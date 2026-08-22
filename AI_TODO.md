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

## 1. Main "Musical Style" dropdown should offer takes, not just a count hint

Right now `renderStyleOptions` (assets/js/main.js:346) puts one `<option>` per
style in `#styleSelect`, with a parenthetical `(N takes)` hint computed by
`maxTakeCountForStyle` (assets/js/library.js:99) -- but that count scans
every section in the *entire* manifest (`for (const section of
manifest.sections)`), not the take(s) actually relevant to whatever the
Pathfinder is currently looking at, and there's no way to pick a specific
take from this dropdown at all -- the comment right above it says so
outright ("picking a specific take only happens by painting it in the mix
editor, not from this selector").

Contrast with Customize Genre Mix's palette (assets/js/mix-editor.js:90-105),
which already does this the way the Pathfinder wants: it builds one button
*per take* (`maxTakeCount` from assets/js/mix.js:45, scoped to only the
currently-selected sections in the mix, not the whole manifest), labeled
"Style · Take N", using `makePaintId`/`parsePaintId` (assets/js/mix.js) to
address a specific take as its own paintable id.

Goal: make the main dropdown list every take the same way (e.g. "Broadway ·
Take 1", "Broadway · Take 2" as separate options), scoped correctly like the
mix editor's version, rather than one option + an approximate count.

Open question: `mix.defaultStyleId` is documented as "never a paint id with a
take suffix" (assets/js/mix.js:17) -- it's the uniform fill for newly
selected sections and the last-resort fallback in program-builder.js. Letting
the main dropdown select a specific take means either relaxing that
invariant (defaultStyleId becomes a real paint id, take suffix and all) or
introducing a separate default-take concept alongside it -- resolve which
before implementing, it changes what `setDefaultStyle`/`syncMixToSelection`
(assets/js/mix.js) need to do.
