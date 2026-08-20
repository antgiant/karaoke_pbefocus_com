# AI Task List

Working queue of larger changes for an AI agent to pick up in this repo.
Each item below is written to be actionable without re-deriving context:
what the goal is, which files are actually involved (verified against the
current code, not guessed), and what to watch out for. Items are ordered by
recommended priority (see the reasoning at the bottom of this intro), not
by when they were added — do them roughly top to bottom unless you have a
specific reason to reorder. When you pick one up:

1. Read the "Relevant files" for that item before touching anything.
2. If an item lists an "Open question," resolve it with the user (or state
   your assumption plainly in the PR/commit) before implementing — don't
   silently guess on user-facing wording or UX behavior.
3. Check this file off (`- [x]`) and add a one-line "Done in <commit>" note
   when finished, rather than deleting the item.
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

**Why this order:** items 1-3 all touch the same shared rendering code
(`word-stream.js`'s `createPassageView()`) — item 1 changes *how* the
passage renders, items 2-3 change *what options wrap around* that render,
so doing 1 first avoids reworking the same call sites twice. Items 2-3 are
otherwise small (thin config wrappers, no new engine). Item 4 is cheap and
self-contained, worth clearing out before the two bigger items. Item 5 is
the largest (new data model, new UI surface, new sharing/encoding logic)
and restructures `storage.js`'s persisted shape; item 6 layers a smaller
addition onto whatever shape item 5 lands on, so it comes last.

---

## 1. [x] Explore a different UI for the live karaoke lyrics display

**Done — not yet committed.** Implemented as the standard 2-line
karaoke-scroll design decided below (window size = fixed word count per
line modeled on typical karaoke lines, transition = line scroll-up,
manual navigation = pauses playback). `createPassageView()`'s public API
is unchanged, so `karaoke.js`/`disappearing-word.js`/`invisible-word.js`/
`blackout-ramp.js`/`sing-along.js` needed zero changes. Tests:
`tests/word-stream.buildLines.test.mjs` (pure line-chunking logic) and
`tests/word-stream.test.mjs` (jsdom -- rendering, window-swap on
highlight, click-to-seek, manual nav, verse filtering, masking-hook
scoping); `npm test` passes (20/20). Verified in a real browser
(Playwright, one-off check, not a committed dependency) against the real
manifest -- caught and fixed a real bug the DOM tests couldn't (the new
nav bar + next-line preview could overlap the sticky player-controls bar;
`.karaoke-view`'s `padding-bottom` bumped 5.5rem -> 8rem, see
`styles.css`). Docs: `README.md`'s Current Features + new Tests section.
New: `package.json`/`tests/` (test infra, applies to every future item
below too, not just this one).

**Reported problem:** on a passage longer than one screenful, the current
display prevents the Pathfinder from scrolling, which has the side effect
of locking them out of the UI.

**Root cause (found by code review, high confidence):** there's no CSS
`overflow: hidden` or fixed-height trap on the main (non-sleep-mode)
karaoke view — `.karaoke-view`/`.karaoke-stream` in `assets/css/styles.css`
scroll normally with the page. The actual culprit is the auto-scroll
behavior in `createPassageView()`'s `highlight()` function,
[assets/js/study-modes/word-stream.js:194-211](assets/js/study-modes/word-stream.js#L194-L211):
on (roughly) every word during playback, if the active word has drifted
outside a ±15%-of-viewport-height band around center
(`isReasonablyInView()`, line 213), it force-smooth-scrolls back to center
on the active word. The code comment right above it already acknowledges
the general risk ("would otherwise fight a Pathfinder trying to manually
scroll or click elsewhere") and throttles *how often* it fires — but not
*how far* a manual scroll is allowed to go before getting overridden. On a
passage taller than one screen, scrolling away from the current word by
more than ~15% of the viewport is exactly what you'd do to read ahead,
reach the sticky player controls, or just look around — and it gets pulled
back within about a second, every time. That reads as "locked out," not
just "occasionally nudged."

**Who's affected:** every study mode that goes through the shared
`createPassageView()` — `karaoke.js`, `disappearing-word.js`,
`invisible-word.js`, `blackout-ramp.js`, `sing-along.js` (i.e. everything
except Type Ahead, which has its own separate, less aggressive
`scrollIntoView({block: "nearest"})` call in `type-ahead.js:123`, gated on
advancing to a new word rather than firing continuously during autoplay —
worth a consistency look too, but it isn't the reported lockout since it
only moves on deliberate advance, not on a timer). This item overlaps with
items 2 and 3's mode consolidation — do this one first so those two build
against the settled new rendering shape instead of the old one.

**Constraint to preserve:** the player controls bar is deliberately
`position: sticky; bottom: 0` (`styles.css:486-494`, with its own comment
explaining why — otherwise Pause etc. can scroll off-screen on a long
chapter with no way back). Whatever replaces the current auto-scroll
behavior still needs to keep transport controls reachable; don't solve the
lyrics-scroll lockout by reintroducing a different way to lose the controls.

**Decided direction: a windowed display.** Show only the current
line/verse (or a small window of context around it), not the entire
passage at once — sidesteps long-passage scrolling entirely by trading
"see the whole passage on screen" for "always fits," closer to a classic
single/double-line karaoke display. This is a bigger visual departure than
today's full-passage view, not a small patch — chosen deliberately over the
smaller alternatives (suspend-auto-scroll + jump button, or confining the
existing full-passage view to its own scrollable panel) because it removes
the problem's precondition (a passage taller than one screen) rather than
managing scroll behavior around it.

**Design questions to settle before/while implementing** (not yet decided —
flag back to the user if these need a product call rather than an
engineering judgment call):
- **Window size:** exactly one verse at a time? A fixed number of lines
  (e.g. 2-3) that scrolls/advances by line rather than by verse? Verses
  vary a lot in length (a short 1 John verse vs. a long narrative Mark
  verse) — a fixed-line window may cut mid-verse, a fixed-verse window may
  have very uneven amounts of text on screen between verses.
- **Transition behavior:** hard cut, slide, or fade between windows as
  playback advances past the current one? Should match the general feel of
  today's highlight/masking transitions (`karaoke-word`'s existing
  `transition: color/background-color/opacity` in `styles.css:538-543`)
  rather than introducing a visually inconsistent new motion style.
- **Manual navigation:** can the Pathfinder step forward/back through
  windows independent of playback (e.g. to peek ahead or re-read), or does
  the window strictly follow the audio position? If manual stepping is
  allowed, does it pause playback or keep playing while browsing?
- **Interaction with masking modes (item 2):** disappearing-word/
  invisible-word/blackout-ramp's word-masking behavior needs to still make
  sense inside a small window — likely simpler than in the full-passage
  view (less to mask at once), but worth designing item 2 and this item
  together rather than sequentially, since both touch how words are
  rendered in the passage view.

**Relevant files:** `assets/js/study-modes/word-stream.js` (the shared
`createPassageView()` engine this replaces/reworks — rendering, the
`highlight()`/`isReasonablyInView()`/`scrollIntoView` logic all become
unnecessary once only one window's worth of words is ever on screen),
`assets/css/styles.css` (`.karaoke-view`, `.karaoke-stream`,
`.player-controls`, `.karaoke-word`), `assets/js/study-modes/type-ahead.js:123`
(its own separate scroll call — likely also moot once type-ahead's UI is
reconciled with the same windowed approach, though item 3 already
established type-ahead has a fundamentally different playback engine, so
confirm this actually applies before assuming it does).

**Note on line numbers above:** verified against commit `38fa1c7`
(the repo's last commit as of this writing). `word-stream.js` and several
other study-mode files show uncommitted edits in progress as of this TODO
entry — re-check line numbers against the current file content before
relying on them.

---

## 2. [x] Collapse the four unscored study modes into one "Unscored" mode with options

**Superseded by a later redesign** (see the new item at the end of this
file, "Redo the study mode and masking UI entirely"): the mode/mask-style
dropdown UI described below was replaced by a single slider + checkboxes,
and Disappearing Word's mechanic was removed outright rather than kept as
a mask-style option. `mountUnscored`'s underlying engine is still the same
one this item built. Left below as the historical record of what was
originally shipped.

**Done — not yet committed.** New `assets/js/study-modes/unscored.js`
(`mountUnscored`) replaces `karaoke.js`/`disappearing-word.js`/
`invisible-word.js`/`blackout-ramp.js`, all four deleted. `index.html`/
`main.js` rewired to the new Unscored/Scored `modeSelect` with a Masking
sub-select (None/Disappearing/Invisible) plus conditional lookahead, hint
level, ramp, and length-matched controls. Blackout ramp's old fixed
0.6-starting ratchet is generalized to ratchet down from whatever hint
level is configured, rather than being a disconnected hardcoded value.
**Caught mid-implementation:** `assets/js/sleep-mode.js` also imported the
now-deleted `karaoke.js` — not in this item's original "Relevant files"
list, would have crashed on load/Sleep Mode. Fixed (now uses `mountUnscored`
with a plain `{maskStyle: "none"}` getter). Worth double-checking any
future file deletion against a full-repo grep, not just the files an item
happened to list. Tests: `tests/unscored.test.mjs` (all three mask styles,
length-matched masking, ramp-on-repeat across a real section revisit,
unmount) — `npm test` passes (27/27, up from 20). Verified in a real
browser (Playwright, one-off): mode/masking option visibility toggles
correctly, blank masking renders bullets and reveals on reach, Scored mode
auto-detects input method, Sleep Mode still works end-to-end via the new
shared code path. Zero console errors. Docs: `README.md`'s Study modes
bullet rewritten for the new structure.

**Modes to collapse:** Standard Karaoke, Disappearing Word, Invisible Word,
Blackout Ramp.

**Why this is a clean merge:** all four already share one underlying engine
— `createPassageView()` in `assets/js/study-modes/word-stream.js` — and each
mode file is just a thin config wrapper around it:
- `karaoke.js` (8 lines): no masking at all, plain highlight-as-sung.
- `disappearing-word.js` (19 lines): words vanish `getLookahead()` steps
  ahead of playback instead of just dimming.
- `invisible-word.js` (43 lines): words are blanked *before* they're sung
  and reveal on reach; `getRevealFraction()` controls how many are given
  away as hints up front, chosen via `blank-priority.js` (semantically
  important words stay blanked longest, not random) plus optional
  length-matched masking from `masking.js`.
- `blackout-ramp.js` (55 lines): identical mechanic to invisible-word, but
  the reveal fraction ratchets down on each repeat play of the *same
  section* (`BASE_REVEAL=0.6`, `STEP_PER_REPEAT=0.2`, tracked in a
  `playCounts` map keyed by `sectionKey()`).

This is genuinely one masking engine with four fixed presets, so collapsing
them is mostly deletion + a small options object, not a rewrite.

**Suggested shape:** one `mountUnscored(container, engine, manifest, mix, options)`
in a new file (e.g. `study-modes/unscored.js`), where `options` covers what
today is spread across four files' hardcoded behavior — e.g. mask style
(`none` / `disappear-on-sing` / `blank-until-sung`), lookahead (disappearing
word's knob), reveal fraction (invisible word's knob), ramp-on-repeat
on/off (blackout ramp's knob), and length-matched masking (already a shared
checkbox — see below). `blank-priority.js`, `masking.js`, and
`word-stream.js` don't need to change; they're already the shared layer.

**Relevant files:**
- `assets/js/study-modes/{karaoke,disappearing-word,invisible-word,blackout-ramp}.js`
  — the four to retire (delete after the merge, don't leave dead code).
- `assets/js/study-modes/word-stream.js`, `masking.js`, `blank-priority.js`
  — shared engine/helpers, reusable as-is.
- `assets/js/main.js:19-22, 314-331, 359-369` — imports, the `modeSelect`
  change handler (which options show/hide per mode — `hintLevelInput`,
  `lookaheadSelect`, `lengthMatchedRow`), and the dispatch in the start-button
  handler. All of this collapses toward one branch plus one options panel.
- `index.html:78-102` — the `modeSelect` `<option>` list and the
  hint-level/lookahead/length-matched controls currently shown/hidden
  per-mode; these become "the Unscored mode's options," always relevant
  together rather than mode-conditionally swapped in and out.

**Decided:** stays one flat `modeSelect` `<select>` — "Unscored" is a single
entry in the same dropdown as today (alongside "Scored," see item 3), each
with its own options panel underneath. No top-level mode-family picker.

---

## 3. [x] Collapse Type Ahead and Sing-Along into one "Scored" mode with options

**Superseded by the same later redesign as item 2** (see the new item at
the end of this file): the `modeSelect`/"Scored" dropdown entry described
below is now a "Scored" checkbox instead, but the underlying dispatch to
Type Ahead/Sing-Along this item built is unchanged. Left below as the
historical record.

**Done — not yet committed.** Implemented together with item 2, since both
share the same `modeSelect` restructuring: `index.html` has one "Scored"
`modeSelect` entry plus a `scoredInputSelect` (Type Ahead / Sing-Along)
that appears only in Scored mode; `main.js` auto-sets it via
`isSingAlongSupported()` on load, with the select itself as the manual
override. Dispatch preserved exactly as flagged as important below: Scored
+ Type Ahead still returns early *before* `engine.loadProgram()`, Scored +
Sing-Along still goes through the normal shared-engine path. `type-ahead.js`
and `sing-along.js` themselves are untouched, as decided (UI-level grouping
only, no engine merge). Verified in a real browser (Playwright, one-off):
both paths mount correctly -- Type Ahead with no shared player-controls (as
expected, it drives its own audio), Sing-Along with the shared engine +
player-controls present. Zero console errors. No new unit test file for
this item specifically: the only genuinely new logic is the dispatch
wiring in `main.js`, which has no exports and isn't structured for
isolated unit testing (a pre-existing characteristic of that file, not
introduced here) -- the browser check covers both branches directly instead.

**Why this one is *not* a small merge like item 2:** Type Ahead and
Sing-Along don't share an engine today, and the difference isn't cosmetic:

- `sing-along.js` uses the shared `createPassageView()` (same engine as the
  unscored modes) plus continuous mic capture scored against the reference
  text via `stt-score.js`. It rides the normal crossfade playback engine.
- `type-ahead.js` deliberately does **not** use the shared crossfade
  `playback-engine.js` at all — its own comment at the top of the file
  explains why: it needs to pause playback and wait for correct input
  before continuing into each word, which the shared engine's continuous
  multi-block auto-advance has no concept of. It drives its own dedicated
  `<audio>` element and takes the `program` directly rather than an
  `engine` instance (contrast its mount signature,
  `mountTypeAhead(container, program, getLengthMatched)`, with every other
  mode's `mountX(container, engine, manifest, mix, ...)`).

So "collapse into one mode with options" here is realistically a **UI-level
grouping** — one "Scored" entry in `modeSelect` with a sub-choice of input
method (Type Ahead / keyboard vs Sing-Along / voice) that still dispatches
to the two existing, differently-built mount functions underneath — *not* a
merge of the two into a single engine. Confirmed with the user: UI-only
grouping is the intent, so don't attempt to force type-ahead onto the shared
playback engine as part of this task.

**Relevant files:**
- `assets/js/study-modes/type-ahead.js` (242 lines) — own audio element,
  pause-gated on correct input, takes `program` not `engine`.
- `assets/js/study-modes/sing-along.js` (137 lines) — shared engine +
  `stt-score.js` mic scoring; feature-detects `SpeechRecognition` and shows
  a fallback note on unsupported browsers (Firefox) via
  `isSingAlongSupported()`.
- `assets/js/main.js:23-24, 351-355, 368` — imports and the two divergent
  dispatch paths (note `typeahead` returns early *before* `engine.loadProgram()`
  is even called, since it doesn't use `engine` — preserve that early-return
  shape or restructure it deliberately, don't lose it by accident).
- `index.html:83-84` — the two `<option>` entries (`typeahead`, `singalong`)
  to become one "Scored" entry with a sub-option.

**Decided:** stays one flat `modeSelect` entry, "Scored" (see item 2's
layout decision — no top-level mode-family picker). Its input-method
sub-choice auto-detects by default: voice/Sing-Along where
`isSingAlongSupported()` is true, keyboard/Type Ahead otherwise, with a
visible manual override control so a Pathfinder can switch either way
regardless of what was auto-selected.

---

## 4. [x] Rename the project to "PBE Karaoke"

**Done — not yet committed.** All six known occurrences renamed
(`index.html` title/h1, `README.md` title/intro, `AGENTS.md` title,
`constants.js`'s `STORAGE_KEY` -> `"pbe-karaoke:v1"`, `sleep-mode.js`'s
MediaSession album) plus one not in the original list because it didn't
exist yet: `package.json`'s `name`/`description` (added for item 1's test
infra, after this item was originally written) -- `name: "pbe-karaoke"`,
lockfile regenerated to match. Verified by grepping the whole repo for any
remaining "PBE Playlist"/"pbe-playlist" -- clean except this file's own
historical description of the task, left as-is intentionally. Verified in
a real browser: title/h1 render "PBE Karaoke", and app state persists
under the new `pbe-karaoke:v1` key (old key absent, as expected --
pre-release, no migration needed). **Not done, by design:** the top-level
project folder is still named `pbe-playlist` -- per this item's own note,
that's an OS-level `mv` best done outside an agent session (would
invalidate the working directory of any running tool/editor), left for
the user to do manually if wanted.

**Goal:** Rename user-facing branding and the folder/file naming scheme from
"PBE Playlist" to "PBE Karaoke" throughout.

**Known occurrences (verified by grep, repo root):**
| File | Line | Text |
|---|---|---|
| `index.html` | 6 | `<title>PBE Playlist</title>` |
| `index.html` | 31 | `<h1>PBE Playlist</h1>` |
| `README.md` | 1, 3 | title + intro line |
| `AGENTS.md` | 1 | title |
| `assets/js/constants.js` | 1 | `STORAGE_KEY = "pbe-playlist:v1"` |
| `assets/js/sleep-mode.js` | 98 | MediaSession `album: "PBE Playlist"` |

**The localStorage key:** `constants.js`'s `STORAGE_KEY` (`"pbe-playlist:v1"`)
gates all persisted app state. Rename it to match (e.g. `"pbe-karaoke:v1"`)
— pre-release, so no migration needed, just change the string.

**Top-level folder rename:** the project directory itself is `pbe-playlist`.
Renaming it is an OS-level `mv`, not a code change — do this manually
(outside the agent session) if it's wanted, since it would invalidate the
working directory paths of any running tool/editor session, and there's no
git remote configured yet to also need updating (`git remote -v` is empty).
Confirmed via grep: no other repo in the `pbefocus.com` family
(`quiz_pbefocus_com`, `pbefocus.com`, `pbe-practice-engine`) references
`pbe-playlist` or "PBE Playlist," so this rename is self-contained to this
repo — nothing cross-repo to chase.

**Not in scope:** `PBE_2026_2027/` (the song library folder) and its
`PBE_2026_2027_<Genre>` subfolders name the *song year/library*, not the
app — leave those alone unless told otherwise.

---

## 5. [x] Named, multi-playlist support + out-of-band sharing

**Done — not yet committed.** The biggest item; implemented in full:
- **Storage** (`storage.js`, `SCHEMA_VERSION = 2`): `{schemaVersion,
  manifestUrl, playlists: [...], activePlaylistId}`, clean break from the
  old single-selection shape as planned (pre-release, no migration).
  Self-repairs a stale/missing `activePlaylistId` and falls back to a
  fresh default playlist for anything not already in the current shape.
- **Playlist CRUD** (new `assets/js/playlists.js`, pure/testable):
  create/rename/duplicate (deep copy, disambiguated name)/delete (never
  leaves the list empty -- deleting the last playlist creates a fresh
  default). Wired into `main.js` + a new Playlists panel in `index.html`
  (`playlistSelect` + New/Rename/Duplicate/Delete buttons). `selected`/
  `verseSelections`/`mix` are now `let` bindings rebuilt from the active
  playlist record on every switch, exactly as this item's own notes
  anticipated.
- **Compact wire format** (new `assets/js/share.js`, pure/testable):
  per-payload local style dictionary + run-length encoding, as specced --
  turned out `mix.js`'s existing `getRuns()` already did conceptually the
  same RLE, though `share.js` writes its own compact `[dictIndex, count]`
  version rather than reusing `getRuns()` directly (that needs a live
  `mix` object with a `Map`; the persisted/shared shape is a plain
  object, so encoding straight off that array was simpler than
  round-tripping through a live `mix` first). A 300-word realistically-painted
  test mix (3 big ranges, not word-by-word) encodes to a small fraction of
  `QR_SAFE_BYTE_LIMIT`.
- **Privacy** (decided: explicit choice, every share): the share dialog's
  "also include library access" checkbox is unchecked by default every
  time it opens; checking it mirrors `manifestUrl` into both the payload
  *and* a `?library=` URL param (so gate.js's existing, unmodified
  auto-unlock picks it up) -- unchecked, only `?playlist=` is set and the
  recipient needs their own library access already, exactly the decided
  tradeoff.
- **Delivery, tiered by size** (decided): link + QR by default
  (`assets/js/qr.js` wraps a vendored `qrcode-generator` 2.0.4, MIT,
  dependency-free -- `assets/js/vendor/qrcode-generator.mjs`, chosen since
  this app has no build step and that library is a perfect fit: single
  file, no dependencies); falls back to a downloadable `.json` file when
  `encodedByteLength(payload) > QR_SAFE_BYTE_LIMIT` (1500 bytes, a
  documented heuristic, not a hard limit).
- **Import**: a previously-exported file (via a file input) or a
  `?playlist=` link (consumed once, then stripped from the address bar so
  a refresh doesn't re-import it) both go through the same
  `recordFromSharedPayload()` path.

Tests: `tests/playlists.test.mjs`, `tests/storage.test.mjs`,
`tests/share.test.mjs`, `tests/qr.test.mjs` (round-trip encoding, RLE
correctness, worst-case no-repeats fallback, privacy opt-in behavior,
non-ASCII names, malformed-input rejection, QR SVG well-formedness) --
`npm test` passes (56/56, up from 27). Verified in a real browser
(Playwright, one-off): full CRUD cycle with per-playlist isolation
confirmed (switching playlists doesn't leak selections between them),
share dialog link/QR/privacy-toggle all correct, clipboard copy works,
file export -> file import round-trips a playlist exactly, `?playlist=`
URL import works and the recipient's own saved library access is reused
(no `?library=` needed when the sharer didn't bundle one), delete
correctly removes a playlist. Zero console errors across the entire flow.
Docs: `README.md`'s Current Features.

**Not done / left as-is:** the two smaller open items this item's own
notes flagged as implementation-time decisions (exact QR size threshold,
tuned here as a documented 1500-byte heuristic) are resolved; nothing
outstanding.

**Goal:** Let a Pathfinder create and manage any number of named playlists
(not just one implicit selection), and share a playlist with someone else
outside the app itself — e.g. QR code or an exportable file.

**Current state — there is no playlist concept, just one implicit selection:**
`storage.js`'s `defaultState()` persists exactly one unnamed selection under
one fixed `localStorage` key (`STORAGE_KEY`, `constants.js:1`):
`{ manifestUrl, selectedSectionKeys, verseSelections, activeStyle, mix }`.
`main.js`'s `persistAppState()` (`main.js:28`) overwrites that single blob on
every change. Adding playlists means turning that one blob into a
**named, listable collection** of blobs (`{selectedSectionKeys,
verseSelections, activeStyle, mix}` each — `manifestUrl` is library access,
not part of a playlist, and almost certainly stays shared across all of a
Pathfinder's playlists rather than duplicated per-playlist).

**Relevant files:**
- `assets/js/storage.js` — schema change: from one state blob to a
  playlist collection (e.g. `{schemaVersion, manifestUrl, playlists: [{id,
  name, selectedSectionKeys, verseSelections, activeStyle, mix}], activePlaylistId}`).
  Pre-release, so just change the shape outright — no migration needed for
  the old single-selection format.
- `assets/js/main.js` — `persistAppState()` and `initSelectionUi()`
  (`main.js:253`) currently assume exactly one selection/mix pair in scope;
  needs a playlist switcher (create / rename / duplicate / delete / select
  active) wired in before the existing chapter-tree/mix-editor UI, which can
  otherwise stay largely as-is once it's just operating on "the active
  playlist" instead of "the selection."
- `assets/js/selection.js`, `assets/js/mix.js` — the per-playlist data
  shapes (`selected` Set, `verseSelections` Map, `mix`) don't need to change
  internally, just get instantiated per-playlist instead of once globally.
- `index.html` — needs new UI surface for the playlist list/switcher itself
  (not just the existing single-selection chapter tree).

**Sharing — prior art already in this codebase:** the library-access gate
already does out-of-band sharing of *state via URL*: `gate.js`'s
`resolveInitialManifestUrl()` reads a manifest URL from `?library=<url>` in
the address bar (`constants.js`'s `MANIFEST_URL_PARAM`), auto-loads it, and
persists it for next visit. The same pattern (serialize state -> URL query
param or fragment -> QR-encode that URL or paste it as a link) is the
natural fit for playlist sharing too, and reuses the same
gate/paste-a-link/scan-a-QR mental model the app already teaches.

**Decided — privacy:** make it an explicit choice at share time, every
time, not a hardcoded default either way. `README.md` is explicit that the
song library is gated behind a private manifest URL that "revokes access"
once pulled down, and that URL is exactly what `?library=` carries today —
bundling it into a shared playlist means the recipient gets full library
access, not just that one playlist. So: when a Pathfinder shares a
playlist, the share UI must ask them to choose, per-share, between (a)
playlist-only (recipient needs their own library access already) and (b)
bundle the manifest URL too (one-tap for the recipient, but also hands them
the whole library). Don't silently default to either — surface the
tradeoff plainly in the share dialog itself (e.g. a labeled checkbox/toggle,
off by default given (a) is the safer of the two) so the person sharing
understands what they're handing out.

**Decided — delivery mechanism:** build both, tiered by payload size.
Default to a copyable/QR-able link (mirrors the existing `?library=`
pattern, no extra library dependency, works cross-device by scanning);
automatically fall back to a downloadable/importable `.json` file when the
serialized playlist (particularly a large custom `mix`) is too big to fit a
reasonably-scannable QR code. Still needs an implementation-time decision on
exactly where that size threshold sits (QR capacity depends on
error-correction level chosen; measure a realistic large-playlist payload
against whatever QR library gets picked before hard-coding a cutoff).

**Decided — compact wire-format for the share payload, to push more
playlists into the QR/link tier before falling back to a file:** this is a
share-payload-only concern, not a manifest change — `scripts/build_manifest.py`
and the manifest JSON stay exactly as they are; they're fetched over plain
HTTP and never QR-encoded, so their verbosity was never the actual
bottleneck. The bottleneck is `mix.sections`: today one style-id string per
word (e.g. `"contemporarychristian"`, 22 chars, repeated once per word —
see `mix.js`), and a Pathfinder typically paints whole sections/ranges one
style at a time, so that array is overwhelmingly repetitive runs of the
same value. Before serializing a playlist for share:
1. Build a small **local style dictionary scoped to that one payload** —
   just the styles actually used in this playlist (typically 1-4 of the
   manifest's ~14), each given a short local index. Reference *this*
   dictionary, not the manifest's global `styles` array/order — indexing
   into the manifest directly would silently break old shared links if a
   style folder is later added/removed and the manifest's style order
   shifts. The local dictionary travels inside the payload itself, so a
   shared playlist stays correct regardless of later manifest changes.
2. **Run-length-encode** each section's per-word style array against that
   local dictionary (index + repeat-count pairs) instead of one entry per
   word — this is where the actual size win comes from, given how
   repetitive real mixes are.
3. Worst case — every single word painted a different style, no repeats —
   RLE buys nothing and the payload falls through to the file-export
   fallback above. That's fine; don't special-case it further, the fallback
   already exists for exactly this.

**Relevant files (for this sub-item):** the RLE/local-dictionary encoding
is new code, probably a `serializePlaylistForShare()` /
`deserializeSharedPlaylist()` pair (e.g. in `mix.js` next to the existing
`toSerializable()`/`fromSerializable()`, or a new `share.js`) — it sits
between the existing in-memory `mix` shape (unchanged) and whatever goes
into the URL/QR/file, so it's an extra encode/decode step at the sharing
boundary only, not a change to how `mix` is represented or edited day to
day.

---

## 6. [x] Create interface to allow access to alternate takes

**Done — not yet committed.** Take is addressed **positionally** (rank 0 =
lowest take, rank 1 = next, ...) rather than by literal take number, since
real take numbers are arbitrary per-file (confirmed against the real
manifest: 480/529 section+style combos have exactly 2 takes, 41 have 1, only
8 have 3+ -- validates the "design around exactly two" decision below).
- `library.js`: new `listTakes(section, styleId)`; `pickRecording()` gained
  an optional `takeRank` param (default 0 = unchanged old behavior),
  falling back to rank 0 if the requested rank doesn't exist for that
  specific section+style (never errors or drops audio).
- `mix.js`: new `defaultTakeRank` (blanket preference, parallel to
  `defaultStyleId`) + `takeOverrides` (per-(section, style) overrides,
  parallel to per-word style painting) with `getTakeRank`/`setTakeRank`/
  `setDefaultTakeRank`; wired into `toSerializable`/`fromSerializable`.
- `program-builder.js`: `alignmentFor()` now calls `getTakeRank(mix, key,
  styleId)` and threads it into `pickRecording()` -- the one chokepoint
  this item's own notes identified.
- `share.js` (item 5) updated too, since it predates this item: take
  preferences now round-trip through the compact share payload, re-keyed
  against the same local style dictionary as everything else style-related.
- **UI, both places, per the decision below:** the main style selector
  gets a simple 2-state "Prefer alternate take" checkbox
  (`defaultTakeCheckbox`) bound to `defaultTakeRank`; the mix editor shows
  a take control per style actually painted in each section -- a checkbox
  for the common exactly-2-takes case, a `<select>` (degrades gracefully)
  for the rarer 3+ case, nothing at all for a style with only one take.
  The mix editor's control refreshes whenever a paint changes which styles
  are in use (not just once at initial render).

Tests: `tests/library.takes.test.mjs`, `tests/mix.takes.test.mjs`,
`tests/program-builder.takes.test.mjs` (full pipeline: rank 0/1 selection,
per-section override beating the blanket default, out-of-range fallback,
serialization round-trip) plus the updated `tests/share.test.mjs` --
`npm test` passes (73/73, up from 57). Verified in a real browser
(Playwright): confirmed via actual network requests (not just DOM state)
that the default checkbox, and independently the per-section override,
each select the correct real take file (`... (22).mp3` vs `... (23).mp3`)
against real Mark 1:1-20 Hip Hop data, including the override correctly
winning over an OFF global default. One test-methodology detour worth
recording: an earlier run of this same check appeared to show the wrong
style playing entirely -- root-caused (not an app bug) to
`program-builder.js`'s pre-existing, documented per-word alignment-gap
fallback combined with a too-short wait, and separately to Chromium not
re-firing a network event for an already-cached identical URL; fixed by
waiting for the specific request rather than a fixed timeout, and by
disabling cache reuse in the test.



**Goal:** Right now a Pathfinder can never reach any take but the lowest
numbered one for a given chapter+style, even when the manifest has several.
Add a way to pick (or otherwise reach) an alternate take.

**Why it's needed:** `pickRecording(section, styleId)` in
[assets/js/library.js:78](assets/js/library.js#L78) filters a section's
`recordings` to the chosen style, sorts by `take` ascending, and always
returns the first (lowest-numbered) one. `program-builder.js:61` calls this
for every section when assembling a playback program — there's no code path
anywhere that reaches take 2+ of a style that has multiple takes. All takes
*are* present in the manifest (`build_manifest.py` includes every OK take,
not just one), so this is a UI/wiring gap, not a data gap.

**Relevant files:**
- `assets/js/library.js` — `pickRecording()` is the single chokepoint; a
  take-aware version needs a way to receive the caller's take preference.
- `assets/js/program-builder.js:61` — the only caller of `pickRecording`.
- `assets/js/mix-editor.js` / `assets/js/mix.js` — **confirmed in scope**
  (see decision below): currently only stores a per-word *style* assignment
  (`mix.sections`); take choice needs its own slot alongside style, keyed
  the same way (per section+style), since the mix editor is exactly where a
  Pathfinder already picks style per section/word.
- `assets/js/storage.js` — if take choice should survive a reload, it needs
  a field in the persisted state shape (bump `schemaVersion` if the shape
  changes incompatibly — see item 4's rename for the precedent). Note item
  5 (playlists) restructures this same file's persisted shape first; slot
  the take-choice field into whatever shape item 5 lands on rather than
  adding it to the old single-blob shape and migrating it later.
- `index.html` / `assets/js/main.js` — the main (non-mix-editor) style
  selector, which also needs the same control.

**Decided:**
- The control must work **both** in the main style selector area and inside
  the mix editor's per-section/word style painting UI — not just one or the
  other. Concretely: wherever a style is currently chosen for a
  section/word, a take choice for that (section, style) pair needs to be
  reachable right there too.
- Design the control around the common case of **exactly two takes**
  (verify this against the manifest — `build_manifest.py`'s `take_number()`
  numbering, most sections will have 1-2 OK takes per style) rather than an
  open-ended N-item dropdown: a simple two-way toggle/switch reads better
  than a `<select>` when there are only two choices. Still needs to degrade
  sensibly for the rarer case of 3+ takes (e.g. the toggle becomes a small
  cycle-through control, or a dropdown only appears when count > 2) —
  don't hard-code "exactly 2" in a way that breaks or silently drops a
  third take if one shows up later.
- Take choice persists (localStorage), same as style/mix choices today —
  needs a field in the persisted state shape (see `storage.js` above; bump
  `schemaVersion`, no migration needed per this file's pre-release note).

---

## 7. [x] Give each musical style a visual indicator of what it sounds like

**Done — not yet committed.** The confirmed table below is now the
literal shipped data, not just documentation:
- `scripts/build_manifest.py`: new `STYLE_METADATA` dict (vibe emoji +
  `churchFit`, keyed by style id) in the table's exact order -- that
  insertion order *is* the canonical style order now (manifest assembly
  iterates it directly instead of `sorted(styles_present)`). Verified: a
  fresh manifest build shows all 14 styles with zero
  missing-metadata warnings, in the exact confirmed order (Contemporary
  Christian/Indie Pop Ballad first, Multi Style's `["very-uncomfortable",
  "great-match"]` range preserved, Hyperpop Glitchcore last).
- New `assets/js/style-fit.js` (`churchFitEmoji`/`churchFitText`/
  `churchFitDescription`) formats the 3-state value (or a `[dominant,
  best-case]` range) for display -- degrades to an empty string for a
  missing/unrecognized value rather than throwing, so an older cached
  manifest without this field doesn't break rendering.
- `main.js`'s `renderStyleOptions`: native `<option>` text becomes
  self-contained plain text -- `"<vibe emoji> <label> — <fit emoji> <fit
  phrase>"` -- since a native `<select>` can't carry a separate tooltip.
- `mix-editor.js`'s style swatches: richer treatment since they're real
  buttons, not native options -- vibe emoji folded into the button text, a
  separate `churchFit` emoji badge, and a `title` tooltip with the full
  plain-language description.
- `main.js`'s `styleLabelFor` (shared by `player-controls.js`'s scrubber
  label and `sleep-mode.js`'s MediaSession lock-screen `artist`): vibe
  emoji only, not the full church-fit phrase, per this item's own caution
  about limited lock-screen space.

Tests: `tests/style-fit.test.mjs` (fixed values, range formatting,
graceful degradation for missing/unrecognized values) -- `npm test`
passes (82/82, up from 73). Verified in a real browser (Playwright):
confirmed the actual rendered `<option>` text, sort order (Multi Style
showing "😱😇 Varies", Hyperpop Glitchcore last), swatch button text, and
tooltip content all match the confirmed table exactly. Zero console
errors.

**Encountered while implementing:** found `AI_TODO.md` had gained a new
item 8 (not written by this session) partway through this work, describing
a real bug in `program-builder.js`'s dead `FALLBACK_STYLE_ID` fallback --
left entirely untouched, not this item's scope, but noted here since it
wasn't there when this item was originally planned.



**Goal:** Someone who's never heard of "Hyperpop Glitchcore" or "Shoegaze
Slowcore" has no way to guess what it sounds like before picking it — add a
visual indicator (emoji or otherwise) per style, and specifically surface
**how musically close or far each style is from a traditional church
hymn**, since that's the reference point a first-time Pathfinder actually
has.

**Current state — styles carry zero descriptive signal today, just a
label and an arbitrary color:** every style in the manifest is
`{id, label}` (`build_manifest.py`'s `STYLE_DIRS`, e.g. `("hyperpop",
"Hyperpop Glitchcore")` — the label is just the genre name, no description).
The only visual differentiation anywhere is `colorForStyle()`
(`assets/js/constants.js:32`, `STYLE_SWATCH_COLORS`), which cycles a fixed,
colorblind-conscious palette **by a style's position in the list** — purely
for telling swatches apart, carries no genre meaning at all (style #3 isn't
violet because it sounds a particular way, just because it's third).

**This is two distinct pieces of information, not one:**
1. A quick "what does this sound like" vibe indicator — an emoji or two per
   style genuinely evocative of the genre.
2. A single **church-appropriateness score** — collapsed down from two
   underlying axes (see "How the single score was derived" below), not
   shipped as two separate scores. On a **3-state scale** (not a graduated
   meter — one face, not a repeated/filled count):
   - 😇 `great-match` — really great match
   - 😬 `nervous` — a noticeable but not alarming departure
   - 😱 `very-uncomfortable` — a big departure

**Decided — display format:** a single face emoji (😇/😬/😱), optionally
paired with a short plain-language phrase for the text-only surfaces
(native `<select><option>` elements can't carry a screen-reader-announced
tooltip, so don't rely on the emoji alone to carry the meaning — most emoji
do have a reasonable accessible name announced by screen readers, e.g.
"anguished face," but a short phrase alongside it is still the safer
choice). No numeric meter/star-counting needed. Rendered per the file
notes below: text-safe surfaces (main `<select>`, playback/lock-screen
labels) show the emoji + short phrase as plain text; the mix editor's
custom swatch buttons may still add a richer treatment (larger emoji, a
tooltip) since that surface allows it.

**Decided — sort order:** wherever styles are listed, sort by the single
church-appropriateness score, ascending (😇 first); alphabetical as the
tiebreak within a tier, except the 😱 tier has a manually curated order
instead — see the "Ordering note" under the confirmed values table below.

**How the single score was derived (rationale/audit trail, not something
the shipped code needs to recompute):** started from two underlying axes —
how uncomfortable a style would feel in a **CCM-primary church** vs. a
**traditional-hymns-only church** (this app is for a Seventh-Day Adventist
audience, whose services span that whole range). Rule for collapsing to
one score: **use the CCM score by default; use the Hymns score instead
only where Hymns was strictly more comfortable than CCM.** That flip
applies to exactly three styles — Broadway, Shoegaze Slowcore, and
Polka — where orchestral/choral formality (Broadway), a slow contemplative
mood (Shoegaze Slowcore), and being a genuinely old-world traditional form
(Polka) each read as a smaller departure from hymn tradition specifically
than from typical band-led CCM. Every other style either had CCM
already-more-comfortable-or-equal, so CCM is what's shown. The two raw
scores per style aren't part of the shipped schema — just this one
collapsed value — but are recorded here so the reasoning survives if a
value ever needs revisiting.

**Decided — Multi Style is a range, not a fixed point, grounded in real
per-take data, not a guess:** every mp3 in this library carries an
embedded ID3 `genre`/`comment` tag from its original generation. Pulled
across all 74 files in `PBE_2026_2027_Multi_Style/`, the genre tags are
dominated by rock-family variants (Hard Rock, Synth-Rock, Grunge, Dark
Alt-Rock, Alternative Rock, Cinematic Rock, Industrial Alt-Rock,
Folk-Rock, ~30 of 74 files) and punk (Pop-Punk, Skate Punk variants, ~15
files) — together ~60% of the folder — with smaller pockets of Dream
Pop/Synth-wave/Lo-Fi/Electronic (~15 files) and Indie/Heartfelt Folk (~10
files) at the gentler end. So Multi Style's score is a **range** spanning
its gentlest take (folk, comparable to Indie Pop Ballad, 😇) to its
harshest (industrial metal/skate punk, 😱) — see the confirmed table
below — but it's **tier-placed at 😱**, not by its low end, because the
rock/punk majority is what a Pathfinder will actually hit most often, not
the folk minority. This same per-take ID3 metadata could sharpen other
styles' ratings too, but a spot-check of
`PBE_2026_2027_Nu_Metal/` found its tags in a different, less-usable
format (mood-adjective fragments like "A soft," "A warm," and comment text
describing a track as "gentle, reflective... soft cleans, warm ambience" —
i.e. the folder name isn't a reliable proxy for every individual take
either). Auditing all 14 folders' tag consistency is out of scope here —
flag it as a separate future item if finer-than-folder accuracy becomes
worth the effort.

**Confirmed starting values** (user-reviewed, ready to use —
not a guess needing further sign-off, though still update this table if
implementation reveals a style needs adjusting). Reggaeton was corrected
from 😱 to 😬 directly by the user (a direct override of the final score,
not a re-derivation from the two axes above):

| Style | Emoji | Church-appropriateness | Derived from |
|---|---|---|---|
| Contemporary Christian | 🙏 | 😇 | CCM |
| Indie Pop Ballad | 🎹 | 😇 | CCM |
| Broadway | 🎭 | 😬 | **Hymns** (flipped) |
| EDM Gospel Fusion | 🎚️🙌 | 😬 | CCM |
| Modern Country Pop | 🎸 | 😬 | CCM |
| Polka | 🪗 | 😬 | **Hymns** (flipped) |
| Reggaeton | 🥁🔥 | 😬 | user correction (was 😱/CCM) |
| Shoegaze Slowcore | 🌫️ | 😬 | **Hymns** (flipped) |
| Multi Style | 🎲 | 😱 – 😇 (dominant range shown first) | CCM |
| Electro Country (Avicii Style) | 🤠⚡ | 😱 | CCM (tie) |
| Hip Hop | 🎤 | 😱 | CCM (tie) |
| Phonk | 👹🎧 | 😱 | CCM (tie) |
| Nu Metal | 🤘 | 😱 | CCM (tie) |
| Hyperpop Glitchcore | ⚡🌀 | 😱 | CCM (tie) |

**Ordering note:** every tier sorts alphabetically *except* the 😱 tier,
where the user specifically asked for Nu Metal and Hyperpop Glitchcore to
sit last — most uncomfortable of the fourteen — with Hyperpop Glitchcore
dead last as the single most extreme style in the library, and Multi Style
placed first within that tier (least severe *within* 😱, since unlike the
other four it isn't uniformly uncomfortable — see the tier-placement
rationale above). Both are deliberate departures from the alphabetical
tiebreak used everywhere else in this table; don't "fix" either back to
alphabetical.

**Relevant files — every consumer of `manifest.styles`, since that's the
single place style metadata already flows through:**
- `scripts/build_manifest.py`'s `STYLE_DIRS` (currently `{folder: (id,
  label)}`) — natural place to add the new per-style data, e.g. extend to
  `(id, label, emoji, churchFit)` where `churchFit` is one of
  `"great-match" | "nervous" | "very-uncomfortable"` (a fixed value) or a
  `[dominant, best-case]` pair of those same three values for a range
  (Multi Style's case — dominant first, matching the decided display
  order, not ascending/low-to-high) — or
  add a parallel `STYLE_METADATA` dict, then fold it into the manifest's
  `"styles"` list output (`main()`, around `build_manifest.py:174`)
  alongside `id`/`label` so every consumer picks it up the same way the
  label already does.
- `assets/js/main.js:226-237` (`renderStyleOptions`) — builds native
  `<select><option>` elements for the main style picker; `option.textContent`
  is plain text only, so this render target needs the **text-safe**
  representation (emoji prefix + short label), not a graphical meter.
- `assets/js/mix-editor.js:34-46` (the `.style-swatch` buttons) — real DOM
  buttons, not native `<option>`s, so this render target *can* carry a
  richer visual (an actual small meter element, a `title` tooltip, stacked
  emoji) if that's wanted, rather than being stuck with the same text-only
  treatment as the main picker.
- `assets/js/player-controls.js:48` and `assets/js/sleep-mode.js:97` —
  both display `styleLabelFor(id)` as plain text during playback (a
  scrubber label, and the MediaSession lock-screen `artist` field
  respectively) — another text-only render target; whatever gets added to
  the label string here should stay short, since lock-screen metadata
  space is limited.
- `assets/css/styles.css:660-686` (`.style-swatch`) — existing swatch
  styling to extend if the mix editor gets a richer treatment than the
  plain `<select>`.

No open questions remain on this item — format, sort order, per-surface
treatment, and the starting values are all decided above.

---

## 8. [ ] Fall back to the Pathfinder's selected default style, not alphabetical-first, when a section has no recording in the active style

**Goal:** When a section doesn't have a recording in the currently active/
painted style, the program builder should fall back to the Pathfinder's
chosen **default musical style** (the one they picked in the main style
selector), not whatever recording happens to sort first.

**Root cause / current state (verified against code):**
- `assets/js/program-builder.js:4` defines `const FALLBACK_STYLE_ID =
  "default"`, intended as the reference style to fall back to when a
  section+style combo has no recording. But no manifest style is ever
  actually named `"default"` — confirmed against
  `scripts/dev-manifest.local.json`'s 14 real style ids (broadway,
  contemporarychristian, edmgospel, electrocountry, hiphop, hyperpop,
  indiepop, moderncountry, multistyle, numetal, phonk, polka, reggaeton,
  shoegaze). So `alignmentFor(FALLBACK_STYLE_ID)` at
  `program-builder.js:67` always resolves to `null`.
- Because of that, the fallback silently falls through to
  `section.recordings[0]` (same line, `67`) — i.e., whichever recording
  happens to be first after `scripts/build_manifest.py:182` sorts
  `recordings` by `(style, take)`. In practice that's the
  alphabetically-first style, "Broadway," which has no relation to what
  the Pathfinder actually selected.
- The Pathfinder's real "default style" already exists as a concept —
  `mix.defaultStyleId` (`assets/js/mix.js:10-11, 34-41`), set initially
  from `manifest.styles[0].id` (`mix.js:73` / `main.js:256`) and persisted
  as `activeStyle` in `storage.js:9`. This is a *different* thing from
  `program-builder.js`'s vestigial `FALLBACK_STYLE_ID`, and the two were
  never wired together.
- Per-word gap-filling is already plumbed for this — `program-builder.js:
  73-89` tags each patched-in word with `fallbackFrom`/`reason`
  (`"alignment-gap"` / `"style-unavailable"`), and `main.js:236-248`'s
  `renderFallbackNote()` already surfaces these to the user. So this is a
  fix to *which* style gets used as the fallback source, not new UI
  plumbing — the fallback machinery and its user-facing note already exist.

**Fix:** `alignmentFor(...)`'s fallback chain in `program-builder.js:67`
should try the Pathfinder's actual `mix.defaultStyleId` (passed into
`buildProgram`) before falling through to `section.recordings[0]`. The
dead `FALLBACK_STYLE_ID = "default"` constant should either be removed or
repointed at the real default-style id passed in — don't leave a string
literal that can never match a real style id.

**Relevant files:**
- `assets/js/program-builder.js:4, 59-67, 73-89` — the fallback chain and
  per-word gap-filling to fix.
- `assets/js/mix.js:10-11, 34-41, 73` — where `defaultStyleId` already
  lives; `buildProgram`'s caller needs to pass this through if it doesn't
  already.
- `assets/js/main.js:236-248, 256` — `renderFallbackNote()` (no change
  expected, already generic) and where `defaultStyleId` is initialized.
- `scripts/build_manifest.py:182` — confirms why "Broadway" ends up as the
  de facto fallback today (alphabetically-first after the `(style, take)`
  sort); context only, no change needed here.

**Open question:** confirm `buildProgram`'s call site(s) actually have
`mix.defaultStyleId` in scope at the point `alignmentFor` needs it — if
`program-builder.js` doesn't currently receive `mix` (only `section`/
`styleId` per call), this needs a signature change to thread the
Pathfinder's default style through, not just a one-line fix inside
`alignmentFor`.

---

## 9. [x] Redo the study mode and masking UI entirely

**Done — not yet committed.** Directly user-specified layout, implemented
as given: after the style-selection controls, an "Karaoke Mode" subtitle
(`<h3 class="karaoke-mode-heading">`), then in order: a slider from
"Karaoke" (nothing blanked) to "Memorized" (everything blanked), paired
with a number input for typing the percent directly (bidirectionally
synced -- `assets/js/main.js`'s `hintLevelSlider`/`hintLevelInput`); "Get
harder each replay"; "Blank length matches word length"; "Scored" (a
checkbox, not a mode dropdown) with an Input method sub-row that appears
only when checked. Defaults to unscored, 0% blanked ("unscored karaoke
mode," as specified).

**Disappearing Word is gone, deliberately** (explicitly confirmed by the
user, not an oversight): `study-modes/unscored.js` no longer has a
mask-style concept at all -- it's unconditionally "blank until sung,"
parameterized by one `blankFraction` (0-1) derived from the slider.
`blankFraction=0` is mathematically identical to the old "None" style
(confirmed via `selectHintedIndices(canonical, 1)` hinting every index),
so collapsing the three old mask styles down to just this one slider lost
no real capability except Disappearing Word's distinct "vanish ahead of
playback" mechanic, which is what was asked to go. `rampOnRepeat` now
ratchets `blankFraction` *up* each replay (capped at 1), inverted from the
old "ratchet reveal down" framing to match the new blank-percent framing.

**"Store settings by playlist"**: new `studyOptions` field on the playlist
record (`assets/js/playlists.js`'s `defaultStudyOptions()` /
`createPlaylistRecord()`) -- `{blankPercent, rampOnRepeat, lengthMatched,
scored, scoredInput}`. Persisted the same way as everything else
playlist-scoped (`persistActivePlaylist()` in `main.js`, which the
Karaoke Mode controls were deliberately declared late enough in the file
to still safely reference via closure -- see the comment on
`persistActivePlaylist()`), restored via `syncStudyOptionsFromActivePlaylist()`
on every playlist switch/delete, and carried through `share.js`'s payload
(no style-dictionary re-keying needed, no style ids inside). `scoredInput`
stays `null` until a Pathfinder actually picks one, so a fresh playlist
still auto-detects by browser capability rather than inheriting a stale
guess.

**Also fixed while in here:** the top nav's self-link still said
"Playlist" (`index.html`, `<a class="active" href="/">`) -- missed by the
original rename item since that item's occurrence table predates this nav
link being audited. Now "Karaoke."

Tests: `tests/unscored.test.mjs` rewritten for the `blankFraction`-only
API (0/1 endpoints, an intermediate value, ramp-up-capped-at-1 including a
multi-replay-cycle regression check); `tests/playlists.test.mjs` and
`tests/share.test.mjs` extended for `studyOptions` (defaults, deep-copy
independence on duplicate, share/import round-trip, graceful `null` when
absent) -- `npm test` passes (86/86, up from 82). Verified in a real
browser (Playwright): confirmed the old `modeSelect`/`maskStyleSelect`/
`lookaheadSelect` are gone from the DOM entirely; slider <-> number-input
sync works both directions; Scored reveals the input-method row and
auto-detects; blanking actually applies to real rendered words at a
mid-range percentage; a new playlist starts at defaults while an existing
one's settings survive both a playlist switch *and* a full page reload
(real `localStorage` persistence, not just in-memory state). Zero console
errors.

**Not done — explicitly deferred, not implemented speculatively:** the
user separately raised a planned architecture change (instrumental/vocal
stem tracks, so blanking affects what's *heard*, not just what's shown) as
something to "start on if you want," but with no stem files provided yet
and framed as future work ("I plan to... in a bit"). Writing playback code
against assets that don't exist yet isn't useful -- see the architecture
notes below instead, which capture how it would integrate with today's
`playback-engine.js`/`program-builder.js`/`mix.js` so whoever picks this
up later (possibly still this session) has a running start once real stem
files exist to build and test against.

---

## 10. [ ] Architecture notes: instrumental/vocal stem tracks for audio-level blanking

**Not started -- planning only, no stem audio exists yet to build or test
against.** Today, "blanking" (Karaoke Mode's slider, item 9) is purely
visual -- `study-modes/unscored.js` hides/reveals *displayed text*; the
audio itself is one fixed recording per section+style+take
(`pickRecording()` in `library.js`) and plays in full regardless of what's
blanked on screen. The user's stated plan: provide separate instrumental
and vocal stem tracks per recording, so a blanked word's *vocal* audio can
be ducked/muted too, not just its on-screen text -- true "guess the words"
recall, not just "don't read ahead."

**Why this is a real architecture change, not a small addition:**
- `assets/js/playback-engine.js` currently drives exactly **two** `<audio>`
  elements total (`elements = [new Audio(), new Audio()]`), used
  specifically for crossfading between *consecutive program blocks* (the
  standby element preloads/crossfades into the next block, see
  `beginCrossfade()`/`completeCrossfade()`). Stems need a *second, parallel*
  pair (or more) -- an instrumental track and a vocal track playing
  **simultaneously**, in sync, for the *same* block, not sequentially like
  today's two elements. That's a different axis of "multiple audio
  elements" than what exists now, not a bigger version of the same thing.
- Keeping two independently-controlled tracks (instrumental always
  audible, vocal duckable) in sample-accurate sync via two separate
  `<audio>` elements is a known hard problem (`<audio>` elements don't
  guarantee frame-accurate sync with each other, especially across a seek
  or a crossfade) -- worth researching a `Web Audio API` (`AudioContext` +
  `AudioBufferSourceNode`/`MediaElementAudioSourceNode` + `GainNode` per
  stem) approach instead of two more plain `<audio>` tags, specifically
  *because* of this sync requirement, before assuming the existing
  dual-`<audio>`-element pattern just extends.
- `program-builder.js`'s `blocks` currently carry one `audioUrl`/`words`
  pair per segment (`recording.audioUrl`, per `pickRecording()`'s chosen
  take). Stems mean each block needs (at minimum) an instrumental URL and
  a vocal URL, both from the *same* take -- `build_manifest.py` would need
  to know about and emit both per recording (assuming stems get delivered
  as sibling files per existing take, e.g. `<take>.instrumental.mp3` /
  `<take>.vocal.mp3`, alongside the current single mp3 -- an assumption to
  confirm once real files arrive, not decided here).
- The actual "duck the vocal for this word" trigger already has a natural
  hook point: `unscored.js`'s per-word blanked/revealed state
  (`hinted`/`revealed` sets, driven by the same `blankFraction` the visual
  slider already uses) is exactly the signal audio-ducking would key off
  of -- this item's job is *only* wiring that same signal to a vocal-track
  gain node at the right sample time, not inventing a new "what's
  currently blanked" concept. Word-level audio ducking needs sample-accurate
  timing (`word.start`/`word.end`, already in every `.json` sidecar) fed to
  a `GainNode.gain.setValueAtTime()`-style ramp, not just a boolean toggle.
- Sing-Along scoring (`stt-score.js`) listens to the Pathfinder's own mic
  while the *reference* track plays for comparison -- confirm stems don't
  change that mode's assumptions (does Sing-Along want the instrumental
  only, so the Pathfinder's own singing isn't drowned out/scored against
  itself? An open product question for whoever picks this up, not
  something to guess at here).

**Suggested first real step once stem files exist:** a small standalone
spike -- two stems for *one* recording, played via Web Audio API
`GainNode`s, confirm they stay in sync through a seek and a section
change -- before touching `playback-engine.js`'s block-advancing/crossfade
logic at all. That logic is already intricate (see its own extensive
comments on crossfade timing and the OneDrive/preload edge cases); adding
stem-awareness to it blind, without first confirming the sync approach
works in isolation, risks destabilizing playback for every study mode at
once, not just an opt-in stem feature.

**Relevant files (for whoever picks this up):** `assets/js/playback-engine.js`
(the two-`<audio>`-element crossfade core), `scripts/build_manifest.py`
(would need to emit stem URLs per recording, once the delivery format is
known), `assets/js/program-builder.js` (blocks would carry stem URLs
alongside/instead of the single `audioUrl`), `assets/js/study-modes/unscored.js`
(the existing per-word blank/reveal signal to wire audio ducking to).
