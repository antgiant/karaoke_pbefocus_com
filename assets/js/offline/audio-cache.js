// Offline audio caching (AI_TODO.md item 7). Two independent Cache Storage
// caches -- an opportunistic one (whatever's played during normal use stays
// available offline, evicted LRU once it grows past a size cap) and an
// uncapped one for an explicit "download this playlist for offline" action
// -- plus a small localStorage-backed index (Cache Storage itself exposes
// no byte sizes or usage timestamps) that tracks per-URL size and
// last-used time so eviction and the storage-usage UI both have something
// to read synchronously. Every recording is an instrumental/vocal stem
// *pair* (see playback-engine.js's file-top comment) -- callers here always
// cache/evict/report on both URLs of a block together so a partially-cached
// pair can't happen.

const CACHE_NAMES = {
  opportunistic: "pbe-audio-opportunistic-v1",
  download: "pbe-audio-downloads-v1",
};
export const CACHE_KIND = { OPPORTUNISTIC: "opportunistic", DOWNLOAD: "download" };

const INDEX_STORAGE_KEY = "pbe-karaoke:offline-audio-index:v1";

// ~500MB -- generous enough to hold a few hours of a Pathfinder's actual
// listening (these are compressed AAC stems, see AGENTS.md's per-recording
// bitrates) without silently consuming a phone's entire free storage. Only
// the opportunistic cache is capped -- the explicit download action is a
// deliberate choice the Pathfinder made, not something to second-guess.
export const OPPORTUNISTIC_CAP_BYTES = 500 * 1024 * 1024;

function cacheNameFor(kind) {
  const name = CACHE_NAMES[kind];
  if (!name) throw new Error(`Unknown offline cache kind: ${kind}`);
  return name;
}

function loadIndex() {
  try {
    const raw = localStorage.getItem(INDEX_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      [CACHE_KIND.OPPORTUNISTIC]: parsed?.[CACHE_KIND.OPPORTUNISTIC] ?? {},
      [CACHE_KIND.DOWNLOAD]: parsed?.[CACHE_KIND.DOWNLOAD] ?? {},
    };
  } catch {
    return { [CACHE_KIND.OPPORTUNISTIC]: {}, [CACHE_KIND.DOWNLOAD]: {} };
  }
}

function saveIndex(index) {
  try {
    localStorage.setItem(INDEX_STORAGE_KEY, JSON.stringify(index));
  } catch {
    // localStorage unavailable/full -- non-fatal, same posture as storage.js; the
    // cache entries themselves are still usable, just without accurate usage/LRU bookkeeping.
  }
}

/** Pure: total bytes and entry count for one cache kind's index bucket -- what the storage-usage UI displays. */
export function usageFor(indexBucket) {
  const entries = Object.values(indexBucket ?? {});
  return { bytes: entries.reduce((sum, e) => sum + e.bytes, 0), count: entries.length };
}

/** Pure: bytes -> a short human string, e.g. "128 MB" / "3 recordings cached". Used by the storage-usage UI. */
export function formatCacheUsage({ bytes, count }) {
  if (count === 0) return "Nothing cached yet";
  const mb = bytes / (1024 * 1024);
  const size = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  return `${size} across ${count} recording${count === 1 ? "" : "s"}`;
}

/**
 * Pure: given a cache kind's index entries (as {url, bytes, lastUsed}[])
 * and a byte cap, returns the urls to evict -- oldest lastUsed first -- to
 * bring the total back under the cap. Exported so eviction order/behavior
 * is directly testable without touching Cache Storage or localStorage.
 */
export function pickEvictions(entries, capBytes) {
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  if (total <= capBytes) return [];
  const oldestFirst = [...entries].sort((a, b) => a.lastUsed - b.lastUsed);
  const toEvict = [];
  for (const entry of oldestFirst) {
    if (total <= capBytes) break;
    toEvict.push(entry.url);
    total -= entry.bytes;
  }
  return toEvict;
}

async function evictIfOverCap(kind) {
  const index = loadIndex();
  const bucket = index[kind];
  const entries = Object.entries(bucket).map(([url, e]) => ({ url, ...e }));
  const toEvict = pickEvictions(entries, OPPORTUNISTIC_CAP_BYTES);
  if (toEvict.length === 0) return;
  const cache = await caches.open(cacheNameFor(kind));
  for (const url of toEvict) {
    await cache.delete(url);
    delete bucket[url];
  }
  saveIndex(index);
}

/** Synchronous check against the local index -- doesn't touch Cache Storage, safe to call often (e.g. to skip redundant work). */
export function isCached(kind, url) {
  if (!url) return false;
  return Boolean(loadIndex()[kind]?.[url]);
}

/** {bytes, count} for one cache kind -- see usageFor. */
export function cacheUsage(kind) {
  return usageFor(loadIndex()[kind]);
}

// remote URL -> blob: object URL, populated as tracks get cached or primed
// from a prior session. Session-lifetime (never revoked) -- at most a
// couple of concurrent recordings' worth of object URLs exist at once (see
// playback-engine.js's two-slot/stem-pair design), so this never grows
// unbounded within one page load.
const objectUrlCache = new Map();

function touch(kind, url, bytes) {
  const index = loadIndex();
  index[kind][url] = { bytes, lastUsed: Date.now() };
  saveIndex(index);
}

/**
 * Fetches and stores `key` into `kind`'s cache if it isn't already there;
 * always refreshes its lastUsed and the in-memory object-URL map either
 * way. Throws on a genuine fetch failure -- callers decide whether that
 * should be fatal (see downloadBlocksForOffline) or swallowed (see
 * cacheOpportunistically).
 *
 * `key` and the URL actually fetched are separate on purpose: for a plain
 * hosted recording they're the same string, but a OneDrive-sourced one
 * (offline/onedrive-library.js) resolves to a short-lived signed download
 * URL that's a different string every time it's re-minted, while `key` (a
 * stable relative path) stays the same -- caching by the ephemeral URL
 * would never hit across sessions. `getUrl` is only called on a cache
 * miss (a plain string or a function returning one/a promise of one) so a
 * cache hit costs nothing beyond a local lookup -- no network, no minting
 * a fresh URL first just to throw it away.
 */
async function storeOne(kind, key, getUrl) {
  if (!key) return;
  const cache = await caches.open(cacheNameFor(kind));
  const index = loadIndex();
  let response = await cache.match(key);
  if (!response) {
    const url = typeof getUrl === "function" ? await getUrl() : getUrl;
    const fetched = await fetch(url);
    if (!fetched.ok) throw new Error(`Failed to fetch ${url}: HTTP ${fetched.status}`);
    await cache.put(key, fetched.clone());
    response = fetched;
  }
  const blob = await response.blob();
  if (!objectUrlCache.has(key)) objectUrlCache.set(key, URL.createObjectURL(blob));
  touch(kind, key, blob.size);
  if (kind === CACHE_KIND.OPPORTUNISTIC) await evictIfOverCap(kind);
}

/**
 * Public, keyed version of storeOne -- for a source (like
 * offline/onedrive-library.js) whose cache key and fetchable URL differ.
 * See storeOne's comment for why. Rethrows on failure, same as storeOne;
 * wrap in try/catch for opportunistic (never-fatal) use.
 */
export async function cacheKeyedUrl(kind, key, getUrl) {
  await storeOne(kind, key, getUrl);
}

/** Best-effort: caches a block's instrumental+vocal pair into the opportunistic cache. Never throws -- a failed opportunistic cache attempt just means this recording stays remote-only for now, which must never break playback. */
export async function cacheOpportunistically(instrumentalUrl, vocalUrl) {
  try {
    await Promise.all([storeOne(CACHE_KIND.OPPORTUNISTIC, instrumentalUrl, instrumentalUrl), storeOne(CACHE_KIND.OPPORTUNISTIC, vocalUrl, vocalUrl)]);
  } catch {
    // best-effort, see above
  }
}

/**
 * Explicit "download this playlist for offline" (deduped by instrumental+
 * vocal pair, so a program with the same recording repeated only fetches it
 * once): stores every block's pair into the uncapped download cache,
 * reporting `onProgress(done, total)` after each pair. Unlike
 * cacheOpportunistically, this rethrows on failure -- it's a deliberate,
 * visible user action, so a failure should surface rather than silently
 * leave part of the download missing.
 */
export async function downloadBlocksForOffline(blocks, onProgress) {
  const seen = new Set();
  const pairs = [];
  for (const block of blocks) {
    const key = `${block.instrumentalUrl}|${block.vocalUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push(block);
  }
  let done = 0;
  onProgress?.(done, pairs.length);
  for (const block of pairs) {
    await Promise.all([
      storeOne(CACHE_KIND.DOWNLOAD, block.instrumentalUrl, block.instrumentalUrl),
      storeOne(CACHE_KIND.DOWNLOAD, block.vocalUrl, block.vocalUrl),
    ]);
    done += 1;
    onProgress?.(done, pairs.length);
  }
}

/** Deletes a whole cache kind -- both its Cache Storage entries and its index bucket. */
export async function clearCache(kind) {
  await caches.delete(cacheNameFor(kind));
  const index = loadIndex();
  index[kind] = {};
  saveIndex(index);
}

/**
 * Synchronous URL resolver for playback-engine.js's setUrlResolver: returns
 * a cached blob: URL if one's already been primed/created this session, or
 * the original remote URL otherwise. Must run after primeResolverCache for
 * a URL that was cached in an *earlier* session to actually resolve --
 * within this session, cacheOpportunistically/downloadBlocksForOffline
 * populate the same map as they go, so a track cached mid-session resolves
 * from then on without needing to be primed again.
 */
export function resolveUrlSync(url) {
  return objectUrlCache.get(url) ?? url;
}

/**
 * Looks up every unique URL in `blocks` against both caches (download
 * preferred over opportunistic when a track happens to be in both) and
 * populates resolveUrlSync's in-memory map for whichever are already
 * cached from a prior session. Awaited once per playback-engine.js
 * loadProgram() call, before that program's first block actually starts
 * playing -- see that file's resolverReady -- so a fully offline session's
 * very first block can still resolve to its cached copy.
 */
export async function primeResolverCache(blocks) {
  const urls = new Set();
  for (const block of blocks) {
    if (block.instrumentalUrl) urls.add(block.instrumentalUrl);
    if (block.vocalUrl) urls.add(block.vocalUrl);
  }
  await Promise.all(
    [...urls].map(async (url) => {
      if (objectUrlCache.has(url)) return;
      for (const kind of [CACHE_KIND.DOWNLOAD, CACHE_KIND.OPPORTUNISTIC]) {
        const cache = await caches.open(cacheNameFor(kind));
        const response = await cache.match(url);
        if (response) {
          const blob = await response.blob();
          objectUrlCache.set(url, URL.createObjectURL(blob));
          return;
        }
      }
    })
  );
}
