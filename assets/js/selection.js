import { estimateSeconds, findSection } from "./library.js";

export function createSelectionState(initialKeys = []) {
  return new Set(initialKeys);
}

export function toggleKey(selected, key) {
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  return selected;
}

export function setBookSelected(selected, chapters, checked) {
  for (const c of chapters) {
    if (checked) selected.add(c.key);
    else selected.delete(c.key);
  }
  return selected;
}

export function bookSelectionState(selected, chapters) {
  const selectedCount = chapters.filter((c) => selected.has(c.key)).length;
  if (selectedCount === 0) return "none";
  if (selectedCount === chapters.length) return "all";
  return "some";
}

export function summarize(selected, manifest, verseSelections) {
  let wordCount = 0;
  for (const key of selected) {
    const section = findSection(manifest, key);
    if (!section) continue;
    const words = section.recordings[0]?.words ?? [];
    const verseSet = verseSelections?.get(key);
    wordCount += verseSet ? words.filter((w) => w.verse !== null && verseSet.has(w.verse)).length : words.length;
  }
  return {
    sectionCount: selected.size,
    wordCount,
    estimatedSeconds: estimateSeconds(wordCount),
  };
}

/**
 * Per-chapter verse narrowing: Map<sectionKey, Set<verseNumber>>. A section
 * with no entry means "every verse it has" (the default, and how a fresh
 * chapter selection starts) -- only sections the Pathfinder has actually
 * narrowed via the verse picker get an entry, so buildProgram's verseFilter
 * (which uses this same "absent = unfiltered" convention) can be built
 * straight from it.
 */
export function createVerseSelections(initial = {}) {
  const map = new Map();
  for (const [key, verses] of Object.entries(initial)) {
    if (Array.isArray(verses)) map.set(key, new Set(verses));
  }
  return map;
}

export function serializeVerseSelections(verseSelections) {
  const obj = {};
  for (const [key, verses] of verseSelections) obj[key] = [...verses].sort((a, b) => a - b);
  return obj;
}

/** The verses currently in effect for a chapter -- its own narrowed set, or every verse it has if untouched. */
export function getSelectedVerses(verseSelections, key, allVerses) {
  const narrowed = verseSelections.get(key);
  return narrowed ? allVerses.filter((v) => narrowed.has(v)) : allVerses;
}

/** Narrows (or clears the narrowing on) one chapter's verse selection -- choosing every verse it has removes the entry, going back to "unfiltered" rather than storing a redundant full set. */
export function setSelectedVerses(verseSelections, key, verses, allVerses) {
  const chosen = new Set(verses);
  const isFull = allVerses.length > 0 && allVerses.every((v) => chosen.has(v));
  if (isFull) verseSelections.delete(key);
  else verseSelections.set(key, chosen);
  return verseSelections;
}
