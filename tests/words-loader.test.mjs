import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureWordsLoaded } from "../assets/js/offline/words-loader.js";

function makeManifest() {
  return {
    styles: [{ id: "hiphop", label: "Hip Hop" }],
    sections: [
      {
        book: "Mark",
        chapter: 1,
        verseStart: null,
        verseEnd: null,
        wordCount: 1,
        verseNumbers: [1],
        recordings: [
          { style: "hiphop", take: 1, wordsUrl: "mark1-hiphop.json" },
          { style: "polka", take: 1, wordsUrl: "mark1-polka.json" },
        ],
      },
      {
        book: "Mark",
        chapter: 2,
        verseStart: null,
        verseEnd: null,
        wordCount: 1,
        verseNumbers: [1],
        recordings: [{ style: "hiphop", take: 1, wordsUrl: "mark2-hiphop.json" }],
      },
    ],
  };
}

function sectionKeyFor(section) {
  return [section.book, section.chapter, section.verseStart ?? "", section.verseEnd ?? ""].join("|");
}

function fakeReader(byUrl) {
  const calls = [];
  return {
    calls,
    readWords: async (url) => {
      calls.push(url);
      return byUrl[url];
    },
  };
}

test("ensureWordsLoaded: fetches and attaches words for every recording in the selected sections", async () => {
  const manifest = makeManifest();
  const [section1] = manifest.sections;
  const { readWords, calls } = fakeReader({
    "mark1-hiphop.json": { words: [{ word: "In", start: 0, end: 0.3, verse: 1 }] },
    "mark1-polka.json": { words: [{ word: "In", start: 0, end: 0.4, verse: 1 }] },
  });

  await ensureWordsLoaded(manifest, [sectionKeyFor(section1)], readWords);

  assert.deepEqual(calls.sort(), ["mark1-hiphop.json", "mark1-polka.json"]);
  assert.deepEqual(section1.recordings[0].words, [{ word: "In", start: 0, end: 0.3, verse: 1 }]);
  assert.deepEqual(section1.recordings[1].words, [{ word: "In", start: 0, end: 0.4, verse: 1 }]);
  // The unselected section's recording must stay untouched.
  assert.equal(manifest.sections[1].recordings[0].words, undefined);
});

test("ensureWordsLoaded: a recording that already has .words is skipped -- no redundant fetch", async () => {
  const manifest = makeManifest();
  const [section1] = manifest.sections;
  section1.recordings[0].words = [{ word: "already-loaded", start: 0, end: 0.1, verse: 1 }];
  const { readWords, calls } = fakeReader({
    "mark1-polka.json": { words: [{ word: "In", start: 0, end: 0.4, verse: 1 }] },
  });

  await ensureWordsLoaded(manifest, [sectionKeyFor(section1)], readWords);

  assert.deepEqual(calls, ["mark1-polka.json"], "only the not-yet-loaded recording should be fetched");
  assert.deepEqual(section1.recordings[0].words, [{ word: "already-loaded", start: 0, end: 0.1, verse: 1 }]);
});

test("ensureWordsLoaded: loads across multiple selected sections at once", async () => {
  const manifest = makeManifest();
  const [section1, section2] = manifest.sections;
  const { readWords } = fakeReader({
    "mark1-hiphop.json": { words: [] },
    "mark1-polka.json": { words: [] },
    "mark2-hiphop.json": { words: [] },
  });

  await ensureWordsLoaded(manifest, [sectionKeyFor(section1), sectionKeyFor(section2)], readWords);

  assert.ok(Array.isArray(section1.recordings[0].words));
  assert.ok(Array.isArray(section1.recordings[1].words));
  assert.ok(Array.isArray(section2.recordings[0].words));
});

test("ensureWordsLoaded: an unknown key is silently skipped, not an error", async () => {
  const manifest = makeManifest();
  const { readWords, calls } = fakeReader({});
  await assert.doesNotReject(ensureWordsLoaded(manifest, ["Nonexistent|99||"], readWords));
  assert.deepEqual(calls, []);
});
