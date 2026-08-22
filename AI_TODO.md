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

---

## 12. [ ] Karaoke Mode silently renders blank when a section's first
playable block starts well after 0:00

**Goal:** fix a real, reproducible bug (found via browser-testing item 8's
Review Mode, but independent of it -- reproduces on plain "Start Studying"
too) where the karaoke word display stays permanently blank (empty
heading, empty word stream, no error visible anywhere) for a section whose
first *playable* block doesn't start at/near the recording's beginning.

**Repro (verified against code and against the repo's own dev fixture,
`scripts/dev-manifest.local.json`):**
- Select **only** "1 John" chapter 1 (any playlist), click "Start
  Studying" (unscored Karaoke Mode, default settings). Audio fetches
  successfully (200s for both `.m4a` stems, confirmed via network
  inspection) and starts playing, but `#karaokeView` never renders
  anything -- no heading text, no word stream, indefinitely. No console
  error, no `pageerror` event, nothing in `#fallbackNote` beyond the
  normal "some words have no audio" note.
- The same flow with "1 John" chapter 2 selected instead renders
  correctly immediately.
- The distinguishing factor (confirmed via a standalone
  `buildProgram(manifest, mix, ["1 John|1||"])` run in Node, no browser):
  1 John 1's *first* canonical words (verse 1's opening words) have no
  audio in any style/take at all (`program.fallbacks` reports
  `reason: "no-aligned-audio"` for `1 John 1:1`), so the section's first
  actual playable block's `inTime` is well past 0:00 (~11s into the
  recording) rather than at/near the start like most sections. 1 John 2
  has no such leading gap.

**Suspected root cause (not yet fixed, needs its own investigation):**
- `playback-engine.js`'s `play()` (~line 672) calls
  `playFromBlock(0, undefined, { applyCountIn: true })` -- an `async`
  function -- without `await` or `.catch()`. If that promise rejects (the
  likely culprit: `await source.seekAndPlay(time)` inside `playFromBlock`,
  ~line 593, where `time` is a large nonzero offset instead of the ~0
  every other section's first block normally has), the rejection is
  silently swallowed. `emit("blockchange", ...)` (the only thing that
  triggers `word-stream.js`'s `renderSection()`, which is what actually
  fills in the heading/word stream) never runs, and nothing else surfaces
  the failure -- `tick()`'s own `if (!block) return;` guard also fails
  silently once `currentBlock()` never advances past `blockIndex === -1`.
- Not yet confirmed *why* `seekAndPlay` itself would reject/hang for a
  nonzero seek specifically -- needs tracing inside
  `makeSource()`/`seekAndPlay()` (~`playback-engine.js:225` onward), not
  just the unhandled-rejection symptom above.

**Relevant files:** `assets/js/playback-engine.js` (`play()`,
`playFromBlock()`, `makeSource()`/`seekAndPlay()`, `tick()`),
`assets/js/study-modes/word-stream.js` (`renderSection()`, only ever
triggered by the `blockchange` event this bug prevents from firing),
`assets/js/program-builder.js` (where a block's `inTime` is computed from
the first available word in its run -- confirms the nonzero-start
condition, doesn't cause the bug itself).
