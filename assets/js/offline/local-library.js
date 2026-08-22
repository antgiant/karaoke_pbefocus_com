// Local-folder library source: lets a Pathfinder point the app directly at
// their PBE_2026_2027/ folder on disk (via the File System Access API)
// instead of fetching from a hosted URL. No network involved at all, so
// there's no HTTP Range-request dependency to worry about -- see
// playback-engine.js's file-top comment and README.md's "Run Locally"
// section for why that normally matters. Every recording's
// instrumentalUrl/vocalUrl is just a path (e.g.
// "PBE_2026_2027_Broadway/Mark 6_30-56 (NKJV) (14).instrumental.m4a"),
// relative to whichever folder gets picked -- exactly what
// `scripts/build_manifest.py` already emits when run with no --base-url
// (see its build_audio_url()). That same script also writes its output
// straight into that folder's root as `manifest.local.json` by default, so
// picking PBE_2026_2027/ itself is all that's needed -- no separate copy
// step (see PBE_2026_2027/AGENTS.md).
//
// Mirrors offline/audio-cache.js's resolve/prime shape (playback-engine.js's
// setUrlResolver) but resolves against a FileSystemDirectoryHandle instead
// of Cache Storage -- the two are mutually exclusive per session (see
// main.js), never both wired at once.

export const LOCAL_PREFIX = "local:";

/** True for the synthetic identifier a local-folder-loaded manifest is remembered under -- see gate.js. */
export function isLocalIdentifier(value) {
  return typeof value === "string" && value.startsWith(LOCAL_PREFIX);
}

/** Feature-detects the File System Access API -- Chrome/Edge only (same posture as study-modes/sing-along.js's Web Speech check). The gate hides its local-folder button entirely when this is false. */
export function isFileSystemAccessSupported() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

const DB_NAME = "pbe-karaoke-local-library";
const DB_VERSION = 1;
const STORE_NAME = "roots";
const MANIFEST_FILENAME = "manifest.local.json";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the local-library database."));
  });
}

async function idbPut(id, handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(handle, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not remember that folder."));
  });
}

async function idbGet(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error ?? new Error("Could not read the remembered folder."));
  });
}

/** True if `handle` already has (or, when `requestIfNeeded`, was just granted) read access. requestPermission requires an active user gesture -- only pass requestIfNeeded:true from a click handler, never from an auto-resume on page load. */
async function verifyReadPermission(handle, { requestIfNeeded = false } = {}) {
  const opts = { mode: "read" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if (!requestIfNeeded) return false;
  return (await handle.requestPermission(opts)) === "granted";
}

/** Opens the native folder picker and remembers the chosen folder under a fresh `local:<uuid>` identifier (IndexedDB -- FileSystemDirectoryHandle isn't JSON-serializable, so this can't reuse storage.js's localStorage). Returns {identifier, handle}. Throws (DOMException "AbortError") if the Pathfinder cancels the picker -- callers should treat that as a silent no-op, not an error. */
export async function pickAndRememberFolder() {
  const handle = await window.showDirectoryPicker({ id: "pbe-karaoke-library", mode: "read" });
  const identifier = `${LOCAL_PREFIX}${crypto.randomUUID()}`;
  await idbPut(identifier.slice(LOCAL_PREFIX.length), handle);
  return { identifier, handle };
}

/** Auto-resume path (page load, no user gesture available): returns the remembered handle only if permission is *already* granted, null otherwise -- never prompts. See attemptReconnect for the gesture-backed version. */
export async function recallFolder(identifier) {
  const handle = await idbGet(identifier.slice(LOCAL_PREFIX.length));
  if (!handle) return null;
  return (await verifyReadPermission(handle)) ? handle : null;
}

/** Click-triggered reconnect: re-requests permission on the previously-picked folder (no new picker dialog) if one's remembered, since requestPermission is allowed to prompt here. Returns null (not a picker) if nothing's remembered yet -- caller falls back to pickAndRememberFolder. */
export async function reconnectFolder(identifier) {
  const handle = await idbGet(identifier.slice(LOCAL_PREFIX.length));
  if (!handle) return null;
  return (await verifyReadPermission(handle, { requestIfNeeded: true })) ? handle : null;
}

/** Walks `relativePath` (e.g. "PBE_2026_2027_Broadway/foo.instrumental.m4a") down from `root` to the file it names. */
async function getFileHandleByPath(root, relativePath) {
  const segments = relativePath.split("/").filter(Boolean);
  let dir = root;
  for (const segment of segments.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(segment);
  }
  return dir.getFileHandle(segments.at(-1));
}

/** Reads and validates `manifest.local.json` from the root of a picked folder -- see this file's top comment for why that's the expected filename/location. */
export async function readManifestFromHandle(handle, validateManifest) {
  let fileHandle;
  try {
    fileHandle = await handle.getFileHandle(MANIFEST_FILENAME);
  } catch {
    throw new Error(`No "${MANIFEST_FILENAME}" found in that folder -- see PBE_2026_2027/AGENTS.md for how to generate one.`);
  }
  // getFile()/text() are a separate try/catch from the JSON.parse below on
  // purpose: an I/O failure here (most likely a cloud-sync client -- OneDrive
  // Files On-Demand, iCloud, Dropbox -- still hydrating a placeholder file;
  // see PBE_2026_2027/AGENTS.md's "OneDrive gotcha" for the same failure mode
  // hitting the pipeline scripts) is a different problem from the file
  // actually containing bad JSON, and deserves its own message rather than
  // the misleading "did not contain valid JSON" for something that was never
  // successfully read at all.
  let text;
  try {
    const file = await fileHandle.getFile();
    text = await file.text();
  } catch (e) {
    throw new Error(
      `Could not read "${MANIFEST_FILENAME}" (${e.message || "unknown error"}) -- if this folder is ` +
        `cloud-synced (OneDrive/iCloud/Dropbox), it may still be downloading; wait a moment and try again.`
    );
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`"${MANIFEST_FILENAME}" did not contain valid JSON.`);
  }
  try {
    return validateManifest(json);
  } catch (e) {
    throw new Error(`That file isn't a valid library manifest: ${e.message}`);
  }
}

let activeRoot = null;
// relative path -> blob: object URL, populated as tracks get resolved.
// Session-lifetime, same posture as audio-cache.js's objectUrlCache.
const objectUrlCache = new Map();

/** Binds the folder every resolve()/prime() call below resolves paths against -- call once, right after a successful local-folder unlock (see gate.js). */
export function setActiveRoot(handle) {
  activeRoot = handle;
  objectUrlCache.clear();
}

/** Synchronous URL resolver for playback-engine.js's setUrlResolver: a relative path resolves to its blob: URL once prime() has run for it, or itself otherwise (which the caller must not actually use -- see primeResolverCache's role). */
export function resolveUrlSync(url) {
  return objectUrlCache.get(url) ?? url;
}

/** Resolves every unique instrumentalUrl/vocalUrl in `blocks` against the active root, populating resolveUrlSync's map -- awaited once per playback-engine.js loadProgram() call before that program's first block plays, same as audio-cache.js's primeResolverCache. Unlike the remote/offline case there's no "stream directly, cache in the background" fallback: a local path is never itself a playable src, so every block must resolve here before it can play. */
export async function primeResolverCache(blocks) {
  if (!activeRoot) return;
  const paths = new Set();
  for (const block of blocks) {
    if (block.instrumentalUrl) paths.add(block.instrumentalUrl);
    if (block.vocalUrl) paths.add(block.vocalUrl);
  }
  await Promise.all(
    [...paths].map(async (path) => {
      if (objectUrlCache.has(path)) return;
      const fileHandle = await getFileHandleByPath(activeRoot, path);
      const file = await fileHandle.getFile();
      objectUrlCache.set(path, URL.createObjectURL(file));
    })
  );
}
