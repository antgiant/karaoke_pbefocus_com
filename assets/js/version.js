// The one place the deployed version lives -- bump it with every change that
// ships, so the footer (below) tells a Pathfinder (or a maintainer checking a
// fresh deploy) exactly which build they're on. Format: YYYY.MM.DD.N, where N
// counts that day's releases starting at 1.
export const APP_VERSION = "2026.11.03.1";

const el = document.getElementById("appVersion");
if (el) el.textContent = `v${APP_VERSION}`;
