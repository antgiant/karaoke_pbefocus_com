// OneDrive-folder-link library source: lets a Pathfinder paste a OneDrive
// **folder** sharing link (e.g. an "anyone with the link" share of
// PBE_2026_2027/) into the gate's existing manifest-URL box instead of a
// hosted manifest URL or a picked local folder. See
// PBE_2026_2027/AGENTS.md for the full design writeup (the
// "OneDrive folder-link library source" plan) -- the short version:
//
// Microsoft Graph requires a signed-in token for every call, even against
// an anonymous-scope share (confirmed against a real link -- see that
// writeup's Step 0), so there is no zero-login path. Every Pathfinder
// signs in with their own free Microsoft account via MSAL.js
// (assets/vendor/msal-browser.min.js, `window.msal` -- see
// assets/vendor/README.md), directly in the browser -- no backend, no
// proxy, a one-time login per device (MSAL caches the session itself).
//
// Once signed in, this mirrors local-library.js's contract on purpose
// (same exported shape: setActiveRoot/resolveUrlSync/primeResolverCache)
// so playback-engine.js's setUrlResolver call site doesn't care which
// source is active. Unlike local-library.js, though, audio bytes here are
// cached persistently in Cache Storage via offline/audio-cache.js's
// cacheKeyedUrl -- keyed by each recording's stable relative path (the
// same value already used as instrumentalUrl/vocalUrl in the manifest),
// never by the short-lived signed download URL Graph mints for it (a
// different string every ~hour), so a repeat play never re-touches
// OneDrive at all once cached. See that function's own comment for why.

import { CACHE_KIND, cacheKeyedUrl, fetchCachedJson, resolveUrlSync as audioResolveUrlSync } from "./audio-cache.js";
import { saveManifest, loadManifest } from "./manifest-cache.js";

const AZURE_CLIENT_ID = "1b28096c-568a-4299-ae55-fe69f14423b5"; // same app registration as Step_Up_Automator -- see PBE_2026_2027/AGENTS.md's "One-time Azure setup"
const AZURE_AUTHORITY = "https://login.microsoftonline.com/common";
const GRAPH_SCOPES = ["Files.Read"];
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const MANIFEST_FILENAME = "manifest.local.json";

/** Recognizes a pasted OneDrive/SharePoint sharing URL -- the gate's `attempt()` branches on this before treating a pasted value as a fetchable manifest URL. */
export function isOneDriveShareLink(value) {
  if (typeof value !== "string") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return /(^|\.)(1drv\.ms|onedrive\.live\.com|sharepoint\.com)$/i.test(url.hostname);
}

// ---- Sign-in ---------------------------------------------------------------

let pca; // lazily constructed -- window.msal isn't available until the vendored script has loaded

function getPca() {
  if (!window.msal) {
    throw new Error("OneDrive sign-in isn't available (the Microsoft sign-in library failed to load) -- try reloading the page.");
  }
  if (!pca) {
    pca = new window.msal.PublicClientApplication({
      auth: { clientId: AZURE_CLIENT_ID, authority: AZURE_AUTHORITY, redirectUri: window.location.origin + window.location.pathname },
    });
  }
  return pca;
}

/**
 * Ensures we have a valid Graph access token, prompting an interactive
 * Microsoft sign-in (popup) only if MSAL can't silently reuse a cached
 * session -- so a returning Pathfinder on the same device/browser doesn't
 * see the prompt again until their session actually expires. Must be
 * called from a click handler the first time (loginPopup needs an active
 * user gesture); the auto-resume-on-reload path benefits from
 * acquireTokenSilent succeeding without one.
 */
export async function signIn() {
  const client = getPca();
  await client.initialize();
  const accounts = client.getAllAccounts();
  if (accounts.length > 0) {
    try {
      const result = await client.acquireTokenSilent({ scopes: GRAPH_SCOPES, account: accounts[0] });
      if (result?.accessToken) return result.accessToken;
    } catch {
      // Fall through to interactive sign-in.
    }
  }
  const result = await client.loginPopup({ scopes: GRAPH_SCOPES });
  if (!result?.accessToken) throw new Error("Microsoft sign-in didn't return an access token.");
  return result.accessToken;
}

// ---- Graph calls, with 429 handling ----------------------------------------

const MAX_RETRY_ATTEMPTS = 3;
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Every Graph call in this module goes through here -- single choke point
 * for 429 (throttling) handling, mirroring
 * Step_Up_Automator/src/graph/client.ts's graphFetch. On a 429, honors the
 * Retry-After header (capped, so a bad/missing header can't hang the UI
 * forever) and retries up to MAX_RETRY_ATTEMPTS total -- a small bounded
 * budget, not unbounded retries, since aggressive retrying works against
 * you (failed attempts still count against the same quota -- Microsoft's
 * own SharePoint throttling guidance). `onRetry` is an optional callback
 * (gate.js wires it to showStatus) so a Pathfinder sees why things paused
 * instead of a silent hang.
 */
async function graphFetch(path, token, init = {}, onRetry) {
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, { ...init, headers });
    if (response.status !== 429) {
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`OneDrive request failed (HTTP ${response.status}): ${body.slice(0, 200)}`);
      }
      return response;
    }
    if (attempt === MAX_RETRY_ATTEMPTS) {
      throw new Error("OneDrive is temporarily busy -- try again in a minute.");
    }
    const retryAfterHeader = response.headers.get("Retry-After");
    const parsedRetryAfter = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
    const retryAfterSeconds = Number.isFinite(parsedRetryAfter) && parsedRetryAfter >= 0 ? parsedRetryAfter : 5;
    const delayMs = Math.min(retryAfterSeconds * 1000, MAX_RETRY_DELAY_MS);
    onRetry?.(`OneDrive is busy, retrying in ${Math.round(delayMs / 1000)}s…`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("OneDrive is temporarily busy -- try again in a minute."); // unreachable, satisfies linters expecting a return/throw
}

async function graphJson(path, token, init, onRetry) {
  const response = await graphFetch(path, token, init, onRetry);
  return response.json();
}

/** Same `u!<base64url>` sharing-URL encoding Step_Up_Automator's encodeShareUrl() uses (src/graph/onedrive.ts) -- documented Graph convention, not project-specific. */
function encodeShareId(shareUrl) {
  const base64 = btoa(unescape(encodeURIComponent(shareUrl)));
  const unpadded = base64.replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  return `u!${unpadded}`;
}

/** Paginates a folder's children via @odata.nextLink, same shape as Step_Up_Automator's listFolderChildren. */
async function listChildren(driveId, itemId, token, onRetry) {
  const results = [];
  let path = `/drives/${driveId}/items/${itemId}/children?$select=id,name,size,folder&$top=200`;
  while (path) {
    const data = await graphJson(path, token, undefined, onRetry);
    results.push(...data.value);
    path = data["@odata.nextLink"] ?? null;
  }
  return results;
}

/** Recursively walks a shared folder, building relativePath -> {driveId, itemId} for every file (folders aren't included -- nothing ever points at one). */
async function walkFolder(shareUrl, token, onRetry) {
  const shareId = encodeShareId(shareUrl);
  const root = await graphJson(`/shares/${shareId}/driveItem?$select=id,name,parentReference,folder`, token, undefined, onRetry);
  if (!root.folder) throw new Error("That OneDrive link points at a file, not a folder -- share the whole music folder instead.");
  const driveId = root.parentReference.driveId;
  const entries = new Map();
  async function walk(itemId, prefix) {
    const children = await listChildren(driveId, itemId, token, onRetry);
    for (const child of children) {
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.folder) {
        await walk(child.id, relativePath);
      } else {
        entries.set(relativePath, { driveId, itemId: child.id });
      }
    }
  }
  await walk(root.id, "");
  return { shareUrl, driveId, entries };
}

const indexCacheKey = (shareUrl) => `onedrive-index:${shareUrl}`;

/** Serializes/deserializes {driveId, entries} for manifest-cache.js, whose saveManifest/loadManifest expect plain JSON (a Map isn't). */
function serializeIndex(root) {
  return { driveId: root.driveId, entries: [...root.entries.entries()] };
}
function deserializeIndex(shareUrl, data) {
  return { shareUrl, driveId: data.driveId, entries: new Map(data.entries) };
}

/**
 * Resolves a OneDrive share link to a walked folder listing. Checks
 * manifest-cache.js's persisted copy first (keyed by the share URL) and
 * only calls Graph at all on a miss -- a repeat visit doesn't re-walk the
 * whole folder tree. See resolveItemForPath for the self-healing path
 * (a lookup miss against a *cached* index triggers exactly one re-walk,
 * for the case where recordings were added/removed since it was cached).
 */
export async function resolveOneDriveFolder(shareUrl, token, onRetry) {
  const cached = await loadManifest(indexCacheKey(shareUrl));
  if (cached) return deserializeIndex(shareUrl, cached);
  const root = await walkFolder(shareUrl, token, onRetry);
  await saveManifest(indexCacheKey(shareUrl), serializeIndex(root));
  return root;
}

/** Re-walks and re-caches `root`'s folder from scratch -- used when a path the manifest references isn't in the (possibly stale) cached index. */
async function refreshIndex(root, token, onRetry) {
  const fresh = await walkFolder(root.shareUrl, token, onRetry);
  await saveManifest(indexCacheKey(root.shareUrl), serializeIndex(fresh));
  root.driveId = fresh.driveId;
  root.entries = fresh.entries;
}

async function resolveItemForPath(root, relativePath, token, onRetry) {
  let item = root.entries.get(relativePath);
  if (!item) {
    await refreshIndex(root, token, onRetry);
    item = root.entries.get(relativePath);
  }
  if (!item) throw new Error(`"${relativePath}" isn't in that OneDrive folder.`);
  return item;
}

/** Mints a fresh, short-lived (~1 hour), Range-request-capable download URL for one item -- Graph's @microsoft.graph.downloadUrl, Azure Blob-backed. Called lazily, only on an audio-cache miss (see cacheKeyedUrl). */
async function mintDownloadUrl(item, token, onRetry) {
  const data = await graphJson(
    `/drives/${item.driveId}/items/${item.itemId}?$select=%40microsoft.graph.downloadUrl`,
    token,
    undefined,
    onRetry
  );
  const url = data["@microsoft.graph.downloadUrl"];
  if (!url) throw new Error("OneDrive didn't return a download URL for that recording.");
  return url;
}

/**
 * Reads and validates manifest.local.json from the root of a resolved
 * OneDrive folder -- same error-message conventions as
 * local-library.js's readManifestFromHandle. Unlike the folder-listing
 * index (deliberately cache-first -- re-listing the whole tree is the
 * expensive part), this is network-first with the cached copy only as a
 * fallback, same shape as gate.js's fetchManifest for a plain hosted URL:
 * the manifest itself is small and cheap to re-check, and always
 * preferring a stale cached copy would hide newly-added recordings from a
 * returning Pathfinder indefinitely.
 */
export async function readManifestFromOneDrive(root, token, validateManifest, onRetry) {
  let json;
  try {
    const item = await resolveItemForPath(root, MANIFEST_FILENAME, token, onRetry);
    const downloadUrl = await mintDownloadUrl(item, token, onRetry);
    const response = await fetch(downloadUrl);
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

// ---- Resolver contract (mirrors local-library.js) --------------------------

let activeRoot = null;
let activeToken = null;

/** Binds the folder + token every resolve()/prime() call below uses -- call once, right after a successful OneDrive sign-in + manifest read (see gate.js). */
export function setActiveRoot(root, token) {
  activeRoot = root;
  activeToken = token;
}

// Cache keys here are the recording's stable relative path (e.g.
// "PBE_2026_2027_Broadway/Mark 6...m4a" -- the same string already used as
// instrumentalUrl/vocalUrl in the manifest), never the ephemeral signed
// download URL -- see audio-cache.js's cacheKeyedUrl comment. Since
// audio-cache.js's own objectUrlCache map is keyed the same way, its
// resolveUrlSync already does exactly what this source needs -- no need
// for a second, parallel in-memory map.
export const resolveUrlSync = audioResolveUrlSync;

/** Resolves every unique instrumentalUrl/vocalUrl in `blocks` -- mints a fresh OneDrive download URL and fetches+caches it (offline/audio-cache.js, the shared opportunistic cache) for anything not already cached, so a block that's been played before (this session or a prior one) costs OneDrive nothing at all. Awaited once per playback-engine.js loadProgram() call, same contract as local-library.js's primeResolverCache. */
export async function primeResolverCache(blocks, onRetry) {
  if (!activeRoot) return;
  const paths = new Set();
  for (const block of blocks) {
    if (block.instrumentalUrl) paths.add(block.instrumentalUrl);
    if (block.vocalUrl) paths.add(block.vocalUrl);
  }
  await Promise.all(
    [...paths].map(async (path) => {
      const item = await resolveItemForPath(activeRoot, path, activeToken, onRetry);
      await cacheKeyedUrl(CACHE_KIND.OPPORTUNISTIC, path, () => mintDownloadUrl(item, activeToken, onRetry));
    })
  );
}

/** Fetches+caches (offline/audio-cache.js's shared opportunistic cache, same as audio) and parses one recording's word-timing sidecar (wordsUrl) -- mints a fresh OneDrive download URL only on a cache miss, same as primeResolverCache's audio. Lazy: called only once a section is actually selected for study/mix-editing (see offline/words-loader.js). */
export async function readWordsAtPath(relativePath, onRetry) {
  if (!activeRoot) throw new Error("No OneDrive library is active.");
  return fetchCachedJson(relativePath, async () => {
    const item = await resolveItemForPath(activeRoot, relativePath, activeToken, onRetry);
    return mintDownloadUrl(item, activeToken, onRetry);
  });
}
