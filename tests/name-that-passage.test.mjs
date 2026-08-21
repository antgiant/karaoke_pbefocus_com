import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installDom, uninstallDom } from "./helpers/dom.mjs";
import { makeSection, makeFakeEngine, sectionKeyFor } from "./helpers/fixtures.mjs";

before(() => installDom());
after(() => uninstallDom());

const { normalizeGuess, isCorrectGuess, pickRandomSectionKey, pickSampleLocation, mountNameThatPassage } = await import(
  "../assets/js/study-modes/name-that-passage.js"
);
const { createMix } = await import("../assets/js/mix.js");
const { buildProgram } = await import("../assets/js/program-builder.js");

test("normalizeGuess lowercases, trims, and collapses whitespace", () => {
  assert.equal(normalizeGuess("  John   3  "), "john 3");
  assert.equal(normalizeGuess("John 3"), "john 3");
});

test("isCorrectGuess: strict book+chapter equality, no abbreviation/spoken-form tolerance", () => {
  const section = { book: "John", chapter: 3 };
  assert.equal(isCorrectGuess("john 3", section), true);
  assert.equal(isCorrectGuess("  John   3 ", section), true, "whitespace/case tolerated");
  assert.equal(isCorrectGuess("John 3:16", section), false, "verse suffix not accepted -- strict equality only");
  assert.equal(isCorrectGuess("Jn 3", section), false, "abbreviation not accepted");
  assert.equal(isCorrectGuess("John chapter 3", section), false, "spoken form not accepted");
  assert.equal(isCorrectGuess("John 4", section), false, "wrong chapter");
  assert.equal(isCorrectGuess("Mark 3", section), false, "wrong book");
});

test("pickRandomSectionKey returns one of the given keys", () => {
  const keys = ["a", "b", "c"];
  for (let i = 0; i < 20; i++) {
    assert.ok(keys.includes(pickRandomSectionKey(keys)));
  }
});

test("pickSampleLocation picks from the pool and filters out the section's final minTailSeconds", () => {
  const blocks = [
    {
      words: [
        { word: "w0", start: 0 },
        { word: "w1", start: 1 },
        { word: "w2", start: 2 },
        { word: "w3", start: 8 }, // within the final 3s of a 10s-outTime section -- should be filtered
      ],
      outTime: 10,
    },
  ];
  for (let i = 0; i < 20; i++) {
    const loc = pickSampleLocation(blocks, { minTailSeconds: 3 });
    assert.ok(loc.time <= 7, `expected a location outside the final 3s, got time=${loc.time}`);
  }
});

test("pickSampleLocation falls back to the unfiltered pool when the tail filter would empty it (short section)", () => {
  const blocks = [{ words: [{ word: "only", start: 0 }], outTime: 0.9 }];
  const loc = pickSampleLocation(blocks, { minTailSeconds: 3 });
  assert.deepEqual(loc, { programIndex: 0, time: 0 });
});

test("pickSampleLocation returns null for a program with no words", () => {
  assert.equal(pickSampleLocation([{ words: [], outTime: 0 }]), null);
});

function setupMount() {
  const { section } = makeSection({ book: "1 John", chapter: 1, versesWordCounts: [4, 4] });
  const key = sectionKeyFor(section);
  const manifest = { styles: [{ id: "indiepop", label: "Indie Pop Ballad" }], sections: [section] };
  const mix = createMix("indiepop");
  const program = buildProgram(manifest, mix, [key]);
  const engine = makeFakeEngine({ blocks: program.blocks });
  const container = document.createElement("div");
  const attempts = [];
  const unmount = mountNameThatPassage(
    container,
    engine,
    manifest,
    mix,
    [key],
    undefined,
    () => ({ helpLevel: 1, inputMethod: "typed" }),
    (...args) => attempts.push(args)
  );
  return { container, engine, section, key, attempts, unmount };
}

test("mountNameThatPassage renders a Play Sample button and a typed-guess input, and reveals nothing about the answer upfront", () => {
  const { container, unmount } = setupMount();
  const playBtn = [...container.querySelectorAll("button")].find((b) => b.textContent.includes("Play Sample"));
  assert.ok(playBtn, "Play Sample button should render");
  assert.ok(container.querySelector(".ntp-guess-input"), "typed guess input should render for inputMethod: typed");
  assert.equal(container.querySelector(".karaoke-heading"), null, "the passage heading (which shows the answer) must never render");
  unmount();
});

test("a correct guess reports onAttempt with accuracy 1 and shows correct feedback", () => {
  const { container, section, key, attempts, unmount } = setupMount();
  const guessInput = container.querySelector(".ntp-guess-input");
  const guessBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Guess");
  guessInput.value = `${section.book} ${section.chapter}`;
  guessBtn.click();

  const feedback = container.querySelector(".ntp-feedback");
  assert.equal(feedback.hidden, false);
  assert.ok(feedback.classList.contains("ntp-correct"));
  assert.equal(attempts.length, 1);
  assert.deepEqual(attempts[0], [key, "namethatpassage", 1]);
  unmount();
});

test("an incorrect guess reports onAttempt with accuracy 0 and shows incorrect feedback", () => {
  const { container, attempts, unmount } = setupMount();
  const guessInput = container.querySelector(".ntp-guess-input");
  const guessBtn = [...container.querySelectorAll("button")].find((b) => b.textContent === "Guess");
  guessInput.value = "Not A Real Book 99";
  guessBtn.click();

  const feedback = container.querySelector(".ntp-feedback");
  assert.ok(feedback.classList.contains("ntp-incorrect"));
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0][2], 0);
  unmount();
});

test("unmount resets the shared engine's stem track volumes back to full", () => {
  const { engine, unmount } = setupMount();
  unmount();
  const last = engine.calls.setStemTrackVolumes.at(-1);
  assert.deepEqual(last, { instrumental: 1, vocal: 1 });
});
