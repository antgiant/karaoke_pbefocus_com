# PBE Playlist (Static Site)

An interactive scripture-song study tool for the PBE Playlist library: pick
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

- Chapter/verse selection tree, driven entirely by the manifest
- Genre mix editor: paint any range of words -- down to one word -- with a
  different musical style, via a Pointer-Events drag/tap UI that works the
  same on mouse and touch
- Study modes: Standard Karaoke, Disappearing Word, Invisible Word,
  Blackout Ramp (masks more on each replay), Type Ahead (types-to-unlock
  recall), and Sing-Along (Web Speech API scoring, Chrome/Edge only)
- Sleep Mode: a full-screen, warm/dark night skin that plays the current
  selection hands-off, with a sleep timer (fade-out) and MediaSession
  lock-screen controls
- Light/dark theme, matching `quiz_pbefocus_com`'s exact token set

## Run Locally

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/?library=<your manifest URL>`.

There's no sample manifest checked in (it would contain the private song
content) -- generate one from your own copy of the library with
`scripts/build_manifest.py` for local testing.

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
