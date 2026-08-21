import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultKaraokeControls,
  clampKaraokeControls,
  resolveKaraokeControls,
  semitonesToRatio,
  loopRangeForCanonicalIndices,
  KARAOKE_CONTROLS_LIMITS,
} from "../assets/js/karaoke-controls.js";

test("defaultKaraokeControls: neutral out of the box (no shift, normal speed, key lock on, no count-in/reverb)", () => {
  assert.deepEqual(defaultKaraokeControls(), {
    pitchSemitones: 0,
    rate: 1,
    keyLock: true,
    countInSeconds: 0,
    reverbAmount: 0,
  });
});

test("resolveKaraokeControls: with no overrides, resolves to the app default exactly", () => {
  const app = defaultKaraokeControls();
  assert.deepEqual(resolveKaraokeControls(app, null, null), app);
  assert.deepEqual(resolveKaraokeControls(app, undefined, undefined), app);
});

test("resolveKaraokeControls: a playlist override wins over the app default for the fields it sets, app default fills the rest", () => {
  const app = { ...defaultKaraokeControls(), rate: 1.2 };
  const resolved = resolveKaraokeControls(app, { pitchSemitones: 3 }, null);
  assert.equal(resolved.pitchSemitones, 3, "playlist override applies");
  assert.equal(resolved.rate, 1.2, "app default still supplies fields the playlist never overrode");
});

test("resolveKaraokeControls: a section override wins over both the playlist override and the app default", () => {
  const app = defaultKaraokeControls();
  const playlistOverride = { pitchSemitones: 3, rate: 1.1 };
  const sectionOverride = { pitchSemitones: -5 };
  const resolved = resolveKaraokeControls(app, playlistOverride, sectionOverride);
  assert.equal(resolved.pitchSemitones, -5, "section override wins");
  assert.equal(resolved.rate, 1.1, "playlist override still applies to fields the section never touched");
  assert.equal(resolved.keyLock, true, "app default still applies to fields neither override touched");
});

test("clampKaraokeControls: clamps every field present to its documented range", () => {
  const clamped = clampKaraokeControls({ pitchSemitones: 99, rate: -5, countInSeconds: 999, reverbAmount: 2 });
  assert.equal(clamped.pitchSemitones, KARAOKE_CONTROLS_LIMITS.pitchSemitones.max);
  assert.equal(clamped.rate, KARAOKE_CONTROLS_LIMITS.rate.min);
  assert.equal(clamped.countInSeconds, KARAOKE_CONTROLS_LIMITS.countInSeconds.max);
  assert.equal(clamped.reverbAmount, KARAOKE_CONTROLS_LIMITS.reverbAmount.max);
});

test("clampKaraokeControls: leaves fields not present in the partial untouched (doesn't invent defaults)", () => {
  assert.deepEqual(clampKaraokeControls({ pitchSemitones: 4 }), { pitchSemitones: 4 });
});

test("clampKaraokeControls: a value already in range is unchanged", () => {
  assert.deepEqual(clampKaraokeControls({ pitchSemitones: 2, rate: 1.1 }), { pitchSemitones: 2, rate: 1.1 });
});

test("semitonesToRatio: 0 semitones is unity", () => {
  assert.equal(semitonesToRatio(0), 1);
});

test("semitonesToRatio: +12 semitones (an octave up) doubles the frequency ratio", () => {
  assert.ok(Math.abs(semitonesToRatio(12) - 2) < 1e-9);
});

test("semitonesToRatio: -12 semitones (an octave down) halves the frequency ratio", () => {
  assert.ok(Math.abs(semitonesToRatio(-12) - 0.5) < 1e-9);
});

function makeBlock({ sectionKey, blockIndexTag, words }) {
  const canonicalIndexMap = new Map(words.map((w) => [w, w.ci]));
  return { sectionKey, blockIndexTag, words, canonicalIndexMap };
}

test("loopRangeForCanonicalIndices: a range entirely inside one block resolves to that block's word start/end times", () => {
  const words = [
    { ci: 0, start: 0, end: 1 },
    { ci: 1, start: 1, end: 2 },
    { ci: 2, start: 2, end: 3 },
    { ci: 3, start: 3, end: 4 },
  ];
  const blocks = [makeBlock({ sectionKey: "a", words })];
  const range = loopRangeForCanonicalIndices(blocks, "a", 1, 2);
  assert.deepEqual(range, { startBlockIndex: 0, startTime: 1, endBlockIndex: 0, endTime: 3 });
});

test("loopRangeForCanonicalIndices: startIndex/endIndex order doesn't matter (a drag can go either direction)", () => {
  const words = [
    { ci: 0, start: 0, end: 1 },
    { ci: 1, start: 1, end: 2 },
  ];
  const blocks = [makeBlock({ sectionKey: "a", words })];
  assert.deepEqual(loopRangeForCanonicalIndices(blocks, "a", 1, 0), loopRangeForCanonicalIndices(blocks, "a", 0, 1));
});

test("loopRangeForCanonicalIndices: a range spanning two blocks of the same section resolves start/end across them", () => {
  const wordsA = [
    { ci: 0, start: 0, end: 1 },
    { ci: 1, start: 1, end: 2 },
  ];
  const wordsB = [
    { ci: 2, start: 0, end: 1 }, // second block's own recording timeline restarts at 0
    { ci: 3, start: 1, end: 2 },
  ];
  const blocks = [makeBlock({ sectionKey: "a", words: wordsA }), makeBlock({ sectionKey: "a", words: wordsB })];
  const range = loopRangeForCanonicalIndices(blocks, "a", 1, 3);
  assert.deepEqual(range, { startBlockIndex: 0, startTime: 1, endBlockIndex: 1, endTime: 2 });
});

test("loopRangeForCanonicalIndices: only considers blocks belonging to the requested section", () => {
  const words = [{ ci: 0, start: 5, end: 6 }];
  const blocks = [makeBlock({ sectionKey: "other", words: [{ ci: 0, start: 0, end: 100 }] }), makeBlock({ sectionKey: "a", words })];
  const range = loopRangeForCanonicalIndices(blocks, "a", 0, 0);
  assert.deepEqual(range, { startBlockIndex: 1, startTime: 5, endBlockIndex: 1, endTime: 6 });
});

test("loopRangeForCanonicalIndices: no matching block/index anywhere -> null, not a throw", () => {
  const blocks = [makeBlock({ sectionKey: "a", words: [{ ci: 0, start: 0, end: 1 }] })];
  assert.equal(loopRangeForCanonicalIndices(blocks, "a", 5, 6), null);
  assert.equal(loopRangeForCanonicalIndices([], "a", 0, 0), null);
});
