import { MANIFEST_URL_PARAM } from "./constants.js";
import { validateManifest } from "./library.js";
import { loadState, saveState } from "./storage.js";

export function resolveInitialManifestUrl() {
  const fromQuery = new URLSearchParams(window.location.search).get(MANIFEST_URL_PARAM);
  if (fromQuery) return fromQuery;
  return loadState().manifestUrl;
}

export async function fetchManifest(url) {
  let response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch {
    throw new Error("Could not reach that URL. Check the link and your internet connection.");
  }
  if (!response.ok) {
    throw new Error(`That URL returned an error (HTTP ${response.status}).`);
  }
  let json;
  try {
    json = await response.json();
  } catch {
    throw new Error("That URL did not return valid JSON.");
  }
  try {
    return validateManifest(json);
  } catch (e) {
    throw new Error(`That file isn't a valid library manifest: ${e.message}`);
  }
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
 * Wires the access-gate screen. Auto-attempts a manifest URL from the query
 * string or a prior visit; otherwise waits for the form (or the upload
 * button, for a manifest handed over as a local file instead of hosted at a
 * URL -- see readManifestFile). On success, persists the URL (not the
 * manifest itself -- it's always re-fetched) and calls onUnlocked(manifest,
 * url); an upload has no URL to persist or re-fetch, so it passes `null`
 * instead -- callers (see main.js's `sameLibrary` check) treat a null
 * manifestUrl as never matching a remembered library, since an uploaded
 * file has no stable identity to compare across visits, and a fresh visit
 * has nothing to auto-reload it from anyway (a re-upload is always a
 * deliberate action).
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

  async function attempt(url) {
    if (!url) return;
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
      unlock(manifest, null);
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
