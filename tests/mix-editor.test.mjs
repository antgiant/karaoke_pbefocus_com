import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installDom, uninstallDom } from "./helpers/dom.mjs";

before(() => installDom());
after(() => uninstallDom());

const { mountMixEditor } = await import("../assets/js/mix-editor.js");
const { createMix, makePaintId, syncMixToSelection } = await import("../assets/js/mix.js");
const { sectionKey } = await import("../assets/js/library.js");

function makeManifest({ takeCount = 1 } = {}) {
  const words = [
    { word: "In", start: 0, end: 0.5, verse: 1 },
    { word: "the", start: 0.5, end: 1, verse: 1 },
  ];
  const recordings = [];
  for (let i = 0; i < takeCount; i++) {
    recordings.push({ style: "hiphop", take: i + 1, instrumentalUrl: `t${i}.instrumental.m4a`, vocalUrl: `t${i}.vocal.m4a`, words });
  }
  const section = { book: "Mark", chapter: 1, verseStart: null, verseEnd: null, wordCount: words.length, recordings };
  return { styles: [{ id: "hiphop", label: "Hip Hop" }], sections: [section] };
}

function setup({ takeCount = 1 } = {}) {
  const manifest = makeManifest({ takeCount });
  const key = sectionKey(manifest.sections[0]);
  const mix = createMix("hiphop");
  syncMixToSelection(mix, manifest, [key]);
  const container = document.createElement("div");
  let changeCount = 0;
  const handle = mountMixEditor(container, manifest, mix, new Set([key]), () => {
    changeCount += 1;
  });
  return { manifest, key, mix, container, handle, getChangeCount: () => changeCount };
}

test("a single-take style gets exactly one palette swatch, with no take number in its label", () => {
  const { container } = setup({ takeCount: 1 });
  const swatches = [...container.querySelectorAll(".style-swatch")];
  assert.equal(swatches.length, 1);
  assert.doesNotMatch(swatches[0].textContent, /Take/);
});

test("a multi-take style gets one palette swatch per take, each labeled with its take number", () => {
  const { container } = setup({ takeCount: 3 });
  const swatches = [...container.querySelectorAll(".style-swatch")];
  assert.equal(swatches.length, 3);
  assert.match(swatches[0].textContent, /Take 1/);
  assert.match(swatches[1].textContent, /Take 2/);
  assert.match(swatches[2].textContent, /Take 3/);
});

test("the first take's swatch starts active, matching mix.defaultStyleId", () => {
  const { container } = setup({ takeCount: 2 });
  const swatches = [...container.querySelectorAll(".style-swatch")];
  assert.ok(swatches[0].classList.contains("active"));
  assert.ok(!swatches[1].classList.contains("active"));
});

test("painting a word with a take-2 swatch stores that take's paint id in mix.sections, and calls onChange", () => {
  const { container, mix, key, getChangeCount } = setup({ takeCount: 2 });
  const swatches = [...container.querySelectorAll(".style-swatch")];
  swatches[1].click(); // select the "Take 2" brush

  const chip = container.querySelector(".word-chip");
  chip.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  window.dispatchEvent(new Event("pointerup"));

  assert.equal(mix.sections.get(key)[0], makePaintId("hiphop", 1));
  assert.equal(getChangeCount(), 1);
});

test("a word chip painted with a take-2 paint id gets the alt-take class and a take-number tooltip", () => {
  const manifest = makeManifest({ takeCount: 2 });
  const key = sectionKey(manifest.sections[0]);
  const mix = createMix("hiphop");
  syncMixToSelection(mix, manifest, [key]);
  mix.sections.get(key)[0] = makePaintId("hiphop", 1); // pre-paint the first word to take 2 before mounting

  const container = document.createElement("div");
  mountMixEditor(container, manifest, mix, new Set([key]), () => {});

  const chip = container.querySelector(".word-chip");
  assert.ok(chip.classList.contains("word-chip-alt-take"));
  assert.match(chip.title, /Take 2/);
});

test("a section with a multi-take style in use gets a preview row with one button per take", () => {
  const { container } = setup({ takeCount: 3 });
  const previewButtons = [...container.querySelectorAll(".mix-take-preview-btn")];
  assert.equal(previewButtons.length, 3);
  assert.deepEqual(previewButtons.map((b) => b.textContent), ["Take 1", "Take 2", "Take 3"]);
});

test("a single-take section gets no preview row at all", () => {
  const { container } = setup({ takeCount: 1 });
  assert.equal(container.querySelectorAll(".mix-take-preview-btn").length, 0);
});

test("unmount doesn't throw and removes its window listeners", () => {
  const { handle } = setup({ takeCount: 2 });
  assert.doesNotThrow(() => handle.unmount());
});

function paintWord(container, chipIndex, swatchIndex) {
  const swatches = [...container.querySelectorAll(".style-swatch")];
  swatches[swatchIndex].click();
  const chip = container.querySelectorAll(".word-chip")[chipIndex];
  chip.dispatchEvent(new Event("pointerdown", { bubbles: true }));
  window.dispatchEvent(new Event("pointerup"));
}

test("undo and redo buttons start disabled", () => {
  const { container } = setup({ takeCount: 2 });
  const [undoBtn, redoBtn] = container.querySelectorAll(".mix-history-toolbar button");
  assert.ok(undoBtn.disabled);
  assert.ok(redoBtn.disabled);
});

test("undo restores the pre-paint style and re-enables redo; redo re-applies the paint", () => {
  const { container, mix, key, getChangeCount } = setup({ takeCount: 2 });
  const [undoBtn, redoBtn] = container.querySelectorAll(".mix-history-toolbar button");

  paintWord(container, 0, 1); // paint word 0 to take 2
  assert.equal(mix.sections.get(key)[0], makePaintId("hiphop", 1));
  assert.ok(!undoBtn.disabled);

  undoBtn.click();
  assert.equal(mix.sections.get(key)[0], "hiphop"); // back to the original default paint id
  assert.ok(undoBtn.disabled);
  assert.ok(!redoBtn.disabled);
  assert.equal(getChangeCount(), 2); // one for the paint, one for the undo

  redoBtn.click();
  assert.equal(mix.sections.get(key)[0], makePaintId("hiphop", 1));
  assert.ok(!undoBtn.disabled);
  assert.ok(redoBtn.disabled);
  assert.equal(getChangeCount(), 3);
});

test("painting a word with the style it's already painted doesn't add an undo step", () => {
  const { container } = setup({ takeCount: 1 }); // mix.defaultStyleId is "hiphop", same as the only swatch
  const [undoBtn] = container.querySelectorAll(".mix-history-toolbar button");

  paintWord(container, 0, 0); // repaint word 0 with the style it already has
  assert.ok(undoBtn.disabled);
});

test("a new paint stroke clears the redo stack", () => {
  const { container, mix, key } = setup({ takeCount: 2 });
  const [, redoBtn] = container.querySelectorAll(".mix-history-toolbar button");

  paintWord(container, 0, 1);
  container.querySelectorAll(".mix-history-toolbar button")[0].click(); // undo
  assert.ok(!redoBtn.disabled);

  paintWord(container, 1, 1); // a fresh stroke on a different word
  assert.ok(redoBtn.disabled);
  assert.equal(mix.sections.get(key)[1], makePaintId("hiphop", 1));
});
