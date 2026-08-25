import { test } from "node:test";
import assert from "node:assert/strict";
import { createMix, getRuns, makePaintId, maxTakeCount, paintRange, parsePaintId, syncMixToSelection } from "../assets/js/mix.js";
import { sectionKey } from "../assets/js/library.js";

function makeManifest({ takeCount = 1 } = {}) {
  const words = [{ word: "In", start: 0, end: 0.5, verse: 1 }];
  const recordings = [];
  for (let i = 0; i < takeCount; i++) {
    recordings.push({ style: "hiphop", take: i + 1, instrumentalUrl: `t${i}.instrumental.m4a`, vocalUrl: `t${i}.vocal.m4a`, words });
  }
  const section = { book: "Mark", chapter: 1, verseStart: null, verseEnd: null, wordCount: words.length, recordings };
  return { styles: [{ id: "hiphop", label: "Hip Hop" }], sections: [section] };
}

test("makePaintId: rank 0 collapses to the plain style id, no suffix", () => {
  assert.equal(makePaintId("hiphop", 0), "hiphop");
});

test("makePaintId: rank 1+ gets a take suffix", () => {
  assert.equal(makePaintId("hiphop", 1), "hiphop::take2");
  assert.equal(makePaintId("hiphop", 2), "hiphop::take3");
});

test("parsePaintId: inverse of makePaintId for every rank", () => {
  for (let rank = 0; rank < 4; rank++) {
    assert.deepEqual(parsePaintId(makePaintId("hiphop", rank)), { styleId: "hiphop", takeRank: rank });
  }
});

test("parsePaintId: a plain style id (no marker) is rank 0", () => {
  assert.deepEqual(parsePaintId("hiphop"), { styleId: "hiphop", takeRank: 0 });
});

test("maxTakeCount: 1 when the style has only one take in every currently-selected section", () => {
  const manifest = makeManifest({ takeCount: 1 });
  const key = sectionKey(manifest.sections[0]);
  const mix = createMix("hiphop");
  syncMixToSelection(mix, manifest, [key]);
  assert.equal(maxTakeCount(manifest, mix, "hiphop"), 1);
});

test("maxTakeCount: reflects the highest take count found in any currently-selected section", () => {
  const manifest = makeManifest({ takeCount: 3 });
  const key = sectionKey(manifest.sections[0]);
  const mix = createMix("hiphop");
  syncMixToSelection(mix, manifest, [key]);
  assert.equal(maxTakeCount(manifest, mix, "hiphop"), 3);
});

test("maxTakeCount: ignores sections not currently selected in the mix", () => {
  const manifest = makeManifest({ takeCount: 3 });
  const mix = createMix("hiphop"); // nothing selected -- syncMixToSelection never called
  assert.equal(maxTakeCount(manifest, mix, "hiphop"), 1);
});

test("paintRange stores whatever paint id it's given, decomposable back via getRuns + parsePaintId", () => {
  const manifest = makeManifest({ takeCount: 2 });
  const key = sectionKey(manifest.sections[0]);
  const mix = createMix("hiphop");
  syncMixToSelection(mix, manifest, [key]);
  paintRange(mix, key, 0, 0, makePaintId("hiphop", 1));
  const runs = getRuns(mix, key);
  assert.equal(runs.length, 1);
  assert.deepEqual(parsePaintId(runs[0].styleId), { styleId: "hiphop", takeRank: 1 });
});
