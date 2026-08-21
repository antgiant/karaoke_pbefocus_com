import { test } from "node:test";
import assert from "node:assert/strict";
import { formatRelativeDate, getSectionHistory, lastAccuracy, lastAttempt, recordAttempt } from "../assets/js/history.js";

test("recordAttempt appends to a section's list without mutating the input history object", () => {
  const original = {};
  const next = recordAttempt(original, "Mark|1|null|null", "karaoke", null);
  assert.deepEqual(original, {}, "input object is untouched");
  assert.equal(getSectionHistory(next, "Mark|1|null|null").length, 1);
  assert.equal(getSectionHistory(next, "Mark|1|null|null")[0].mode, "karaoke");
  assert.equal(getSectionHistory(next, "Mark|1|null|null")[0].accuracy, null);
});

test("recordAttempt keeps a section's existing attempts and appends, leaving other sections alone", () => {
  let history = recordAttempt({}, "Mark|1|null|null", "karaoke", null);
  history = recordAttempt(history, "Mark|1|null|null", "typeahead", 0.75);
  history = recordAttempt(history, "1 John|2|null|null", "singalong", 0.5);
  assert.equal(getSectionHistory(history, "Mark|1|null|null").length, 2);
  assert.equal(getSectionHistory(history, "1 John|2|null|null").length, 1);
});

test("recordAttempt caps a section's attempts at a rolling maximum, dropping the oldest first", () => {
  let history = {};
  for (let i = 0; i < 60; i++) history = recordAttempt(history, "k", "karaoke", null);
  const attempts = getSectionHistory(history, "k");
  assert.ok(attempts.length <= 50, `expected a capped list, got ${attempts.length}`);
});

test("getSectionHistory returns an empty array for a section with no history", () => {
  assert.deepEqual(getSectionHistory({}, "nope"), []);
});

test("lastAttempt returns the most recent entry, or null if there's none", () => {
  assert.equal(lastAttempt({}, "k"), null);
  let history = recordAttempt({}, "k", "karaoke", null);
  history = recordAttempt(history, "k", "typeahead", 0.9);
  assert.equal(lastAttempt(history, "k").mode, "typeahead");
});

test("lastAccuracy skips over null (unscored) attempts to find the most recent real score", () => {
  let history = recordAttempt({}, "k", "typeahead", 0.6);
  history = recordAttempt(history, "k", "karaoke", null);
  assert.equal(lastAccuracy(history, "k"), 0.6);
});

test("lastAccuracy returns null when a section has only unscored attempts", () => {
  const history = recordAttempt({}, "k", "karaoke", null);
  assert.equal(lastAccuracy(history, "k"), null);
});

test("formatRelativeDate: today, days, weeks, months, years", () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  assert.equal(formatRelativeDate(daysAgo(0)), "today");
  assert.equal(formatRelativeDate(daysAgo(1)), "1d ago");
  assert.equal(formatRelativeDate(daysAgo(3)), "3d ago");
  assert.equal(formatRelativeDate(daysAgo(14)), "2w ago");
  assert.equal(formatRelativeDate(daysAgo(90)), "3mo ago");
  assert.equal(formatRelativeDate(daysAgo(400)), "1y ago");
});
