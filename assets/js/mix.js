import { canonicalWords, findSection, orderedSections, sectionKey } from "./library.js";

/**
 * The genre-assignment model: for every selected section, an array of style
 * ids -- one per canonical (scripture) word -- recording which style plays
 * that word. Adjacent equal entries collapse into one playback block (see
 * getRuns/program-builder.js); painting is just overwriting a subrange of
 * this array, right down to a single index.
 */
export function createMix(defaultStyleId) {
  return { defaultStyleId, defaultTakeRank: 0, sections: new Map(), takeOverrides: {} };
}

/**
 * Which take (0 = lowest, 1 = next, ...) to use for a given section+style --
 * see AI_TODO.md item 6. An explicit per-(section, style) override (set via
 * the mix editor, same granularity as style painting) wins; otherwise falls
 * back to `mix.defaultTakeRank` (set via the main style selector's take
 * toggle, a blanket "prefer take N" Pathfinder preference applied wherever
 * there's no more specific override) which itself defaults to 0 -- today's
 * unchanged "always lowest take" behavior.
 */
export function getTakeRank(mix, sectionKeyStr, styleId) {
  return mix.takeOverrides?.[sectionKeyStr]?.[styleId] ?? mix.defaultTakeRank ?? 0;
}

/** Sets a per-(section, style) take override, or clears it (back to following mix.defaultTakeRank) if `rank` already matches the current default -- keeps the persisted shape from accumulating overrides that aren't actually doing anything. */
export function setTakeRank(mix, sectionKeyStr, styleId, rank) {
  if (!mix.takeOverrides) mix.takeOverrides = {};
  if (rank === (mix.defaultTakeRank ?? 0)) {
    if (mix.takeOverrides[sectionKeyStr]) {
      delete mix.takeOverrides[sectionKeyStr][styleId];
      if (Object.keys(mix.takeOverrides[sectionKeyStr]).length === 0) delete mix.takeOverrides[sectionKeyStr];
    }
    return;
  }
  if (!mix.takeOverrides[sectionKeyStr]) mix.takeOverrides[sectionKeyStr] = {};
  mix.takeOverrides[sectionKeyStr][styleId] = rank;
}

/** The blanket take-rank preference applied wherever there's no more specific per-(section, style) override -- see getTakeRank. */
export function setDefaultTakeRank(mix, rank) {
  mix.defaultTakeRank = rank;
}

/** Ensures every currently-selected section has an assignment array, sized to its canonical word count. */
export function syncMixToSelection(mix, manifest, selectedKeys) {
  const selected = new Set(selectedKeys);
  for (const key of selected) {
    if (mix.sections.has(key)) continue;
    const section = findSection(manifest, key);
    if (!section) continue;
    const length = canonicalWords(section).length;
    mix.sections.set(key, new Array(length).fill(mix.defaultStyleId));
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

export function paintRange(mix, sectionKeyStr, startIndex, endIndexInclusive, styleId) {
  const assignment = mix.sections.get(sectionKeyStr);
  if (!assignment) return;
  const lo = Math.max(0, Math.min(startIndex, endIndexInclusive));
  const hi = Math.min(assignment.length - 1, Math.max(startIndex, endIndexInclusive));
  for (let i = lo; i <= hi; i++) assignment[i] = styleId;
}

/** Run-length-encodes a section's assignment into contiguous {styleId, startIndex, endIndex} blocks. */
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
    defaultTakeRank: mix.defaultTakeRank ?? 0,
    sections: Object.fromEntries(mix.sections),
    takeOverrides: mix.takeOverrides ?? {},
  };
}

/** Restores a mix, but only reuses per-section arrays whose length still matches the current manifest
 *  (a changed manifest could shift canonical word counts, and a stale-length array would misalign). */
export function fromSerializable(saved, manifest) {
  const mix = createMix(saved?.defaultStyleId ?? manifest.styles[0]?.id ?? null);
  mix.defaultTakeRank = Number.isInteger(saved?.defaultTakeRank) ? saved.defaultTakeRank : 0;
  mix.takeOverrides = saved?.takeOverrides && typeof saved.takeOverrides === "object" ? saved.takeOverrides : {};
  if (!saved?.sections) return mix;
  for (const section of orderedSections(manifest)) {
    const key = sectionKey(section);
    const savedAssignment = saved.sections[key];
    if (Array.isArray(savedAssignment) && savedAssignment.length === canonicalWords(section).length) {
      mix.sections.set(key, savedAssignment);
    }
  }
  return mix;
}
