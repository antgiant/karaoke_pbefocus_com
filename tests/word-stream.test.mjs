import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installDom, uninstallDom } from "./helpers/dom.mjs";
import { makeSection, makeFakeEngine, makeBlock, sectionKeyFor } from "./helpers/fixtures.mjs";

before(() => installDom());
after(() => uninstallDom());

// Imported after installDom() runs (top-level `before` executes before any
// test body, but static imports run before that) -- word-stream.js only
// touches `document` inside function bodies, never at module-load time, so
// importing it before the DOM is installed is safe as long as no test
// calls createPassageView() before the before() hook has run. node:test
// guarantees before() runs first.
const { createPassageView, LINE_TRANSITION_MS } = await import("../assets/js/study-modes/word-stream.js");

const MANIFEST_STUB = { styles: [{ id: "indiepop", label: "Indie Pop Ballad" }] };

/**
 * Mounts createPassageView and, unless `skipInitialBlockchange` is set,
 * immediately emits the blockchange that (in the real app) engine.play()
 * fires once playback of the first block actually starts -- see
 * makeFakeEngine's doc comment for why this ordering matters.
 */
function setup({ versesWordCounts = [3, 3, 2], allowedVerses = null, skipInitialBlockchange = false } = {}) {
  const { section, words } = makeSection({ versesWordCounts });
  const manifest = { ...MANIFEST_STUB, sections: [section] };
  const key = sectionKeyFor(section);
  const block = makeBlock({ words, sectionKey: key, canonicalWords: words });
  const engine = makeFakeEngine({ blocks: [block] });
  const container = document.createElement("div");
  const verseFilter = allowedVerses ? new Map([[key, allowedVerses]]) : undefined;
  const view = createPassageView(container, engine, manifest, null, verseFilter);
  if (!skipInitialBlockchange) engine.emit("blockchange", block);
  return { view, container, engine, block, section, words, key };
}

function currentLineWords(container) {
  const current = container.querySelector(".karaoke-line.current-line");
  return current ? [...current.querySelectorAll(".karaoke-word")].map((el) => el.textContent.trim()) : [];
}

function nextLineWords(container) {
  const next = container.querySelector(".karaoke-line.next-line");
  return next ? [...next.querySelectorAll(".karaoke-word")].map((el) => el.textContent.trim()) : [];
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("initial render: shows the current line + a preview of the next, and the section heading", () => {
  // verse 1 is exactly WORDS_PER_LINE (8) words -> fills line 0 completely;
  // verse 2 always starts its own new line (never merged onto verse 1's),
  // so it becomes the next-line preview.
  const { container } = setup({ versesWordCounts: [8, 3] });
  const heading = container.querySelector(".karaoke-heading");
  assert.equal(heading.textContent, "1 John 1");
  assert.deepEqual(currentLineWords(container), ["w1-0", "w1-1", "w1-2", "w1-3", "w1-4", "w1-5", "w1-6", "w1-7"]);
  assert.deepEqual(nextLineWords(container), ["w2-0", "w2-1", "w2-2"]);
});

test("a verse longer than one line still only shows the current line + next line, not the whole passage", () => {
  // 20 words in one verse -> lines of 8, 8, 4 -> 3 lines total
  const { container } = setup({ versesWordCounts: [20] });
  assert.equal(currentLineWords(container).length, 8);
  assert.equal(nextLineWords(container).length, 8);
  // nothing from line 3 (the last 4 words) should be in the DOM yet
  const allShown = [...container.querySelectorAll(".karaoke-word")].map((el) => el.textContent.trim());
  assert.ok(!allShown.includes("w1-16"), "words beyond the 2-line window must not be rendered at all");
});

test("verse filter: a verse outside the allowed set never appears in the window", () => {
  const { container } = setup({ versesWordCounts: [2, 2, 2], allowedVerses: new Set([1, 3]) });
  const shown = [...container.querySelectorAll(".karaoke-word")].map((el) => el.textContent.trim());
  assert.ok(!shown.some((t) => t.startsWith("w2-")), "verse 2 was filtered out and must not appear");
  assert.ok(shown.includes("w1-0") && shown.includes("w3-0"));
});

test("highlight advances the active word and, once it crosses a line boundary, swaps the window", async () => {
  const { container, engine, block, words } = setup({ versesWordCounts: [20] }); // 3 lines: 8/8/4
  // word index 7 (last word of line 0) is still within the current line -- no swap yet.
  engine.emit("timeupdate", words[7].start, block);
  assert.deepEqual(currentLineWords(container).slice(0, 1), ["w1-0"], "still showing line 0 as current");
  assert.ok(container.querySelector(".karaoke-word.active").textContent.trim() === "w1-7");

  // word index 8 (first word of line 1) crosses into the next line -> window must swap.
  engine.emit("timeupdate", words[8].start, block);
  await wait(LINE_TRANSITION_MS + 50);
  assert.deepEqual(currentLineWords(container).slice(0, 1), ["w1-8"], "current line swapped to line 1");
  assert.equal(container.querySelectorAll(".karaoke-line-group").length, 1, "the outgoing group is removed after its transition");
});

test("clicking a word seeks playback to that word's block/time", () => {
  const { container, engine, block } = setup({ versesWordCounts: [3, 3, 2] });
  const target = [...container.querySelectorAll(".karaoke-word")][2]; // "w1-2"
  assert.equal(target.textContent.trim(), "w1-2");
  target.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(engine.calls.skipToBlock.length, 1);
  assert.equal(engine.calls.skipToBlock[0].programIndex, 0);
  assert.equal(engine.calls.skipToBlock[0].time, block.words[2].start);
});

test("Enter/Space on a focused word also seeks (keyboard accessibility)", () => {
  const { container, engine } = setup({ versesWordCounts: [3] });
  const target = [...container.querySelectorAll(".karaoke-word")][1];
  target.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  assert.equal(engine.calls.skipToBlock.length, 1);
});

test("manual navigation: Next line pauses the engine and advances the window without a timeupdate event", async () => {
  const { container, engine } = setup({ versesWordCounts: [20] }); // 3 lines
  const nextBtn = [...container.querySelectorAll(".karaoke-line-nav button")].find((b) => /Next/.test(b.textContent));
  nextBtn.click();
  await wait(LINE_TRANSITION_MS + 50);
  assert.equal(engine.calls.pause, 1, "manual navigation must pause playback");
  assert.deepEqual(currentLineWords(container).slice(0, 1), ["w1-8"], "window advanced to line 1 purely from the button");
});

test("manual navigation: Previous/Next buttons disable at the first/last line", async () => {
  const { container } = setup({ versesWordCounts: [5] }); // one verse, under WORDS_PER_LINE -> exactly 1 line
  const [prevBtn, nextBtn] = [...container.querySelectorAll(".karaoke-line-nav button")];
  assert.equal(prevBtn.disabled, true, "already at the only/first line");
  assert.equal(nextBtn.disabled, true, "already at the only/last line");
});

test("setRenderWord/setOnPastWord hooks (used by masking study modes) only fire for currently-rendered words", () => {
  // Mirrors real usage (see karaoke.js/invisible-word.js etc.): the study
  // mode sets its hooks right after construction, *before* playback (and
  // so the first render) actually starts.
  const { view, container, engine, block, words } = setup({ versesWordCounts: [20], skipInitialBlockchange: true });
  const seenPast = [];
  view.setRenderWord((w) => ({ text: w.word.toUpperCase() }));
  view.setOnPastWord((el, isPast, i) => {
    if (isPast) seenPast.push(i);
  });

  engine.emit("blockchange", block);
  assert.ok(currentLineWords(container)[0].startsWith("W1-"), "renderWord hook applied (uppercased)");

  engine.emit("timeupdate", words[3].start, block);
  assert.deepEqual(seenPast, [0, 1, 2], "onPastWord only called for indices 0..2, all within the rendered window");
});

test("getCanonical returns the full passage regardless of what's currently windowed", () => {
  const { view, words } = setup({ versesWordCounts: [20] });
  assert.equal(view.getCanonical().length, words.length);
});

test("markWord no-ops silently for a canonical index outside the current window", () => {
  const { view } = setup({ versesWordCounts: [20] }); // index 15 is in line 2, not rendered (lines 0+1 only)
  assert.doesNotThrow(() => view.markWord(15, "hit", true));
});

test("unmount stops listening to further engine events", () => {
  const { view, container, engine, block, words } = setup({ versesWordCounts: [3] });
  view.unmount();
  const before = container.innerHTML;
  engine.emit("timeupdate", words[1].start, block);
  assert.equal(container.innerHTML, before, "no further DOM changes after unmount");
});
