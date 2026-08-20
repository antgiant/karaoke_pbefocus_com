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
