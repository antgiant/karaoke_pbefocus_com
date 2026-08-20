import { test } from "node:test";
import assert from "node:assert/strict";
import { createMix, getTakeRank, setTakeRank, setDefaultTakeRank, toSerializable, fromSerializable } from "../assets/js/mix.js";

const KEY = "Mark|1|null|null";

test("getTakeRank: defaults to 0 (today's unchanged lowest-take behavior) with no overrides set", () => {
  const mix = createMix("hiphop");
  assert.equal(getTakeRank(mix, KEY, "hiphop"), 0);
});

test("setDefaultTakeRank: becomes the fallback for every (section, style) with no more specific override", () => {
  const mix = createMix("hiphop");
  setDefaultTakeRank(mix, 1);
  assert.equal(getTakeRank(mix, KEY, "hiphop"), 1);
  assert.equal(getTakeRank(mix, "Mark|2|null|null", "polka"), 1, "applies blanket, not tied to one section/style");
});

test("setTakeRank: a per-(section, style) override wins over the default", () => {
  const mix = createMix("hiphop");
  setDefaultTakeRank(mix, 1);
  setTakeRank(mix, KEY, "hiphop", 0);
  assert.equal(getTakeRank(mix, KEY, "hiphop"), 0, "explicit override for this section+style");
  assert.equal(getTakeRank(mix, "Mark|2|null|null", "hiphop"), 1, "other sections still follow the default");
});

test("setTakeRank: two different styles in the same section can have independent overrides", () => {
  const mix = createMix("hiphop");
  setTakeRank(mix, KEY, "hiphop", 1);
  setTakeRank(mix, KEY, "polka", 2);
  assert.equal(getTakeRank(mix, KEY, "hiphop"), 1);
  assert.equal(getTakeRank(mix, KEY, "polka"), 2);
});

test("setTakeRank: setting a rank equal to the current default clears the override instead of storing a no-op entry", () => {
  const mix = createMix("hiphop");
  setTakeRank(mix, KEY, "hiphop", 1); // default is 0, so this is a real override
  assert.equal(Object.keys(mix.takeOverrides).length, 1);
  setTakeRank(mix, KEY, "hiphop", 0); // matches the default again
  assert.equal(Object.keys(mix.takeOverrides).length, 0, "override cleared, not stored as {hiphop: 0}");
  assert.equal(getTakeRank(mix, KEY, "hiphop"), 0);
});

test("toSerializable/fromSerializable round-trip defaultTakeRank and takeOverrides", () => {
  const manifest = { styles: [{ id: "hiphop", label: "Hip Hop" }], sections: [] };
  const mix = createMix("hiphop");
  setDefaultTakeRank(mix, 1);
  setTakeRank(mix, KEY, "polka", 2);

  const restored = fromSerializable(toSerializable(mix), manifest);
  assert.equal(restored.defaultTakeRank, 1);
  assert.deepEqual(restored.takeOverrides, { [KEY]: { polka: 2 } });
});

test("fromSerializable: missing/malformed take fields in saved data don't throw, default to 0/{}", () => {
  const manifest = { styles: [{ id: "hiphop", label: "Hip Hop" }], sections: [] };
  const restored = fromSerializable({ defaultStyleId: "hiphop", sections: {} }, manifest);
  assert.equal(restored.defaultTakeRank, 0);
  assert.deepEqual(restored.takeOverrides, {});
});
