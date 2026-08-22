# PBE Karaoke — Agent Instructions

Static scripture-song karaoke study app -- see `README.md` for what it does,
how to run it locally, and how to run the tests. This repo ships with **no
song content**: the private song library, its NKJV reference text, and the
pipeline that produces them all live outside this repo's tracked files and
git history until copyright clearance is granted (see `.gitignore` and
`README.md`'s "The Library Isn't Public Yet").

If you're working on that pipeline rather than the public app, the import
below pulls in its documentation automatically whenever it's present on
disk (i.e. on a machine that actually has the private library) -- it's
gitignored, so it won't exist in a fresh clone of this repo.

@PBE_2026_2027/AGENTS.md

## Conserve context: compact/clear often

Actively manage session context rather than letting it grow unchecked --
compact or clear as often as it's safe to, not only when a session is at
risk of running out. This matters most when working through
`AI_TODO.md`: its items are deliberately independent (each one's "Relevant
files" is self-contained, see that file's own intro), so there's rarely a
reason to carry one item's exploration/discussion into the next. Once an
item is finished and removed from `AI_TODO.md`, or a round of decisions on
an item has just been recorded into it, that's a natural, safe point to
compact or clear before starting the next item -- don't wait for a long
multi-item session to accumulate stale context from items that are already
done.

## Go-live checklist: shared header/footer site nav

`index.html`'s header/footer nav (`[data-pbe-site-nav]` /
`[data-pbe-site-footer-nav]`) is populated at runtime by
`https://pbefocus.com/site-nav.js`, shared across pbefocus.com,
quiz.pbefocus.com, and this app (karaoke.pbefocus.com) — see that file's
`SITES` array in the `pbefocus.com` repo. This app's `karaoke` entry there
currently has `live: false`, so it only shows up in *this* site's own nav
(forced in via the current-site override) and stays hidden from
pbefocus.com's and quiz's nav. **When this app actually goes live** (repo
pushed to GitHub, `karaoke.pbefocus.com` DNS/CNAME live, GitHub Pages
serving it), flip `karaoke`'s `live` to `true` in `pbefocus.com/site-nav.js`
and redeploy that repo — otherwise this app stays invisible from the other
two sites' navs indefinitely.
