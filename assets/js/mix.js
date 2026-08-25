import { findSection, listTakes, orderedSections, sectionKey } from "./library.js";

/**
 * The genre-assignment model: for every selected section, an array of
 * *paint ids* -- one per canonical (scripture) word -- recording which
 * style (and, where a style has more than one take, which take) plays that
 * word. Adjacent equal entries collapse into one playback block (see
 * getRuns/program-builder.js); painting is just overwriting a subrange of
 * this array, right down to a single index.
 *
 * A paint id is either a plain style id ("hiphop", meaning that style's
 * first/lowest take) or "<styleId>::take<N>" for its Nth take (N >= 2) --
 * see makePaintId/parsePaintId. This is AI_TODO.md item 1's redesign: a
 * take is just another paintable brush alongside each style, not a
 * separate take-selector control layered on top of style painting (the
 * old mix.defaultTakeRank/mix.takeOverrides/getTakeRank/setTakeRank, now
 * removed). mix.defaultStyleId is a paint id too -- the main style <select>
 * (main.js's renderStyleOptions) offers one option per take, same as the
 * mix editor's palette, so picking a take there is just picking a
 * different paint id as the default. It's still the uniform fill for
 * newly-selected sections (see syncMixToSelection) and the last-resort
 * fallback in program-builder.js -- those just don't care that the id
 * might carry a take suffix.
 */
const TAKE_MARK = "::take";

/** Combines a style id + take rank (0 = first/lowest take) into one paintable id. Rank 0 collapses to the plain styleId (no suffix), so the common single-take case is indistinguishable from before this existed. */
export function makePaintId(styleId, takeRank = 0) {
  return takeRank > 0 ? `${styleId}${TAKE_MARK}${takeRank + 1}` : styleId;
}

/** The inverse of makePaintId -- splits a paint id back into {styleId, takeRank}. A plain styleId (no marker) is rank 0. */
export function parsePaintId(paintId) {
  const idx = paintId.lastIndexOf(TAKE_MARK);
  if (idx === -1) return { styleId: paintId, takeRank: 0 };
  const takeNumber = Number(paintId.slice(idx + TAKE_MARK.length));
  return { styleId: paintId.slice(0, idx), takeRank: takeNumber - 1 };
}

/**
 * Highest number of takes `styleId` has in any single section currently in
 * the mix (i.e. currently selected) -- how many take-variant palette
 * entries the mix editor should offer for this style. 1 (no variants,
 * just the plain style) if it has no multi-take recording in any
 * currently-selected section.
 */
export function maxTakeCount(manifest, mix, styleId) {
  let max = 1;
  for (const key of mix.sections.keys()) {
    const section = findSection(manifest, key);
    if (!section) continue;
    max = Math.max(max, listTakes(section, styleId).length);
  }
  return max;
}

export function createMix(defaultStyleId) {
  return { defaultStyleId, sections: new Map() };
}

/** Ensures every currently-selected section has an assignment array, sized to its canonical word count. Uses the manifest's precomputed section.wordCount (same number canonicalWords(section).length would give, once that section's recordings' words are actually loaded) rather than the real word content -- this runs synchronously on every selection change, well before a section's words are lazily fetched (see offline/words-loader.js), so it must not depend on them. */
export function syncMixToSelection(mix, manifest, selectedKeys) {
  const selected = new Set(selectedKeys);
  for (const key of selected) {
    if (mix.sections.has(key)) continue;
    const section = findSection(manifest, key);
    if (!section) continue;
    mix.sections.set(key, new Array(section.wordCount).fill(mix.defaultStyleId));
  }
  for (const key of [...mix.sections.keys()]) {
    if (!selected.has(key)) mix.sections.delete(key);
  }
}

/**
 * Changes the overall default style. Sections the Pathfinder hasn't
 * customized (every word still equals the old default) switch over with it;
 * a section they've already painted a mix into is left alone.
 */
export function setDefaultStyle(mix, newStyleId) {
  for (const [key, assignment] of mix.sections) {
    if (assignment.every((s) => s === mix.defaultStyleId)) {
      mix.sections.set(key, new Array(assignment.length).fill(newStyleId));
    }
  }
  mix.defaultStyleId = newStyleId;
}

export function paintRange(mix, sectionKeyStr, startIndex, endIndexInclusive, paintId) {
  const assignment = mix.sections.get(sectionKeyStr);
  if (!assignment) return;
  const lo = Math.max(0, Math.min(startIndex, endIndexInclusive));
  const hi = Math.min(assignment.length - 1, Math.max(startIndex, endIndexInclusive));
  for (let i = lo; i <= hi; i++) assignment[i] = paintId;
}

/** Run-length-encodes a section's assignment into contiguous {styleId, startIndex, endIndex} blocks. `styleId` here is actually a paint id (see the file-top comment) -- callers that need a real manifest style id (e.g. for color/label lookups) must decompose it via parsePaintId first. */
export function getRuns(mix, sectionKeyStr) {
  const assignment = mix.sections.get(sectionKeyStr);
  if (!assignment || assignment.length === 0) return [];
  const runs = [];
  let runStart = 0;
  for (let i = 1; i <= assignment.length; i++) {
    if (i === assignment.length || assignment[i] !== assignment[runStart]) {
      runs.push({ styleId: assignment[runStart], startIndex: runStart, endIndex: i - 1 });
      runStart = i;
    }
  }
  return runs;
}

export function toSerializable(mix) {
  return {
    defaultStyleId: mix.defaultStyleId,
    sections: Object.fromEntries(mix.sections),
  };
}

/** Restores a mix, but only reuses per-section arrays whose length still matches the current manifest
 *  (a changed manifest could shift canonical word counts, and a stale-length array would misalign). */
export function fromSerializable(saved, manifest) {
  const mix = createMix(saved?.defaultStyleId ?? manifest.styles[0]?.id ?? null);
  if (!saved?.sections) return mix;
  for (const section of orderedSections(manifest)) {
    const key = sectionKey(section);
    const savedAssignment = saved.sections[key];
    if (Array.isArray(savedAssignment) && savedAssignment.length === section.wordCount) {
      mix.sections.set(key, savedAssignment);
    }
  }
  return mix;
}
