// Google Drive-folder-link library source: lets a Pathfinder paste a Google
// Drive **folder** sharing link (e.g. an "Anyone with the link" share of
// PBE_2026_2027/) into the gate's existing manifest-URL box instead of a
// hosted manifest URL or a picked local folder. See
// PBE_2026_2027/AGENTS.md for the full design writeup (the
// "Google Drive folder-link library source" section) -- the short version:
//
// Unlike Microsoft Graph (offline/onedrive-library.js), the Google Drive
// API v3 accepts a plain API key for both listing and downloading a file
// that's shared "Anyone with the link" -- no Pathfinder sign-in at all.
// The API key is a build-time credential restricted (in Google Cloud
// Console) to the Drive API and to this site's own origin as an HTTP
// referrer, so it's safe to ship in client code -- see GOOGLE_API_KEY below.
//
// Mirrors local-library.js's/onedrive-library.js's contract on purpose
// (same exported shape: setActiveRoot/resolveUrlSync/primeResolverCache)
// so playback-engine.js's setUrlResolver call site doesn't care which
// source is active. Audio bytes are cached persistently in Cache Storage
// via offline/audio-cache.js's cacheKeyedUrl -- keyed by each recording's
// stable relative path (the same value already used as
// instrumentalUrl/vocalUrl in the manifest), so a repeat play never
// touches Google Drive again once cached.

import { CACHE_KIND, cacheKeyedUrl, fetchCachedJson, resolveUrlSync as audioResolveUrlSync } from "./audio-cache.js";
import { saveManifest, loadManifest } from "./manifest-cache.js";

// Restricted (HTTP referrer + Drive API only) in Google Cloud Console --
// see PBE_2026_2027/AGENTS.md's "One-time Google Cloud setup". The
// referrer restriction is what keeps this safe to ship in client code
// despite being public -- it only works from the real site's origin, not
// localhost (Google doesn't allow that as a referrer restriction), so
// local dev against this source needs the deployed site itself.
const GOOGLE_API_KEY = "AIzaSyCasE-WU2AWhkJKZUXknzrzjaEFfAaqxhQ";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const MANIFEST_FILENAME = "manifest.local.json";

/** Recognizes a pasted Google Drive sharing URL -- the gate's `attempt()` branches on this before treating a pasted value as a fetchable manifest URL. */
export function isGoogleDriveShareLink(value) {
  if (typeof value !== "string") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return /(^|\.)drive\.google\.com$/i.test(url.hostname);
}

/**
 * Pulls a folder id (and, when present, a resourceKey) out of a pasted
 * Drive folder link. Handles the common share-link shapes:
 * .../drive/folders/<id>, .../drive/u/<n>/folders/<id>, and
 * .../open?id=<id> -- with an optional ?resourcekey=<key> query param
 * Google adds to some older/restricted-scope links. A resourceKey found
 * here is only honored for the initial folder lookup below (see
 * verifyFolder) -- it isn't propagated to child listing or file-download
 * requests, which is a known gap for the rare pre-2021-style restricted
 * link (see AI_TODO.md item 13's write-up); a folder freshly shared as
 * "Anyone with the link" never has one.
 */
function extractFolderRef(url) {
  const idFromPath = url.pathname.match(/\/folders\/([a-zA-Z0-9_-]+)/)?.[1];
  const folderId = idFromPath || url.searchParams.get("id");
  if (!folderId) return null;
  const resourceKey = url.searchParams.get("resourcekey") || undefined;
  return { folderId, resourceKey };
}

// ---- Drive API calls, with rate-limit retry ---------------------------------

const MAX_RETRY_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Every Drive API call in this module goes through here -- single choke
 * point for rate-limit retry handling. Google doesn't guarantee a
 * Retry-After header on a 429/403 the way Graph does, so this backs off
 * exponentially (with jitter) instead, capped and bounded to
 * MAX_RETRY_ATTEMPTS -- same small-bounded-budget posture as
 * onedrive-library.js's graphFetch, for the same reason (a failed attempt
 * still counts against the same quota). A plain 403 that *isn't* a rate
 * limit (e.g. the folder genuinely isn't public) is not retried -- it's
 * surfaced immediately.
 */
async function driveFetch(path, resourceKeyHeader, onRetry) {
  const base = path.startsWith("http") ? path : `${DRIVE_API_BASE}${path}`;
  const url = `${base}${base.includes("?") ? "&" : "?"}key=${GOOGLE_API_KEY}`;
  const headers = new Headers();
  if (resourceKeyHeader) headers.set("X-Goog-Drive-Resource-Keys", resourceKeyHeader);
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, { headers });
    if (response.ok) return response;
    const bodyText = await response.text().catch(() => "");
    const rateLimited = response.status === 429 || (response.status === 403 && /rateLimitExceeded/i.test(bodyText));
    if (!rateLimited) {
      throw new Error(`Google Drive request failed (HTTP ${response.status}): ${bodyText.slice(0, 200)}`);
    }
    if (attempt === MAX_RETRY_ATTEMPTS) {
      throw new Error("Google Drive is temporarily busy -- try again in a minute.");
    }
    const delayMs = Math.min(2 ** (attempt - 1) * 1000 + Math.random() * 500, MAX_RETRY_DELAY_MS);
    onRetry?.(`Google Drive is busy, retrying in ${Math.round(delayMs / 1000)}s…`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("Google Drive is temporarily busy -- try again in a minute."); // unreachable, satisfies linters expecting a return/throw
}

async function driveJson(path, resourceKeyHeader, onRetry) {
  const response = await driveFetch(path, resourceKeyHeader, onRetry);
  return response.json();
}

const resourceKeyHeaderFor = (fileId, resourceKey) => (resourceKey ? `${fileId}/${resourceKey}` : undefined);

async function verifyFolder(folderId, resourceKey, onRetry) {
  const data = await driveJson(
    `/files/${folderId}?fields=id,name,mimeType&supportsAllDrives=true`,
    resourceKeyHeaderFor(folderId, resourceKey),
    onRetry
  );
  if (data.mimeType !== FOLDER_MIME) {
    throw new Error("That Google Drive link points at a file, not a folder -- share the whole music folder instead.");
  }
}

/** Paginates a folder's children via nextPageToken. */
async function listChildren(folderId, onRetry) {
  const results = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name,mimeType)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await driveJson(`/files?${params}`, undefined, onRetry);
    results.push(...data.files);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return results;
}

/** Recursively walks a shared folder, building relativePath -> fileId for every file (folders aren't included -- nothing ever points at one). */
async function walkFolder(shareUrl, onRetry) {
  const ref = extractFolderRef(new URL(shareUrl));
  if (!ref) {
    throw new Error('That doesn\'t look like a Google Drive folder link -- share the whole music folder ("Anyone with the link") and paste that link.');
  }
  await verifyFolder(ref.folderId, ref.resourceKey, onRetry);
  const entries = new Map();
  async function walk(folderId, prefix) {
    const children = await listChildren(folderId, onRetry);
    for (const child of children) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.mimeType === FOLDER_MIME) {
        await walk(child.id, relativePath);
      } else {
        entries.set(relativePath, child.id);
      }
    }
  }
  await walk(ref.folderId, "");
  return { shareUrl, folderId: ref.folderId, resourceKey: ref.resourceKey, entries };
}

const indexCacheKey = (shareUrl) => `googledrive-index:${shareUrl}`;

/** Serializes/deserializes {folderId, entries} for manifest-cache.js, whose saveManifest/loadManifest expect plain JSON (a Map isn't). */
function serializeIndex(root) {
  return { folderId: root.folderId, resourceKey: root.resourceKey ?? null, entries: [...root.entries.entries()] };
}
function deserializeIndex(shareUrl, data) {
  return { shareUrl, folderId: data.folderId, resourceKey: data.resourceKey ?? undefined, entries: new Map(data.entries) };
}

/**
 * Resolves a Google Drive share link to a walked folder listing. Checks
 * manifest-cache.js's persisted copy first (keyed by the share URL) and
 * only calls the Drive API at all on a miss -- a repeat visit doesn't
 * re-walk the whole folder tree. See resolveItemForPath for the
 * self-healing path (a lookup miss against a *cached* index triggers
 * exactly one re-walk, for the case where recordings were added/removed
 * since it was cached).
 */
export async function resolveGoogleDriveFolder(shareUrl, onRetry) {
  const cached = await loadManifest(indexCacheKey(shareUrl));
  if (cached) return deserializeIndex(shareUrl, cached);
  const root = await walkFolder(shareUrl, onRetry);
  await saveManifest(indexCacheKey(shareUrl), serializeIndex(root));
  return root;
}

/** Re-walks and re-caches `root`'s folder from scratch -- used when a path the manifest references isn't in the (possibly stale) cached index. */
async function refreshIndex(root, onRetry) {
  const fresh = await walkFolder(root.shareUrl, onRetry);
  await saveManifest(indexCacheKey(root.shareUrl), serializeIndex(fresh));
  root.folderId = fresh.folderId;
  root.entries = fresh.entries;
}

async function resolveItemForPath(root, relativePath, onRetry) {
  let fileId = root.entries.get(relativePath);
  if (!fileId) {
    await refreshIndex(root, onRetry);
    fileId = root.entries.get(relativePath);
  }
  if (!fileId) throw new Error(`"${relativePath}" isn't in that Google Drive folder.`);
  return fileId;
}

/** The directly-fetchable download URL for one file -- unlike Graph's short-lived signed downloadUrl, this needs no separate "mint" call: the API key in the URL itself is what authorizes it, and it doesn't expire. */
function mediaUrl(fileId) {
  return `${DRIVE_API_BASE}/files/${fileId}?alt=media&key=${GOOGLE_API_KEY}&supportsAllDrives=true`;
}

/**
 * Reads and validates manifest.local.json from the root of a resolved
 * Google Drive folder -- same error-message conventions as
 * local-library.js's readManifestFromHandle. Unlike the folder-listing
 * index (deliberately cache-first -- re-listing the whole tree is the
 * expensive part), this is network-first with the cached copy only as a
 * fallback, same shape as gate.js's fetchManifest for a plain hosted URL.
 */
export async function readManifestFromGoogleDrive(root, validateManifest, onRetry) {
  let json;
  try {
    const fileId = await resolveItemForPath(root, MANIFEST_FILENAME, onRetry);
    const response = await fetch(mediaUrl(fileId));
    if (!response.ok) throw new Error(`Could not download "${MANIFEST_FILENAME}" (HTTP ${response.status}).`);
    try {
      json = await response.json();
    } catch {
      throw new Error(`"${MANIFEST_FILENAME}" did not contain valid JSON.`);
    }
    await saveManifest(root.shareUrl, json);
  } catch (e) {
    const cached = await loadManifest(root.shareUrl);
    if (!cached) throw e;
    json = cached;
  }
  try {
    return validateManifest(json);
  } catch (e) {
    throw new Error(`That file isn't a valid library manifest: ${e.message}`);
  }
}

// ---- Resolver contract (mirrors local-library.js/onedrive-library.js) ------

let activeRoot = null;

/** Binds the folder every resolve()/prime() call below uses -- call once, right after a successful Google Drive manifest read (see gate.js). No token to bind (see file-top comment) -- just the resolved folder. */
export function setActiveRoot(root) {
  activeRoot = root;
}

// Cache keys here are the recording's stable relative path (e.g.
// "PBE_2026_2027_Broadway/Mark 6...m4a" -- the same string already used as
// instrumentalUrl/vocalUrl in the manifest), never the fetchable Drive URL
// itself -- see audio-cache.js's cacheKeyedUrl comment. Since
// audio-cache.js's own objectUrlCache map is keyed the same way, its
// resolveUrlSync already does exactly what this source needs -- no need
// for a second, parallel in-memory map.
export const resolveUrlSync = audioResolveUrlSync;

/** Resolves every unique instrumentalUrl/vocalUrl in `blocks` -- fetches+caches each one (offline/audio-cache.js, the shared opportunistic cache) for anything not already cached, so a block that's been played before (this session or a prior one) costs Google Drive nothing at all. Awaited once per playback-engine.js loadProgram() call, same contract as local-library.js's/onedrive-library.js's primeResolverCache. */
export async function primeResolverCache(blocks, onRetry) {
  if (!activeRoot) return;
  const paths = new Set();
  for (const block of blocks) {
    if (block.instrumentalUrl) paths.add(block.instrumentalUrl);
    if (block.vocalUrl) paths.add(block.vocalUrl);
  }
  await Promise.all(
    [...paths].map(async (path) => {
      const fileId = await resolveItemForPath(activeRoot, path, onRetry);
      await cacheKeyedUrl(CACHE_KIND.OPPORTUNISTIC, path, mediaUrl(fileId));
    })
  );
}

/** Fetches+caches (offline/audio-cache.js's shared opportunistic cache, same as audio) and parses one recording's word-timing sidecar (wordsUrl) -- no separate mint step needed, same as primeResolverCache's audio. Lazy: called only once a section is actually selected for study/mix-editing (see offline/words-loader.js). */
export async function readWordsAtPath(relativePath, onRetry) {
  if (!activeRoot) throw new Error("No Google Drive library is active.");
  const fileId = await resolveItemForPath(activeRoot, relativePath, onRetry);
  return fetchCachedJson(relativePath, mediaUrl(fileId));
}
