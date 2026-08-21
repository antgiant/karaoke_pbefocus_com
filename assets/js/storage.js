import { STORAGE_KEY } from "./constants.js";
import { createPlaylistRecord } from "./playlists.js";

// schemaVersion 2: a named, listable collection of playlists instead of one
// implicit selection (see AI_TODO.md item 5). Pre-release -- no migration
// from schemaVersion 1's shape, just a clean break; loadState() below
// falls back to a fresh single default playlist for anything that doesn't
// already look like the current shape (missing/malformed `playlists`),
// which also covers a first-ever visit.
export const SCHEMA_VERSION = 2;

function defaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    manifestUrl: null,
    playlists: [createPlaylistRecord("My Playlist")],
    activePlaylistId: null, // resolved to playlists[0].id below once the array exists
    // sectionKey -> Attempt[] (see history.js) -- global across playlists,
    // not per-playlist, since the same section can be studied from more
    // than one playlist and should share one history (AI_TODO.md item 5).
    history: {},
  };
}

function withDefaultActivePlaylist(state) {
  if (state.activePlaylistId && state.playlists.some((p) => p.id === state.activePlaylistId)) return state;
  return { ...state, activePlaylistId: state.playlists[0]?.id ?? null };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return withDefaultActivePlaylist(defaultState());
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("bad state");
    if (!Array.isArray(parsed.playlists) || parsed.playlists.length === 0) {
      // Anything pre-schemaVersion-2 (or otherwise not already in the
      // current shape) starts fresh rather than being migrated -- see the
      // schemaVersion comment above.
      return withDefaultActivePlaylist({ ...defaultState(), manifestUrl: parsed.manifestUrl ?? null });
    }
    return withDefaultActivePlaylist({ ...defaultState(), ...parsed });
  } catch {
    return withDefaultActivePlaylist(defaultState());
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) -- non-fatal, just no persistence.
  }
}
