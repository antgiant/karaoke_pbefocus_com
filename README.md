# PBE Karaoke (Static Site)

An interactive scripture-song study tool for the PBE Karaoke library: pick
chapters/verses, choose the musical style for any part of the passage down
to a single word, and drill it with several karaoke-style memorization
modes -- or just let it play hands-off like a normal playlist.

Static HTML/CSS/JS, no build step, no backend -- works on GitHub Pages or
any local static server, matching the other `pbefocus.com` family tools.

## The Library Isn't Public Yet

This app ships with **no song content at all**. Everything -- audio, lyrics,
word timing -- lives behind a private library manifest URL you supply,
either as `?library=<url>` in the address bar or pasted into the form on
first load. The manifest URL is remembered in `localStorage` for later
visits, but always re-fetched (never cached), so pulling the manifest down
revokes access. See `AGENTS.md` and `scripts/build_manifest.py` for how
that manifest gets built from the private song library -- that pipeline and
its output never belong in this public repo (see `.gitignore`).

## Current Features

- Named, multi-playlist support: create/rename/duplicate/delete any number
  of playlists (`assets/js/playlists.js`), each with its own
  chapter/verse selection and genre mix, switchable from the Playlists
  panel. Sharing a playlist (link + QR code, or a downloadable file for a
  playlist too large for a reliable QR code) asks explicitly, every time,
  whether to also bundle library access -- off by default, since that
  grants the recipient your whole library, not just the one playlist (see
  `assets/js/share.js`'s compact wire format: a per-payload local style
  dictionary + run-length encoding, since a real mix is usually a handful
  of large painted ranges, not one style per word). QR rendering is via a
  vendored copy of `qrcode-generator` (MIT, dependency-free) --
  `assets/js/vendor/qrcode-generator.mjs`.
- Chapter/verse selection tree, driven entirely by the manifest
- Genre mix editor: paint any range of words -- down to one word -- with a
  different musical style, via a Pointer-Events drag/tap UI that works the
  same on mouse and touch
- Alternate takes: most chapter/style combos have 2+ recorded takes, and a
  Pathfinder can now actually reach the others -- a "Prefer alternate take"
  toggle next to the default style sets a blanket preference, and each
  section in the mix editor gets its own take control (a checkbox for the
  common 2-take case, a dropdown if a style has 3+) that overrides the
  blanket preference just for that section+style. See `getTakeRank`/
  `setTakeRank`/`setDefaultTakeRank` in `assets/js/mix.js`.
- Style indicators: every style shows a vibe emoji plus a
  church-appropriateness face (😇 great match / 😬 a bit of a stretch / 😱
  a big departure) for a Seventh-Day Adventist audience whose services
  range from traditional-hymns-only to primarily-CCM -- so "Hyperpop
  Glitchcore" isn't a total mystery before you pick it. Set once, per
  style, in `scripts/build_manifest.py`'s `STYLE_METADATA` and formatted
  for display by `assets/js/style-fit.js`; the main style picker shows
  emoji + a short phrase (self-contained plain text, since a native
  `<select>` can't carry a tooltip), while the mix editor's style swatches
  add a title tooltip with the full description. Styles are listed
  everywhere in church-appropriateness order (😇 first), not alphabetically.
- Windowed karaoke lyrics display: a standard 2-line karaoke layout
  (current line + a dimmed preview of the next), word-by-word highlight
  fill, and a scroll-up transition between lines -- rather than showing an
  entire passage at once and auto-scrolling to follow it. A long passage
  never fights a Pathfinder trying to scroll or interact with the page,
  since there's nothing to scroll past. Previous/Next-line buttons let a
  Pathfinder browse independent of playback (pausing it while they do).
  See `assets/js/study-modes/word-stream.js` for the shared implementation
  every study mode below builds on.
- Karaoke Mode: one slider from "Karaoke" (nothing blanked) to "Memorized"
  (everything blanked until sung), driven by `assets/js/study-modes/unscored.js`
  -- plus "Get harder each replay" (ratchets the blank amount up on every
  replay of the same section), "Blank length matches word length", and a
  "Scored" checkbox that switches to Type Ahead (types-to-unlock recall) or
  Sing-Along (Web Speech API voice scoring, Chrome/Edge only -- auto-selected
  when the browser supports it, with a manual override either way). All of
  these settings are saved per playlist, like everything else about it.
  Defaults to unscored, nothing blanked. (This replaced an earlier
  mode/mask-style-dropdown design -- Disappearing Word's separate "vanish
  ahead of playback" mechanic was removed outright in the redesign, not
  carried forward.) An additional "Also fade out the sung words when
  blanked (where available)" checkbox extends the blanking from the
  on-screen text to the actual audio -- for whichever recordings have
  separated instrumental/vocal stems (a growing but still small subset of
  the library), the vocal track fades toward silence for exactly the
  words currently blanked, true "guess the words" recall rather than just
  "don't read ahead." Off by default (only takes effect for a stem-backed
  recording, otherwise a no-op). See `scripts/organize_stems.py` for how a
  stem-separation drop gets sorted into the library, and
  `assets/js/playback-engine.js`'s `setVocalDuckPredicate` for the
  playback side.
- A block-to-block crossfade smooths every transition, but a boundary
  where the *musical style* actually changes (a Customize Genre Mix paint
  boundary) gets a longer, more deliberate fade than a same-style segment
  seam -- "jumping between genres" is a bigger audible event than a
  same-recording gap patch, and sounds like one.
- Sleep Mode: a full-screen, warm/dark night skin that plays the current
  selection hands-off, with a sleep timer (fade-out) and MediaSession
  lock-screen controls
- Light/dark theme, matching `quiz_pbefocus_com`'s exact token set

## Run Locally

**Use a server that supports HTTP Range requests -- this genuinely matters,
not just for speed.** Seeking an `<audio>` element to any position beyond
what's already sequentially buffered requires the browser to ask the server
for a specific byte range; without that, the browser can't jump ahead at
all (`audio.seekable` never extends past the start), so anything past the
very first few seconds of a track becomes unreachable -- playback, the
karaoke highlight, and click-to-seek all silently break as soon as a study
session needs to start mid-file (which is the normal case, not an edge
case). Plain `python3 -m http.server` does **not** support Range requests
(confirmed against Python 3.14) and should not be used for this app.

```bash
npx http-server -p 8000 -c-1
```

(`http-server` supports Range out of the box; `-c-1` disables caching, handy
while iterating.) Then open `http://localhost:8000/?library=<your manifest
URL>`. Any other local server with real Range support works too -- check
with `curl -I -r 0-100 <url-to-an-mp3>` and confirm you get back
`206 Partial Content` with an `Accept-Ranges: bytes` header, not `200 OK`.

The same requirement applies to wherever you end up hosting the real
content for production: virtually every static host (GitHub Pages, S3,
Cloudflare R2/Pages, Netlify, Backblaze B2, a plain nginx/Apache) supports
Range by default, so this is unlikely to bite you there -- it's specifically
ad-hoc dev servers like Python's that tend not to.

There's no sample manifest checked in (it would contain the private song
content) -- generate one from your own copy of the library with
`scripts/build_manifest.py` for local testing.

## Tests

```bash
npm install   # first time only -- installs jsdom, the only dev dependency
npm test
```

Runs Node's built-in test runner (`node --test`) against `tests/`. Still no
build step for the app itself -- this only exists to test it. Covers the
DOM-independent pure-logic pieces directly (e.g. `word-stream.js`'s
`buildLines()`) and the DOM-touching pieces via `jsdom` (see
`tests/helpers/dom.mjs`) with a small fake playback engine
(`tests/helpers/fixtures.mjs`) standing in for `assets/js/playback-engine.js`
-- no real audio/network/manifest needed to run the suite. Add new tests
alongside the module they cover, one `<module>.test.mjs` per source file (or
`<module>.<behavior>.test.mjs` for a large file, e.g.
`word-stream.buildLines.test.mjs`).

## Manifest Schema

See the `year` / `styles` / `sections` shape documented at the top of
`scripts/build_manifest.py`. Each section groups one book/chapter(/verse
range)'s recordings across styles; each recording carries its own
verse-tagged word timing (`{word, start, end, verse}`), produced by
`scripts/correct_lyrics.py`.

## Pipeline

The lyrics/transcription pipeline that produces the manifest's source data
is documented in `AGENTS.md`, not here -- this README covers the app that
consumes it.
