import { STORAGE_KEY } from "./constants.js";

function defaultState() {
  return {
    schemaVersion: 1,
    manifestUrl: null,
    selectedSectionKeys: [],
    activeStyle: null,
    mix: null,
  };
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("bad state");
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable (private browsing, quota, etc.) -- non-fatal, just no persistence.
  }
}
