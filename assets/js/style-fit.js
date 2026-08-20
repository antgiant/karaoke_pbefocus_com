// Formats a style's "church-appropriateness" indicator (AI_TODO.md item 7)
// for display -- how uncomfortable a style would feel in a Seventh-Day
// Adventist service, collapsed to a single 3-state value per style in the
// manifest (`style.churchFit`, from scripts/build_manifest.py's
// STYLE_METADATA): "great-match" | "nervous" | "very-uncomfortable", or a
// [dominant, best-case] pair for a style whose actual takes vary too much
// for one fixed value (currently only Multi Style).
const CHURCH_FIT_INFO = {
  "great-match": { emoji: "😇", phrase: "Great match for church" },
  nervous: { emoji: "😬", phrase: "A bit of a stretch for church" },
  "very-uncomfortable": { emoji: "😱", phrase: "A big departure for church" },
};

/** Just the emoji(s) -- "😱", or "😱😇" (dominant first) for a range. Empty string for an unrecognized/missing value rather than throwing -- a manifest built before this field existed, or a style this script doesn't have metadata for, shouldn't break rendering. */
export function churchFitEmoji(churchFit) {
  if (Array.isArray(churchFit)) return churchFit.map((v) => CHURCH_FIT_INFO[v]?.emoji ?? "").join("");
  return CHURCH_FIT_INFO[churchFit]?.emoji ?? "";
}

/** "<emoji> <phrase>" (or "<emoji><emoji> Varies" for a range) -- self-contained plain text safe for a native <select><option>, a playback scrubber label, or MediaSession lock-screen metadata, none of which can carry a separate tooltip. */
export function churchFitText(churchFit) {
  if (Array.isArray(churchFit)) return `${churchFitEmoji(churchFit)} Varies for church`;
  const info = CHURCH_FIT_INFO[churchFit];
  return info ? `${info.emoji} ${info.phrase}` : "";
}

/** Full plain-language description, for a title/tooltip attribute on a richer surface (e.g. the mix editor's style swatches). */
export function churchFitDescription(churchFit) {
  if (Array.isArray(churchFit)) {
    const [dominant, bestCase] = churchFit;
    const dominantPhrase = CHURCH_FIT_INFO[dominant]?.phrase;
    const bestPhrase = CHURCH_FIT_INFO[bestCase]?.phrase;
    if (!dominantPhrase || !bestPhrase) return "";
    return `Usually ${dominantPhrase.toLowerCase()}, occasionally ${bestPhrase.toLowerCase()} -- varies by take`;
  }
  return CHURCH_FIT_INFO[churchFit]?.phrase ?? "";
}
