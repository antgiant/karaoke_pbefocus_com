// CRUD over the playlist collection stored by storage.js. Pure/testable --
// no DOM, no localStorage I/O (that's storage.js's job). A "playlist
// record" is the raw persisted shape: {id, name, selectedSectionKeys,
// verseSelections, activeStyle, mix}, the same fields the single implicit
// selection used to carry directly (see AI_TODO.md item 5) -- main.js
// converts a record to/from the live in-memory selection/verseSelections/
// mix objects via selection.js/mix.js, same as it always did.

function generateId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneRecord(record) {
  return typeof structuredClone === "function" ? structuredClone(record) : JSON.parse(JSON.stringify(record));
}

/**
 * Karaoke Mode settings (the redesigned study-mode UI -- one slider from
 * "Karaoke" to "Memorized" plus a few checkboxes, replacing the old
 * mode/mask-style dropdowns) default to plain, unscored karaoke:
 * blankPercent 0 = nothing blanked, matching "should default to unscored
 * karaoke mode." scoredInput starts `null` (not yet chosen) rather than a
 * fixed value so the first time Scored gets checked, it still auto-detects
 * by browser capability (see main.js) instead of always defaulting to one
 * input method regardless of what the browser supports.
 */
export function defaultStudyOptions() {
  return {
    blankPercent: 0,
    rampOnRepeat: false,
    lengthMatched: false,
    scored: false,
    scoredInput: null,
    duckVocals: false, // off by default -- a genuine "guess the words" recall mode, not what most Pathfinders expect out of the box
    // Sleep Mode's independent instrumental/vocal volume sliders
    // (AI_TODO.md item 2), 0-1 each. Both default to full volume -- the
    // normal full-mix balance, same as before these sliders existed.
    instrumentalVolume: 1,
    vocalVolume: 1,
    // "Name that Passage" (AI_TODO.md item 6): helpLevel 0-100 (full help by
    // default, same "start easy" philosophy as blankPercent's 0-default),
    // and nameThatPassageInput follows scoredInput's own null-means-
    // "auto-detect by browser capability, not yet an explicit choice"
    // convention.
    nameThatPassageHelp: 100,
    nameThatPassageInput: null,
  };
}

export function createPlaylistRecord(name) {
  return {
    id: generateId(),
    name,
    selectedSectionKeys: [],
    verseSelections: {},
    activeStyle: null,
    mix: null,
    studyOptions: defaultStudyOptions(),
    // Karaoke Controls (AI_TODO.md item 4) middle/song tiers -- see
    // karaoke-controls.js's resolveKaraokeControls. Both start empty
    // (nothing overridden, everything follows the app-wide default):
    // karaokeControlsOverride is a *partial* settings object (only the
    // fields this playlist has explicitly customized); Section Overrides is
    // a plain object keyed by sectionKey, each value itself a partial
    // settings object for that one section ("song").
    karaokeControlsOverride: {},
    karaokeControlsSectionOverrides: {},
  };
}

export function findPlaylist(playlists, id) {
  return playlists.find((p) => p.id === id) ?? null;
}

/** No-op if `id` doesn't exist or `newName` is blank (silently ignored -- callers should validate input before calling, this just guards against being handed garbage). */
export function renamePlaylist(playlists, id, newName) {
  const trimmed = (newName ?? "").trim();
  if (!trimmed) return;
  const record = findPlaylist(playlists, id);
  if (record) record.name = trimmed;
}

function uniqueCopyName(playlists, baseName) {
  const existing = new Set(playlists.map((p) => p.name));
  let candidate = `${baseName} copy`;
  let n = 2;
  while (existing.has(candidate)) {
    candidate = `${baseName} copy ${n}`;
    n += 1;
  }
  return candidate;
}

/** Deep-copies `id`'s playlist (a new id, "<name> copy" or "<name> copy N" if that's taken) and appends it. Returns the new record, or null if `id` doesn't exist. */
export function duplicatePlaylist(playlists, id) {
  const record = findPlaylist(playlists, id);
  if (!record) return null;
  const copy = { ...cloneRecord(record), id: generateId(), name: uniqueCopyName(playlists, record.name) };
  playlists.push(copy);
  return copy;
}

/**
 * Removes `id`'s playlist in place. The list is never left empty -- deleting
 * the last playlist creates a fresh default one instead. Returns the id
 * that should become the new active playlist (the one before the deleted
 * one, or the first remaining one, or the fresh default).
 */
export function deletePlaylist(playlists, id) {
  const index = playlists.findIndex((p) => p.id === id);
  if (index === -1) return playlists[0]?.id ?? null;
  playlists.splice(index, 1);
  if (playlists.length === 0) {
    const fresh = createPlaylistRecord("My Playlist");
    playlists.push(fresh);
    return fresh.id;
  }
  return playlists[Math.max(0, index - 1)].id;
}
