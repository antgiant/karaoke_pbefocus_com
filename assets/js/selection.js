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

export function summarize(selected, manifest) {
  let wordCount = 0;
  for (const key of selected) {
    const section = findSection(manifest, key);
    if (section) wordCount += section.recordings[0]?.words.length ?? 0;
  }
  return {
    sectionCount: selected.size,
    wordCount,
    estimatedSeconds: estimateSeconds(wordCount),
  };
}
