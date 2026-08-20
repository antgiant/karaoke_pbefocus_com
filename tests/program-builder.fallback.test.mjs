import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProgram } from "../assets/js/program-builder.js";
import { createMix } from "../assets/js/mix.js";
import { sectionKey } from "../assets/js/library.js";

// AI_TODO.md item 8: alignmentFor's fallback used to try a dead
// FALLBACK_STYLE_ID = "default" (never a real style id, so it always
// missed) before falling through to section.recordings[0] -- whichever
// recording happens to be listed first in the manifest, regardless of
// what the Pathfinder actually picked as their default style. It should
// try the Pathfinder's actual mix.defaultStyleId first.

function makeManifest() {
  const words = [
    { word: "In", start: 0, end: 0.5, verse: 1 },
    { word: "the", start: 0.5, end: 1, verse: 1 },
    { word: "beginning", start: 1, end: 1.5, verse: 1 },
  ];
  const section = {
    book: "Mark",
    chapter: 1,
    verseStart: null,
    verseEnd: null,
    recordings: [
      // Listed first -- an old, dead "section.recordings[0]" fallback
      // would land here regardless of the Pathfinder's actual choice.
      { style: "broadway", take: 1, instrumentalUrl: "broadway.instrumental.m4a", vocalUrl: "broadway.vocal.m4a", words },
      { style: "hiphop", take: 1, instrumentalUrl: "hiphop.instrumental.m4a", vocalUrl: "hiphop.vocal.m4a", words },
    ],
  };
  return { styles: [{ id: "broadway", label: "Broadway" }, { id: "hiphop", label: "Hip Hop" }], sections: [section] };
}

test("buildProgram falls back to the Pathfinder's actual default style, not section.recordings[0], when the requested style has no recording", () => {
  const manifest = makeManifest();
  const key = sectionKey(manifest.sections[0]);
  const mix = createMix("hiphop"); // the Pathfinder's actual choice
  const selected = new Set([key]);
  // A run requesting a style with no recording in this section at all --
  // bypasses syncMixToSelection's normal defaultStyleId fill on purpose.
  mix.sections.set(key, new Array(3).fill("reggaeton"));

  const program = buildProgram(manifest, mix, selected);
  assert.equal(program.blocks.length, 1);
  assert.equal(program.blocks[0].style, "hiphop", "should fall back to the Pathfinder's default style, not the first-listed recording");
  assert.equal(program.blocks[0].instrumentalUrl, "hiphop.instrumental.m4a");
  assert.equal(program.fallbacks[0].usedStyle, "hiphop");
  assert.equal(program.fallbacks[0].requestedStyle, "reggaeton");
});

test("buildProgram falls back to section.recordings[0] as a last resort when even the default style has no recording here", () => {
  const manifest = makeManifest();
  const key = sectionKey(manifest.sections[0]);
  const mix = createMix("indiepop"); // no recording anywhere in this section
  const selected = new Set([key]);
  mix.sections.set(key, new Array(3).fill("reggaeton"));

  const program = buildProgram(manifest, mix, selected);
  assert.equal(program.blocks.length, 1);
  assert.equal(program.blocks[0].style, "broadway", "last resort: whichever recording is listed first");
});
