/** Deterministic pseudo-random in [0,1) from an integer -- stable across re-renders of the same block. */
function pseudoRandom(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/** Whether word index i should be shown as a hint rather than blanked, given a 0..1 reveal fraction. */
export function shouldHint(index, revealFraction) {
  return pseudoRandom(index + 1) < revealFraction;
}

export function maskedText(word) {
  return "•".repeat(Math.max(2, Math.min(word.length, 8)));
}
