// Settings model for the "Karaoke Controls" panel (AI_TODO.md item 4):
// pitch, speed, key-lock, count-in, and reverb, resolved through three
// tiers -- an app-wide default, an optional per-playlist override, and an
// optional per-section ("song") override on top of that. Each override is a
// *partial* object (only the fields the Pathfinder actually changed while
// that tier was selected), not a full snapshot -- a playlist that only ever
// overrode pitch still tracks the app-wide default for everything else, so
// changing the app default later still flows through to it.
//
// A/B loop is deliberately NOT part of this model -- see karaoke-controls-
// panel.js's doc comment for why it's treated as live session state instead
// of a persisted preference.

const PITCH_MIN = -12;
const PITCH_MAX = 12;
const RATE_MIN = 0.5;
const RATE_MAX = 1.5;
const COUNT_IN_MAX_SECONDS = 8;

export const KARAOKE_CONTROLS_LIMITS = {
  pitchSemitones: { min: PITCH_MIN, max: PITCH_MAX, step: 1 },
  rate: { min: RATE_MIN, max: RATE_MAX, step: 0.05 },
  countInSeconds: { min: 0, max: COUNT_IN_MAX_SECONDS, step: 1 },
  reverbAmount: { min: 0, max: 1, step: 0.05 },
};

export function defaultKaraokeControls() {
  return {
    pitchSemitones: 0,
    rate: 1,
    // Key Lock, DJ-software convention: ON keeps pitch fixed as rate
    // changes (the browser's native preservesPitch); OFF lets pitch follow
    // rate naturally, vinyl-style. Either way the pitch slider's own
    // semitone offset (above) still applies on top -- see
    // playback-engine.js's applyPitchAndRate.
    keyLock: true,
    countInSeconds: 0,
    reverbAmount: 0,
  };
}

function clamp(value, { min, max }) {
  return Math.min(max, Math.max(min, value));
}

/** Clamps every numeric field present in `partial` to its valid range -- called on whatever a UI control produces before it's written into an override, so a stray out-of-range value (e.g. a manually-typed number input) can't corrupt persisted state. Fields not present in `partial` are left untouched. */
export function clampKaraokeControls(partial) {
  const clamped = { ...partial };
  for (const field of Object.keys(KARAOKE_CONTROLS_LIMITS)) {
    if (field in clamped) clamped[field] = clamp(clamped[field], KARAOKE_CONTROLS_LIMITS[field]);
  }
  return clamped;
}

/**
 * Three-tier resolution: section override ?? playlist override ?? app-wide
 * default, per field (not as whole objects) -- see the file doc comment.
 * `appDefault` must be a complete object (defaultKaraokeControls() or
 * loaded state shaped like it); `playlistOverride`/`sectionOverride` may be
 * null/undefined/partial.
 */
export function resolveKaraokeControls(appDefault, playlistOverride, sectionOverride) {
  return { ...appDefault, ...(playlistOverride ?? {}), ...(sectionOverride ?? {}) };
}

/** Equal-temperament frequency ratio for a pitch shift of `semitones` -- what playback-engine.js's pitch-shift worklet actually takes as its grain-read-rate multiplier. */
export function semitonesToRatio(semitones) {
  return Math.pow(2, semitones / 12);
}

/**
 * Groups a section's canonical words by verse number, in first-appearance
 * order, giving each verse's canonical index range -- verse (and "whole
 * chapter," the full array) is the A/B loop picker's primary way to set a
 * loop (karaoke-controls-panel.js), rather than dragging an arbitrary
 * word-by-word range. Words with no verse number (spoken filler, never part
 * of the addressable text) are skipped -- there's no verse to loop them
 * under.
 */
export function verseRangesForSection(canonical) {
  const ranges = [];
  let current = null;
  canonical.forEach((w, i) => {
    if (w.verse === null || w.verse === undefined) return;
    if (!current || current.verse !== w.verse) {
      current = { verse: w.verse, startIndex: i, endIndex: i };
      ranges.push(current);
    } else {
      current.endIndex = i;
    }
  });
  return ranges;
}

/**
 * Locates the program block(s) spanning a canonical word-index range within
 * one section, for the A/B loop's verse/chapter picker (see
 * karaoke-controls-panel.js) -- translates {sectionKey, startIndex,
 * endIndex} (canonical, mix-editor-style) into
 * {startBlockIndex, startTime, endBlockIndex, endTime}, the shape
 * playback-engine.js's setLoopRange expects. Returns null if the section
 * isn't in the program at all, or if neither endpoint resolves to any
 * block (e.g. a range entirely inside a verse-filtered-out gap).
 *
 * `blocks` is a program's block list (engine.getProgramBlocks()) -- passed
 * in rather than the engine itself so this stays a pure, unit-testable
 * function.
 */
export function loopRangeForCanonicalIndices(blocks, sectionKey, startIndex, endIndex) {
  const lo = Math.min(startIndex, endIndex);
  const hi = Math.max(startIndex, endIndex);

  let start = null; // {blockIndex, time}
  let end = null;
  blocks.forEach((block, blockIndex) => {
    if (block.sectionKey !== sectionKey) return;
    for (const [word, ci] of block.canonicalIndexMap) {
      if (ci < lo || ci > hi) continue;
      if (start === null || blockIndex < start.blockIndex || (blockIndex === start.blockIndex && word.start < start.time)) {
        start = { blockIndex, time: word.start };
      }
      if (end === null || blockIndex > end.blockIndex || (blockIndex === end.blockIndex && word.end > end.time)) {
        end = { blockIndex, time: word.end };
      }
    }
  });

  if (!start || !end) return null;
  return { startBlockIndex: start.blockIndex, startTime: start.time, endBlockIndex: end.blockIndex, endTime: end.time };
}
