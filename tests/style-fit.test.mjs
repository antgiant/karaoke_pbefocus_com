import { test } from "node:test";
import assert from "node:assert/strict";
import { churchFitEmoji, churchFitText, churchFitDescription } from "../assets/js/style-fit.js";

test("churchFitEmoji: a fixed value returns its single emoji", () => {
  assert.equal(churchFitEmoji("great-match"), "😇");
  assert.equal(churchFitEmoji("nervous"), "😬");
  assert.equal(churchFitEmoji("very-uncomfortable"), "😱");
});

test("churchFitEmoji: a range returns both emoji, dominant first", () => {
  assert.equal(churchFitEmoji(["very-uncomfortable", "great-match"]), "😱😇");
});

test("churchFitEmoji: unrecognized/missing value degrades to empty string rather than throwing", () => {
  assert.equal(churchFitEmoji("not-a-real-value"), "");
  assert.equal(churchFitEmoji(undefined), "");
  assert.equal(churchFitEmoji(null), "");
});

test("churchFitText: fixed value pairs the emoji with its plain-language phrase", () => {
  assert.equal(churchFitText("great-match"), "😇 Great match for singing in church");
  assert.equal(churchFitText("very-uncomfortable"), "😱 A big departure for singing in church");
});

test("churchFitText: a range reads as 'Varies', not one specific phrase", () => {
  assert.equal(churchFitText(["very-uncomfortable", "great-match"]), "😱😇 Varies for singing in church");
});

test("churchFitText: degrades to empty string for a missing/unrecognized value", () => {
  assert.equal(churchFitText(undefined), "");
});

test("churchFitDescription: fixed value returns just its phrase", () => {
  assert.equal(churchFitDescription("nervous"), "A bit of a stretch for singing in church");
});

test("churchFitDescription: a range explains both ends in plain language", () => {
  const desc = churchFitDescription(["very-uncomfortable", "great-match"]);
  assert.match(desc, /usually a big departure/i);
  assert.match(desc, /occasionally great match/i);
});

test("churchFitDescription: degrades to empty string for a missing/unrecognized value", () => {
  assert.equal(churchFitDescription("bogus"), "");
});
