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

**Open question:** what should "improved" actually look like? Some
directions worth considering, none decided: giving every take control the
same interaction pattern regardless of take count (always a dropdown/list,
never switching shape at exactly 2 takes); letting the Pathfinder preview
a take's audio before committing to it; showing which take is *currently
in effect* more prominently when a per-section override is following vs.
overriding the blanket default; surfacing take count in the main style
selector's `<option>` text so a Pathfinder knows before drilling into the
mix editor whether a style even has alternates worth exploring. Resolve
with the user before implementing rather than guessing at a specific
design.

**Relevant files:** `index.html`'s `#defaultTakeRow`/`#styleSelect`,
`assets/js/main.js` (the checkbox's wiring, `renderStyleOptions`),
`assets/js/mix-editor.js`'s `renderTakeControls()`, `assets/js/mix.js`
(`getTakeRank`/`setTakeRank`/`setDefaultTakeRank`), `assets/css/styles.css`
(`.mix-take-control` and friends).

---

## 2. [ ] Sleep Mode: separate instrumental/vocal volume sliders

**Goal:** add two independent volume sliders to Sleep Mode -- one for the
instrumental track's level, one for the vocal track's level -- so a
Pathfinder can turn the vocals down (or off) relative to the music while
falling asleep, instead of only the single overall volume Sleep Mode has
today.

**Current state (verified against code, post stem-pipeline overhaul --
every recording in the library is now a separated instrumental/vocal stem
pair, see AGENTS.md):** `playback-engine.js` already always plays every
block through a synced instrumental+vocal pair (`makeSource()`) -- there's
no more single-track/dual-track branching, so Sleep Mode already gets a
dual-track source for free, same as every other mode. `sleep-mode.js` reuses
`mountUnscored` with a fixed `PLAIN_KARAOKE_OPTIONS = () =>
({ blankFraction: 0 })` (`sleep-mode.js:10`) -- no `duckVocals` key, so it
never sets a duck predicate, meaning the vocal element's `duckFactor` just
stays at 1 (full volume) throughout, same as the instrumental. The engine's
only existing volume control is `setMasterVolume(v)` (`playback-engine.js`)
-- one overall multiplier applied to *both* tracks together, used today for
the sleep timer's fade-out (`sleep-mode.js:80,85,156`) -- there's no concept
of two independently controllable tracks anywhere Sleep Mode touches.

**What this needs:** a new engine API (e.g. something like
`setStemTrackVolumes({ instrumental, vocal })`) for a flat, Pathfinder-set
multiplier per track, independent of `setVocalDuckPredicate`'s per-word
boolean (Karaoke Mode's "fade out the sung words when blanked" checkbox) --
the source already separates `envelopeVolume` (the crossfade-driven volume,
shared by both tracks) from `duckFactor` (the vocal-only multiplier), so
this is a fairly direct extension: a second per-track multiplier that
Sleep Mode's sliders drive directly, alongside (not replacing) the
duck-predicate path Karaoke Mode uses. Since every recording now has stems,
there's no longer a "what about a recording with no stems" question to
resolve -- the sliders can just always be available.

**Open questions:**
- Should the two sliders persist per playlist (like every other Karaoke
  Mode setting) or be a Sleep-Mode-session-only preference that resets
  each time?
- Does a 0% vocal slider need to actually stop fetching/decoding the vocal
  track (bandwidth/battery -- Sleep Mode is explicitly a leave-it-running-
  overnight feature), or is muting its `<audio>` element's volume enough?

**Relevant files:** `assets/js/sleep-mode.js` (`PLAIN_KARAOKE_OPTIONS`,
the volume/fade-out wiring), `assets/js/playback-engine.js`
(`makeSource()`, `setVocalDuckPredicate`, `setMasterVolume`),
`assets/js/playlists.js` (`defaultStudyOptions()`, if these end up
persisted like `duckVocals`).

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

## 5. [ ] Practice history / progress tracking across sessions

**Goal:** persist per-section practice results across sessions -- attempts,
accuracy trend, last-practiced date -- so a Pathfinder can see improvement
over time instead of a score that vanishes the moment a study session ends.

**Current state (verified against code):**
- Type-Ahead's accuracy (`type-ahead.js`'s
  `` scoreEl.textContent = `Score: ${correctFirstTry}/${totalGated} words correct on the first try (${pct}%)` ``)
  and Sing-Along's accuracy (`sing-along.js`'s `scorer.getScore()`, from
  `stt-score.js`'s `createScorer`) are both computed purely in memory and
  written straight into a `<p>` -- neither is ever passed to `storage.js`
  or persisted anywhere. Reloading the page or leaving the mode loses it.
- `storage.js` persists exactly `{schemaVersion, manifestUrl, playlists,
  activePlaylistId}` -- there's no history/stats field in the shape today.
- `library.js`'s `sectionKey(section)` (`book|chapter|verseStart|verseEnd`)
  is already a stable, manifest-independent identifier a history record
  could key off of -- the same key `mix.takeOverrides`/`mix.sections`
  already use for their own per-section data.

**Open questions:**
- What gets recorded per attempt -- just a latest/best score, or enough
  detail (date, mode, accuracy) to show a trend per section over time?
- Does history live per-playlist (inside a playlist record, like
  `studyOptions`) or globally across all playlists, since the same section
  could be studied from more than one playlist? `sectionKey` being
  manifest/playlist-independent makes a global history the more capable
  option (it would also feed item 8 below) -- confirm before implementing
  rather than defaulting to per-playlist out of convenience.
- Should Karaoke Mode (unscored) log anything, given it has no inherent
  score today, or does history only cover the two modes that already
  produce one (Type-Ahead, Sing-Along)?

**Relevant files:** `assets/js/study-modes/type-ahead.js`,
`assets/js/study-modes/sing-along.js`, `assets/js/study-modes/stt-score.js`
(the score computations to persist), `assets/js/storage.js` (persisted
state shape), `assets/js/library.js` (`sectionKey`), `assets/js/
playlists.js` (if this ends up scoped per-playlist instead of global).

---

## 6. [ ] Verse-reference drill mode

**Goal:** add a study mode that drills scripture-reference recall --
"given this passage text, name the reference" and/or "given this
reference, recite the passage" -- since PBE competition scoring includes
reference recall, not just word-for-word text, and no existing mode tests
this.

**Current state (verified against code):**
- Every existing study mode (unscored/Karaoke Mode, Type-Ahead,
  Sing-Along) drills the passage's *words* only. References appear
  purely as passive display -- `passageLabel(section)` in the heading,
  `verse-num` superscripts inline per verse (`word-stream.js`) -- and are
  never the thing being tested.
- `library.js`'s `passageLabel(section)` (`` `${book} ${chapter}:${verseStart}-${verseEnd}` ``
  or `` `${book} ${chapter}` ``) already formats a reference string a drill
  mode could reuse for prompts/answers; `orderedSections`/`findSection`
  already give the tools to pick and look up sections.
- The existing study-mode architecture -- each `study-modes/*.js` file
  exports a `mount*()` returning an `unmount()`, wired up alongside
  `mountUnscored`/`mountSingAlong`/`mountTypeAhead` from wherever the Study
  panel's mode picker lives -- is the pattern a new mode would follow.

**Open questions:**
- Text→reference, reference→text, or both directions?
- Multiple-choice (pick the right reference from a few) vs. free-text entry
  (like Type-Ahead's typed-word matching)? Free text needs tolerance for
  reference-format variation ("John 3:16" vs "3:16" vs "John chapter 3
  verse 16").
- Does this reuse `createPassageView`'s windowed word display for the
  passage-text side, or is reference drilling a lighter-weight,
  non-karaoke UI entirely (more like a flashcard)?

**Relevant files:** `assets/js/study-modes/` (a new file alongside
`unscored.js`/`type-ahead.js`/`sing-along.js`), `assets/js/library.js`
(`passageLabel`, `orderedSections`, `findSection`), wherever the Study
panel's mode picker lives in `index.html`/`main.js`.

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

**Open questions:**
- Cache the manifest + audio opportunistically (whatever's been fetched
  during normal use just stays available), or does a Pathfinder need an
  explicit "download this playlist for offline" action? Audio files are
  naturally largish (a full passage's worth of stems), so an explicit
  download step may be better than silently filling up storage.
- Every recording is now a stem *pair* (instrumental + vocal, see
  AGENTS.md) -- both need caching together per block, or a partially-cached
  pair breaks playback.
- Should the uploaded-local-file manifest path (`gate.js`'s "upload a JSON
  file" flow, explicitly *not* remembered today) interact with offline
  support at all, or does offline only make sense for the URL-based/
  remembered manifest path?

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

**Open questions:**
- Draw the review set from "every section across all playlists" (simple,
  no dependency on item 5), or "every section with a logged practice
  history" (more targeted, but depends on item 5 shipping first)? Worth
  sequencing against item 5 rather than deciding in isolation.
- Which style/mix applies to a section pulled in from outside the
  currently-active playlist -- that section's own playlist's mix, or the
  active playlist's default style?
- Does this reuse one of the existing study modes (Karaoke Mode) against
  this cross-playlist program, or is it its own mode with its own UI entry
  point?

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

**Open questions:**
- App-wide setting (persisted once, applies everywhere `.karaoke-word`
  renders, including Sleep Mode) or per-mode (e.g. Sleep Mode wants it
  bigger than the regular Study panel)?
- A fixed set of sizes (Small/Medium/Large) or a continuous slider?

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

**Open questions:**
- Should undo be scoped to one continuous paint stroke (one undo step per
  drag/tap), or should it also cover other mix-editor actions (take-rank
  changes, style-select changes) as one combined history?
- How many undo steps to retain -- unlimited for the current editing
  session, or a capped stack?
- Does undo state need to survive a page reload (persisted in the playlist
  record), or is it session-only (cleared once the mix editor closes/
  unmounts)? Session-only is simpler and matches how most in-app undo
  already behaves, but confirm rather than assuming.

**Relevant files:** `assets/js/mix-editor.js` (the paint gesture handlers),
`assets/js/mix.js` (`paintRange`, and wherever a snapshot/history array
would need to hook in).
