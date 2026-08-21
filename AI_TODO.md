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

## 1. [ ] Improve the alternate-takes UI (both the default style and the custom genre mix)

**Goal:** the existing take-selection controls work (see AI_TODO.md's prior
"Create interface to allow access to alternate takes" item, now done and
removed from this file) but are rough -- make them genuinely pleasant to
use, not just functional. No specific redesign has been decided yet; this
item is scoped as "go improve this," not "implement design X."

**Current state (verified against code):**
- Main style selector (`index.html`'s `#defaultTakeRow`, wired in
  `main.js`): a single binary checkbox, "Prefer alternate take (where one
  exists)," next to the default style `<select>`. It only ever toggles
  `mix.defaultTakeRank` between `0` and `1` (`setDefaultTakeRank` in
  `mix.js`) -- there's no way to reach a 3rd+ take from here at all, even
  for a style/passage combo that has one.
- Mix editor (`assets/js/mix-editor.js`'s `renderTakeControls()`, per
  section): one control per (section, style-actually-painted) pair, shown
  under that section's heading -- a checkbox ("`<style>`: alternate take")
  for the common 2-take case, or a `<select>` ("Take 1"/"Take 2"/...) for
  3+. This part already scopes correctly per section (confirmed -- each
  section's `<details>` gets its own `renderTakeControls()` call, so two
  sections using the same style don't share or collide on one control).
- Neither surface gives the Pathfinder any way to tell takes apart before
  picking one -- no duration, no preview, no label beyond an arbitrary
  ordinal ("Take 2"). They're differentiated only by whatever recording
  happened to sort into that position (`listTakes()` in `library.js`).
- The two surfaces use different interaction models for the same concept:
  the main selector is a single blanket on/off toggle; the mix editor is a
  per-section-and-style control that's a checkbox in some cases and a
  dropdown in others depending on take count. A Pathfinder using both has
  to learn two different mental models for "which take."

**Decided (confirmed with the user):**
- **Core redesign: treat each take as its own paintable style**, not a
  separate take-selector control layered on top of style painting. Since
  most style/passage combos only ever have two takes, the Pathfinder's
  mental model should be "paint Take 1 vs Take 2 the same way you paint
  Country vs Pop" rather than learning a second, parallel UI (today's
  checkbox-or-dropdown `takeOverrides`) just for take choice. This is a
  bigger change than it sounds: it folds take selection into the existing
  style-painting model instead of keeping it as a separate axis
  (`mix.defaultTakeRank`/`mix.takeOverrides`), so it needs real scoping
  before implementation -- e.g. the style palette (today one entry per
  manifest style) would need take-variant entries exposed alongside each
  style wherever more than one take exists, and `mix.sections`' per-word
  style-id array (or a replacement of it) would need to encode take
  alongside style. Whoever picks this up should design the concrete data-
  model change (probably via a fresh look at `mix.js`'s `createMix`/
  `paintRange`/`getRuns` and `mix-editor.js`'s style palette rendering)
  rather than bolting this onto the existing take-rank fields.
- **Also include**, regardless of how the above lands: an audio preview so
  a Pathfinder can hear a take before picking it (rather than choosing
  blind based on an arbitrary ordinal); a clearer visual indicator of which
  take is currently in effect for a given section/style; and take count
  surfaced in the main style selector's `<option>` text so a Pathfinder
  knows before drilling in whether a style has alternates worth exploring.
- Explicitly **not** pursuing a "keep the current checkbox/dropdown model
  but make it always a dropdown" fix -- the take-as-style-variant redesign
  above supersedes that direction.

**Relevant files:** `index.html`'s `#defaultTakeRow`/`#styleSelect`,
`assets/js/main.js` (the checkbox's wiring, `renderStyleOptions`),
`assets/js/mix-editor.js`'s `renderTakeControls()`, `assets/js/mix.js`
(`getTakeRank`/`setTakeRank`/`setDefaultTakeRank`), `assets/css/styles.css`
(`.mix-take-control` and friends).

---

## 3. [ ] Sleep Mode: typing-effect word reveal, two-line dim/active display, drop line-nav buttons

**Goal:** redesign Sleep Mode's word display so that: (a) words appear with
a typing effect as they're sung, rather than snapping in whole; (b) only
two lines are ever on screen -- the line just finished, dimmed to 50%
opacity, and the current line being typed at full opacity; (c) once a third
line would appear, the oldest (now off-screen) line is dropped, so it's
always exactly these two; (d) the Previous line/Next line buttons are
removed; (e) the reference for whatever is currently being typed is always
shown above the two lines.

**Current state (verified against code):** Sleep Mode's word display isn't
its own implementation -- it reuses `mountUnscored()` /
`createPassageView()` (`assets/js/study-modes/unscored.js`,
`assets/js/study-modes/word-stream.js`), the same shared windowed karaoke
renderer used by every other engine-driven study mode (Karaoke Mode,
disappearing-word, invisible-word, blackout-ramp, sing-along). Specifics:
- Word reveal today (`unscored.js`'s `setOnPastWord`) is instantaneous -- a
  blanked word's full text is swapped in the moment it's marked "past"
  (sung). There's no letter-by-letter/typing animation anywhere in the
  codebase to build on.
- The windowing (`word-stream.js`'s `showWindow`) currently shows the
  *current* line plus a dimmed preview of the *next* (upcoming,
  not-yet-sung) line -- `.current-line`/`.next-line` in `styles.css`. The
  requested behavior is the mirror of this: the *previous* (just-finished)
  line dimmed to 50%, and the *current* line being typed at full opacity --
  no forward preview.
- `heading.textContent = passageLabel(section)` (`word-stream.js:281`)
  already renders the reference above the two-line window on every section
  change, so part (e) may already be satisfied -- confirm it updates
  correctly across every block/section transition Sleep Mode hits
  (including with shuffle on) before assuming there's nothing to do there.
- The Previous/Next line nav buttons (`.karaoke-line-nav`, `prevBtn`/
  `nextBtn` in `word-stream.js`) are built unconditionally by
  `createPassageView` for every mode that uses it, Sleep Mode included --
  there's currently no option to suppress them for just one caller.

**Decided (confirmed with the user):**
- Build this as new options on the existing shared view
  (`createPassageView`/`mountUnscored` -- e.g. a "typing" render style plus
  a `hideNav` flag) rather than forking a separate Sleep-Mode-only
  renderer, since it reuses the already-working word-to-time mapping,
  click-to-seek, filler text, and section-change handling.
- Typing speed/cadence is driven by each word's actual sung timing
  (spreading its letters across its known start/end from the transcript),
  not a fixed type-speed constant -- keeps the typing locked to the audio.
- Click-to-seek on individual words stays working in Sleep Mode's display,
  same as every other study mode, even with the line-nav buttons gone.

**Relevant files:** `assets/js/sleep-mode.js` (`mountSleepMode`, where
`PLAIN_KARAOKE_OPTIONS` and `mountUnscored` are wired up),
`assets/js/study-modes/unscored.js` (`mountUnscored`,
`setOnPastWord`/`setRenderWord`), `assets/js/study-modes/word-stream.js`
(`createPassageView`, `showWindow`, `buildLineElement`, the nav buttons),
`assets/css/styles.css` (`.karaoke-line-group`, `.current-line`,
`.next-line`, `.karaoke-line-nav` and friends).

---

## 4. [ ] Add an expandable "Karaoke Controls" section (pitch + speed, library-level and song-level)

**Goal:** add a new expandable "Karaoke Controls" section (following the
existing `<details class="panel">`/`<summary class="panel-summary">`
pattern already used for `#selectionPanel` in `index.html`) that lets a
Pathfinder change the music's pitch and speed, plus four related controls
decided below. Settings resolve through three tiers: an app-wide default,
an optional per-playlist override on top of it, and a per-song (per-section)
override on top of that -- see "Decided" below for the exact fallback
order and what "song" means here.

**Current state (verified against code):**
- Playback runs entirely through plain `<audio>` elements (`makeSource()`
  in `playback-engine.js`) -- no `playbackRate` or `preservesPitch` usage
  exists anywhere in `assets/js/` today, confirmed by search. Native
  HTMLMediaElement gives tempo change for free via `.playbackRate`, and
  `preservesPitch` (supported in current Chrome/Firefox/Safari) can hold
  pitch constant while speed changes -- but there's no native way to shift
  *pitch alone* while keeping tempo fixed (a true "key change"). That would
  need Web Audio API routing through a pitch-shifting node/library (e.g. a
  SoundTouch-based AudioWorklet) instead of the current plain-audio-element
  pipeline -- a materially bigger change than wiring up a slider, and worth
  scoping deliberately rather than assuming it's cheap.
- Every block plays through a synced instrumental+vocal *pair* (`slots`,
  `makeSource()`) -- any rate/pitch change has to be applied to both
  elements of a pair identically, and shouldn't fight the existing
  `resyncIfDrifted()` stem-drift guard.
- A "library-level default + song-level override" pattern already exists
  and is the natural template to follow: take selection's
  `mix.defaultTakeRank` (global) plus `mix.takeOverrides[sectionKey][styleId]`
  (per-song), read together via the `mix.takeOverrides?.[sectionKeyStr]?.[styleId]
  ?? mix.defaultTakeRank ?? 0` fallback chain in `getTakeRank()`
  (`mix.js:23-24`). "Song" in this app maps to a *section* (a
  passage/chapter, which can itself span multiple styles/takes via
  Customize Genre Mix), not a single recording -- so a per-section override
  keyed like `mix.takeOverrides` is likely the right granularity, not
  per-recording. By contrast, `playlist.studyOptions`
  (`defaultStudyOptions()` in `playlists.js`) is playlist-wide only with no
  per-section override today -- a weaker precedent for this specific ask.
- The shared transport bar (`mountPlayerControls` in `player-controls.js`)
  is used by every study mode and Sleep Mode -- worth deciding up front
  whether the new controls live near it (global to any mode) or are scoped
  into specific study-mode setup panels only.

**Decided (confirmed with the user):**
- **Pitch scope:** true independent pitch-shift (key change with tempo held
  constant), not just speed-with-pitch-preserved. This means routing
  playback through Web Audio + a pitch-shifting node/library (e.g. a
  SoundTouch-based AudioWorklet) rather than relying solely on
  HTMLMediaElement's native `playbackRate`/`preservesPitch` -- budget for
  this as a real audio-pipeline change, not a slider hookup.
- **Song-level granularity:** one override per *section* (a whole
  passage/chapter), matching `mix.takeOverrides[sectionKey]` -- not
  finer-grained per style-run within a section.
- **Library-level scope (three tiers, not two):** the setting resolves
  through an app-wide default, an optional per-playlist override on top of
  it, and the per-section override on top of that. The Pathfinder picks the
  app-wide default day-to-day; adjusting it while a specific playlist is
  open offers a "save for this playlist only" option that creates the
  playlist-level override, same general shape as `mix`'s
  default-then-override chain but with one more tier. Fallback order when
  resolving an effective value: section override ?? playlist override ??
  app-wide default.
- **Sleep Mode inherits these settings** (ties back to item 3 above) --
  Sleep Mode uses whatever pitch/speed is in effect for the
  playlist/section it's playing, rather than always forcing normal
  pitch/speed.
- **Additional controls: build all four**, alongside pitch and speed:
  - **Key-lock / preserve-pitch toggle** -- with true pitch-shift already
    in scope, this becomes "lock pitch while I change speed" (or vice
    versa) rather than relying on `preservesPitch` alone.
  - **Count-in / lead-in** -- a few seconds of instrumental-only before
    lyrics/vocals start; no pre-roll concept exists anywhere in the engine
    today, so this needs new support in `playback-engine.js`, not just UI.
  - **A/B loop / section repeat** -- loop just the currently-playing block,
    or a chosen line range, for drilling one hard passage repeatedly.
    Distinct from Sleep Mode's whole-program loop (`sleep-mode.js`'s
    `offEnded`/`loadAndPlay`), which restarts the whole selection, not one
    passage.
  - **Reverb/echo** -- must also work in Scored mode
    (`assets/js/study-modes/sing-along.js`'s `mountSingAlong`), not just
    plain/unscored karaoke playback -- both already share
    `createPassageView`, so this is a playback-engine-level effect rather
    than something scoped to one study mode's renderer.
- Instrumental/vocal balance ("turn vocals down/off") is already tracked
  separately as item 2 above (Sleep Mode's planned volume sliders). If this
  Karaoke Controls section gets built, item 2's sliders probably belong
  inside it rather than as Sleep-Mode-only UI -- reconcile the two when
  either is implemented, rather than building both independently.

**Relevant files:** `index.html` (`#selectionPanel` for the `<details>`
pattern to follow, and wherever the new section should be inserted),
`assets/js/playback-engine.js` (`makeSource()`, `slots` -- where
`playbackRate`/pitch would need to be threaded through both elements of a
pair), `assets/js/mix.js` (`getTakeRank`/`setTakeRank`/
`setDefaultTakeRank` -- the default+override pattern to mirror),
`assets/js/player-controls.js` (if controls should live in the shared
transport bar), `assets/js/playlists.js` (`defaultStudyOptions()`, if this
ends up playlist-scoped instead of mix-scoped).

---

## 6. [ ] "Name that passage" -- audio-sample reference-recall mode

**Goal:** add a study mode that plays a sung sample from a section and
quizzes the Pathfinder on *which passage that is* (the reference), rather
than testing the passage's text. Deliberately audio/karaoke-first, not a
plain-text flashcard -- the user already has other tools for text-based
reference recall outside this app, so this needs to stay within the
karaoke/playback theme to earn its place here. PBE competition scoring
includes reference recall, not just word-for-word text, and no existing
mode tests this.

**Current state (verified against code):**
- Every existing study mode (unscored/Karaoke Mode, Type-Ahead,
  Sing-Along) drills the passage's *words* only. References appear purely
  as passive display -- `passageLabel(section)` in the heading, `verse-num`
  superscripts inline per verse (`word-stream.js`) -- never the thing being
  tested. `library.js`'s `passageLabel(section)` already formats the
  reference string this mode would quiz against.
- The dual voice-or-typed input pattern this mode should reuse already
  exists for Scored mode: `main.js`'s `scoredInputSelect` picks between
  `"typeahead"` (→ `mountTypeAhead`, typed input) and `"singalong"` (→
  `mountSingAlong`, Web Speech API mic input via `isSingAlongSupported()`),
  defaulting to whichever the browser supports (`main.js:691`). It's an
  either/or selection today, not simultaneous -- this mode should offer
  the same choice mechanism for submitting a reference guess.
- Karaoke Mode's existing blank-percent slider (`unscored.js`,
  `getOptions().blankFraction`) is the precedent for a difficulty control
  the Pathfinder adjusts per attempt -- this mode's "how much help" control
  (words shown/hidden, vocals on/off) should follow the same pattern rather
  than being a fixed on/off setting.
- Every recording already plays as a synced instrumental+vocal *pair*
  (`playback-engine.js`'s `makeSource()`), and the engine already supports
  muting/scaling each track independently (`setVolume`, the duck-predicate
  machinery) -- an "instrumental-only, no words" hard-mode sample is a
  direct application of mechanisms that already exist, not new engine
  capability. (Also ties to item 2's planned instrumental/vocal sliders --
  worth building on the same underlying per-track volume control rather
  than a separate one-off for this mode.)

**Decided (confirmed with the user):**
- **Primary direction only: sample → guess the reference.** Play an audio
  sample from a section, Pathfinder identifies which passage it is. The
  reverse (show the reference, Pathfinder sings/produces the passage
  karaoke-style) is a stretch-goal/open exploration only, not required --
  the user isn't sure there's a clean karaoke-style way to do that
  direction, so don't block this item on solving it.
- **Answer input:** accepts both voice and typed, matching Scored mode's
  existing `scoredInputSelect` pattern (`mountTypeAhead`/`mountSingAlong`)
  -- reuse that choice mechanism rather than inventing a new one.
- **Sample difficulty is configurable per attempt**, mirroring Karaoke
  Mode's blank-percent slider: a control lets the Pathfinder choose how
  much help they get each time -- ranging from full audio with karaoke
  words shown (easy) down to instrumental-only with no on-screen words
  (hardest, pure melody-based recognition) -- rather than one fixed
  difficulty.

**Decided (confirmed with the user):**
- **Sample:** a short clip from a random point within a randomly-picked
  section -- not the whole section from its start. Closer to real "name
  that tune" difficulty, forcing recognition from a snippet rather than
  the full passage.
- **Answer strictness:** book + chapter is close enough to count as
  correct -- an exact verse-range match isn't required. Getting the
  specific verse boundaries right is treated as less important than
  knowing roughly where the passage lives.

**Open question (implementation-level, not yet resolved):**
- What tolerance does the free-text/voice answer matching need for
  reference-format variation ("John 3:16" vs "3:16" vs spoken-out-loud
  forms like "John chapter three")? A matching-strictness decision (book +
  chapter, above) still needs a text-normalization approach to actually
  compare a Pathfinder's answer against it.

**Relevant files:** `assets/js/study-modes/` (a new file alongside
`unscored.js`/`type-ahead.js`/`sing-along.js`), `assets/js/library.js`
(`passageLabel`, `orderedSections`, `findSection`), `assets/js/
playback-engine.js` (`makeSource()`, per-track volume -- for the
instrumental-only hard mode), `assets/js/main.js` (`scoredInputSelect`,
the pattern to mirror for voice-vs-typed input), `assets/js/
study-modes/unscored.js` (`blankFraction`, the difficulty-slider pattern
to mirror).

---

## 7. [ ] Offline / PWA support

**Goal:** add a service worker + manifest.json so a playlist whose audio
has already been fetched keeps working without a network connection --
useful for Sleep Mode running overnight, or a club meeting with unreliable
wifi.

**Current state (verified against code):** No `manifest.json`, no service
worker, and no `navigator.serviceWorker` reference anywhere in the repo
(confirmed by search) -- this is entirely new infrastructure, not an
extension of something partial.
- The content-gating model (`gate.js`) is network-dependent by design: the
  library manifest is "always re-fetched, never cached" (the gate's own
  comment) from a URL outside this repo, and every recording's audio is
  fetched from wherever the manifest points (also external, not bundled).
  True offline support needs to cache both the manifest response and the
  specific audio files a Pathfinder's playlists actually reference, not
  just this app's own static assets.
- Content is explicitly *not* shipped in this repo (see AGENTS.md/gate.js)
  -- the manifest and audio are hosted separately and privately, so a
  service worker here can only cache what it observes being fetched at
  runtime, not pre-cache anything at install time.

**Decided (confirmed with the user):**
- **Both caching modes, not one or the other:** a size-capped opportunistic
  cache (whatever's played during normal use stays available offline, up
  to a storage limit) *and* an explicit "download this playlist for
  offline" action for a deliberate, complete download. Both need their own
  "clear this cache" action and a way to see how much space each is
  currently using -- this is real storage-management UI, not just a
  background service worker.
- **Remember the manifest across reloads no matter how it was loaded** --
  URL, pasted, or uploaded-file alike. This changes `gate.js`'s current
  behavior beyond just this item's scope: today the uploaded-file path is
  explicitly *not* remembered (`gate.js`'s own comment), and even the
  URL-based manifest is "always re-fetched, never cached." Making the
  manifest itself persist/cache is a prerequisite for offline support to
  work for every load path, not an optional nice-to-have -- implementing
  this item means revisiting that "always re-fetched" design decision in
  `gate.js` directly, not just adding a service worker alongside it.
- Every recording is a stem *pair* (instrumental + vocal, see AGENTS.md) --
  both need caching together per block in either caching mode, or a
  partially-cached pair breaks playback.

**Relevant files:** `assets/js/gate.js` (`fetchManifest`, the "always
re-fetched" comment, `manifestUrl` persistence), `assets/js/
playback-engine.js` (`makeSource()`, where `instrumentalUrl`/`vocalUrl`
get fetched), a new `manifest.json` + service-worker registration (no
existing file to extend), `AGENTS.md` (confirms the private-hosting/
no-bundled-content model this has to work around).

---

## 8. [ ] Cross-passage review/drill mode

**Goal:** once a Pathfinder has studied more than one passage, offer a mode
that drills a shuffled mix across everything they've selected/studied (not
just one playlist's passages in the order chosen), for long-term retention
review.

**Current state (verified against code):**
- `program-builder.js`'s `buildProgram(manifest, mix, selectedKeys,
  verseFilter)` already builds a playable program from an arbitrary set of
  section keys plus a mix -- it isn't restricted to one playlist's own
  selection, so the underlying "play any set of sections" mechanism already
  exists.
- Today every playlist is a self-contained unit -- its own
  `selectedSectionKeys`, `mix`, `studyOptions` (`playlists.js`) -- there's
  no existing concept of pulling sections from more than one playlist into
  one study session, and no notion of "sections I've studied before" to
  draw a review set from (this ties directly to item 5's practice-history
  data, if that gets built).
- `shuffleBySection` (`program-builder.js`) already exists and is reused by
  Sleep Mode's shuffle toggle -- the same shuffling mechanism would likely
  apply here.

**Decided (confirmed with the user):**
- **Let the Pathfinder choose the review-set source** rather than
  hard-coding one -- offer both "every section across all playlists" and
  "only sections with a logged practice history" (depends on item 5) as
  options in this mode's own setup UI, not a single fixed behavior.
- A section pulled in from outside the currently-active playlist uses
  *that section's own playlist's mix* -- respects whatever genre-mix
  customization the Pathfinder already did for it, rather than flattening
  everything to the active playlist's default style.
- This reuses the existing Karaoke Mode renderer, just pointed at a
  cross-playlist program -- not a new standalone mode with its own UI.

**Relevant files:** `assets/js/program-builder.js` (`buildProgram`,
`shuffleBySection`), `assets/js/playlists.js` (playlist record shape --
would need a way to enumerate sections across all playlists),
`assets/js/selection.js`.

---

## 9. [ ] Font-size control for the karaoke display

**Goal:** let a Pathfinder increase/decrease the text size of the karaoke
word display -- useful for a phone propped up across a room in Sleep Mode,
or general readability preference.

**Current state (verified against code):**
- `.karaoke-word`/`.karaoke-line`/`.karaoke-heading` and friends in
  `styles.css` use fixed `rem` font-size values with no CSS custom property
  backing them -- confirmed no font-size-related custom property exists at
  `:root` today, so there's nothing to just multiply; sizes would need to
  be re-expressed relative to a new scale variable first.
- No existing settings surface holds a persisted "text size" preference --
  would need a new field, likely in `storage.js`'s top-level state (an
  app-wide preference, since it's about the device/viewing conditions
  rather than the passage) or alongside `studyOptions` if scoped
  per-playlist instead.

**Decided (confirmed with the user):**
- **Per-mode, not app-wide** -- each mode (regular Study panel vs. Sleep
  Mode) gets its own text-size setting, since viewing conditions differ
  (a phone held close during active study vs. propped up across a dark
  room overnight). This means a separate persisted value per mode, not one
  shared app-wide number.
- **A continuous slider**, not a fixed Small/Medium/Large set -- needs
  testing across the range to make sure text still fits its container well
  at both extremes.

**Relevant files:** `assets/css/styles.css` (`.karaoke-word`,
`.karaoke-line`, `.karaoke-heading`, `.sleep-overlay .karaoke-word` -- the
Sleep-Mode-specific overrides would need to scale too), `assets/js/
storage.js` (if persisted app-wide), wherever the new control's UI lives
(likely near the other Study panel controls, or inside item 4's Karaoke
Controls section if that ships first).

---

## 10. [ ] Undo/redo in the mix editor

**Goal:** let a Pathfinder undo (and redo) a mistaken paint stroke in the
mix editor instead of having to manually repaint over it word-by-word.

**Current state (verified against code):**
- `mix-editor.js`'s paint gesture (pointerdown/pointerenter drag, or a
  single tap) calls `paintRange(mix, sectionKeyStr, startIndex,
  endIndexInclusive, styleId)` (`mix.js:75`), which mutates
  `mix.sections.get(key)` in place, overwriting whatever style was there
  before -- the prior values aren't captured anywhere, so the only way back
  today is manually repainting the correct style back over the same range.
- No history/undo-stack concept exists anywhere in `mix.js` or
  `mix-editor.js` today.

**Decided (confirmed with the user):**
- Scoped to paint strokes only -- one undo step per drag/tap paint
  gesture. Take-rank changes and style-select changes stay outside this
  history (not combined into one undo model).
- Unlimited undo steps for the current editing session -- no capped stack,
  no eviction logic needed.
- Session-only -- cleared once the mix editor closes/unmounts, not
  persisted in the playlist record across a reload.

**Relevant files:** `assets/js/mix-editor.js` (the paint gesture handlers),
`assets/js/mix.js` (`paintRange`, and wherever a snapshot/history array
would need to hook in).

---

## 11. [ ] Port the "Rogue Sheep" easter egg from pbe-practice-engine

**Goal:** bring over the "Rogue Sheep" whimsical easter egg from the
sibling `pbe-practice-engine` workspace -- a toggleable, purely-decorative
wandering sheep sprite that roams the screen -- adapted to this app's
module structure and UI conventions.

**Current state (verified against `pbe-practice-engine`'s code, a separate
workspace at `/Users/daddy/Library/CloudStorage/OneDrive-Personal/
Documents/Code/pbe-practice-engine`, not part of this repo):**
- It's a single `<label>`/checkbox toggle (`#rogue-sheep` in
  `index.html:106-109`) sitting near that app's quiz-results UI, wired to
  `rogueSheepCheckbox`'s `change` listener (`script.js:5993-6000`), which
  calls `startRogueSheep()`/`stopRogueSheep()` to start/stop a spawn
  interval.
- **This is a large, self-contained subsystem, not a small snippet** --
  confirmed contiguous from `script.js:4096` to `script.js:6001`, roughly
  1,900 of that file's 6,078 total lines (about a third of the whole
  file). It's made of `createSheepParticle()` (spawns a small rising
  emoji/particle effect), `performSheepAction()` (a ~1,400-line `switch`
  with one case per action name, each animating a different emoji/particle
  combo above the sheep), `pickRandomAction()` (weighted-random pick from
  `sheepActions`, ~90 named actions grouped into categories -- weather,
  sports, holidays, transportation, animal encounters, occupations, etc.,
  each `weight: 1` except `read` at `weight: 2`), and `createRogueSheep()`
  itself (`script.js:5646-5958`, ~312 lines) -- the movement/behavior state
  machine (`purposeful`/`wandering`/`grazing`/`curious`/`trotting`/
  `performing` states), screen-edge entry/exit, `visualViewport`-aware
  positioning with iOS-safe-area padding, and movement speed scaled to the
  screen's diagonal so it looks consistent across device sizes.
- Visuals: a random 🐑/🐏 emoji, sized 75%-125%, with a 1% chance of being
  a "black sheep" (`filter: brightness(0.2) saturate(0.5)`, see
  `styles.css:653-712`'s `.rogue-sheep*` rules and the `sheep-jump`/
  `sheep-jump-flipped` keyframes). It's `aria-hidden="true"` and
  `pointer-events: none` -- purely decorative, no interaction with any
  quiz/study logic in that app, which should make it low-coupling to port.
- `pbe-practice-engine`'s `script.js` is one large non-module script (no
  ES imports/exports, unlike this repo). This app (`pbe-playlist`) is
  organized as focused ES modules under `assets/js/`, with study-mode-like
  features following a `mount*(container, ...)` → returns `unmount()`
  convention (see `mountUnscored`/`mountSleepMode`/`mountPlayerControls`
  etc., all wired from `main.js`). Porting this isn't a drop-in file copy
  -- it needs restructuring into that convention, most likely a new
  `assets/js/rogue-sheep.js` exporting something like
  `mountRogueSheep()`/an `unmount()`/toggle pair.

**Decided (confirmed with the user):**
- **Placement:** a sheep-emoji button next to the Start Studying and Sleep
  Mode buttons. It toggles the mode on/off, shows a tooltip on hover
  ("This toggles Rogue Sheep Mode on or off"), and must clearly visually
  indicate whether it's currently on or off (not just a plain icon with no
  state feedback) -- not the footer, not buried in the Study panel's other
  settings.
- **Port the full ~90-action library as-is** -- no trimming/curation pass,
  bring over every action category unchanged.
- **Toggle state persists across reloads**, stored in `storage.js`'s
  top-level state -- once turned on, it stays on until explicitly turned
  off, consistent with how this app's other settings persist.

**Open question (implementation-level, not yet resolved):**
- Confirm no part of `performSheepAction()`'s ~90 cases depends on
  `pbe-practice-engine`-specific globals, CSS variables, or DOM elements
  that don't exist in this app before porting wholesale -- not yet checked
  in detail given the size of that switch statement.

**Relevant files (source, in the separate `pbe-practice-engine` workspace):**
`index.html:106-109` (the checkbox), `styles.css:653-712` (`.rogue-sheep*`
rules, `sheep-jump`/`sheep-jump-flipped` keyframes), `script.js:4096-6001`
(`createSheepParticle`, `performSheepAction`, `pickRandomAction`,
`createRogueSheep`, `startRogueSheep`, `stopRogueSheep`).
**Relevant files (destination, in this repo):** a new
`assets/js/rogue-sheep.js` following the `mount*()`/`unmount()`
convention, `assets/js/main.js` (where it'd get wired up), `index.html`
(new toggle markup), `assets/css/styles.css` (ported `.rogue-sheep*`
rules).
