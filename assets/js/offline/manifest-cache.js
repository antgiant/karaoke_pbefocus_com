// Persists the library manifest's own content (AI_TODO.md item 7) -- not
// just its URL -- so a reload can fall back to the last-known copy when
// offline, no matter how it was originally loaded (a URL, or an uploaded
// file, which has no URL of its own to re-fetch from). Uses the Cache
// Storage API rather than localStorage: a full library manifest can run to
// several MB for a large recording library, comfortably past what
// localStorage's much smaller quota reliably holds. See gate.js for how
// this gets read/written on each load path.

const MANIFEST_CACHE_NAME = "pbe-manifest-cache-v1";
const UPLOAD_KEY_PATH = "/__offline_manifest__/";

/**
 * A valid, same-origin, never-actually-requested URL to use as an uploaded
 * manifest's Cache Storage key. Cache.put/match require an http(s) URL --
 * an uploaded file has no real one of its own, so `id` (see gate.js's
 * UPLOAD_PREFIX identifiers) gets one synthesized under a reserved path
 * instead, purely as a lookup key.
 */
export function uploadCacheKey(id) {
  return `${window.location.origin}${UPLOAD_KEY_PATH}${id}`;
}

/** Best-effort: failing to persist just means the next offline load won't have a fallback copy -- never fatal to the load that's succeeding right now. */
export async function saveManifest(key, manifest) {
  try {
    const cache = await caches.open(MANIFEST_CACHE_NAME);
    await cache.put(key, new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json" } }));
  } catch {
    // best-effort, see above
  }
}

/** Returns the persisted manifest for `key`, or null if there isn't one (never seen, or Cache Storage unavailable/cleared). */
export async function loadManifest(key) {
  try {
    const cache = await caches.open(MANIFEST_CACHE_NAME);
    const response = await cache.match(key);
    return response ? await response.json() : null;
  } catch {
    return null;
  }
}

export async function clearManifestCache() {
  try {
    await caches.delete(MANIFEST_CACHE_NAME);
  } catch {
    // best-effort
  }
}
