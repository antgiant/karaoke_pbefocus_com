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

1. **Scripture, live from bolls.life, exactly as quiz.pbefocus.com does it**
   (`quiz_pbefocus_com/assets/js/data-service.js`). One request per chapter:
   `GET https://bolls.life/get-text/NKJV/{bookNumber}/{chapter}/`, where
   `bookNumber` is the 1-66 canonical number (the quiz's `41-mark` ids carry it
   as their prefix; this app's `CANONICAL_BOOK_ORDER` index + 1 gives the
   same). A single-verse endpoint, `get-verse/NKJV/{book}/{ch}/{v}/`, also
   exists; we only need the chapter one. The quiz calls it straight from the
   browser, so CORS is already permissive. Port the quiz's tolerant response
   parser (it accepts several field names) rather than assuming one shape.
   - **Normalize before use.** The quiz never strips markup, so I can't tell
     from its code whether NKJV text from bolls carries `<i>` italics for
     supplied words, footnote marks, or Strong's tags. The extractor must strip
     tags and entities, fold curly quotes, and split the lyric-vs-text
     differences the existing pipeline already handles (`correct_lyrics.py`).
     Phase 0 samples a real chapter and a few songs.
   - Cache each chapter permanently (the text never changes) in IndexedDB,
     plus an n-gram index for identification (§1c.3). Prefetch every passage
     found in a scanned library, so after first use alignment works fully
     offline. A third-party API is a single point of failure, so a failed
     fetch queues the song rather than failing it, with retry.
   - The Phase 0 translation check is now a non-issue to *find* (it's NKJV in
     both places) but still worth running: bolls' NKJV must match the text your
     songs were generated from, word for word.
2. **Commentary text (ABC), preprocessed offline and committed to the repo.**
   (Source: this year's commentary PDFs listed at
   <https://nadpbe.org/pbe-resources/>.)
   Public per-book PDFs get converted by a one-time build script
   (`tools/extract-commentary/`: PDF text extraction, strip headers/footers/
   page numbers, normalize hyphenation and smart quotes, segment into the
   units songs are actually built from) into `data/commentary/<book>.json`
   plus a small `index.json`. The app fetches only the books it needs, and the
   service worker caches them. The extraction is run by a maintainer when a
   new year's PDFs appear; it is not part of the user's runtime, so users still
   install nothing. Extraction is the risky step (multi-column layouts,
   footnotes, sidebars), so each book gets a spot-check report (word counts,
   odd-character rate, unmatched-segment list) before it's committed.

Passage identity extends to `{source: "scripture"|"commentary", book, ref}`;
the sidecar records which source and version aligned it, and the filename
convention for commentary songs is needed to detect it (§9). With neither
source available (API unreachable, no network on first run), degrade to the
"free transcript" tier (no verse tags, no blanking modes).

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
  **Lyrics only**.
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

- **Phase 0, spike (blocks the rest):** with ~5 songs from your existing
  library plus their Python outputs as ground truth, measure in a throwaway
  page: (a) forced CTC vs. Whisper word-timing error against the
  Python-produced `.json`; (b) separation time and quality per candidate model
  on WebGPU and WASM; (c) the Drive `drive.file` + Picker folder-child
  question; (d) AAC encode support matrix. Output: pick models, set the
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

### 9a. Needed to finish the text-source design

Resolved: the scripture API (bolls.life, same calls as the quiz), and where
the commentary lives (nadpbe.org/pbe-resources). Still open:

- **The commentary PDFs themselves.** This sandbox can't reach nadpbe.org or
  bolls.life (only GitHub is reachable), so I can't download them. Either
  commit the PDFs to a folder in this repo (e.g. `tools/extract-commentary/
  input/`; fine to keep them gitignored if you'd rather not publish the PDFs
  themselves) or run the extractor on a machine that can fetch them.
  I've confirmed nothing about their layout yet.
- How commentary songs relate to the text: do they sing commentary prose
  verbatim, and how are their files named, so §1c step 1 can recognize them?
- Rights check on committing the *extracted* commentary text to a public repo,
  separate from the PDFs being freely downloadable. If there's any doubt,
  the extractor can output to the private library folder instead, and the app
  reads it from there like it does the manifest.
