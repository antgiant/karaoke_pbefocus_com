import { test } from "node:test";
import assert from "node:assert/strict";
import { listTakes, pickRecording } from "../assets/js/library.js";

function makeSection(recordings) {
  return { book: "Mark", chapter: 1, verseStart: null, verseEnd: null, recordings };
}

test("listTakes: sorted ascending by take number, filtered to the requested style", () => {
  const section = makeSection([
    { style: "hiphop", take: 7, audioUrl: "a" },
    { style: "polka", take: 1, audioUrl: "b" },
    { style: "hiphop", take: 3, audioUrl: "c" },
  ]);
  const takes = listTakes(section, "hiphop");
  assert.deepEqual(takes.map((r) => r.take), [3, 7]);
});

test("listTakes: empty array when the style has no recordings in this section", () => {
  const section = makeSection([{ style: "hiphop", take: 1, audioUrl: "a" }]);
  assert.deepEqual(listTakes(section, "polka"), []);
});

test("pickRecording: defaults to rank 0 (lowest take), same as the pre-item-6 behavior", () => {
  const section = makeSection([
    { style: "hiphop", take: 14, audioUrl: "a" },
    { style: "hiphop", take: 6, audioUrl: "b" },
  ]);
  assert.equal(pickRecording(section, "hiphop").take, 6);
  assert.equal(pickRecording(section, "hiphop", 0).take, 6);
});

test("pickRecording: rank 1 returns the second-lowest take, addressed positionally not by literal take number", () => {
  const section = makeSection([
    { style: "hiphop", take: 23, audioUrl: "a" },
    { style: "hiphop", take: 14, audioUrl: "b" },
  ]);
  assert.equal(pickRecording(section, "hiphop", 1).take, 23);
});

test("pickRecording: an out-of-range rank falls back to rank 0 rather than erroring or returning nothing", () => {
  const section = makeSection([{ style: "hiphop", take: 5, audioUrl: "a" }]);
  assert.equal(pickRecording(section, "hiphop", 1).take, 5, "only one take exists -- rank 1 falls back to it");
  assert.equal(pickRecording(section, "hiphop", 99).take, 5);
});

test("pickRecording: null when the style has no recording at all, regardless of rank", () => {
  const section = makeSection([{ style: "hiphop", take: 1, audioUrl: "a" }]);
  assert.equal(pickRecording(section, "polka", 0), null);
  assert.equal(pickRecording(section, "polka", 5), null);
});
