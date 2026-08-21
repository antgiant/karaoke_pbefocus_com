import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { installDom, uninstallDom } from "./helpers/dom.mjs";

before(() => installDom());
after(() => uninstallDom());
beforeEach(() => localStorage.clear());

const { loadState, saveState, SCHEMA_VERSION } = await import("../assets/js/storage.js");
const { STORAGE_KEY } = await import("../assets/js/constants.js");

test("loadState with nothing saved yet: one default playlist, active id set to it", () => {
  const state = loadState();
  assert.equal(state.schemaVersion, SCHEMA_VERSION);
  assert.equal(state.manifestUrl, null);
  assert.equal(state.playlists.length, 1);
  assert.equal(state.playlists[0].name, "My Playlist");
  assert.equal(state.activePlaylistId, state.playlists[0].id);
});

test("saveState then loadState round-trips a multi-playlist collection exactly", () => {
  const saved = {
    schemaVersion: SCHEMA_VERSION,
    manifestUrl: "https://example.com/library.json",
    playlists: [
      { id: "a", name: "Mark Drill", selectedSectionKeys: ["Mark|1|null|null"], verseSelections: {}, activeStyle: "hiphop", mix: null },
      { id: "b", name: "1 John Focus", selectedSectionKeys: [], verseSelections: {}, activeStyle: null, mix: null },
    ],
    activePlaylistId: "b",
    history: { "Mark|1|null|null": [{ date: "2026-01-01T00:00:00.000Z", mode: "karaoke", accuracy: null }] },
  };
  saveState(saved);
  const loaded = loadState();
  assert.deepEqual(loaded, saved);
});

test("loadState defaults history to an empty object when nothing's been saved yet", () => {
  const state = loadState();
  assert.deepEqual(state.history, {});
});

test("loadState falls back to a fresh default playlist for pre-schemaVersion-2 (or otherwise malformed) saved state, without throwing", () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, manifestUrl: "https://example.com/library.json", selectedSectionKeys: ["x"], mix: {} }));
  const state = loadState();
  assert.equal(state.playlists.length, 1);
  assert.equal(state.playlists[0].name, "My Playlist");
  assert.equal(state.manifestUrl, "https://example.com/library.json", "manifestUrl is still carried over -- it's independent of the playlist schema change");
  assert.equal(state.activePlaylistId, state.playlists[0].id);
});

test("loadState recovers from corrupt JSON in localStorage rather than throwing", () => {
  localStorage.setItem(STORAGE_KEY, "{not valid json");
  const state = loadState();
  assert.equal(state.playlists.length, 1);
  assert.equal(state.activePlaylistId, state.playlists[0].id);
});

test("loadState repairs an activePlaylistId that no longer matches any playlist (e.g. that playlist was deleted in another tab)", () => {
  saveState({
    schemaVersion: SCHEMA_VERSION,
    manifestUrl: null,
    playlists: [{ id: "only-one", name: "Solo", selectedSectionKeys: [], verseSelections: {}, activeStyle: null, mix: null }],
    activePlaylistId: "some-other-id-that-does-not-exist",
  });
  const state = loadState();
  assert.equal(state.activePlaylistId, "only-one");
});

test("saveState is a non-throwing no-op if localStorage.setItem fails (e.g. private browsing/quota)", () => {
  const original = localStorage.setItem;
  localStorage.setItem = () => {
    throw new Error("quota exceeded");
  };
  try {
    assert.doesNotThrow(() => saveState({ schemaVersion: SCHEMA_VERSION, playlists: [], activePlaylistId: null }));
  } finally {
    localStorage.setItem = original;
  }
});
