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

## 14. [ ] Dropbox folder-link library source

**Goal:** same pattern again: paste a Dropbox shared-folder link into the
gate and read the manifest + audio from it.

**Login — needs to be decided before implementing, not guessed:** Dropbox
has no anonymous, credential-free API for walking a shared folder's
contents. Two real options, and they trade off differently from the
OneDrive/Google Drive sources above:
- **App-owned token (recommended to investigate first):** register one
  Dropbox app for this project and generate a single long-lived access
  token under *your* Dropbox account once, ship no user-facing login at
  all. Dropbox's sharing endpoints (e.g. resolving a shared link's
  metadata and listing/downloading its contents) accept a shared-link URL
  as an argument regardless of which account created the link, so one
  token you control should be able to read *any* Pathfinder's "anyone with
  the link" folder without them signing in to anything. This would make
  Dropbox the only one of the three with truly zero Pathfinder-facing
  login — confirm this against Dropbox's current Sharing API docs
  (`developers.dropbox.com/dbx-sharing-guide`) before committing to it,
  since it wasn't verified end-to-end against a live folder in this
  research pass.
- **Per-Pathfinder OAuth (fallback if the above doesn't pan out):** same
  shape as the OneDrive source — each Pathfinder signs in with their own
  free Dropbox account via Dropbox's browser OAuth flow, no backend
  needed.
- A raw `?dl=1` direct-download link (no API/app registration at all) was
  also considered and rejected as the primary mechanism: it forces a
  whole-folder `.zip` download rather than per-file access, sources
  disagree on the size cap (1 GB vs. 250 GB turned up in different
  places), and it can't do the incremental per-recording fetch-and-cache
  this app relies on (`offline/audio-cache.js`). It may still be worth a
  per-*file* direct link as the actual audio-byte fetch once a file's
  path is known via the API, mirroring how OneDrive's Graph-minted
  download URLs are used only at play time, not for bulk fetching.

**Quota:** Dropbox rate-limits per authorizing access token, not with
fixed published numbers (their guide describes limits as dynamic/
per-authorization, growing with usage over time) — so if the app-owned-
token approach above pans out, *every* Pathfinder's traffic shares one
token's budget, same shared-ceiling caveat as the Google Drive source
above, and worth load-testing before relying on it for a live group
session rather than assuming headroom.

**Relevant files:** `assets/js/gate.js`, `assets/js/constants.js`, a new
`assets/js/offline/dropbox-library.js` modeled on
`assets/js/offline/onedrive-library.js`, `PBE_2026_2027/AGENTS.md`.

**Open question:** app-owned token vs. per-Pathfinder OAuth (above) needs
an answer — from Dropbox's actual current docs/a real test, not
assumption — before writing the folder-walk code, since it changes both
the login UX and which quota bucket applies.
