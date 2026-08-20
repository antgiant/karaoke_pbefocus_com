// Compact, self-describing wire format for sharing one playlist (link/QR/
// file) -- see AI_TODO.md item 5. The bottleneck is a playlist's `mix`:
// one style-id string per canonical word (e.g. "contemporarychristian", 22
// chars, repeated once per word), even though a Pathfinder typically
// paints whole ranges one style at a time -- so that array is
// overwhelmingly repetitive runs of the same value.
//
// Before serializing:
//  1. Build a small dictionary of just the style ids *actually used in
//     this playlist* (typically 1-4 of the manifest's ~14) and reference
//     styles by their index into it. This dictionary is *local to the
//     payload*, not the manifest's global style list/order -- indexing
//     into the manifest directly would silently break an old shared link
//     if a style folder is later added/removed and the manifest's order
//     shifts. Self-describing payloads stay correct regardless.
//  2. Run-length-encode each section's per-word style-index array into
//     [dictIndex, repeatCount] pairs instead of one entry per word --
//     this is where the actual size win comes from.
// Worst case (every word painted a different style, no repeats) RLE buys
// nothing; that's fine, the caller falls back to a file export instead of
// a link/QR at that point (see QR_SAFE_BYTE_LIMIT below).

const PAYLOAD_FORMAT_VERSION = 1;

// A QR code can theoretically hold ~2953 bytes (version 40, lowest error
// correction), but that's a dense, hard-to-scan code. This is a much more
// conservative heuristic for "comfortably scannable," not a hard limit --
// tune once this is exercised against real playlists and whatever QR
// library ends up in use (see AI_TODO.md item 5).
export const QR_SAFE_BYTE_LIMIT = 1500;

function runLengthEncode(assignment, styleIndexFor) {
  const runs = [];
  let i = 0;
  while (i < assignment.length) {
    const idx = styleIndexFor(assignment[i]);
    let j = i + 1;
    while (j < assignment.length && assignment[j] === assignment[i]) j++;
    runs.push([idx, j - i]);
    i = j;
  }
  return runs;
}

function runLengthDecode(runs, dict) {
  const out = [];
  for (const [dictIndex, count] of runs) {
    const styleId = dict[dictIndex];
    for (let n = 0; n < count; n++) out.push(styleId);
  }
  return out;
}

/**
 * Turns a playlist record (the same shape playlists.js/storage.js persist)
 * into the compact share payload. `includeManifestUrl`/`manifestUrl` are
 * the explicit, per-share privacy choice (see AI_TODO.md item 5) --
 * bundling the manifest URL hands the recipient full library access, not
 * just this one playlist, so it's opt-in and never defaulted on here.
 */
export function serializePlaylistForShare(record, { includeManifestUrl = false, manifestUrl = null } = {}) {
  const dict = [];
  const dictIndex = new Map();
  const styleIndexFor = (styleId) => {
    if (styleId === null || styleId === undefined) return -1;
    if (!dictIndex.has(styleId)) {
      dictIndex.set(styleId, dict.length);
      dict.push(styleId);
    }
    return dictIndex.get(styleId);
  };

  const activeStyleIndex = styleIndexFor(record.activeStyle ?? null);

  let mixOut = null;
  if (record.mix) {
    const defaultStyleIndex = styleIndexFor(record.mix.defaultStyleId ?? null);
    const sections = {};
    for (const [key, assignment] of Object.entries(record.mix.sections ?? {})) {
      sections[key] = runLengthEncode(assignment, styleIndexFor);
    }
    // Take preferences (AI_TODO.md item 6) -- small, so no need for the
    // same repetition-driven RLE treatment as the per-word style arrays,
    // but still re-keyed against the local style dictionary rather than
    // raw style ids, for the same reason: self-describing, independent of
    // the manifest's own style ordering.
    const takeOverrides = {};
    for (const [key, byStyle] of Object.entries(record.mix.takeOverrides ?? {})) {
      const reKeyed = {};
      for (const [styleId, rank] of Object.entries(byStyle)) reKeyed[styleIndexFor(styleId)] = rank;
      takeOverrides[key] = reKeyed;
    }
    mixOut = { defaultStyleIndex, sections, defaultTakeRank: record.mix.defaultTakeRank ?? 0, takeOverrides };
  }

  const payload = {
    v: PAYLOAD_FORMAT_VERSION,
    name: record.name,
    selectedSectionKeys: record.selectedSectionKeys ?? [],
    verseSelections: record.verseSelections ?? {},
    activeStyleIndex,
    styleDict: dict,
    mix: mixOut,
    // Karaoke Mode settings (blankPercent/rampOnRepeat/lengthMatched/
    // scored/scoredInput) -- no style ids inside, so no dictionary
    // re-keying needed, just pass through as-is.
    studyOptions: record.studyOptions ?? null,
  };
  if (includeManifestUrl && manifestUrl) payload.manifestUrl = manifestUrl;
  return payload;
}

/** Reverses serializePlaylistForShare -- back into a playlist-record-shaped object (no `id`; the importer assigns a fresh one, same as any other new playlist). `manifestUrl` is present only if the sharer opted to bundle it. */
export function deserializePlaylistFromShare(payload) {
  if (!payload || payload.v !== PAYLOAD_FORMAT_VERSION) {
    throw new Error("Unrecognized or unsupported shared-playlist format.");
  }
  const dict = Array.isArray(payload.styleDict) ? payload.styleDict : [];
  const styleAt = (index) => (index === -1 || index === undefined || index === null ? null : (dict[index] ?? null));

  let mix = null;
  if (payload.mix) {
    const sections = {};
    for (const [key, runs] of Object.entries(payload.mix.sections ?? {})) {
      sections[key] = runLengthDecode(runs, dict);
    }
    const takeOverrides = {};
    for (const [key, byStyleIndex] of Object.entries(payload.mix.takeOverrides ?? {})) {
      const reKeyed = {};
      for (const [styleIndex, rank] of Object.entries(byStyleIndex)) {
        const styleId = styleAt(Number(styleIndex));
        if (styleId !== null) reKeyed[styleId] = rank;
      }
      takeOverrides[key] = reKeyed;
    }
    mix = {
      defaultStyleId: styleAt(payload.mix.defaultStyleIndex),
      defaultTakeRank: Number.isInteger(payload.mix.defaultTakeRank) ? payload.mix.defaultTakeRank : 0,
      sections,
      takeOverrides,
    };
  }

  return {
    name: typeof payload.name === "string" && payload.name.trim() ? payload.name : "Shared Playlist",
    selectedSectionKeys: Array.isArray(payload.selectedSectionKeys) ? payload.selectedSectionKeys : [],
    verseSelections: payload.verseSelections && typeof payload.verseSelections === "object" ? payload.verseSelections : {},
    activeStyle: styleAt(payload.activeStyleIndex),
    mix,
    manifestUrl: typeof payload.manifestUrl === "string" ? payload.manifestUrl : null,
    // null (not the imported record's studyOptions) if the sharer's
    // payload predates this field or is malformed -- the importer (main.js)
    // falls back to defaultStudyOptions() itself rather than this module
    // reaching into playlists.js for that default.
    studyOptions: payload.studyOptions && typeof payload.studyOptions === "object" ? payload.studyOptions : null,
  };
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(b64url) {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** URL-safe (no padding, no +/) encoding of a share payload, for a query-string param or a QR code. */
export function encodePlaylistPayload(payload) {
  const json = JSON.stringify(payload);
  return bytesToBase64Url(new TextEncoder().encode(json));
}

/** Reverses encodePlaylistPayload. Throws on malformed input (truncated/corrupted link, wrong param) -- callers should catch and show a friendly error rather than let a bad link crash the app. */
export function decodePlaylistPayload(encoded) {
  const json = new TextDecoder().decode(base64UrlToBytes(encoded));
  return JSON.parse(json);
}

/** UTF-8 byte length of a payload once encoded -- what actually has to fit in a URL/QR code, not the raw JSON's character count. */
export function encodedByteLength(payload) {
  return new TextEncoder().encode(encodePlaylistPayload(payload)).length;
}
