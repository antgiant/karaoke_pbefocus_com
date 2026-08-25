// Lazily loads word-timing data for a selection's recordings (AI_TODO.md:
// the manifest used to inline every recording's `words` array, which grew
// the whole-library manifest to ~89MB -- too large to fetch as the very
// first step, before a Pathfinder has picked anything to study). Each
// recording now carries a `wordsUrl` (built_manifest.py, same convention as
// instrumentalUrl/vocalUrl) pointing at its own already-existing sidecar
// file instead -- fetched here, once, only for whichever section(s) are
// actually about to be studied or mix-edited.

import { findSection, parseWordsFile } from "../library.js";

/**
 * For every recording in every selected section that doesn't yet have
 * `.words` loaded, fetches and attaches it in place via `readWords(wordsUrl)`
 * (one of the per-source readers -- local-library.js's/onedrive-library.js's/
 * googledrive-library.js's readWordsAtPath, or audio-cache.js's
 * fetchCachedJson for a plain hosted URL -- see main.js's wiring).
 * Already-loaded recordings are skipped, so this is cheap and safe to call
 * before every playback start or mix-editor open, even repeatedly for the
 * same selection.
 */
export async function ensureWordsLoaded(manifest, keys, readWords) {
  const pending = [];
  for (const key of keys) {
    const section = findSection(manifest, key);
    if (!section) continue;
    for (const recording of section.recordings) {
      if (!recording.words) pending.push(recording);
    }
  }
  await Promise.all(
    pending.map(async (recording) => {
      const json = await readWords(recording.wordsUrl);
      recording.words = parseWordsFile(json);
    })
  );
}
