# AI Task List

Working queue of larger changes for an AI agent to pick up in this repo.
Each item below is written to be actionable without re-deriving context:
what the goal is, which files are actually involved (verified against the
current code, not guessed), and what to watch out for. When you pick one
up:

1. Read the "Relevant files" for that item before touching anything.
2. If an item lists an "Open question," resolve it with the user (or state
   your assumption plainly in the PR/commit) before implementing — don't
   silently guess on user-facing wording or UX behavior.
3. Once finished (tests passing, verified in a real browser where the item
   touches the UI), remove the item from this file rather than checking it
   off in place — the commit message is the record of what was done and
   why; this file only tracks what's still outstanding.
4. Keep entries here scoped to *planned, not-yet-done* work — this file is a
   queue, not a changelog or a design doc archive.

**Status: pre-release.** This app has not been released or deployed
anywhere — there are no real users and nothing in `localStorage` anywhere
that needs preserving. Freely make breaking changes to persisted-state
shape, `localStorage` keys, naming, URLs, etc. — no migrations, dual-read
fallbacks, or backwards-compatibility shims for old saved state. Just change
the shape and move on. (This repo's own top-level guidance already says not
to add compatibility shims for hypothetical needs; this note just confirms
there's no *actual* prior-version data to protect here either.)

---

## 13. [ ] Verse-granularity navigation & genre mix; preserve vocal flourishes; fix non-live content attachment

**Goal:** Make the *verse* the smallest addressable unit for playback
forward/back navigation and for genre-mix painting (today they operate on
coarser/finer units — see below). Stop clipping vocal flourishes
(ad-libs/runs within a recording). Keep looping working — it's already
verse-scoped, just needs to include flourishes/lead-ins in its bounds. Make
non-live content (spoken chapter headings, intros — `word.verse === null`)
that sits immediately before a verse belong to the verse *after* it, not
wherever it currently ends up.

**Current state (verified against code):**
- `engine.skipToNextBlock()`/`skipToPreviousBlock()`
  (`assets/js/playback-engine.js:850-856`, wired from
  `assets/js/player-controls.js:36-37` and `assets/js/sleep-mode.js:192-193`)
  step through `program.blocks` — one block per contiguous run of the
  genre-mix paint assignment, which by default is a whole section/chapter.
  "Next" can currently skip an entire multi-verse passage at once.
- The mix editor (`assets/js/mix-editor.js:258-346`) paints at individual
  **word** granularity — a drag can start/end mid-verse, splitting one verse
  across two styles.
- Non-live filler (`word.verse === null`) is only ever attached to whichever
  segment's `[inTime, outTime]` window it happens to fall inside, and
  `inTime`/`outTime` are always clipped to the first/last **canonical
  (scripture) word's own timestamp** (`assets/js/program-builder.js:176-177`).
  So filler immediately before a verse gets glued to the *previous* verse's
  audio, or — if a genre-mix run boundary falls between the two verses —
  silently dropped from playback entirely. A vocal ad-lib/flourish tacked
  onto the end of a verse's audio (after the last scripture word's own
  timestamp) gets cut off the same way.
- Looping (`assets/js/karaoke-controls-panel.js`, `mountAbLoopPicker`) is
  already verse/whole-chapter scoped by design (its own doc comment notes an
  earlier arbitrary-word-range version was deliberately replaced with this
  coarser granularity) — that part already matches what's wanted. But its
  time bounds come from the same canonical-word-only timestamps
  (`loopRangeForCanonicalIndices`, `assets/js/karaoke-controls.js:104-125`),
  so a verse loop currently clips any lead-in heading or trailing flourish.
- No manifest/schema concept of "flourish" exists — `verse: null` is the only
  signal, and it's used identically for headings, ad-libs, and any other
  filler (`library-format.html:212-215`).

**Decided (confirmed with the user):** the four requirements above — verse
as the smallest unit for nav + genre mix, flourishes preserved, looping kept
working, non-live content reassigned to the verse *after* it — are the
confirmed scope. The design below is a proposed implementation that has
**not** yet been walked through/approved step-by-step with the user; confirm
before or during implementation if anything below turns out to be wrong once
you're in the code.

**Proposed design:**

*Core rule (no manifest/schema changes needed):* given an ordered word list
with `.verse` tags, classify each run of `verse === null` words by what
surrounds it as it's walked in order:
- bounded by the **same** verse number on both sides → an **interior
  flourish** (mid-verse ad-lib) → stays attached to that verse.
- otherwise (a different verse follows, or nothing precedes it) → **boundary
  filler** → attaches to the verse that **follows** it. Only if nothing
  follows (trailing filler at the very end of a recording) does it fall back
  to attaching to the verse before.

This needs no reprocessing of `scripts/correct_lyrics.py`/`build_manifest.py`
or the manifest schema — flourishes and headings are inferred purely from
existing `verse`/timestamp data, per recording (each take's own ad-libs are
its own).

- **`assets/js/library.js`:** add `verseAudioBounds(words)` — pure function
  implementing the rule above over any single recording's own `words` array
  (works for the canonical reference recording or any specific take).
  Returns `Map<verseNumber, {startTime, endTime}>`, each verse's
  *filler-inclusive* audio span in that recording's own timeline. (Scripture
  verses appear as one contiguous run per recording, so a single
  `{startTime, endTime}` per verse is sufficient.)
- **`assets/js/program-builder.js`** (`buildProgram`, ~line 176): after
  computing a segment's initial `inTime`/`outTime` from the first/last
  canonical word, widen them using `verseAudioBounds(recording.words)` for
  that segment's first/last verse. Because each verse's leading filler always
  resolves within *that verse's own assigned recording* (genre-mixing splices
  whole verses, not sub-verse audio), this needs no cross-segment
  coordination. Also attach `block.verseBounds: Map<verseNumber,
  {startTime, endTime}>` (restricted to the verses that block covers) so
  downstream consumers don't need to recompute it.
- **`assets/js/karaoke-controls.js`:** keep `verseRangesForSection` as-is
  (still needed for verse order/boundaries). Rewrite
  `loopRangeForCanonicalIndices` to resolve start/end time via each matching
  block's new `verseBounds` instead of scanning raw `canonicalIndexMap` word
  timestamps. Add `programVerseStops(program)`: flattens `program.blocks` in
  order into `[{sectionKey, verse, blockIndex, time}]` — the ordered list
  forward/back navigation steps through.
- **`assets/js/playback-engine.js`:** add `skipToNextVerse()`/
  `skipToPreviousVerse()`, built on the existing `skipToBlock(index, time)`
  (already supports an arbitrary in-block seek time — no engine internals
  need to change) plus `programVerseStops`. Keep `skipToNextBlock`/
  `skipToPreviousBlock` in place but stop calling them from the UI.
- **`assets/js/player-controls.js`:** wire Previous/Next to the new verse
  skip methods; update the status line (`renderStatus`, ~line 47-49) from
  "section X of Y" to a verse-based label.
- **`assets/js/sleep-mode.js:192-193`:** same swap for the OS media-session
  prev/next handlers.
- **`assets/js/mix-editor.js`:** compute `verseRangesForSection(canonical)`
  once per section render; on `pointerdown`/`pointerenter`
  (`mix-editor.js:288,293`), snap `dragStart`/`dragEnd` to the containing
  verse's full `[startIndex, endIndex]` instead of the raw word index. Word
  chips stay individually visible for readability, but painting always
  covers whole verses. No change needed to `mix.js`'s storage
  (`paintRange`/`getRuns` stay word-indexed) — this is a UI-level constraint,
  keeping the persisted-mix format unchanged.
- The loop picker (`assets/js/karaoke-controls-panel.js`) needs no structural
  change — it already calls `loopRangeForCanonicalIndices`, which returns
  flourish/filler-inclusive bounds automatically once the above lands.

**Open question:** the interior-flourish-vs-boundary-filler heuristic (same
verse on both sides = flourish, otherwise attach forward) was only checked
conceptually and against one real example (a chapter heading in `1 John 1`
with `verse: null` before verse 1) — spot-check it against a few more real
manifest recordings that actually contain mid-verse ad-libs before relying on
it for playback timing.

**Relevant files:** `assets/js/library.js` (new `verseAudioBounds`),
`assets/js/program-builder.js` (`buildProgram`, segment `inTime`/`outTime`,
new `block.verseBounds`), `assets/js/karaoke-controls.js`
(`loopRangeForCanonicalIndices`, new `programVerseStops`),
`assets/js/playback-engine.js` (new `skipToNextVerse`/`skipToPreviousVerse`),
`assets/js/player-controls.js` (button wiring + status label),
`assets/js/sleep-mode.js` (media-session handlers), `assets/js/mix-editor.js`
(drag/tap snapping). Tests: `tests/library.*.test.mjs`,
`tests/program-builder.fallback.test.mjs`,
`tests/program-builder.paint-id.test.mjs`, `tests/karaoke-controls.test.mjs`,
`tests/playback-engine.test.mjs`, `tests/mix-editor.test.mjs`.

---

## 14. [ ] Usability review: streamline the study UI

**Goal:** Reduce on-screen clutter so the default view foregrounds
studying/memorizing scripture, not tweaking settings. Move
advanced/rarely-used controls behind expandable disclosure, and hide
controls that are irrelevant in the current context (e.g. don't show
Name-that-Passage options while Karaoke Mode is what's about to run, or
vice versa).

**Current state (verified against code):** `index.html` is one page —
after the one-time library-load gate (`#gatePanel`, lines 44-69),
`#appPanel` (lines 71-308) reveals everything at once:
- Playlist manager (lines 72-88) — always visible, not collapsible.
- Offline/Downloads (`<details id="offlinePanel">`, lines 90-110) —
  collapsed by default.
- Chapter/verse selection tree (`<details id="selectionPanel" open>`,
  lines 135-147) — **open by default**.
- "Study" section (lines 149-235) — a plain, non-collapsible
  `<section>` containing: style select + "Customize Genre Mix" toggle
  (149-160, mix editor via `mix-editor.js`), text-size slider
  (162-167), a 5-control "Karaoke Mode" cluster (hint level, ramp,
  length-matched, duck-vocals, scored + input method; 169-201), a
  separate "Name that Passage" cluster (help slider + input select;
  203-217), action buttons (219-223), and Review Mode controls
  (224-231) — Karaoke Mode and Name-that-Passage options are both shown
  simultaneously even though a user only starts one mode at a time.
- "Karaoke Controls" (`<details id="karaokeControlsPanel">`, lines
  237-307) — collapsed by default; expands to ~10 more controls (pitch,
  rate, key-lock, count-in, reverb, track balance sliders, A/B loop
  picker).

So progressive disclosure exists but is inconsistent (3 of ~6 panels use
`<details>`; the "Study" section itself does not), and song/passage
selection plus all study-mode tuning controls live on one screen with no
separation between "choose a song" and "choose what to study." No
wizard/tabs/basic-vs-advanced labeling exists anywhere in the current UI.

**Open question:** which entry-flow direction to take — this has not
been decided and should be resolved with the user before implementing.
Candidates raised so far:
1. Keep the current song-first flow, but consistently apply progressive
   disclosure (convert the "Study" section to collapsible/expandable
   pieces like the other panels already do) and hide clusters irrelevant
   to whichever mode is about to run.
2. A wizard-like multi-step flow (one decision per screen instead of
   everything at once).
3. Invert the flow entirely: ask what the user wants to study first,
   then offer only the songs/passages that cover it, rather than
   picking a song first and configuring study options after.
Option 3 is the most aligned with "focus on studying, not settings" but
is also the biggest structural change (song/passage selection and
playlist logic are currently independent of "what to study"); start the
conversation with the user from these three framings rather than
re-deriving them.

**Relevant files:** `index.html` (panel structure/layout), `assets/js/
main.js` (fallback/status rendering tied into the same screen),
`assets/js/mix-editor.js`, `assets/js/karaoke-controls-panel.js`,
`assets/js/karaoke-controls.js`, `assets/js/player-controls.js`.

---

## 15. [ ] Investigate excessive "song/audio not available" warnings

**Goal:** Figure out why the UI shows so many warnings claiming
songs/audio aren't available, and fix the root cause — either soften/
accept the warning if the underlying data really is incomplete, or fix
the matching logic if it's a false positive.

**Current state (verified against code):** The warning is generated by
`renderFallbackNote()` (`assets/js/main.js:393-405`), which writes into
`<p id="fallbackNote">` (`index.html:232`), joining one phrase per
fallback entry — either `"{label} (using {style} instead)"` or, worst
case, `"{label} (no audio available anywhere)"`. It's called from
`main.js:1168` and `main.js:1326`, fed by `program.fallbacks` from
`buildProgram()` (`assets/js/program-builder.js:75-163`).

Critically, **this is not a file-existence/404 check**. For each
canonical (scripture) word, `buildProgram` calls `alignWordsToCanonical`
(`assets/js/library.js:133-146`), which matches by `(verse,
position-within-verse)` and returns `null` — reason `"alignment-gap"` —
whenever a style's recording has fewer transcribed words in a verse than
the canonical reference recording (per its own doc comment,
`program-builder.js:24-34`). That can happen from ASR mishearings,
ad-libs, or repeated lines in either recording, even when the actual
audio file is completely fine. The canonical reference recording itself
is chosen by `canonicalWords()` (`library.js:106-117`), which picks
whichever recording has the most verse-tagged words — if that pick
happens to be an unusually verbose/ad-libbed take, it would manufacture
widespread spurious gaps across every other style. Granularity is per
contiguous word/verse-range per section (not per whole song), so several
small gaps across several selected sections is what produces "so very
many warnings" on screen at once.

**Open question:** is this heuristic producing false positives at scale,
or are the manifest recordings genuinely incomplete for many
verses/styles? Needs spot-checking against real manifest data (start
with whichever section/style the user sees the most warnings on) before
deciding whether this is a data problem (re-transcribe/re-align source
recordings) or a matching-logic bug (fix `alignWordsToCanonical` and/or
how the reference recording is chosen).

**Relevant files:** `assets/js/main.js` (`renderFallbackNote`),
`assets/js/program-builder.js` (`buildProgram`, fallback/
unavailable-range logic), `assets/js/library.js`
(`alignWordsToCanonical`, `canonicalWords`, `pickRecording`).

---

## 16. [ ] Let the user download the now-playing song as a mastered MP3; add a manifest opt-out

**Goal:** Add a "download" option for the currently playing song that
saves audio to the user's device — a real file download, not just the
in-app offline cache. Two forms are both wanted:
1. When the pristine pre-separation source `.mp3` for the relevant
   recording(s) is still available, offer it directly (already properly
   mastered, likely already carries real ID3 tags/artwork, no
   client-side re-encode needed).
2. Otherwise — or when genre-mixing means what's playing is spliced from
   multiple recordings/takes — dynamically render a single **mastered
   MP3** of the actual assembled/mixed playback (same instrumental+vocal
   blend, track balance, and mastering chain used live).
Either way, the MP3 must carry correct ID3 tags (title/artist/album,
etc.) and embedded cover art, sourced from metadata carried in the
manifest, itself populated from the original source files' own
tags/artwork at manifest-build time. Also add a manifest field so a
specific recording (or style/section) can be marked non-downloadable —
every recording today happens to be freely downloadable, but that won't
necessarily stay true once recordings with tighter licensing are added,
so the manifest needs a way to say "cache/stream this for playback, but
don't let the user save a copy" (this should gate both download forms).

**Decided (confirmed with the user):** both a direct source-file download
(when the source is still on disk) and a dynamically-rendered mastered
MP3 (when it isn't, or when a splice makes a single source file not
apply) are in scope — not an either/or choice. ID3 metadata and cover art
must round-trip from the original source audio through the manifest into
whichever form is downloaded.

**Done so far:** the metadata/cover-art half of that round-trip is now
implemented. `scripts/build_manifest.py` reads title, artist, album,
genre, a style-description (its ID3 comment), and cover art off each
recording's *original* Suno-generated mp3 and writes them next to that
recording's own audio files (`extract_suno_metadata`, `--suno-downloads-dir`,
new `COVER_ART_EXT_BY_MIME`/`extract_suno_metadata` near
`build_audio_url`) — **not** inlined into the manifest itself. The missing
piece was where a tagged copy could still be found at all, since
`separate_stems.py` deletes `rec.mp3` right after separating it (confirmed:
0 pre-separation mp3s remain anywhere under `PBE_2026_2027/` today) — the
fix was realizing every one of those files originated as a download from
the sibling **Suno Automater** project (`../Suno Automater`, i.e.
`Documents/Code/Suno Automater/`), which already writes full ID3 tags
(title/artist/album/genre/comment/lyrics) and embedded cover art via
`node-id3` at download time (`src/downloadSong.ts`'s
`buildId3Tags`/`downloadSong` there), and keeps those files in its own
`downloads/` folder under the *exact same base filename* used throughout
the PBE pipeline (verified directly: e.g.
`Suno Automater/downloads/1 John 1 (NKJV) (24).mp3` matches
`PBE_2026_2027/.../1 John 1 (NKJV) (24).instrumental.m4a` — the pipeline's
"take" number, `take_number()`, even turns out to be the same disambiguation
suffix Suno Automater's own downloader appends for duplicate titles). So
`build_manifest.py` now matches each recording to that folder by base
name, reads its tags via `mutagen` (`scripts/requirements.txt`, installed
into a local `.venv/`, gitignored), and writes two small sidecar files next
to that recording's own audio (skipped if already present, same as every
other pipeline artifact): the text tags as `<style_dir>/<base>.tags.json`
and any embedded cover art as `<style_dir>/<base>.cover.<ext>` — adding
`tagsUrl`/`coverUrl` pointers (the existing `build_audio_url` helper) to
the recording instead of the text fields themselves, so the manifest stays
just an index and this data lives the same place instrumentalUrl/vocalUrl
already point at (see the "manifest is too large" fix elsewhere in this
file, which did the same for `words`). Manifest schema documented in
`library-format.html` (new `tagsUrl`/`coverUrl` rows under the
`recordings[]` table). Run against the real local library: **1061/1061
recordings matched** a Suno Automater download and got tagged (1033 of
those also had embedded cover art; the rest have text tags only). All of
this degrades gracefully — missing `mutagen`, a missing
`--suno-downloads-dir`, or an unmatched/untagged file just skip that
recording's metadata rather than failing the build.

This does **not** yet cover: (a) exposing the *original full-mix audio*
itself as a downloadable source file (today only its tags/art are pulled
in — the audio bytes in Suno Automater's `downloads/` folder are never
copied/hosted anywhere the deployed app could reach), (b) the
dynamically-rendered mastered-MP3 path, or (c) the "downloadable" opt-out
flag. See the still-open items below.

**Current state (verified against code):** There is already a download
feature, but it's a different thing — "Download for offline" caches a
playlist's audio blocks into the browser's Cache Storage
(`assets/js/offline/audio-cache.js`, `downloadBlocksForOffline`,
lines 182-222) so the app can play without a network connection; it does
not save a file the user can access outside the app, and it doesn't
touch mastering/encoding at all. It's wired to
`#offlineDownloadPlaylistBtn` (`index.html`, inside the `#offlinePanel`
`<details>`) via `assets/js/main.js:831-853`. There is no "save this file
to disk" affordance anywhere in the UI.

This app is a static site with no build step and no server component —
`package.json`'s own description says it "ships as plain HTML/CSS/JS,"
and its only dependency is a test-runner helper (`jsdom`). So the whole
render → master → MP3-encode → tag pipeline has to run client-side in
the browser; there's nothing to send the audio to. No MP3 encoder and no
ID3-tag-writing code exists anywhere in the repo today (checked — no
`lamejs`, no ID3 read/write, nothing under `assets/js/vendor/` for
either). The real-time "mastering" chain that already exists for live
playback is `masterGain → limiter AudioWorkletNode → destination`,
built in `createMasterBus` (`assets/js/playback-engine.js:89-96`) using
`audio/limiter-processor.js`/`audio/limiter-math.js`, wired against a
live `AudioContext` (`playback-engine.js:430-464`) — producing an offline
bounce with the same processing means either reusing this graph-building
logic against an `OfflineAudioContext` instead, or refactoring it to
accept either context type.

The manifest schema (`library-format.html:163-229`) has (as of "Done so
far" above) `tagsUrl`/`coverUrl` alongside the original `style`, `take`,
`instrumentalUrl`, `vocalUrl`, and `wordsUrl`, but still **no
permission/rights field** — every recording is still implicitly "freely
downloadable," there's just no way yet to mark an exception.

The pre-separation source `.mp3` the user originally asked about is
confirmed to exist only as a transient pipeline artifact:
`scripts/separate_stems.py` writes each recording's `instrumentalUrl`/
`vocalUrl` `.m4a` pair from a single source `rec.mp3`, then **deletes
that source file once separation succeeds**, specifically "to avoid
~doubling the library's storage" (`scripts/separate_stems.py:12`, delete
at line 146, function doc at 109-112) — confirmed 0 such files remain
anywhere under `PBE_2026_2027/` today. `scripts/correct_lyrics.py:233-239`'s
`display_name` doc comment independently confirms which physical files
exist for a given recording varies over its lifetime — "a not-yet-separated
.mp3, a stem pair, or ... neither." A *tagged copy* of that same audio
does durably survive elsewhere though — see "Done so far" above — even
though the raw pipeline copy itself is always gone by the time
`build_manifest.py` runs.

**Open questions:**
- How should the app actually get *a downloadable copy of the original
  full-mix audio* itself, not just its tags? The Suno Automater
  `downloads/` folder is a private, local, unhosted directory — nothing
  today uploads/hosts those mp3s anywhere the deployed app (Drive/
  OneDrive/local-folder library sources) could reach them. Options: teach
  `build_manifest.py` to add a `sourceUrl` (via the existing
  `build_audio_url` helper, same as `instrumentalUrl`/`vocalUrl`) once
  those files are copied/hosted alongside the stems, or decide this path
  isn't worth it and lean entirely on the dynamically-rendered mastered
  MP3 instead. Note the earlier "most recordings won't have a surviving
  source mp3" concern turned out to be about `PBE_2026_2027/`'s own
  (deleted) copy specifically — the Suno Automater `downloads/` folder
  still had every one of them (1061/1061) — so this is really a hosting
  question now, not a data-availability one, *as long as that downloads
  folder itself is never cleared out*.
- In-browser MP3 encoding of a multi-minute program could be slow —
  does this need a progress indicator (`downloadBlocksForOffline` already
  has a precedent for progress callbacks) and/or a Web Worker so it
  doesn't block the UI thread?
- Confirm whether the new "downloadable" opt-out flag should live
  per-recording, per-style, or per-section.

**Relevant files:** `scripts/build_manifest.py` (done: `extract_suno_metadata`,
`--suno-downloads-dir`/`--no-suno-metadata`, `COVER_ART_EXT_BY_MIME`, wired
into `main()`'s per-recording loop and its summary print), `scripts/
requirements.txt` (done: added `mutagen`), `library-format.html` (done:
schema doc for `tagsUrl`/`coverUrl`), `../Suno Automater/src/downloadSong.ts` (reference — where
those tags/art originally get written, `buildId3Tags`). Still to do:
`assets/js/playback-engine.js` (`createMasterBus` and the live audio
graph, lines 89-96 and 430-464 — needs an `OfflineAudioContext`-compatible
path for the mastered-render option), `assets/js/audio/
limiter-processor.js` / `limiter-math.js` (mastering chain to reuse),
`assets/js/vendor/` (would gain a vendored MP3 encoder and ID3 writer,
following the same vendoring pattern used for SoundTouchJS — see the
"Replace hand-rolled granular pitch shift with vendored SoundTouchJS"
commit), `assets/js/offline/audio-cache.js` and `assets/js/main.js:
799-816` (existing download UX/progress pattern to model the new button
after).

---

Google Drive and OneDrive folder-link sources are done; Dropbox was
considered and deliberately dropped (Dropbox retired indefinite access
tokens in 2021, has no origin-restriction mechanism for credentials the way
Google's API key does, and per-Pathfinder OAuth would just duplicate the
OneDrive login step) — not worth the added surface for a third source.
