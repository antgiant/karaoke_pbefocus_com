/**
 * Recognizes spoken number words (as heard in a recording's spoken
 * verse-number callouts, e.g. someone saying "Five," right before verse 5
 * starts) so filler restoration can suppress them -- showing both the
 * numeral and its spoken-word form right next to each other reads as a
 * duplicate, not useful context.
 */
const ONES = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function normalize(raw) {
  return (raw || "").toLowerCase().replace(/[^a-z-]/g, "");
}

/** The number a single spoken word represents ("Five," -> 5, "Twenty-one," -> 21), or null. */
export function wordToNumber(raw) {
  const norm = normalize(raw);
  if (!norm) return null;
  if (norm in ONES) return ONES[norm];
  if (norm in TEENS) return TEENS[norm];
  if (norm in TENS) return TENS[norm];
  const hyphenated = norm.match(/^([a-z]+)-([a-z]+)$/);
  if (hyphenated && TENS[hyphenated[1]] !== undefined && ONES[hyphenated[2]] !== undefined) {
    return TENS[hyphenated[1]] + ONES[hyphenated[2]];
  }
  return null;
}

/** Whether two adjacent words ("Twenty", "one,") together spell out a target number. */
export function wordPairFormsNumber(tensWord, onesWord, target) {
  const tens = TENS[normalize(tensWord)];
  const ones = ONES[normalize(onesWord)];
  return tens !== undefined && ones !== undefined && tens + ones === target;
}

/**
 * Drops a trailing spoken-number match for `targetVerse` from a list of
 * filler words (word objects with a `.word` string) -- the verse-number
 * callout is always the last thing said right before the verse it
 * announces, so only the tail is checked, keeping any earlier filler
 * (like a chapter title) intact.
 */
export function stripTrailingVerseAnnouncement(words, targetVerse) {
  if (words.length === 0 || targetVerse === null || targetVerse === undefined) return words;
  const last = words[words.length - 1];
  if (wordToNumber(last.word) === targetVerse) return words.slice(0, -1);
  if (words.length >= 2) {
    const secondLast = words[words.length - 2];
    if (wordPairFormsNumber(secondLast.word, last.word, targetVerse)) return words.slice(0, -2);
  }
  return words;
}
