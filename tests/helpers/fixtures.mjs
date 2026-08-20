// Test fixtures shared across study-mode tests: a minimal fake playback
// engine (matches the subset of assets/js/playback-engine.js's interface
// word-stream.js actually uses) and a manifest/section builder.
import { sectionKey } from "../../assets/js/library.js";

/**
 * Builds one section with `versesWordCounts.length` verses, each holding
 * that many words (word text is "w<verse>-<n>", one second apart, verse
 * numbers 1..N). All words are canonical (verse !== null) -- filler is
 * added separately by tests that need it, via extraFillerWords.
 */
export function makeSection({ book = "1 John", chapter = 1, versesWordCounts = [3, 3, 2], style = "indiepop" }) {
  const words = [];
  let t = 0;
  versesWordCounts.forEach((count, vi) => {
    const verse = vi + 1;
    for (let n = 0; n < count; n++) {
      words.push({ word: `w${verse}-${n}`, start: t, end: t + 0.9, verse });
      t += 1;
    }
  });
  const section = {
    book,
    chapter,
    verseStart: null,
    verseEnd: null,
    recordings: [{ style, take: 1, instrumentalUrl: "test.instrumental.m4a", vocalUrl: "test.vocal.m4a", words }],
  };
  return { section, words };
}

/**
 * Fake engine: emits blockchange/timeupdate on demand, records
 * pause()/skipToBlock() calls. getState().block starts out `null` and only
 * becomes non-null once a blockchange is emitted -- this matches the real
 * playback-engine.js, where loadProgram() leaves blockIndex at -1 (so
 * getState().block is null) until play() actually starts the first block.
 * createPassageView's constructor only does its own synchronous initial
 * render `if (initial.block)`, so tests must emit blockchange themselves to
 * kick off rendering, same as real playback triggers it via engine.play() --
 * this also ensures setRenderWord/setOnPastWord/setOnSectionChange (always
 * called by the mounting study mode right after construction, before
 * playback starts) are in place before the first render happens, matching
 * real app behavior.
 */
export function makeFakeEngine({ blocks }) {
  const listeners = { blockchange: [], timeupdate: [], ended: [], playstate: [] };
  const calls = { pause: 0, skipToBlock: [], setVocalDuckPredicate: [] };
  let currentBlock = null;

  return {
    calls,
    on(event, fn) {
      listeners[event].push(fn);
      return () => {
        listeners[event] = listeners[event].filter((f) => f !== fn);
      };
    },
    emit(event, ...args) {
      if (event === "blockchange") currentBlock = args[0] ?? null;
      for (const fn of listeners[event]) fn(...args);
    },
    getState() {
      return { block: currentBlock, isPlaying: false, blockIndex: 0, totalBlocks: blocks.length };
    },
    getProgramBlocks() {
      return blocks;
    },
    pause() {
      calls.pause += 1;
    },
    skipToBlock(programIndex, time) {
      calls.skipToBlock.push({ programIndex, time });
    },
    setVocalDuckPredicate(predicate) {
      calls.setVocalDuckPredicate.push(predicate);
    },
  };
}

/** One block covering every word of `words`, with a canonicalIndexMap keyed by canonical index (matches how createPassageView reads it). */
export function makeBlock({ words, sectionKey: key, canonicalWords }) {
  const canonicalIndexMap = new Map();
  for (const w of words) {
    const ci = canonicalWords.indexOf(w);
    if (ci !== -1) canonicalIndexMap.set(w, ci);
  }
  return {
    sectionKey: key,
    words,
    canonicalIndexMap,
    inTime: words[0]?.start ?? 0,
    outTime: (words[words.length - 1]?.end ?? 0) + 0.1,
  };
}

export function sectionKeyFor(section) {
  return sectionKey(section);
}
