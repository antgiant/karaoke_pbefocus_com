import { test } from "node:test";
import assert from "node:assert/strict";
import { wordIndexAtTime, shouldUseStem, crossfadeSecondsFor, duckTargetFor } from "../assets/js/playback-engine.js";

test("wordIndexAtTime: finds the last word whose start <= t", () => {
  const words = [{ start: 0 }, { start: 1 }, { start: 2 }, { start: 3 }];
  assert.equal(wordIndexAtTime(words, -1), -1, "before the first word");
  assert.equal(wordIndexAtTime(words, 0), 0);
  assert.equal(wordIndexAtTime(words, 1.5), 1);
  assert.equal(wordIndexAtTime(words, 3), 3);
  assert.equal(wordIndexAtTime(words, 99), 3, "after the last word stays on the last word");
});

test("wordIndexAtTime: empty word list is always -1", () => {
  assert.equal(wordIndexAtTime([], 5), -1);
});

function makeBlock(overrides = {}) {
  const words = overrides.words ?? [{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }];
  const canonicalIndexMap = overrides.canonicalIndexMap ?? new Map(words.map((w, i) => [w, i]));
  return {
    style: overrides.style ?? "hiphop",
    inTime: overrides.inTime ?? 0,
    outTime: overrides.outTime ?? 3,
    instrumentalUrl: overrides.instrumentalUrl,
    vocalUrl: overrides.vocalUrl,
    words,
    canonicalIndexMap,
  };
}

test("shouldUseStem: needs both stem URLs AND an active duck predicate", () => {
  const stemBlock = makeBlock({ instrumentalUrl: "i.mp3", vocalUrl: "v.mp3" });
  const plainBlock = makeBlock();
  const predicate = () => true;

  assert.equal(shouldUseStem(stemBlock, predicate), true);
  assert.equal(shouldUseStem(stemBlock, null), false, "no predicate -- Sleep Mode/Sing-Along/Type Ahead never set one");
  assert.equal(shouldUseStem(plainBlock, predicate), false, "predicate alone isn't enough without both stem URLs");
  assert.equal(shouldUseStem(makeBlock({ instrumentalUrl: "i.mp3" }), predicate), false, "only one stem present");
});

test("shouldUseStem: tolerates a null/undefined block", () => {
  assert.equal(shouldUseStem(null, () => true), false);
  assert.equal(shouldUseStem(undefined, () => true), false);
});

test("crossfadeSecondsFor: same style -> the short segment blip", () => {
  const prev = makeBlock({ style: "hiphop", inTime: 0, outTime: 30 });
  const next = makeBlock({ style: "hiphop" });
  assert.equal(crossfadeSecondsFor(prev, next), 0.35);
});

test("crossfadeSecondsFor: different style -> the longer genre crossfade", () => {
  const prev = makeBlock({ style: "hiphop", inTime: 0, outTime: 30 });
  const next = makeBlock({ style: "polka" });
  assert.equal(crossfadeSecondsFor(prev, next), 1.5);
});

test("crossfadeSecondsFor: never longer than the outgoing block's own duration", () => {
  const prev = makeBlock({ style: "hiphop", inTime: 0, outTime: 0.8 }); // shorter than the 1.5s genre crossfade
  const next = makeBlock({ style: "polka" });
  assert.equal(crossfadeSecondsFor(prev, next), 0.8);
});

test("crossfadeSecondsFor: missing prev/next block falls back to the segment duration", () => {
  assert.equal(crossfadeSecondsFor(null, makeBlock()), 0.35);
  assert.equal(crossfadeSecondsFor(makeBlock(), null), 0.35);
});

test("duckTargetFor: no predicate -> always full volume", () => {
  const block = makeBlock();
  assert.equal(duckTargetFor(block, 1.5, null), 1);
});

test("duckTargetFor: the word at time t is blanked -> 0", () => {
  const block = makeBlock();
  const predicate = (canonicalIdx) => canonicalIdx === 1; // second word is blanked
  assert.equal(duckTargetFor(block, 1.5, predicate), 0, "t=1.5 falls in the second word (start=1,end=2)");
  assert.equal(duckTargetFor(block, 0.5, predicate), 1, "t=0.5 falls in the first word, not blanked");
});

test("duckTargetFor: before the first word's start -> full volume, not silent", () => {
  const block = makeBlock();
  assert.equal(duckTargetFor(block, -1, () => true), 1);
});

test("duckTargetFor: a word with no canonical mapping (alignment gap) is never ducked", () => {
  const words = [{ start: 0, end: 1 }];
  const block = makeBlock({ words, canonicalIndexMap: new Map() }); // word deliberately unmapped
  assert.equal(duckTargetFor(block, 0.5, () => true), 1);
});
