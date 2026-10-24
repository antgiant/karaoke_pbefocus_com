// Merge helpers for synced documents. All of them are commutative, associative and idempotent, so devices converge no matter
// what order they exchange data in. Deletes are tombstones (`deleted: true` with a newer stamp), never removals.

import { stableStringify } from "./envelope.js";

const stampOf = (record, key) => (typeof record?.[key] === "number" ? record[key] : 0);

/** Picks the newer of two versions of a record; an exact tie is broken by comparing content, so every device picks the same one. */
function newer(a, b, stampKey) {
  const sa = stampOf(a, stampKey);
  const sb = stampOf(b, stampKey);
  if (sa !== sb) return sa > sb ? a : b;
  return stableStringify(a) >= stableStringify(b) ? a : b;
}

/**
 * Merges two arrays of records that have a stable `id` and an `updatedAt` stamp: last writer wins per record.
 * @param {object[]} a
 * @param {object[]} b
 * @param {{ idKey?: string, stampKey?: string, sort?: (x: object, y: object) => number }} [options]
 *  `sort` fixes the order of the result (default: by `createdAt`, then id) so every device ends up with identical arrays.
 */
export function mergeRecords(a = [], b = [], { idKey = "id", stampKey = "updatedAt", sort } = {}) {
  const byId = new Map();
  for (const rec of [...a, ...b]) {
    if (!rec || rec[idKey] === undefined) continue;
    const prev = byId.get(rec[idKey]);
    byId.set(rec[idKey], prev ? newer(prev, rec, stampKey) : rec);
  }
  const order = sort || ((x, y) => stampOf(x, "createdAt") - stampOf(y, "createdAt") || String(x[idKey]).localeCompare(String(y[idKey])));
  return [...byId.values()].sort(order);
}

/** Last-writer-wins for a single value stored as `{ v, t }`. Missing values lose. */
export function mergeStamped(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return newer(a, b, "t");
}

/** Merges two objects whose every property is a `{ v, t }` stamped value. */
export function mergeStampedMap(a = {}, b = {}) {
  const out = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) out[key] = mergeStamped(a[key], b[key]);
  return out;
}

/**
 * Union of two arrays of immutable items (for example practice attempts), keyed by `keyFn`, sorted by `sortFn`.
 * If both sides hold an item with the same key, the first argument's copy is kept (the items are assumed identical).
 */
export function unionBy(a = [], b = [], keyFn, sortFn) {
  const seen = new Map();
  for (const item of [...a, ...b]) {
    const k = keyFn(item);
    if (!seen.has(k)) seen.set(k, item);
  }
  const out = [...seen.values()];
  return sortFn ? out.sort(sortFn) : out.sort((x, y) => String(keyFn(x)).localeCompare(String(keyFn(y))));
}

/** Drops tombstones older than `maxAgeMs`. Only call once every device has had a long time to see them (weeks, not minutes). */
export function pruneTombstones(records, now, maxAgeMs, { stampKey = "updatedAt", deletedKey = "deleted" } = {}) {
  return records.filter((r) => !(r[deletedKey] && now - stampOf(r, stampKey) > maxAgeMs));
}
