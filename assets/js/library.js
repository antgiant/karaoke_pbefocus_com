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
      verseNumbers: sectionVerseNumbers(section),
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

/** Every recording for a section in a given style, sorted ascending by take number (real manifest take numbers are arbitrary per-file, not necessarily 1/2 -- this is what lets callers address "the Nth take" positionally instead of by a specific number). */
export function listTakes(section, styleId) {
  return section.recordings.filter((r) => r.style === styleId).sort((a, b) => a.take - b.take);
}

/**
 * The recording for a section in a given style at position `takeRank` (0 =
 * lowest take, 1 = next, ...), or null if that style isn't available there
 * at all. Falls back to rank 0 if `takeRank` is out of range for however
 * many takes this particular section+style actually has -- e.g. a
 * Pathfinder's saved "prefer take 2" choice shouldn't error or silently
 * omit audio just because one specific section only has a single take;
 * take 1 is always a safe, present fallback whenever *any* recording
 * exists for that style.
 */
export function pickRecording(section, styleId, takeRank = 0) {
  const candidates = listTakes(section, styleId);
  if (candidates.length === 0) return null;
  return candidates[takeRank] ?? candidates[0];
}

/**
 * The scripture words (verse != null) of whichever recording in this section
 * has the most of them, in order. This is the addressable "canonical word
 * sequence" the mix editor paints against -- picking one real recording
 * (rather than needing the separate NKJV text, which the manifest
 * deliberately doesn't carry) as the common reference every style's
 * recording gets aligned to.
 */
export function canonicalWords(section) {
  let best = null;
  let bestCount = -1;
  for (const r of section.recordings) {
    const count = r.words.reduce((n, w) => n + (w.verse !== null ? 1 : 0), 0);
    if (count > bestCount) {
      bestCount = count;
      best = r;
    }
  }
  return best.words.filter((w) => w.verse !== null);
}

/** Distinct verse numbers actually present in a section, in order -- the selectable set for the per-chapter verse picker (not just verseStart..verseEnd, since a rough take can be missing a verse's audio entirely). */
export function sectionVerseNumbers(section) {
  return [...new Set(canonicalWords(section).map((w) => w.verse))].sort((a, b) => a - b);
}

/**
 * Maps each canonical word to the corresponding word in a specific style's
 * own recording, by verse number + position-within-verse (NOT raw array
 * index -- different recordings interleave spoken filler differently and
 * can ad-lib/repeat lines, so index alignment would drift). Returns an
 * array the same length as `canonical`; an entry is null where that style's
 * recording has fewer words in that verse than the canonical sequence does
 * (rare, but possible on a rough take).
 */
export function alignWordsToCanonical(canonical, styleWords) {
  const byVerse = new Map();
  for (const w of styleWords) {
    if (w.verse === null) continue;
    if (!byVerse.has(w.verse)) byVerse.set(w.verse, []);
    byVerse.get(w.verse).push(w);
  }
  const cursor = new Map();
  return canonical.map((cw) => {
    const pos = cursor.get(cw.verse) ?? 0;
    cursor.set(cw.verse, pos + 1);
    return (byVerse.get(cw.verse) || [])[pos] ?? null;
  });
}

// Rough spoken-word-rate estimate (words/sec) used only to give the
// Pathfinder a sense of session length before playback exists (Phase 3).
const ESTIMATED_WORDS_PER_SECOND = 2.2;

export function estimateSeconds(wordCount) {
  return wordCount / ESTIMATED_WORDS_PER_SECOND;
}

/** Sorted, deduped verse numbers -> "1-3, 5, 9-11", for the verse-picker summary. */
export function formatVerseRanges(verses) {
  if (verses.length === 0) return "";
  const ranges = [];
  let start = verses[0];
  let prev = verses[0];
  for (let i = 1; i < verses.length; i++) {
    const v = verses[i];
    if (v === prev + 1) {
      prev = v;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = v;
    prev = v;
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(", ");
}

export function formatDuration(seconds) {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
