import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBookTree, parseWordsFile, validateManifest } from "../assets/js/library.js";

function makeManifest(sectionOverrides = {}) {
  return {
    styles: [{ id: "hiphop", label: "Hip Hop" }],
    sections: [
      {
        book: "Mark",
        chapter: 1,
        verseStart: null,
        verseEnd: null,
        wordCount: 12,
        verseNumbers: [1, 2],
        recordings: [{ style: "hiphop", take: 1, wordsUrl: "Mark 1.json" }],
        ...sectionOverrides,
      },
    ],
  };
}

test("validateManifest: accepts the index shape -- wordCount/verseNumbers required, no inline words needed", () => {
  const manifest = makeManifest();
  assert.deepEqual(validateManifest(manifest), manifest);
});

test("validateManifest: rejects a section missing wordCount", () => {
  const manifest = makeManifest();
  delete manifest.sections[0].wordCount;
  assert.throws(() => validateManifest(manifest), /wordCount/);
});

test("validateManifest: rejects a section missing verseNumbers", () => {
  const manifest = makeManifest();
  delete manifest.sections[0].verseNumbers;
  assert.throws(() => validateManifest(manifest), /verseNumbers/);
});

test("validateManifest: still rejects a section with no recordings", () => {
  const manifest = makeManifest({ recordings: [] });
  assert.throws(() => validateManifest(manifest), /recordings/);
});

test("buildBookTree: reads wordCount/verseNumbers straight off the section -- no recording's words[] needed", () => {
  const manifest = makeManifest({ wordCount: 245, verseNumbers: [1, 2, 3] });
  const [book] = buildBookTree(manifest);
  assert.equal(book.chapters[0].wordCount, 245);
  assert.deepEqual(book.chapters[0].verseNumbers, [1, 2, 3]);
});

test("buildBookTree: styleIds is still derived live from recordings (unaffected by the words -> wordsUrl split)", () => {
  const manifest = makeManifest({
    recordings: [
      { style: "hiphop", take: 1, wordsUrl: "a.json" },
      { style: "polka", take: 1, wordsUrl: "b.json" },
      { style: "hiphop", take: 2, wordsUrl: "c.json" },
    ],
  });
  const [book] = buildBookTree(manifest);
  assert.deepEqual(book.chapters[0].styleIds, ["hiphop", "polka"]);
});

test("parseWordsFile: unwraps a valid word-timing sidecar's words array", () => {
  const words = [{ word: "In", start: 0, end: 0.3, verse: 1 }];
  assert.deepEqual(parseWordsFile({ text: "In the beginning", words }), words);
});

test("parseWordsFile: rejects a file with no words list", () => {
  assert.throws(() => parseWordsFile({ text: "oops" }), /has no "words" list/);
  assert.throws(() => parseWordsFile(null), /has no "words" list/);
});
