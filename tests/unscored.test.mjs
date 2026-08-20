import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installDom, uninstallDom } from "./helpers/dom.mjs";
import { makeSection, makeFakeEngine, makeBlock, sectionKeyFor } from "./helpers/fixtures.mjs";

before(() => installDom());
after(() => uninstallDom());

const { LINE_TRANSITION_MS } = await import("../assets/js/study-modes/word-stream.js");
const { mountUnscored } = await import("../assets/js/study-modes/unscored.js");

const MANIFEST_STUB = { styles: [{ id: "indiepop", label: "Indie Pop Ballad" }] };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setup({ versesWordCounts = [6], options }) {
  const { section, words } = makeSection({ versesWordCounts });
  const manifest = { ...MANIFEST_STUB, sections: [section] };
  const key = sectionKeyFor(section);
  const block = makeBlock({ words, sectionKey: key, canonicalWords: words });
  const engine = makeFakeEngine({ blocks: [block] });
  const container = document.createElement("div");
  const unmount = mountUnscored(container, engine, manifest, null, options, undefined);
  engine.emit("blockchange", block);
  return { container, engine, block, words, unmount };
}

function wordEl(container, text) {
  return [...container.querySelectorAll(".karaoke-word")].find((el) => el.textContent.trim().startsWith(text) || el.textContent.trim() === text);
}

test("blankFraction 0 (the slider's 'Karaoke' end): plain text, nothing blanked, .sung toggles with isPast", () => {
  const { container, engine, block, words } = setup({ options: () => ({ blankFraction: 0 }) });
  const shown = [...container.querySelectorAll(".karaoke-word")].map((el) => el.textContent.trim());
  assert.deepEqual(shown, ["w1-0", "w1-1", "w1-2", "w1-3", "w1-4", "w1-5"]);
  assert.ok(![...container.querySelectorAll(".karaoke-word")].some((el) => el.classList.contains("blanked")));

  engine.emit("timeupdate", words[2].start, block);
  const past = [...container.querySelectorAll(".karaoke-word")].filter((el) => el.classList.contains("sung"));
  assert.equal(past.length, 2, "words 0 and 1 are before the active word (index 2)");
});

test("blankFraction 1 (the slider's 'Memorized' end): every word starts blanked, reveals real text once sung", () => {
  const { container, engine, block, words } = setup({
    options: () => ({ blankFraction: 1, lengthMatched: false }),
  });
  const initiallyBlanked = [...container.querySelectorAll(".karaoke-word.blanked")];
  assert.equal(initiallyBlanked.length, 6, "blankFraction 1 -> no hints -> every word starts blanked");
  assert.ok(initiallyBlanked.every((el) => el.textContent.trim() === "•••"), "static (non-length-matched) mask is 3 bullets");

  engine.emit("timeupdate", words[2].start, block); // words 0,1 are now past -> should reveal
  assert.equal(wordEl(container, "w1-0")?.textContent.trim(), "w1-0", "past word reveals its real text");
  assert.equal(wordEl(container, "w1-0")?.classList.contains("blanked"), false);
  assert.equal(container.querySelectorAll(".karaoke-word.blanked").length, 4, "the 2 sung words are no longer blanked");
});

test("intermediate blankFraction values partially blank the passage", () => {
  const { container } = setup({ options: () => ({ blankFraction: 0.5 }) });
  const blanked = container.querySelectorAll(".karaoke-word.blanked").length;
  assert.ok(blanked > 0 && blanked < 6, `expected some but not all words blanked at 0.5, got ${blanked}/6`);
});

test("length-matched masking produces a bullet count based on word length", () => {
  const { container } = setup({
    versesWordCounts: [1], // "w1-0", 4 chars
    options: () => ({ blankFraction: 1, lengthMatched: true }),
  });
  const el = container.querySelector(".karaoke-word.blanked");
  assert.equal(el.textContent.trim(), "•".repeat("w1-0".length));
});

test("rampOnRepeat: blankFraction ratchets *up* on each replay of the same section, capped at 1", async () => {
  const versesWordCounts = [10];
  const { section: sectionA, words: wordsA } = makeSection({ versesWordCounts, chapter: 1 });
  const { section: sectionB, words: wordsB } = makeSection({ versesWordCounts, chapter: 2 });
  const manifest = { ...MANIFEST_STUB, sections: [sectionA, sectionB] };
  const keyA = sectionKeyFor(sectionA);
  const keyB = sectionKeyFor(sectionB);
  const blockA = makeBlock({ words: wordsA, sectionKey: keyA, canonicalWords: wordsA });
  const blockB = makeBlock({ words: wordsB, sectionKey: keyB, canonicalWords: wordsB });
  const engine = makeFakeEngine({ blocks: [blockA, blockB] });
  const container = document.createElement("div");
  const START_BLANK = 0.2;
  mountUnscored(container, engine, manifest, null, () => ({ blankFraction: START_BLANK, rampOnRepeat: true }), undefined);

  engine.emit("blockchange", blockA);
  const blankedFirstVisit = container.querySelectorAll(".karaoke-word.blanked").length;

  engine.emit("blockchange", blockB); // switch away
  await wait(LINE_TRANSITION_MS + 20);
  engine.emit("blockchange", blockA); // and back -- second visit to section A
  await wait(LINE_TRANSITION_MS + 20);
  const blankedSecondVisit = container.querySelectorAll(".karaoke-word.blanked").length;

  assert.ok(
    blankedSecondVisit > blankedFirstVisit,
    `expected more blanked words on replay (harder each time): first=${blankedFirstVisit}, second=${blankedSecondVisit}`
  );
});

test("rampOnRepeat never exceeds full blank (100%) no matter how many replays", async () => {
  const versesWordCounts = [6];
  const { section, words } = makeSection({ versesWordCounts, chapter: 1 });
  const { section: otherSection, words: otherWords } = makeSection({ versesWordCounts, chapter: 2 });
  const manifest = { styles: MANIFEST_STUB.styles, sections: [section, otherSection] };
  const key = sectionKeyFor(section);
  const otherKey = sectionKeyFor(otherSection);
  const block = makeBlock({ words, sectionKey: key, canonicalWords: words });
  const otherBlock = makeBlock({ words: otherWords, sectionKey: otherKey, canonicalWords: otherWords });
  const engine = makeFakeEngine({ blocks: [block, otherBlock] });
  const container = document.createElement("div");
  mountUnscored(container, engine, manifest, null, () => ({ blankFraction: 0.9, rampOnRepeat: true }), undefined);

  // Cycle through several replays -- 0.9 + a few ramp steps would exceed 1 without the cap.
  for (let i = 0; i < 4; i++) {
    engine.emit("blockchange", block);
    await wait(LINE_TRANSITION_MS + 20);
    engine.emit("blockchange", otherBlock);
    await wait(LINE_TRANSITION_MS + 20);
  }
  engine.emit("blockchange", block);
  await wait(LINE_TRANSITION_MS + 20);
  assert.equal(container.querySelectorAll(".karaoke-word.blanked").length, 6, "still exactly fully blanked, not broken by exceeding 1.0");
});

test("unmount stops rendering further updates", () => {
  const { container, engine, block, words, unmount } = setup({ options: () => ({ blankFraction: 0 }) });
  unmount();
  const before = container.innerHTML;
  engine.emit("timeupdate", words[4].start, block);
  assert.equal(container.innerHTML, before);
});
