// Covers createPassageView's `typing`/`hideNav` options (AI_TODO.md item 3,
// Sleep Mode's typing-effect two-line display) -- see word-stream.test.mjs
// for the default (non-typing) window/nav behavior these options replace.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installDom, uninstallDom } from "./helpers/dom.mjs";
import { makeSection, makeFakeEngine, makeBlock, sectionKeyFor } from "./helpers/fixtures.mjs";

before(() => installDom());
after(() => uninstallDom());

const { createPassageView, LINE_TRANSITION_MS } = await import("../assets/js/study-modes/word-stream.js");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MANIFEST_STUB = { styles: [{ id: "indiepop", label: "Indie Pop Ballad" }] };

function setup({ versesWordCounts = [20], options = { typing: true, hideNav: true } } = {}) {
  const { section, words } = makeSection({ versesWordCounts });
  const manifest = { ...MANIFEST_STUB, sections: [section] };
  const key = sectionKeyFor(section);
  const block = makeBlock({ words, sectionKey: key, canonicalWords: words });
  const engine = makeFakeEngine({ blocks: [block] });
  const container = document.createElement("div");
  const view = createPassageView(container, engine, manifest, null, undefined, options);
  engine.emit("blockchange", block);
  return { view, container, engine, block, words, key };
}

function lettersOf(wordEl) {
  return [...wordEl.querySelectorAll(".letter")];
}

function wordEls(container, roleClass) {
  const line = container.querySelector(`.karaoke-line.${roleClass}`);
  return line ? [...line.querySelectorAll(".karaoke-word")] : [];
}

test("hideNav: true omits the Previous/Next line nav buttons from the DOM entirely", () => {
  const { container } = setup({ options: { hideNav: true } });
  assert.equal(container.querySelector(".karaoke-line-nav"), null);
});

test("hideNav absent (default) still renders the nav, unaffected by typing", () => {
  const { container } = setup({ options: { typing: true } });
  assert.ok(container.querySelector(".karaoke-line-nav"), "nav must still render when hideNav isn't passed");
});

test("typing: true windows previous-line + current-line, never a next-line preview", async () => {
  // 3 lines (8/8/4). Cross into line 1 so a previous line actually exists.
  const { container, engine, block, words } = setup({ versesWordCounts: [20] });
  engine.emit("timeupdate", words[8].start, block);
  await wait(LINE_TRANSITION_MS + 50); // let the outgoing (old current-line) group finish removal
  assert.equal(container.querySelector(".karaoke-line.next-line"), null, "no forward preview in typing mode");
  assert.deepEqual(
    wordEls(container, "previous-line").map((el) => el.textContent.trim()),
    ["w1-0", "w1-1", "w1-2", "w1-3", "w1-4", "w1-5", "w1-6", "w1-7"]
  );
  assert.deepEqual(wordEls(container, "current-line").slice(0, 1).map((el) => el.textContent.trim()), ["w1-8"]);
});

test("typing: true has no previous line yet on the very first line (nothing to show above it)", () => {
  const { container } = setup({ versesWordCounts: [20] });
  assert.equal(container.querySelector(".karaoke-line.previous-line"), null);
  assert.ok(container.querySelector(".karaoke-line.current-line"));
});

test("typing: true renders each word as per-letter spans, all hidden until reached", () => {
  const { container } = setup({ versesWordCounts: [3] });
  const first = wordEls(container, "current-line")[0]; // "w1-0" -- 4 chars + trailing space = 5 letters
  const letters = lettersOf(first);
  assert.equal(letters.length, 5);
  assert.ok(letters.every((l) => !l.classList.contains("shown")), "nothing revealed before any timeupdate");
});

test("typing: true reveals a word's letters in proportion to elapsed time across its start/end", () => {
  const { container, engine, block, words } = setup({ versesWordCounts: [3] });
  // words[0]: start 0, end 0.9 -> halfway through at t=0.45
  engine.emit("timeupdate", 0.45, block);
  const letters = lettersOf(wordEls(container, "current-line")[0]);
  const shownCount = letters.filter((l) => l.classList.contains("shown")).length;
  assert.ok(shownCount > 0 && shownCount < letters.length, `expected partial reveal, got ${shownCount}/${letters.length}`);
});

test("typing: true finalizes a word to fully shown once playback moves past it", () => {
  const { container, engine, block, words } = setup({ versesWordCounts: [3] });
  engine.emit("timeupdate", 0.45, block); // partway through word 0
  engine.emit("timeupdate", words[1].start, block); // now on word 1 -- word 0 is past
  const firstLetters = lettersOf(wordEls(container, "current-line")[0]);
  assert.ok(firstLetters.every((l) => l.classList.contains("shown")), "a past word's letters must all be shown, not left mid-reveal");
});

test("typing: true shows a not-yet-reached word's letters as fully hidden, even after a later word was active", () => {
  const { container, engine, block, words } = setup({ versesWordCounts: [3] });
  engine.emit("timeupdate", words[1].start, block);
  const thirdLetters = lettersOf(wordEls(container, "current-line")[2]);
  assert.ok(thirdLetters.every((l) => !l.classList.contains("shown")));
});

test("typing: true marks the previous line's words fully shown (finished), not partially revealed", async () => {
  const { container, engine, block, words } = setup({ versesWordCounts: [20] });
  engine.emit("timeupdate", words[8].start, block); // crosses into line 1 -> line 0 becomes previous-line
  await wait(LINE_TRANSITION_MS + 50);
  for (const wordEl of wordEls(container, "previous-line")) {
    const letters = lettersOf(wordEl);
    assert.ok(letters.every((l) => l.classList.contains("shown")), `${wordEl.textContent.trim()} should be fully typed already`);
  }
});

test("typing: true tags every word span with typing-word for CSS to hook into", () => {
  const { container } = setup({ versesWordCounts: [3] });
  const words = wordEls(container, "current-line");
  assert.ok(words.length > 0);
  assert.ok(words.every((el) => el.classList.contains("typing-word")));
});

test("typing: true still lets click-to-seek work on a word built from letter spans", () => {
  const { container, engine, block } = setup({ versesWordCounts: [3] });
  const target = wordEls(container, "current-line")[1]; // "w1-1"
  target.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(engine.calls.skipToBlock.length, 1);
  assert.equal(engine.calls.skipToBlock[0].time, block.words[1].start);
});
