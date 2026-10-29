# Plan: Fully client-side PWA with in-browser song ingest

**Goal:** a Pathfinder opens the site, hands it one audio file or a folder
(subfolders included), and the browser itself produces everything the app
needs (stems, word timing, verse tags, sidecars) and saves it *beside the
originals*. Nothing to install: no Python, no CLI, no server. Works over a
shared local folder, OneDrive, or Google Drive, with aggressive caching because
the two cloud drives are slow.

This is a plan, not a spec. Phase 0 exists to settle the choices that depend
on measurement. Where I recommend a default, it is marked **Rec.**

## 0. What exists today (verified in code)

- **Playback side is already client-only.** `playback-engine.js` plays an
  instrumental + vocal stem pair; `local-library.js`, `onedrive-library.js`,
  and `googledrive-library.js` each export `setActiveRoot` /
  `resolveUrlSync` / `primeResolverCache`; Cache Storage holds audio
  (`audio-cache.js`) and the manifest (`manifest-cache.js`); `sw.js` caches the
  app shell.
- **All three sources are read-only.** Local uses `mode: "read"`; OneDrive
  requests `Files.Read`; Drive uses a referrer-restricted API key against
  "Anyone with the link" shares. Nothing can write a sidecar today.
- **`main.js` branches three ways** (`isLocalLibrary` / `isOneDriveLibrary` /
  `isGoogleDriveLibrary`, ~lines 435-450, 863-890). A fourth source (OPFS,
  overlay) makes that untenable, so a common provider interface comes first.
- **The producing pipeline is not in this checkout.** `scripts/` and
  `PBE_2026_2027/` are gitignored, so I could not read `build_manifest.py`,
  `separate_stems.py`, `correct_lyrics.py`, or the NKJV reference file. This
  plan is built from `library-format.html` and the client code. **Before
  Phase 2 I need those scripts** (or a session on the machine that has them),
  because "parity with the existing pipeline" is the acceptance test.
- Missing for a real installable PWA: `manifest.json` only has an SVG icon (no
  192/512 PNG), and `sw.js` has no precache list.

## 1. Architecture

```
 input (file / folder / drag-drop / OS "Open with")
        │
   fs/ Provider  ──── Local (FS Access, rw) · OPFS · OneDrive · Drive · Overlay
        │                    ▲ all reads go through fs/cache.js (see §4)
        ▼
 ingest/scan → identify → [separate] → align → encode → sidecars
        │                 (workers, WebGPU→WASM)            │
        ▼                                                   ▼
 ingest/queue (IndexedDB, resumable)             provider.write (write-behind)
        │
        ▼
 library index (in-memory manifest built from sidecars) → existing app
```

### 1a. Provider interface (`assets/js/fs/`)

One contract, replacing the three bespoke ones:
`list(path)`, `stat(path)` (size, mtime, remote hash/etag), `read(path, {range})`,
`write(path, bytes|stream, {ifAbsent})`, `capabilities` (`{write, rangeRead,
delta}`).

- **Local:** `showDirectoryPicker({mode:"readwrite"})`; handle persisted in
  IndexedDB (already done). Works on a mapped network share or a
  OneDrive/Dropbox-synced folder, which is what "shared local folder" most
  likely means.
- **OPFS:** private browser storage, supported in Chrome, Safari, and Firefox.
  It is where **lone files** live (see §5), and the fallback for browsers
  without `showDirectoryPicker` (they ingest via `<input webkitdirectory>` /
  drag-drop into OPFS), always with an "Export as zip" button and an upgrade
  path to OneDrive/Drive so the work isn't trapped.
- **OneDrive:** MSAL scope goes `Files.Read` → `Files.ReadWrite`. This needs a
  one-time re-consent and an update to the Azure app registration. Writes use
  `PUT …/content` under 4 MB and a resumable upload session (320 KiB-multiple
  chunks) for stems.
- **Google Drive:** see §6, because write access is a real policy problem, not
  just code.
- **Overlay:** when the source is read-only (a share the user can't write to,
  or the current API-key Drive mode), derived files go to a local OPFS overlay
  that the provider layer merges transparently on read. The user gets a full
  experience, and "Save to the folder" can push them later.

Migration order matters: wrap the existing three behind the interface first
with **zero behavior change** and the current tests green.

### 1b. Sidecar format

Keep the existing on-disk shape so libraries produced by the Python pipeline
keep working and the browser can finish half-processed ones:

| File (beside the source) | Contents |
|---|---|
| `<base>.instrumental.m4a`, `<base>.vocal.m4a` | stems (existing names) |
| `<base>.json` | `{words:[{word,start,end,verse}]}` (existing `wordsUrl` shape) |
| `<base>.pbek.json` (new) | provenance: source fingerprint, `pipelineVersion`, models used, per-word/verse confidence, tier reached, identified passage + how |

The browser **assembles the manifest in memory** from a tree scan plus the
sidecars, and writes `manifest.local.json` as a cached index so other clients
and the old pipeline still work. Never overwrite an existing sidecar with an
older `pipelineVersion`. Never write a partial stem (write to `*.part`, rename
when complete; on drives without rename, upload under the final name only after
success).

### 1c. Identify what a song *is* (`ingest/identify.js`)

Cheapest signal first, escalate only on failure:
1. Filename/path: `Mark 6_30-56 (NKJV) (14)`, with parent folder = style,
   trailing `(n)` = take. This is the existing convention.
2. ID3/MP4 tags (title, genre, comment), plus embedded cover art, which
   already feeds `tagsUrl` / `coverUrl`.
3. Audio: transcribe the first ~30 s of the vocal and fuzzy-match against an
   n-gram index of the scripture text. The user confirms in the UI
   ("Looks like Mark 6:30-56 — correct?").

**Reference text sources (decided direction; details pending):** the app
needs the canonical words of whatever a song sings, for identification (§1c.3)
and alignment (§1d). Two corpora, behind one `TextSource` interface
(`getPassage(ref) → [{verse, words[]}]`, `searchIndex()` for fuzzy
identification) so alignment never cares where text came from:

1. **Scripture from bolls.life, as one whole-translation download.** The
   API docs (`Bolls-Bible/bain/docs/API.md`) explicitly ask clients *not* to
   page through `get-text` chapter by chapter to collect a whole Bible (it's a
   single small server), and point to
   `https://bolls.life/static/translations/NKJV.json` (also `.zip`) instead.
   The quiz currently makes per-chapter calls
   (`get-text/NKJV/{book}/{chapter}/`, book = 1-66 canonical number); this
   app should do the better thing: **download `NKJV.json` once**, parse it into
   per-chapter records plus an n-gram index for identification (§1c.3), and
   store those locally. One request replaces hundreds and makes everything
   after it offline. (Mind the unknown size: verses plus `comment` fields, so
   expect single-digit MB; Phase 0 measures it. Unzip via
   `DecompressionStream` if `.json` ever misbehaves, as the docs suggest.)
   - **Normalize.** The docs confirm verse text is *HTML* (`<i>`, `<br>`),
     so strip tags/entities, fold curly quotes/dashes, and drop `comment`
     content. Phase 0 diffs a normalized chapter against your existing
     NKJV file word-for-word, since alignment quality depends on it.
   - A failed download queues songs instead of failing them, with retry.
   - Single-verse and per-chapter endpoints stay as a fallback only.
2. **Commentary text (ABC), OCR'd offline and committed to the repo.** The PDF
   you attached (Mark, 1-2 Peter, 1-3 John) turns out to be **6 scanned page
   images (A4, 300 dpi) with no text layer**: one page per book, two
   columns, hyphenated line breaks ("fo-cus"), slight skew, scan specks. Each
   page holds that book's *introduction*: Title and Authorship, Date,
   Backgrounds, Theology and Purpose (roughly 300-450 words). So:
   - The one-time tool (`tools/extract-commentary/`) must **OCR** (Tesseract,
     two-column layout mode), not just extract text; then de-hyphenate, join
     columns in reading order, drop page numbers/rules/specks, normalize quotes,
     and split on the four bold headings.
   - OCR output is checked by a person (it's ~2,000 words total, so a full
     read-through is cheap) before commit. Each book writes
     `data/commentary/<book>.json` with `{sections:[{id, heading, text}]}`.
   - **"Verses" don't exist in commentary.** The app's unit for these songs is
     the *section* (or paragraph); sections are numbered 1..n as stand-in verse
     numbers, with the heading kept as a display label, so study modes,
     navigation, and blanking keep working. This needs a small `unitLabel`
     field in the manifest/sidecar and a UI string tweak ("section 2" vs.
     "verse 2").
   - Tesseract isn't installed in this sandbox, so I haven't run OCR; Phase 0
     does that and reports accuracy on all six pages.

Passage identity extends to `{source: "scripture"|"commentary", book, ref}`;
the sidecar records which source and version aligned it, and the filename
convention for commentary songs is needed to detect it (§9). With neither
source available (API unreachable, no network on first run), degrade to the
"free transcript" tier (no verse tags, no blanking modes).

### 1c-bis. One Bible download shared across all pbefocus.com subdomains

Browser storage (IndexedDB, Cache Storage, OPFS, service workers) is per
*origin*, so `karaoke.` and `quiz.pbefocus.com` can't see each other's copy. Two
mechanisms do cross subdomains, because browsers partition by top-level *site*
(`pbefocus.com`), not full hostname:

- **Shared HTTP cache (free, partial).** If both apps fetch the *same URL*
  with the default cache, they share one entry. That holds for the bolls.life
  file automatically, but only if bolls sends useful `Cache-Control`/`ETag`
  headers, which I couldn't check from here. Without them it still works as
  a cheap conditional request, not a re-download.
- **Shared store iframe (robust). Rec.** A tiny page on one canonical origin
  (e.g. `https://pbefocus.com/shared-store.html`, in the `pbefocus.com` repo)
  owns an IndexedDB holding the parsed Bible and commentary indexes. Every
  subdomain embeds it as a hidden iframe and talks to it over `postMessage`
  (`get(book, chapter)`, `has(version)`, `put(...)`). Because all embedders
  share the top-level site, they share its partition, so the translation is
  downloaded and parsed **once for the whole family** and works offline for all.
  It stores only what the visitor's own browser fetched from bolls; we don't
  host or redistribute the NKJV text ourselves.
- The same bridge can hold the commentary JSON, and later any other data the
  two apps both want (e.g. book names, the quiz's question index).
- Fallback when the bridge is blocked (older Safari/ITP, strict privacy
  settings, or the iframe not yet deployed): each app uses its own origin
  cache. Behaviour is identical; only the duplicate download returns.
- This is a shared module (`shared-store.js` client + the iframe page).
  **It needs a change in `pbefocus.com`**, which this session can't reach,
  and a matching small change in `quiz_pbefocus_com`. Add it to the go-live
  checklist beside the `site-nav.js` note in `AGENTS.md`. Phase 0 verifies
  cross-subdomain sharing really works in Chrome, Firefox, and Safari.

### 1d. Alignment (the "aligned STT")

Lyrics are known text, so don't run open-ended transcription when you don't
have to. **Rec.: try cheap, escalate on low confidence.**
1. **Forced CTC alignment** of the known verse text against the **vocal stem**
   (16 kHz mono) with a small English wav2vec2/CTC ONNX model. Roughly
   5-20x faster than Whisper decoding, can't hallucinate, and yields per-word
   scores.
2. Verses scoring below a threshold (ad-libs, repeats, a sung chorus that
   isn't in the text) escalate to **Whisper (tiny/base, WebGPU) with word
   timestamps**, then a Needleman-Wunsch alignment to the canonical text. Words
   that don't match get `verse: null`, which is exactly the existing flourish
   convention (and what AI_TODO item 13 builds on).
3. Verse boundaries are snapped to the nearest word onset; confidence is stored
   in the `.pbek.json`.

I expect Whisper's cross-attention timestamps to be looser (~100-200 ms) than
CTC's. Phase 0 measures that against your existing Python outputs.

**Verbatim vs. adapted: the user confirms, per song.** Both scripture and
commentary songs may sing the text word for word, paraphrase it, or mix the two.
The app can estimate which, but shouldn't decide silently:
1. After identification, run a cheap probe (CTC-align ~30 s of vocal and score
   it; or transcribe it and measure word overlap with the reference).
2. Show a **"Words" chip** on each song: `Exact text` / `Adapted` / `Mixed`,
   pre-selected from the probe with its confidence ("looks exact, 94% match").
   For a folder it's applied as a default to every song with a one-click bulk
   confirm, and can be overridden per song. Songs are held in "Needs
   confirmation" only until the first decision is made; low-confidence ones
   are held, high-confidence ones proceed provisionally so nothing stalls
   while the user is away.
3. What each choice does:
   - **Exact:** the fast path above (CTC against the reference; Whisper only
     for low-scoring verses).
   - **Adapted:** skip straight to Whisper. The *sung* words become the
     displayed lyrics and the reference text is used only to tag each sung
     line with its nearest verse/section (fuzzy match; no match => `verse:
     null`).
   - **Mixed:** per-verse decision by score, as in the escalation above, and
     the chip shows "3 of 12 verses adapted" so the user can see and fix it.
4. The choice and probe score are stored in `.pbek.json`.

**Dependency to flag:** the existing app assumes every take of a section has
essentially the same words (`library.js` `alignWordsToCanonical`, matched by
verse + position). Adapted songs break that, so alignment across takes would
produce gap warnings (AI_TODO item 15's symptom, amplified). Genre-mix painting
across adapted takes should splice at verse/section boundaries only, which is
exactly what AI_TODO item 13 plans. So **item 13 (verse-granularity) should
land before or with Phase 2**, and adapted takes need a per-take word list
(their own "canonical") rather than aligning to a shared reference.

### 1e. Stem separation

This is the real cost: a full-song source separation model, 50-300 MB, in the
browser. Pluggable `Separator` with a model picked by the device benchmark:
- **Preferred:** a quantized/fp16 Demucs-class or MDX-class ONNX model on
  **WebGPU** (onnxruntime-web or transformers.js).
- **Fallback:** a smaller vocal-only model on WASM-SIMD (threads need
  cross-origin isolation, which GitHub Pages can't set by header; use the
  `coi-serviceworker` shim, with the cost of one reload on first visit).
- Process in overlapping ~10-30 s chunks with a crossfade; each chunk is
  checkpointed to OPFS so a reload or crash resumes mid-song.
- Output encoding: WebCodecs `AudioEncoder` → AAC in MP4 (vendored muxer) to
  match the `.m4a` the library already uses. Firefox can't encode AAC; fall
  back to Opus-in-WebM or 16-bit FLAC/WAV, since the engine plays any
  browser-playable format.

## 2. Speed: what can actually be done

1. **Tiers, so nothing blocks on the slowest step** (this is the biggest win):
   - **T0 Listed**: filename only, seconds. Shows in the picker, plays the mix.
   - **T1 Lyrics**: CTC-aligned on the *mix* (vocals are usually dominant).
     Karaoke highlight, blanking, type-ahead, and scoring all work. Only the
     "fade out the sung words" audio feature is unavailable.
   - **T2 Full**: stems done; upgrades the song in place, with no user action.
   - Needs one small engine change: allow `vocalUrl` to be absent (play the
     mix as `instrumentalUrl`, vocal path silent/disabled).
2. **Align on the vocal stem when it exists, but don't wait for it** (T1
   above). Re-align on the clean stem when T2 lands only if T1's confidence
   was low.
3. **Device benchmark on first run** (~10 s synthetic clip): picks backend
   (WebGPU > WASM-threads > WASM), model size, and chunk size, and yields a
   real-time factor used for honest ETAs.
4. **Model cost paid once:** weights stored in OPFS/Cache Storage, SHA-checked,
   with a visible "Download models (≈180 MB) once" step, not a surprise.
5. **Scheduling:** GPU stage concurrency 1 (WebGPU contention hurts); CPU
   stages (decode, resample, encode, upload) overlapped with the next song's
   GPU stage, so the GPU never waits on I/O. Decode and resample in workers.
6. **Never redo work:** skip any song whose fingerprint matches an existing
   sidecar (size + mtime + remote hash, or first/last-64 KB hash for local
   files; remote hashes come free from Graph `sha1Hash`/`quickXorHash` and
   Drive `md5Checksum`, so no download is needed to fingerprint).
7. **Reorder by intent:** the song the user just selected jumps the queue. The
   rest is ordered by the current playlist, then by most recently opened
   folder.
8. **Reality check:** a cold start on a mid-range laptop CPU will still be
   slow (minutes per song for full stems). WebGPU on a decent GPU or Apple
   Silicon should be several times faster. I won't promise numbers before
   Phase 0.

## 3. UI for slow work

Principles: never block the app, always show a usable state, and make the wait
honest and interruptible.

- **Drop zone / "Add songs"** (first-run and a persistent button): choose
  files, choose a folder, or drag. A preview step lists what was found, with
  detected passage/style/take per row (editable inline), a count of
  already-prepared vs. new, and an **estimate for this device** ("~2 h 10 min
  for full stems · ~25 min for lyrics-only"). The user chooses a mode:
  **Lyrics first** (T1 for all, then stems in the background), **Full**, or
  **Lyrics only**, plus the per-song **Words** chip (§1d: Exact / Adapted /
  Mixed) with a bulk "apply to folder" confirm.
- **Persistent progress chip** in the header ("Preparing 4 of 31 · ~1 h 20 m")
  opening a **Library** panel: a per-song list with state pills
  (`Listed → Queued → Separating 43% → Aligning → Ready (lyrics) → Ready (full)
  / Needs review / Failed — retry`), a per-stage progress bar, and a thin
  global one. Rows sort by "needs attention", then by the current playlist.
- **Study while it works:** any song at T1+ is selectable and playable
  immediately, with a small badge "stems still preparing". The song upgrades
  mid-session at the next block boundary, never mid-note.
- **Controls:** pause/resume all, "do this one now", skip, retry, cancel;
  "Only run while charging / on Wi-Fi"; a **Keep screen awake** toggle (Screen
  Wake Lock), pairing naturally with the existing Sleep Mode skin for
  overnight batches. Queue and checkpoints persist, so closing the tab loses
  at most one chunk. Browsers can't compute with the tab closed; the UI says
  so plainly instead of implying background magic.
- **Review queue:** songs whose confidence is low are flagged. A simple
  editor (reusing the mix-editor's word chips) lets a user nudge a word's
  boundary or reassign a verse; edits are written back to the sidecar and
  marked `humanReviewed` so reruns never clobber them.
- **Shared libraries:** on a drive that several people use, the first person
  to prepare a song benefits everyone. A small `<base>.pbek.lock` (device id +
  heartbeat) prevents two devices burning cycles on the same song; a stale lock
  expires after a few minutes.
- **Errors in plain words:** "Couldn't read this file (still syncing from
  OneDrive?)", "This folder is read-only — saving to this device instead."
  The existing local-library error copy is a good model.

## 4. Aggressive caching (OneDrive/Drive are slow)

Layered, content-addressed, stale-while-revalidate:

1. **Listing/index cache.** Persist the scanned tree + assembled manifest in
   IndexedDB. Open the app → render from cache instantly → revalidate in the
   background using **Graph delta** (`/delta`) and **Drive `changes`**, so a
   revisit costs one small call, not a full recursive crawl. Cloud tree walks
   are the single worst latency offender; this removes them from the critical
   path.
2. **Byte cache keyed by remote hash**, not path or signed URL. Renames/moves
   don't refetch. Existing path-keying in `audio-cache.js` migrates to this.
3. **Store audio in OPFS** (not just Cache Storage) for large files:
   range reads without materializing a blob, and no 2x memory spike from
   `blob:` URLs. Keep Cache Storage for small JSON.
4. **Prefetch:** on playlist load, fetch the sidecar `.json` files in bulk
   (Graph `$batch` ≤ 20 per call; Drive with a concurrency limit), then
   prefetch the next N blocks' stems ahead of the playhead. The existing
   `primeResolverCache` becomes the single hook point.
5. **Persistence:** call `navigator.storage.persist()`; show quota via
   `storage.estimate()`; raise or remove the 500 MB opportunistic cap for a
   library the user owns. LRU still applies to opportunistic data but **never
   evicts write-behind outputs not yet uploaded**.
6. **Write-behind queue:** processing completes locally first (outputs land in
   OPFS), then uploads with retry/backoff and resumable sessions; the song is
   playable from the local copy before the upload finishes. The upload queue
   survives reloads.
7. **Warm-start:** SW precaches the app shell (versioned list). Model weights
   are cached separately and survive app updates.

## 5. Input paths ("one file or a folder, subfolders included")

- Folder: `showDirectoryPicker` (recursive scan), else `<input webkitdirectory>`
  / drag-drop (`webkitGetAsEntry`/`getAsFileSystemHandle`) into OPFS.
- Single file: `<input type=file>`, `showOpenFilePicker`, drag-drop, or PWA
  `file_handlers` in `manifest.json` ("Open with PBE Karaoke" from the OS),
  launched via `launchQueue`.
- **Decided: a lone file is treated as an upload into browser-local storage
  (OPFS).** A handle to one file never grants write access to its parent
  folder, so there is no "beside the file" for it. The app shows a clear
  warning ("These files live only in this browser; clearing site data or
  switching devices loses them") with an **Upgrade to OneDrive / Google Drive**
  action that moves the audio and its derived files to a chosen cloud folder,
  plus an "Export as zip" escape hatch. Works identically in every browser.
- Accept `audio/*` plus known extensions (mp3, m4a, wav, flac, ogg, opus);
  skip already-derived `*.instrumental.*` / `*.vocal.*` so stems are never
  re-ingested.

## 6. Cloud write access: decisions that need you

- **OneDrive:** straightforward. `Files.ReadWrite` + re-consent. A folder
  shared read-only can't be written; the Overlay covers it.
- **Google Drive: decided, `drive.file` scope via the Google Picker only; the
  full `drive` scope is off the table.** Today's flow uses a public API key,
  which cannot write, so writing needs OAuth (Google Identity Services) plus
  a Picker step where the user selects the library folder. `drive.file` reaches
  only files the app created or the user picked. Phase 0 must verify whether a
  picked *folder* grants write access to its existing children. If not, stems
  and sidecars created by the app are still app-owned (so writable and
  readable by it), and the Overlay fallback covers anything else. Consequence
  to design for: files added to the folder by someone else *after* picking may
  need a re-pick to be visible.
- **Browser support (corrected):** only one thing is Chromium-only: **writing
  into a real local folder** (File System Access API). Cloud ingest
  (OneDrive/Drive writes over HTTP) and lone-file/OPFS storage work in every
  browser. WebGPU and WebCodecs AAC encode availability in Safari/Firefox is
  unverified and is a Phase 0 check; where absent, those browsers run the
  slower WASM path and the Opus/WAV output fallback. iOS also throttles
  background tabs, so long batches need the Screen Wake Lock toggle.
  **Rec.:** show a capability summary on the "Add songs" screen.

## 7. Phases (each independently shippable)

> **Priority shift (see §10-§11):** embeds (YouTube/Suno playlists) are now the
> *primary* use case and uploaded personal files the *secondary* one, so the
> shared data model, `RemotePlayer`/YouTube, tap-sync, and collaboration come
> **before** the heavy ML path (stems, STT, WebGPU). The phase list below keeps
> its content, but the authoritative order is **§11f**.

- **Phase 0, spike (blocks the rest):** with ~5 songs from your existing
  library plus their Python outputs as ground truth, measure in a throwaway
  page: (a) forced CTC vs. Whisper word-timing error against the
  Python-produced `.json`; (b) separation time and quality per candidate model
  on WebGPU and WASM; (c) the Drive `drive.file` + Picker folder-child
  question; (d) AAC encode support matrix; (e) NKJV.json size and its word-for-word match
  to your NKJV file; (f) OCR accuracy on the six commentary pages; (g) shared
  store iframe actually sharing across two subdomains in each browser; (h) the
  exact-vs-adapted probe's accuracy on a few known songs of each kind. Output: pick models, set the
  acceptance thresholds.
- **Phase 1, provider layer + cache:** `fs/` interface; wrap Local/OneDrive/Drive
  (no behavior change); content-addressed cache; index + delta revalidation;
  OPFS audio store. Extend `tests/helpers/fake-fs.mjs`/`fake-caches.mjs`.
- **Phase 2, local ingest, lyrics tier:** scan, identify, CTC align on mix,
  sidecar writer, in-memory manifest assembly, absent-`vocalUrl` engine
  support, minimal "Add songs" + Library panel. Parity test against the Python
  outputs (golden files in a private fixtures dir, not committed).
- **Phase 3, stems:** separator workers, chunk checkpointing, WebCodecs
  encode, T1→T2 upgrade, benchmark-driven model choice.
- **Phase 4, queue + full UI:** persisted queue, ETA, priority, wake lock,
  pause/resume, review editor, locks.
- **Phase 5, cloud writes:** OneDrive `ReadWrite` + resumable upload; Drive
  per §6; write-behind queue; Overlay.
- **Phase 6, PWA hardening:** PNG icons (192/512 + maskable), versioned precache,
  `file_handlers`/`launch_handler`, `coi-serviceworker`, install prompt,
  update-available toast.

## 8. Testing & risks

- **Pure logic first:** filename parser, fingerprinting, queue state machine,
  sidecar merge/version rules, Needleman-Wunsch matcher, ETA estimator, the
  index delta applier. All Node-testable like the rest of the suite.
- **Heavy parts behind adapters:** workers take an injectable "model" so tests
  use a stub (as the playback tests use a fake engine). Real-model accuracy is
  a separate, opt-in golden-data check, not part of `npm test`.
- **Risks:** singing alignment quality is harder than speech (Phase 0 may push
  us toward Whisper-heavy); browser memory limits on long songs (hence
  chunking); iOS/Safari background throttling; WebGPU availability;
  **model licenses** (several multilingual alignment models are non-commercial;
  confirm each chosen model's license before vendoring or hosting it);
  repo-hosting of ~hundreds of MB of weights (host them from the
  `pbefocus.com` side or fetch from a model CDN into the user's cache, not the
  git repo).
- **Privacy/copyright stays intact:** processing and derived files never leave
  the user's device/drive. No song content or scripture text enters this repo.

## 9. Open questions (with my defaults)

1. ~~Tiered "lyrics before stems"~~ **Decided: yes.**
2. ~~Reference text~~ **Decided direction:** scripture via the quiz API,
   commentary via preprocessed JSON in the repo. Still needed: see §9a.
3. ~~Google Drive scope~~ **Decided:** Picker + `drive.file` only.
4. ~~Lone files~~ **Decided:** browser-local (OPFS) with a warning and an
   upgrade-to-cloud action. Browser target: Chrome/Edge for local-folder
   writes, all browsers for cloud + lone files (verify in Phase 0).
5. Keep the Python pipeline as the bulk/"gold" path alongside the browser one?
   **Rec.: yes**, with identical sidecar formats so they interoperate.
6. Can you make `scripts/` (or at least `build_manifest.py`,
   `correct_lyrics.py`, `separate_stems.py`) and ~5 reference songs with their
   outputs available for Phase 0?

### 9a. Remaining text-source questions

Resolved: scripture source and method (bolls.life whole-translation file),
commentary source and scope (the attached PDF is the complete ABC commentary:
six book introductions, section-level units only), verbatim vs. adapted (user
confirms per song, §1d), shared download (§1c-bis, approved as a prerequisite
change to `pbefocus.com` and `quiz_pbefocus_com`), and committing the OCR'd
commentary text to this public repo (approved).

- **Filenames of commentary songs** (to recognize them in §1c step 1), e.g.
  "Mark - Title and Authorship (3).mp3"? A sample would settle it; until then
  recognition falls back to the audio probe and a manual "this is commentary"
  choice in the preview step.
- Still outstanding: the Python pipeline scripts and ~5 reference songs with
  their outputs (Phase 0 input).

## 10. Remote sources: YouTube, Suno, other sites

**The one fact that drives everything:** an embedded player (YouTube
IFrame API, Suno/Spotify/SoundCloud/Vimeo embeds) lets us *control* playback
but never *touch the audio*. It lives in a cross-origin iframe, so there is no
Web Audio access, no download, and no samples to separate or align. Ripping or
capturing that audio is also against YouTube's terms and a gray area for the
others. So the pipeline can't be pointed at them. The design splits sources into
two classes instead of pretending they're alike.

### 10a. Two source classes

| | **Owned audio** (files, Drive/OneDrive, direct URL with CORS) | **Remote player** (YouTube, Spotify, SoundCloud, Vimeo, Suno embed*) |
|---|---|---|
| Audio access | full (decode, separate, align, cache) | none |
| Timing comes from | our aligner (§1d) | sidecar lookup, tap-sync, imported timed lyrics, or an aligned copy of the same song the user owns (§10c) |
| Engine | today's `playback-engine.js` | new `RemotePlayer` adapter: `play/pause/seek/getTime/setRate/setVolume`, events |
| Offline | yes | no |

\* Suno: see §10d; its audio CDN may make it an *owned-audio* source.

Add a **capability set** to every playback source
(`{stems, pitch, reverb, vocalFade, mix, crossfade, offline, lockScreen,
preciseSeek}`). The UI reads it and disables a control with a one-line reason
("Not available for YouTube links") rather than silently doing nothing. A
recording may hold *both* an embed reference and owned files; the engine
prefers the files when present, so a link can be upgraded later.

### 10b. What still works, what doesn't (remote player)

- **Works:** karaoke highlight (follow `getCurrentTime()`, interpolated between
  ~4 Hz polls with `performance.now()` and re-synced on drift > ~150 ms),
  Karaoke Mode blanking, Type Ahead, Sing-Along (use headphones, since the mic
  would otherwise hear the embed), Name that Passage, playlists, verse
  navigation and A/B verse loops (seek-based, so loop edges are looser, about
  +/-0.3 s), playback-rate control where the platform offers it, volume fade for
  the Sleep Mode timer where the platform allows it (not iOS).
- **Doesn't:** stems and vocal fade-out, pitch/key-lock/reverb, mastering
  limiter, gapless crossfades, lock-screen controls, offline use, and **genre-mix
  splicing across recordings** (it needs sample-accurate scheduling of two
  streams). A best-effort "switch embeds at verse boundaries" mode is possible
  with a visible gap and risk of ads; treat it as out of scope for v1 and say
  so in the UI.
- **Sharing is better, not worse:** a shared playlist holds only IDs plus
  timing sidecars, so it never distributes audio.
- **Embed rules shape the layout:** YouTube requires a visible player of
  reasonable minimum size and doesn't allow hiding it for audio-only playback.
  (I'm going from memory of their developer policy; verify before building.)
  The lyric display must leave room for the video, not cover it. Mobile
  browsers also need a user tap to start an embed, and pause it when the tab
  is backgrounded, so Sleep Mode degrades to "screen on, video visible".
- **Ads/unavailable videos:** pre-roll shifts nothing if we only start the
  clock on the player's `PLAYING` state, but a mid-roll or an
  embedding-disabled/removed video interrupts. Detect `onError`/state changes,
  pause the highlight, and show "video unavailable" with the sidecar kept.

### 10c. Where do word timings come from?

This is the biggest operational change: no audio means no STT. In order of
preference:
1. **Existing sidecar** for the same `(platform, videoId)`, found in the
   library folder or shared drive (`<name>.pbek.link.json` plus the usual
   words sidecar). One person syncs a song; everyone with the library gets it.
   (A future shared index could let users find each other's timing; not v1.)
2. **Bind to an owned copy:** the user drops their own legal audio file for the
   same song; we align it with the normal pipeline (§1d), then a one-step
   **offset calibration** (play the embed, tap when a known word is sung)
   maps that timing onto the video's clock (`timingOffset`; optional
   `timeScale` for a different-speed upload).
3. **Tap-to-sync editor:** the reference text is already known, so the user
   only supplies *when*. Tap at each verse/line while the embed plays; word
   times inside a line are interpolated by syllable weight, then refined with
   nudge controls. Coarser than STT but plenty for karaoke highlighting, and
   it works for any embed. Reuses the review editor from §3.
4. **Import** timed lyrics (LRC or our JSON).
5. *Not planned:* capturing tab audio (`getDisplayMedia`) to feed the aligner.
   It would technically work in Chromium in real time, but it processes
   audio the platform doesn't allow us to extract. Left as an explicit
   decision for you, not a default.

A sidecar is bound to the video via `{provider, id, durationSec}`; if the
embed's reported duration later differs (a re-upload, a different cut), warn
before applying old timing.

### 10d. Suno specifically (needs a test, can't verify from here)

- Suno song pages/embeds are an iframe, so treat them as a remote player
  *unless* the embed exposes no usable time/seek API, in which case timing
  can't follow playback at all. I don't know of a public player API for them;
  Phase 0 checks.
- Their audio is served from a public CDN URL pattern (the existing
  pipeline's originals came from there). If that CDN allows cross-origin
  reads (CORS), a Suno link becomes a **direct-URL, owned-audio** source and
  the *full* pipeline (stems included) applies; if it doesn't, a plain
  `<audio>` can still play it but Web Audio can't touch it. I also recall
  Suno exposing word-timed lyrics to signed-in users, but it's an
  undocumented, authenticated API and not something to build on without
  checking terms. Confirm the account tier's usage rights before processing
  anyone's Suno audio.

### 10e. "Other sites"

A pasted URL is classified in order: (1) **direct audio URL** (mp3/m4a/ogg;
a CORS-readable one is a full owned-audio source via a read-only `URL`
provider and gets cached like any other file; a non-CORS one is
playback-only); (2) **known embed provider** with a player API
(YouTube, SoundCloud Widget, Vimeo, Spotify), handled by a per-provider
`RemotePlayer` adapter that implements the same small interface; (3) anything
else: save as a reference link only ("can't play this site inside the app").
There is no CORS-proxy fallback; the app has no server and a proxy would
also be a rights problem. Spotify's embed generally plays short previews
unless the viewer is a signed-in Premium user, so label it "preview only".

### 10f. Changes to earlier sections

- **Manifest/sidecar:** a recording's audio fields become optional; add
  `source: {kind: "file"|"url"|"embed", provider, id, durationSec,
  startOffset, endOffset, timingOffset}` and `capabilities`. Timing sidecars
  carry how they were produced (`aligned | tapped | imported`).
- **Queue (§3):** a remote item skips separate/encode; its "align" stage
  becomes a **Needs timing** state with the choices in §10c, and its tier tops
  out at T1 (lyrics) unless an owned copy is added later.
- **Add songs (§5):** a "Paste a link" tab beside file/folder: detects the
  provider, shows title/thumbnail (oEmbed where CORS allows, else the bare ID),
  asks passage + Words chip, then asks how to get timing.
- **Caching (§4):** nothing to cache for audio. Cache timing sidecars and
  link metadata aggressively, and remember "unavailable" results.
- **Phases:** add **Phase 2b, remote sources**, right after Phase 2: capability
  flags, `RemotePlayer` interface and a fake for Node tests, YouTube adapter,
  link recording + tap-sync editor. Then direct-URL (cheap), then Suno/other
  providers after the Phase 0 findings. Phase 0 gains: (i) YouTube clock
  accuracy and loop-edge error on real devices, (ii) Suno embed API and CDN
  CORS behavior, (iii) which of SoundCloud/Vimeo/Spotify are worth adapters.

## 11. Collaborative space: shared playlists, shared timings, votes

### 11a. Is it possible with this architecture?

**Not with karaoke's current one** (no identity, no write path, no merging),
**but the architecture of `score_pbefocus_com` is the right foundation, so adopt
it.** From reading its code and docs (`AGENTS.md` "Cloud Folder Sync
Architecture", `SYNC_SETUP.md`):
- Data lives in **Yjs CRDT documents**, IndexedDB-first, so editing works
  offline and merges without conflicts.
- Sharing is a **cloud folder** (Google Drive or OneDrive) that members open
  with their own account. **Each device writes only its own files**
  (`c-{clientId}.yjs`, optional `snapshot-*.yjs`) and merges everyone else's;
  nothing is deleted. No server of ours.
- It already solved the hard parts I'd flagged: Drive via **`drive.file` +
  Google Picker (with `appId`) for a shared folder**, OneDrive via MSAL
  `Files.ReadWrite.AppFolder` / `.All`, adaptive polling with backoff, "large
  event" relay beyond ~20 writers, status/reconnect UX, and a `FolderBackend`
  interface (`list/get/put`) with a mock for tests. It also ships PWA file/link
  handlers and shares OAuth registrations across pbefocus.com apps.
- Caveat: its sign-in/real-folder flows are marked as needing manual testing with
  real client IDs, so Phase 0 should still run a two-account shared-folder test.

### 11b. Three spaces, one data model

| Space | Who | Where it lives | Server? |
|---|---|---|---|
| **Personal** | you | IndexedDB / your Drive / OneDrive / local folder | none |
| **Club** | a team that shares a folder | shared cloud folder, Yjs, `score`-style | none |
| **Community catalog** | all pathfinders | read-mostly published data, and (optionally) votes | static files, or a thin service (§11d) |

The same record types work in all three, behind a `SpaceProvider` interface
(like `fs/` providers): `FolderSpace` (score engine), `CatalogSpace` (static
JSON, like the quiz's `questions/v1/` files), and later `ServiceSpace`.

**Records** (all small JSON; audio is never stored):
- `song`: `{provider, id, durationSec, passageRef | commentaryRef, wordsMode}`
- `timingSet`: **immutable, content-addressed** (`sha256` of its canonical JSON):
  `{song, textVersion, wordTimes[], method: tapped|aligned|imported, parent?,
  author: pseudonymousId, createdAt}`. "Improving" a timing = publishing a
  *child* set, not editing in place. Immutable versions merge trivially in any
  storage (a file per hash), keep full history, and make forks and rollbacks
  free.
- `vote`: `{timingSetHash, voter, value, note?: early|late|good}`, last-write-wins
  per `(voter, set)`.
- `playlist`: ordered items `{song, chosenTimingSet?}` plus the existing
  genre-mix/style settings where they still apply (§10b).

### 11c. How "quality" is decided

- **Rank sets** per song by an adjustable score (net votes, recency, and
  whether the author is a trusted validator), and play the top one by default
  with a "Timing: ★ 4.6 (12) · other versions" control, so a newcomer needs no
  decisions.
- **Cheap, low-effort feedback:** after a play-through, "timing felt: early /
  good / late". Early/late votes also yield a **consensus offset** (median) that
  is applied to a set without anyone re-tapping it.
- **Improve:** open a set in the tap-sync editor, fix the bad verse, save as a
  child version; the diff vs. the parent is shown, and votes then decide which
  wins. Live co-editing of one set is unnecessary, so avoid it.
- **Validators:** like the quiz's `validatedBy`, maintainers or club leaders can
  mark a set as verified; that outranks vote count.
- **Bridge from owned audio:** any member who has the audio can run the aligner
  (§1d) and publish the *timing* (never the audio), tagged `aligned`. That
  gives the community high-quality timings with no tapping.

### 11d. Where voting needs a server (the real decision)

A shared Drive folder is a **trusted-group** model: anyone who can open it can
read and write; votes are honest-by-assumption. That's fine for a club (tens of
people) and wrong for the whole community (thousands, strangers, no way to
stop ballot-stuffing, folder-share friction, Drive quotas). Options:

1. **Club-only voting + maintainer-curated catalog (no server).** Clubs vote
   inside their own folder; maintainers/validators promote good sets into the
   public catalog (static JSON in `pbefocus.com` or this repo). Cheapest, safest,
   no new infrastructure. Cross-club ranking is manual.
2. **Thin service for the commons.** One tiny hosted service (e.g. Cloudflare
   Workers + D1/KV, or Supabase) that verifies the user's Google/Microsoft ID
   token, stores pseudonymous `timingSet`/`vote` records, rate-limits, and
   serves rankings as cached JSON. Everything else stays client-side. Gives
   true global voting but adds hosting, cost, abuse handling, and ends the
   "nothing is sent to our servers" posture the score app advertises.
3. **GitHub PRs as the backend.** Contributors open PRs against a data repo.
   Strong review and history but a poor fit: needs GitHub accounts and is
   far too heavy for children.

**Rec.:** ship (1) first, but build behind `SpaceProvider` so (2) can be added
later without touching the app. Decide on (2) only if clubs ask for
cross-club voting.

### 11e. Safeguards (Pathfinders are minors)

- **No free text, photos, or real names** in shared data. Members appear as
  club-chosen nicknames or a random pseudonym; the score app currently records
  the account's real name for folder members, so don't copy that for community
  data, and say who can see what in the UI.
- **Playlists are private by default** and shared explicitly (link/QR as today,
  or into a club folder).
- **Moderation:** a "report this timing" action; club leaders or validators can
  hide a set (a `hidden` marker record, never a delete). With a service (option
  2), add rate limits and a takedown path.
- **Rights:** shared data is song *references* (IDs), timings, and scripture/
  commentary word lists. It never contains audio or someone else's lyrics beyond
  the commentary text already approved for this repo.
- Clubs on school/church Google or Microsoft tenants may block third-party
  OAuth or need admin consent (score's `SYNC_SETUP.md` notes this for `.All`),
  so keep **share-link import** (no sign-in) as the lowest-friction path.

### 11f. Revised phases (authoritative order)

0. **Spikes:** YouTube clock/loop accuracy; tap-sync quality (can a first-time
   user produce a good verse-level sync in a few minutes?); Suno embed/CDN (§10d);
   two-account Drive and OneDrive shared-folder test using score's code; NKJV
   file/OCR/commentary checks from earlier; the pipeline scripts and reference
   songs still needed *only* for the secondary ML path.
1. **Data model + `RemotePlayer` + YouTube adapter + capability flags** (§10),
   in karaoke's existing engine, with a fake player for Node tests.
2. **Tap-sync editor**, `timingSet` records, personal-space storage
   (IndexedDB), and the Paste-a-link flow. First usable milestone: a user can
   build a YouTube playlist with synced lyrics entirely by themselves.
3. **Share links** for playlists + timing sets (extends `share.js`), still
   serverless; shared bible store (§1c-bis).
4. **Club spaces:** port/vendor the `score` folder-sync engine, providers, and
   auth (or extract a shared package used by both apps); votes, versions,
   "improve", validators, report/hide.
5. **Community catalog** (static, maintainer-curated) and consensus-offset
   votes; then **decide on the thin service** (§11d option 2).
6. **Personal audio path (original Phases 1-6):** provider/cache layer,
   alignment, stems, queue UI, cloud writes, PWA hardening. Aligned timings can
   now be *published* into the shared space.
7. Suno/SoundCloud/Vimeo/Spotify adapters as Phase 0 justifies.
