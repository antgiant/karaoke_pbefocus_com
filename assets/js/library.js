import { bookSortIndex } from "./constants.js";

export function sectionKey(section) {
  return [section.book, section.chapter, section.verseStart ?? "", section.verseEnd ?? ""].join("|");
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Manifest is not a JSON object.");
  }
  if (!Array.isArray(manifest.styles) || manifest.styles.length === 0) {
    throw new Error("Manifest has no 'styles' list.");
  }
  if (!Array.isArray(manifest.sections) || manifest.sections.length === 0) {
    throw new Error("Manifest has no 'sections' list.");
  }
  for (const section of manifest.sections) {
    if (!section.book || !section.chapter || !Array.isArray(section.recordings) || section.recordings.length === 0) {
      throw new Error(`Manifest section is missing book/chapter/recordings: ${JSON.stringify(section).slice(0, 120)}`);
    }
  }
  return manifest;
}

export function passageLabel(section) {
  return section.verseStart
    ? `${section.book} ${section.chapter}:${section.verseStart}-${section.verseEnd}`
    : `${section.book} ${section.chapter}`;
}

/** Groups manifest.sections into a book -> ordered chapter/verse-range tree for the selection UI. */
export function buildBookTree(manifest) {
  const byBook = new Map();
  for (const section of manifest.sections) {
    if (!byBook.has(section.book)) {
      byBook.set(section.book, []);
    }
    byBook.get(section.book).push({
      key: sectionKey(section),
      book: section.book,
      chapter: section.chapter,
      verseStart: section.verseStart,
      verseEnd: section.verseEnd,
      label: passageLabel(section),
      wordCount: section.recordings[0]?.words.length ?? 0,
      styleIds: [...new Set(section.recordings.map((r) => r.style))],
    });
  }

  const books = [...byBook.entries()].map(([book, chapters]) => ({
    book,
    chapters: chapters.sort((a, b) => a.chapter - b.chapter || (a.verseStart ?? 0) - (b.verseStart ?? 0)),
  }));

  books.sort((a, b) => bookSortIndex(a.book) - bookSortIndex(b.book) || a.book.localeCompare(b.book));
  return books;
}

export function findSection(manifest, key) {
  return manifest.sections.find((s) => sectionKey(s) === key);
}

/** manifest.sections sorted into canonical book/chapter/verse order (see buildBookTree). */
export function orderedSections(manifest) {
  return manifest.sections
    .slice()
    .sort(
      (a, b) =>
        bookSortIndex(a.book) - bookSortIndex(b.book) ||
        a.book.localeCompare(b.book) ||
        a.chapter - b.chapter ||
        (a.verseStart ?? 0) - (b.verseStart ?? 0)
    );
}

// Rough spoken-word-rate estimate (words/sec) used only to give the
// Pathfinder a sense of session length before playback exists (Phase 3).
const ESTIMATED_WORDS_PER_SECOND = 2.2;

export function estimateSeconds(wordCount) {
  return wordCount / ESTIMATED_WORDS_PER_SECOND;
}

export function formatDuration(seconds) {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
