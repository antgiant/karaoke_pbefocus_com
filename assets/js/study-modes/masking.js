// A fixed-width blank by default: revealing word length via a
// length-matched number of bullets is itself a memorization hint, so the
// default shouldn't give that away. Length-matched is opt-in.
const STATIC_MASK_LENGTH = 3;

export function maskedText(word, lengthMatched = false) {
  if (lengthMatched) return "•".repeat(Math.max(2, Math.min(word.length, 8)));
  return "•".repeat(STATIC_MASK_LENGTH);
}
