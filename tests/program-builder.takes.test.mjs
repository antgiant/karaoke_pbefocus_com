import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProgram } from "../assets/js/program-builder.js";
import { createMix, syncMixToSelection, setDefaultTakeRank, setTakeRank } from "../assets/js/mix.js";
import { sectionKey } from "../assets/js/library.js";

function makeManifest() {
  const section = {
    book: "Mark",
    chapter: 1,
    verseStart: null,
    verseEnd: null,
    recordings: [
      {
        style: "hiphop",
        take: 1,
        audioUrl: "take1.mp3",
        words: [
          { word: "In", start: 0, end: 0.5, verse: 1 },
          { word: "the", start: 0.5, end: 1, verse: 1 },
        ],
      },
      {
        style: "hiphop",
        take: 2,
        audioUrl: "take2.mp3",
        words: [
          { word: "In", start: 10, end: 10.5, verse: 1 },
          { word: "the", start: 10.5, end: 11, verse: 1 },
        ],
      },
    ],
  };
  return { styles: [{ id: "hiphop", label: "Hip Hop" }], sections: [section] };
}

test("buildProgram picks the lowest take by default, matching pre-item-6 behavior", () => {
  const manifest = makeManifest();
  const key = sectionKey(manifest.sections[0]);
  const mix = createMix("hiphop");
  const selected = new Set([key]);
  syncMixToSelection(mix, manifest, selected);

  const program = buildProgram(manifest, mix, selected);
  assert.equal(program.blocks[0].audioUrl, "take1.mp3");
  assert.equal(program.blocks[0].take, 1);
});

test("buildProgram honors mix.defaultTakeRank for the whole playlist", () => {
  const manifest = makeManifest();
  const key = sectionKey(manifest.sections[0]);
  const mix = createMix("hiphop");
  const selected = new Set([key]);
  syncMixToSelection(mix, manifest, selected);
  setDefaultTakeRank(mix, 1);

  const program = buildProgram(manifest, mix, selected);
  assert.equal(program.blocks[0].audioUrl, "take2.mp3");
  assert.equal(program.blocks[0].take, 2);
});

test("buildProgram: a per-(section, style) override wins over the playlist default", () => {
  const manifest = makeManifest();
  const key = sectionKey(manifest.sections[0]);
  const mix = createMix("hiphop");
  const selected = new Set([key]);
  syncMixToSelection(mix, manifest, selected);
  setDefaultTakeRank(mix, 1);
  setTakeRank(mix, key, "hiphop", 0); // pin this specific section+style back to take 1

  const program = buildProgram(manifest, mix, selected);
  assert.equal(program.blocks[0].audioUrl, "take1.mp3");
});
