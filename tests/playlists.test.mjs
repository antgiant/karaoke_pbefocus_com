import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlaylistRecord, defaultStudyOptions, findPlaylist, renamePlaylist, duplicatePlaylist, deletePlaylist } from "../assets/js/playlists.js";

test("createPlaylistRecord: fresh record has the expected empty shape and a unique id", () => {
  const a = createPlaylistRecord("Mark Drill");
  const b = createPlaylistRecord("Mark Drill");
  assert.equal(a.name, "Mark Drill");
  assert.deepEqual(a.selectedSectionKeys, []);
  assert.deepEqual(a.verseSelections, {});
  assert.equal(a.activeStyle, null);
  assert.equal(a.mix, null);
  assert.notEqual(a.id, b.id, "two records must not collide on id even with the same name");
});

test("defaultStudyOptions: defaults to unscored plain karaoke (nothing blanked), per its own contract", () => {
  const options = defaultStudyOptions();
  assert.equal(options.blankPercent, 0);
  assert.equal(options.rampOnRepeat, false);
  assert.equal(options.lengthMatched, false);
  assert.equal(options.scored, false);
  assert.equal(options.scoredInput, null, "not yet chosen -- lets the UI auto-detect on first use rather than forcing one input method");
  assert.equal(options.duckVocals, false, "off by default -- a new/experimental effect, and only a handful of recordings have stems so far");
  assert.equal(options.instrumentalVolume, 1, "Sleep Mode's instrumental slider defaults to full volume, the normal mix balance");
  assert.equal(options.vocalVolume, 1, "Sleep Mode's vocal slider defaults to full volume, the normal mix balance");
});

test("createPlaylistRecord: studyOptions defaults to defaultStudyOptions()", () => {
  const record = createPlaylistRecord("Mark Drill");
  assert.deepEqual(record.studyOptions, defaultStudyOptions());
});

test("findPlaylist: finds by id, returns null when absent", () => {
  const list = [createPlaylistRecord("A"), createPlaylistRecord("B")];
  assert.equal(findPlaylist(list, list[1].id), list[1]);
  assert.equal(findPlaylist(list, "nope"), null);
});

test("renamePlaylist: renames in place, trims whitespace, ignores blank/missing input", () => {
  const list = [createPlaylistRecord("Old Name")];
  const id = list[0].id;
  renamePlaylist(list, id, "  New Name  ");
  assert.equal(list[0].name, "New Name");

  renamePlaylist(list, id, "   ");
  assert.equal(list[0].name, "New Name", "blank name is ignored, not applied");

  renamePlaylist(list, "missing-id", "Should not throw");
  assert.equal(list.length, 1);
});

test("duplicatePlaylist: deep-copies content (including studyOptions) under a new id and a disambiguated name", () => {
  const original = createPlaylistRecord("Study Set");
  original.selectedSectionKeys = ["Mark|1|null|null"];
  original.mix = { defaultStyleId: "hiphop", sections: { "Mark|1|null|null": ["hiphop", "hiphop"] } };
  original.studyOptions = { ...original.studyOptions, blankPercent: 40, scored: true };
  const list = [original];

  const copy = duplicatePlaylist(list, original.id);
  assert.equal(list.length, 2);
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.name, "Study Set copy");
  assert.deepEqual(copy.selectedSectionKeys, original.selectedSectionKeys);
  assert.deepEqual(copy.mix, original.mix);
  assert.deepEqual(copy.studyOptions, original.studyOptions);

  // mutating the copy must not affect the original (a real deep copy, not a shared reference)
  copy.mix.sections["Mark|1|null|null"][0] = "polka";
  assert.equal(original.mix.sections["Mark|1|null|null"][0], "hiphop");
  copy.studyOptions.blankPercent = 90;
  assert.equal(original.studyOptions.blankPercent, 40);

  const copy2 = duplicatePlaylist(list, original.id);
  assert.equal(copy2.name, "Study Set copy 2", "a second duplicate disambiguates further");
});

test("duplicatePlaylist: returns null for a missing id, list unchanged", () => {
  const list = [createPlaylistRecord("Only One")];
  const result = duplicatePlaylist(list, "missing-id");
  assert.equal(result, null);
  assert.equal(list.length, 1);
});

test("deletePlaylist: removes the target and returns the previous entry as the new active id", () => {
  const list = [createPlaylistRecord("A"), createPlaylistRecord("B"), createPlaylistRecord("C")];
  const [a, b, c] = list;
  const nextActive = deletePlaylist(list, b.id);
  assert.deepEqual(list.map((p) => p.id), [a.id, c.id]);
  assert.equal(nextActive, a.id, "falls back to the entry before the deleted one");
});

test("deletePlaylist: deleting the first entry falls back to the new first entry", () => {
  const list = [createPlaylistRecord("A"), createPlaylistRecord("B")];
  const [a, b] = list;
  const nextActive = deletePlaylist(list, a.id);
  assert.deepEqual(list.map((p) => p.id), [b.id]);
  assert.equal(nextActive, b.id);
});

test("deletePlaylist: deleting the only playlist creates a fresh default one rather than leaving the list empty", () => {
  const list = [createPlaylistRecord("Only One")];
  const onlyId = list[0].id;
  const nextActive = deletePlaylist(list, onlyId);
  assert.equal(list.length, 1);
  assert.notEqual(list[0].id, onlyId);
  assert.equal(list[0].name, "My Playlist");
  assert.equal(nextActive, list[0].id);
});

test("deletePlaylist: a missing id is a no-op that still returns a sane active id", () => {
  const list = [createPlaylistRecord("A")];
  const nextActive = deletePlaylist(list, "missing-id");
  assert.equal(list.length, 1);
  assert.equal(nextActive, list[0].id);
});
