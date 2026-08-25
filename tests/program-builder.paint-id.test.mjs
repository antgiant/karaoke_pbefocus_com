import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProgram } from "../assets/js/program-builder.js";
import { createMix, makePaintId, paintRange, syncMixToSelection } from "../assets/js/mix.js";
import { sectionKey } from "../assets/js/library.js";

// AI_TODO.md item 1: takes are now painted like any other style (a paint id
// encoding style + take, see mix.js) instead of being chosen through a
// separate mix.defaultTakeRank/takeOverrides control -- buildProgram has to
// decompose a run's paint id back into {styleId, takeRank} and resolve the
// matching recording directly.

function makeManifest() {
  const section = {
    book: "Mark",
    chapter: 1,
    verseStart: null,
    verseEnd: null,
    wordCount: 2,
    recordings: [
      {
        style: "hiphop",
        take: 1,
        instrumentalUrl: "take1.instrumental.m4a",
        vocalUrl: "take1.vocal.m4a",
        words: [
          { word: "In", start: 0, end: 0.5, verse: 1 },
          { word: "the", start: 0.5, end: 1, verse: 1 },
        ],
      },
      {
        style: "hiphop",
        take: 2,
        instrumentalUrl: "take2.instrumental.m4a",
        vocalUrl: "take2.vocal.m4a",
        words: [
          { word: "In", start: 10, end: 10.5, verse: 1 },
          { word: "the", start: 10.5, end: 11, verse: 1 },
        ],
      },
    ],
  };
  return { styles: [{ id: "hiphop", label: "Hip Hop" }], sections: [section] };
}

test("buildProgram picks the first/lowest take by default (an unpainted section's plain style id)", () => {
  const manifest = makeManifest();
  const key = sectionKey(manifest.sections[0]);
  const mix = createMix("hiphop");
  const selected = new Set([key]);
  syncMixToSelection(mix, manifest, selected);

  const program = buildProgram(manifest, mix, selected);
  assert.equal(program.blocks[0].instrumentalUrl, "take1.instrumental.m4a");
  assert.equal(program.blocks[0].take, 1);
  assert.equal(program.blocks[0].style, "hiphop", "block.style stays a real style id, not a paint id");
});

test("buildProgram resolves a painted take-2 paint id to the second recording", () => {
  const manifest = makeManifest();
  const key = sectionKey(manifest.sections[0]);
  const mix = createMix("hiphop");
  const selected = new Set([key]);
  syncMixToSelection(mix, manifest, selected);
  paintRange(mix, key, 0, 1, makePaintId("hiphop", 1));

  const program = buildProgram(manifest, mix, selected);
  assert.equal(program.blocks[0].instrumentalUrl, "take2.instrumental.m4a");
  assert.equal(program.blocks[0].take, 2);
  assert.equal(program.blocks[0].style, "hiphop");
});

test("buildProgram: painting only part of a section to take 2 splits it into separate blocks per take", () => {
  const manifest = makeManifest();
  const key = sectionKey(manifest.sections[0]);
  const mix = createMix("hiphop");
  const selected = new Set([key]);
  syncMixToSelection(mix, manifest, selected);
  paintRange(mix, key, 1, 1, makePaintId("hiphop", 1)); // just the second word gets take 2

  const program = buildProgram(manifest, mix, selected);
  assert.equal(program.blocks.length, 2);
  assert.equal(program.blocks[0].instrumentalUrl, "take1.instrumental.m4a");
  assert.equal(program.blocks[1].instrumentalUrl, "take2.instrumental.m4a");
});

test("buildProgram: an out-of-range take paint id (more takes than this section actually has) falls back to the lowest take rather than erroring", () => {
  const manifest = makeManifest();
  const key = sectionKey(manifest.sections[0]);
  const mix = createMix("hiphop");
  const selected = new Set([key]);
  syncMixToSelection(mix, manifest, selected);
  paintRange(mix, key, 0, 1, makePaintId("hiphop", 5)); // only 2 takes exist

  const program = buildProgram(manifest, mix, selected);
  assert.equal(program.blocks[0].instrumentalUrl, "take1.instrumental.m4a");
});
