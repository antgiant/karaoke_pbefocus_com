/**
 * Pure scoring logic for sing-along mode: no DOM, no SpeechRecognition --
 * just aligning a stream of recognized words against the expected scripture
 * words, so it can be unit-tested directly (see scripts/test-stt-score.mjs).
 *
 * Deliberately NOT a port of correct_lyrics.py's difflib.SequenceMatcher:
 * that operates on two complete sequences at once, which fits an offline
 * batch correction pass but not a live, streaming scoring UI where
 * recognized words arrive one at a time while the Pathfinder is still
 * singing. Instead this is a greedy windowed matcher: for each recognized
 * word, look a few words ahead of the current expected-word cursor for a
 * similar one, mark it matched, and advance the cursor past it -- cheap
 * per-word work, and tolerant of the Pathfinder skipping or fumbling a
 * word without losing sync with the rest of the passage.
 */

function normalize(word) {
  return (word || "").toLowerCase().replace(/[^a-z0-9']/g, "");
}

/** Cheap character-overlap ratio in [0,1] -- good enough to catch mishearings without a full edit-distance computation. */
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  let matches = 0;
  let j = 0;
  for (let i = 0; i < longer.length && j < shorter.length; i++) {
    if (longer[i] === shorter[j]) {
      matches++;
      j++;
    }
  }
  return (2 * matches) / (a.length + b.length);
}

export const MATCH_THRESHOLD = 0.6;
export const LOOKAHEAD = 6;

/**
 * expectedWords: array of {word, ...}. Only pass scripture words (verse !=
 * null) -- there's nothing meaningful to sing along to for spoken filler.
 */
export function createScorer(expectedWords, { matchThreshold = MATCH_THRESHOLD, lookahead = LOOKAHEAD } = {}) {
  const state = expectedWords.map((w) => ({ word: w.word, matched: false, recognizedText: null }));
  let cursor = 0;

  function submitRecognizedWord(rawText) {
    const norm = normalize(rawText);
    if (!norm) return { matched: false, index: -1 };
    for (let offset = 0; offset < lookahead && cursor + offset < state.length; offset++) {
      const candidate = state[cursor + offset];
      if (candidate.matched) continue;
      if (similarity(norm, normalize(candidate.word)) >= matchThreshold) {
        candidate.matched = true;
        candidate.recognizedText = rawText;
        cursor = cursor + offset + 1;
        return { matched: true, index: cursor - 1 };
      }
    }
    return { matched: false, index: -1 };
  }

  function submitRecognizedPhrase(text) {
    return (text || "").trim().split(/\s+/).filter(Boolean).map(submitRecognizedWord);
  }

  function getScore() {
    const matchedCount = state.filter((s) => s.matched).length;
    return {
      matchedCount,
      total: state.length,
      accuracy: state.length ? matchedCount / state.length : 0,
      perWord: state.map((s) => ({ word: s.word, matched: s.matched })),
    };
  }

  return { submitRecognizedWord, submitRecognizedPhrase, getScore };
}
