// Practice history: a log of study attempts per section, global across every
// playlist (see AI_TODO.md item 5) -- library.js's sectionKey() is stable
// and manifest/playlist-independent, so the same section studied from two
// different playlists shares one history here. Pure/testable, like
// playlists.js -- no DOM, no localStorage I/O (that's storage.js's job).
//
// Shape: { [sectionKey]: Attempt[] }, Attempt = { date: ISO string, mode:
// "karaoke" | "typeahead" | "singalong", accuracy: number (0-1) | null }.
// accuracy is null for Karaoke Mode (unscored) attempts, which have no
// inherent score -- they still get an entry so history reflects practice
// frequency, not only scored-mode accuracy.

// Rolling cap per section rather than an unbounded log -- "the full trend"
// (per the decided scope) doesn't need to mean literally every attempt ever,
// just enough to see a trend across sessions.
const MAX_ATTEMPTS_PER_SECTION = 50;

export function recordAttempt(history, key, mode, accuracy = null) {
  const attempts = (history[key] ?? []).slice();
  attempts.push({ date: new Date().toISOString(), mode, accuracy });
  if (attempts.length > MAX_ATTEMPTS_PER_SECTION) attempts.splice(0, attempts.length - MAX_ATTEMPTS_PER_SECTION);
  return { ...history, [key]: attempts };
}

export function getSectionHistory(history, key) {
  return history[key] ?? [];
}

export function lastAttempt(history, key) {
  const attempts = getSectionHistory(history, key);
  return attempts.length ? attempts[attempts.length - 1] : null;
}

/** Most recent accuracy for a section, ignoring null (unscored) attempts -- or null if it's never been scored. */
export function lastAccuracy(history, key) {
  const attempts = getSectionHistory(history, key);
  for (let i = attempts.length - 1; i >= 0; i--) {
    if (attempts[i].accuracy !== null) return attempts[i].accuracy;
  }
  return null;
}

/** "today" / "3d ago" / "5w ago" etc., for a compact per-section history badge. */
export function formatRelativeDate(isoString) {
  const then = new Date(isoString).getTime();
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
