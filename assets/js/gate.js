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

/**
 * Wires the access-gate screen. Auto-attempts a manifest URL from the query
 * string or a prior visit; otherwise waits for the form. On success, persists
 * the URL (not the manifest itself -- it's always re-fetched) and calls
 * onUnlocked(manifest, url).
 */
export function initGate({ onUnlocked }) {
  const gatePanel = document.getElementById("gatePanel");
  const appPanel = document.getElementById("appPanel");
  const form = document.getElementById("gateForm");
  const input = document.getElementById("gateUrlInput");
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

  async function attempt(url) {
    if (!url) return;
    input.value = url;
    submitBtn.disabled = true;
    showStatus("Loading library…");
    try {
      const manifest = await fetchManifest(url);
      const state = loadState();
      saveState({ ...state, manifestUrl: url });
      clearMessages();
      gatePanel.hidden = true;
      appPanel.hidden = false;
      onUnlocked(manifest, url);
    } catch (e) {
      showError(e.message);
    } finally {
      submitBtn.disabled = false;
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    attempt(input.value.trim());
  });

  const initialUrl = resolveInitialManifestUrl();
  if (initialUrl) {
    attempt(initialUrl);
  }
}
