import { MANIFEST_URL_PARAM } from "./constants.js";
import { validateManifest } from "./library.js";
import { loadState, saveState } from "./storage.js";
import { saveManifest, loadManifest, uploadCacheKey } from "./offline/manifest-cache.js";

// AI_TODO.md item 7 (offline support): an uploaded manifest has no URL of
// its own, so it's remembered under a synthetic identifier of this shape
// instead -- see attemptUpload/isUploadIdentifier below. Anything else
// state.manifestUrl holds is a real fetchable URL.
const UPLOAD_PREFIX = "upload:";

/** True for the synthetic identifier an uploaded (not URL-loaded) manifest is remembered under -- see the UPLOAD_PREFIX comment. Exported for main.js's share dialog, which can only offer a real URL to share. */
export function isUploadIdentifier(value) {
  return typeof value === "string" && value.startsWith(UPLOAD_PREFIX);
}

export function resolveInitialManifestUrl() {
  const fromQuery = new URLSearchParams(window.location.search).get(MANIFEST_URL_PARAM);
  if (fromQuery) return fromQuery;
  return loadState().manifestUrl;
}

/**
 * Fetches and validates a manifest from `url`. Also persists its content
 * (AI_TODO.md item 7) so a later offline reload of the same URL can fall
 * back to this copy, and itself falls back to any already-persisted copy
 * if the network request fails or errors -- "always re-fetched" (this
 * function still tries the network first every time) no longer means
 * "never cached."
 */
export async function fetchManifest(url) {
  let response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch {
    const cached = await loadManifest(url);
    if (cached) return cached;
    throw new Error("Could not reach that URL. Check the link and your internet connection.");
  }
  if (!response.ok) {
    const cached = await loadManifest(url);
    if (cached) return cached;
    throw new Error(`That URL returned an error (HTTP ${response.status}).`);
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error("That URL did not return valid JSON.");
  }
  let manifest;
  try {
    manifest = validateManifest(json);
  } catch (e) {
    throw new Error(`That file isn't a valid library manifest: ${e.message}`);
  }
  await saveManifest(url, manifest);
  return manifest;
}

/** Same validation as fetchManifest, for a manifest read from a local file instead of a URL -- see initGate's upload button. */
export async function readManifestFile(file) {
  let text;
  try {
    text = await file.text();
  } catch {
    throw new Error("Could not read that file.");
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("That file did not contain valid JSON.");
  }
  try {
    return validateManifest(json);
  } catch (e) {
    throw new Error(`That file isn't a valid library manifest: ${e.message}`);
  }
}

/**
 * Wires the access-gate screen. Auto-attempts a manifest identifier from
 * the query string or a prior visit; otherwise waits for the form (or the
 * upload button, for a manifest handed over as a local file instead of
 * hosted at a URL -- see readManifestFile). On success, persists that
 * identifier and calls onUnlocked(manifest, identifier).
 *
 * AI_TODO.md item 7 (offline support): the manifest's own content is now
 * remembered too (see offline/manifest-cache.js), not just its URL, and
 * that's true for an upload as well as a URL load -- an upload gets a
 * synthetic `upload:<uuid>` identifier (see UPLOAD_PREFIX) so a later visit
 * can reload it from the cached copy without asking the Pathfinder to
 * re-upload the file every single time. If that cached copy is ever gone
 * (storage cleared, quota eviction), attemptRememberedUpload below surfaces
 * a clear error and the upload button is still right there to try again.
 */
export function initGate({ onUnlocked }) {
  const gatePanel = document.getElementById("gatePanel");
  const appPanel = document.getElementById("appPanel");
  const form = document.getElementById("gateForm");
  const input = document.getElementById("gateUrlInput");
  const uploadBtn = document.getElementById("gateUploadBtn");
  const uploadInput = document.getElementById("gateUploadFile");
  const errorEl = document.getElementById("gateError");
  const statusEl = document.getElementById("gateStatus");
  const submitBtn = document.getElementById("gateSubmitBtn");

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
    statusEl.hidden = true;
  }

  function showStatus(message) {
    statusEl.textContent = message;
    statusEl.hidden = false;
    errorEl.hidden = true;
  }

  function clearMessages() {
    errorEl.hidden = true;
    statusEl.hidden = true;
  }

  function unlock(manifest, url) {
    const state = loadState();
    saveState({ ...state, manifestUrl: url });
    clearMessages();
    gatePanel.hidden = true;
    appPanel.hidden = false;
    onUnlocked(manifest, url);
  }

  async function attemptRememberedUpload(identifier) {
    submitBtn.disabled = true;
    showStatus("Loading previously uploaded library…");
    try {
      const manifest = await loadManifest(uploadCacheKey(identifier.slice(UPLOAD_PREFIX.length)));
      if (!manifest) throw new Error("That uploaded library isn't available any more -- upload the manifest file again.");
      unlock(manifest, identifier);
    } catch (e) {
      showError(e.message);
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function attempt(url) {
    if (!url) return;
    if (isUploadIdentifier(url)) {
      await attemptRememberedUpload(url);
      return;
    }
    input.value = url;
    submitBtn.disabled = true;
    showStatus("Loading library…");
    try {
      const manifest = await fetchManifest(url);
      unlock(manifest, url);
    } catch (e) {
      showError(e.message);
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function attemptUpload(file) {
    if (!file) return;
    uploadBtn.disabled = true;
    showStatus("Reading manifest file…");
    try {
      const manifest = await readManifestFile(file);
      const identifier = `${UPLOAD_PREFIX}${crypto.randomUUID()}`;
      await saveManifest(uploadCacheKey(identifier.slice(UPLOAD_PREFIX.length)), manifest);
      unlock(manifest, identifier);
    } catch (e) {
      showError(e.message);
    } finally {
      uploadBtn.disabled = false;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    attempt(input.value.trim());
  });

  uploadBtn.addEventListener("click", () => uploadInput.click());
  uploadInput.addEventListener("change", () => {
    const file = uploadInput.files[0];
    uploadInput.value = ""; // so choosing the same file again still fires "change"
    attemptUpload(file);
  });

  const initialUrl = resolveInitialManifestUrl();
  if (initialUrl) {
    attempt(initialUrl);
  }
}
