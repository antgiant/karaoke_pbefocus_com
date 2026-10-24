// Turns Karaoke's persisted state into a mergeable "sync document" and back (docs/unified-storage-plan.md, Phase 1).
//
// The app mutates its state in place at many call sites and never stamped changes, so stamps are DERIVED here instead of at each
// call site: a small sidecar `meta` remembers a content hash and an `updatedAt` per record; whenever the state is turned into a
// document, any record whose content differs from its hash gets a new stamp, and any record that has disappeared becomes a
// tombstone. Pure and testable: no DOM, no localStorage I/O (cloud.js does that).
//
// Synced:   playlists (by id, last writer wins, tombstones), practice history (union), app-wide controls and text scale (per field).
// Not synced (device-local): manifestUrl (a library link can grant access to the whole private library), activePlaylistId, audio caches.

import { stableStringify } from "../../vendor/pbe-storage/envelope.js";
import { mergeRecords, mergeStampedMap, unionBy } from "../../vendor/pbe-storage/merge.js";

export const SYNC_SCHEMA = 1;
export const MAX_ATTEMPTS_PER_SECTION = 50;

export function emptyMeta() {
  return { playlists: {}, controls: {}, textScale: {} };
}

export function emptyDoc() {
  return { playlists: [], history: {}, controls: {}, textScale: {} };
}

const clone = (v) => JSON.parse(JSON.stringify(v));

function normalizeMeta(meta) {
  const m = meta && typeof meta === "object" ? clone(meta) : {};
  return { playlists: m.playlists ?? {}, controls: m.controls ?? {}, textScale: m.textScale ?? {} };
}

/** Stamps a map of plain values `{ field: value }` against `metaMap`, returning the stamped map `{ field: { v, t } }`. */
function stampFields(values, metaMap, now) {
  const out = {};
  for (const [field, v] of Object.entries(values ?? {})) {
    const hash = stableStringify(v);
    const prev = metaMap[field];
    const t = prev && prev.hash === hash ? prev.t : now;
    metaMap[field] = { hash, t };
    out[field] = { v: clone(v), t };
  }
  return out;
}

/**
 * Builds the sync document for the current state and the updated sidecar.
 * @param {object} state what storage.js loads/saves
 * @param {object} [meta] the sidecar from the previous call (emptyMeta() the first time)
 * @param {number} [now]
 * @returns {{ doc: object, meta: object }}
 */
export function toSyncDoc(state, meta, now = Date.now()) {
  const next = normalizeMeta(meta);
  const playlists = [];
  const seen = new Set();

  for (const p of state.playlists ?? []) {
    seen.add(p.id);
    const hash = stableStringify(p);
    const prev = next.playlists[p.id];
    let m;
    if (!prev || prev.deleted) m = { createdAt: prev ? prev.createdAt : now, updatedAt: now, hash, deleted: false };
    else if (prev.hash !== hash) m = { ...prev, hash, updatedAt: now };
    else m = prev;
    next.playlists[p.id] = m;
    playlists.push({ id: p.id, createdAt: m.createdAt, updatedAt: m.updatedAt, record: clone(p) });
  }
  for (const [id, prev] of Object.entries(next.playlists)) {
    if (seen.has(id)) continue;
    const t = prev.deleted ? prev.updatedAt : now;
    next.playlists[id] = { createdAt: prev.createdAt, updatedAt: t, hash: "", deleted: true };
    playlists.push({ id, createdAt: prev.createdAt, updatedAt: t, deleted: true, record: null });
  }

  const doc = {
    playlists: mergeRecords(playlists, []),
    history: capHistory(clone(state.history ?? {})),
    controls: stampFields(state.karaokeControls, next.controls, now),
    textScale: stampFields(state.karaokeTextScale, next.textScale, now),
  };
  return { doc, meta: next };
}

const attemptKey = (a) => `${a.date}|${a.mode}|${a.accuracy}`;
const byDate = (a, b) => String(a.date).localeCompare(String(b.date)) || attemptKey(a).localeCompare(attemptKey(b));

function capHistory(history) {
  const out = {};
  for (const [key, attempts] of Object.entries(history)) {
    if (!Array.isArray(attempts) || !attempts.length) continue;
    out[key] = unionBy(attempts, [], attemptKey, byDate).slice(-MAX_ATTEMPTS_PER_SECTION);
  }
  return out;
}

function mergeHistory(a = {}, b = {}) {
  const out = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out[key] = unionBy(a[key] ?? [], b[key] ?? [], attemptKey, byDate).slice(-MAX_ATTEMPTS_PER_SECTION);
  }
  return out;
}

/** Commutative, associative and idempotent: devices converge whatever order they sync in. */
export function mergeDocs(a = emptyDoc(), b = emptyDoc()) {
  return {
    playlists: mergeRecords(a.playlists ?? [], b.playlists ?? []),
    history: mergeHistory(a.history, b.history),
    controls: mergeStampedMap(a.controls, b.controls),
    textScale: mergeStampedMap(a.textScale, b.textScale),
  };
}

export function docsEqual(a, b) {
  return stableStringify(a) === stableStringify(b);
}

const plain = (stamped) => Object.fromEntries(Object.entries(stamped ?? {}).map(([k, s]) => [k, clone(s.v)]));

/**
 * Applies a merged document to the state. Returns the new state and the sidecar updated to match it exactly, so applying remote data
 * is never mistaken for a local edit on the next call to toSyncDoc.
 */
export function applyDoc(state, doc, meta) {
  const next = normalizeMeta(meta);
  const live = [];
  for (const entry of doc.playlists ?? []) {
    next.playlists[entry.id] = {
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      deleted: Boolean(entry.deleted),
      hash: entry.deleted || !entry.record ? "" : stableStringify(entry.record),
    };
    if (!entry.deleted && entry.record) live.push(clone(entry.record));
  }
  for (const [field, s] of Object.entries(doc.controls ?? {})) next.controls[field] = { hash: stableStringify(s.v), t: s.t };
  for (const [field, s] of Object.entries(doc.textScale ?? {})) next.textScale[field] = { hash: stableStringify(s.v), t: s.t };

  const activePlaylistId = live.some((p) => p.id === state.activePlaylistId) ? state.activePlaylistId : (live[0]?.id ?? null);
  return {
    state: {
      ...state,
      playlists: live,
      activePlaylistId,
      history: clone(doc.history ?? {}),
      karaokeControls: { ...(state.karaokeControls ?? {}), ...plain(doc.controls) },
      karaokeTextScale: { ...(state.karaokeTextScale ?? {}), ...plain(doc.textScale) },
    },
    meta: next,
  };
}
