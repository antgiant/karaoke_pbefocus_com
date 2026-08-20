import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLines, WORDS_PER_LINE } from "../assets/js/study-modes/word-stream.js";

function words(versesWordCounts) {
  const out = [];
  versesWordCounts.forEach((count, vi) => {
    const verse = vi + 1;
    for (let n = 0; n < count; n++) out.push({ word: `w${verse}-${n}`, start: 0, end: 0, verse });
  });
  return out;
}

test("buildLines: a verse shorter than the line length is its own single line", () => {
  const canonical = words([3]);
  const { lines } = buildLines(canonical, null, 8);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].indices, [0, 1, 2]);
  assert.equal(lines[0].verse, 1);
  assert.equal(lines[0].isVerseStart, true);
});

test("buildLines: a verse longer than the line length splits into multiple lines, none crossing a verse boundary", () => {
  const canonical = words([10]); // one verse, 10 words, wordsPerLine=4 -> 3 lines (4,4,2)
  const { lines } = buildLines(canonical, null, 4);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((l) => l.indices.length), [4, 4, 2]);
  // only the first line of the verse is marked as its start
  assert.deepEqual(lines.map((l) => l.isVerseStart), [true, false, false]);
  assert.ok(lines.every((l) => l.verse === 1));
});

test("buildLines: a new verse always starts a new line, even if the previous line has room left", () => {
  const canonical = words([2, 5]); // verse1: 2 words, verse2: 5 words, wordsPerLine=8
  const { lines } = buildLines(canonical, null, 8);
  assert.equal(lines.length, 2, "verse 2 must not be appended onto verse 1's line even though there'd be room");
  assert.deepEqual(lines[0].indices, [0, 1]);
  assert.deepEqual(lines[1].indices, [2, 3, 4, 5, 6]);
  assert.equal(lines[1].isVerseStart, true);
});

test("buildLines: verses outside the allowed set are skipped entirely, not just hidden", () => {
  const canonical = words([2, 2, 2]); // verses 1, 2, 3
  const allowed = new Set([1, 3]);
  const { lines, lineOfIndex } = buildLines(canonical, allowed, 8);
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.flatMap((l) => l.indices.map((i) => canonical[i].verse)),
    [1, 1, 3, 3]
  );
  // verse 2's canonical indices (2, 3) never got assigned a line at all
  assert.equal(lineOfIndex.has(2), false);
  assert.equal(lineOfIndex.has(3), false);
});

test("buildLines: allowing every verse is equivalent to passing null", () => {
  const canonical = words([2, 2]);
  const withNull = buildLines(canonical, null, 8);
  const withAll = buildLines(canonical, new Set([1, 2]), 8);
  assert.deepEqual(withNull.lines, withAll.lines);
});

test("buildLines: lineOfIndex maps every included canonical index to its line number", () => {
  const canonical = words([5]);
  const { lines, lineOfIndex } = buildLines(canonical, null, 2); // -> 3 lines: [0,1] [2,3] [4]
  assert.equal(lines.length, 3);
  assert.equal(lineOfIndex.get(0), 0);
  assert.equal(lineOfIndex.get(1), 0);
  assert.equal(lineOfIndex.get(2), 1);
  assert.equal(lineOfIndex.get(3), 1);
  assert.equal(lineOfIndex.get(4), 2);
});

test("buildLines: empty input produces no lines", () => {
  const { lines, lineOfIndex } = buildLines([], null, 8);
  assert.deepEqual(lines, []);
  assert.equal(lineOfIndex.size, 0);
});

test("WORDS_PER_LINE default is a sane, positive karaoke-style line length", () => {
  assert.ok(Number.isInteger(WORDS_PER_LINE) && WORDS_PER_LINE > 0 && WORDS_PER_LINE <= 15);
});
