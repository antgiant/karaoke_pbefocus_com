import { buildBookTree, findSection, formatDuration, formatVerseRanges, maxTakeCountForStyle, passageLabel } from "./library.js";
import { formatRelativeDate, lastAccuracy, lastAttempt, recordAttempt } from "./history.js";
import { churchFitDescription, churchFitEmoji } from "./style-fit.js";
import { initGate, isUploadIdentifier, isLocalIdentifier } from "./gate.js";
import { loadState, saveState, SCHEMA_VERSION } from "./storage.js";
import { MANIFEST_URL_PARAM, PLAYLIST_URL_PARAM } from "./constants.js";
import {
  bookSelectionState,
  createSelectionState,
  createVerseSelections,
  getSelectedVerses,
  serializeVerseSelections,
  setBookSelected,
  setSelectedVerses,
  summarize,
  toggleKey,
} from "./selection.js";
import { createMix, fromSerializable, setDefaultStyle, syncMixToSelection, toSerializable } from "./mix.js";
import { createPlaylistRecord, defaultStudyOptions, findPlaylist, renamePlaylist, duplicatePlaylist, deletePlaylist } from "./playlists.js";
import {
  serializePlaylistForShare,
  deserializePlaylistFromShare,
  encodePlaylistPayload,
  decodePlaylistPayload,
  encodedByteLength,
  QR_SAFE_BYTE_LIMIT,
} from "./share.js";
import { renderQrCodeSvg } from "./qr.js";
import { mountMixEditor } from "./mix-editor.js";
import { buildProgram, shuffleBySection } from "./program-builder.js";
import { createPlaybackEngine } from "./playback-engine.js";
import { mountUnscored } from "./study-modes/unscored.js";
import { mountTypeAhead } from "./study-modes/type-ahead.js";
import { mountSingAlong, isSingAlongSupported } from "./study-modes/sing-along.js";
import { mountNameThatPassage } from "./study-modes/name-that-passage.js";
import { mountSleepMode } from "./sleep-mode.js";
import { mountPlayerControls } from "./player-controls.js";
import { clampKaraokeControls, resolveKaraokeControls } from "./karaoke-controls.js";
import { mountAbLoopPicker } from "./karaoke-controls-panel.js";
import {
  CACHE_KIND,
  cacheOpportunistically,
  cacheUsage,
  clearCache,
  downloadBlocksForOffline,
  formatCacheUsage,
  primeResolverCache,
  resolveUrlSync,
} from "./offline/audio-cache.js";
import { primeResolverCache as primeLocalResolverCache, resolveUrlSync as resolveLocalUrlSync } from "./offline/local-library.js";

// AI_TODO.md item 7 (offline support): registers the app-shell service
// worker (assets/js/../../sw.js at the repo root, so its default scope
// covers the whole app -- see that file) so a reload works without a
// network connection. Registered with a plain relative path, resolved
// against the page's own URL (not this module's), so it still works if the
// app is ever deployed under a subpath. Best-effort: a browser with no
// serviceWorker support, or a registration failure, just means no offline
// app shell -- never fatal to the app itself.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

/** A shared-playlist payload -> a fresh playlist record (no id assigned by the payload; the importer always gets a new one, same as any other new playlist). */
function recordFromSharedPayload(payload) {
  const shared = deserializePlaylistFromShare(payload);
  const record = createPlaylistRecord(shared.name);
  record.selectedSectionKeys = shared.selectedSectionKeys;
  record.verseSelections = shared.verseSelections;
  record.activeStyle = shared.activeStyle;
  record.mix = shared.mix;
  if (shared.studyOptions) record.studyOptions = shared.studyOptions;
  if (shared.karaokeControlsOverride) record.karaokeControlsOverride = shared.karaokeControlsOverride;
  if (shared.karaokeControlsSectionOverrides) record.karaokeControlsSectionOverrides = shared.karaokeControlsSectionOverrides;
  return record;
}

/**
 * Imports a playlist from `?playlist=<encoded>` in the address bar, if
 * present -- consumed once: the param is stripped from the URL immediately
 * either way, so a refresh doesn't re-import the same link repeatedly. If
 * the sharer also bundled library access, that rode in as a normal
 * `?library=` param alongside this one (see the share dialog wiring below)
 * and gate.js's existing auto-unlock already picked it up unmodified --
 * this only ever needs to deal with the playlist half.
 */
function tryImportPlaylistFromUrl() {
  const url = new URL(window.location.href);
  const encoded = url.searchParams.get(PLAYLIST_URL_PARAM);
  if (!encoded) return null;
  url.searchParams.delete(PLAYLIST_URL_PARAM);
  window.history.replaceState(null, "", url.toString());
  try {
    return recordFromSharedPayload(decodePlaylistPayload(encoded));
  } catch (e) {
    alert(`Couldn't import the shared playlist from this link: ${e.message}`);
    return null;
  }
}

function renderSummary(selected, manifest, verseSelections) {
  const { sectionCount, wordCount, estimatedSeconds } = summarize(selected, manifest, verseSelections);
  document.getElementById("summarySectionCount").textContent = sectionCount;
  document.getElementById("summaryWordCount").textContent = wordCount.toLocaleString();
  document.getElementById("summaryDuration").textContent = `~${formatDuration(estimatedSeconds)}`;
}

/** sectionKey -> Set<verseNumber>, restricted to currently-selected sections -- the shape buildProgram's verseFilter expects. */
function buildVerseFilter(selected, verseSelections) {
  const filter = new Map();
  for (const [key, verses] of verseSelections) {
    if (selected.has(key)) filter.set(key, verses);
  }
  return filter;
}

const openBooks = new Set();
const openVersePickers = new Set();

/** Per-chapter verse picker: All/Clear/range controls plus one checkbox per verse the chapter actually has recorded. Returns null for chapters with 0-1 verses -- nothing there to narrow. */
function renderVersePicker(chapter, selected, verseSelections, onChange) {
  const { key, verseNumbers } = chapter;
  if (verseNumbers.length <= 1) return null;

  const isChecked = selected.has(key);
  const effective = getSelectedVerses(verseSelections, key, verseNumbers);
  const effectiveSet = new Set(effective);

  const details = document.createElement("details");
  details.className = "verse-picker" + (isChecked ? "" : " is-disabled");
  details.open = openVersePickers.has(key);
  details.addEventListener("toggle", () => {
    if (details.open) openVersePickers.add(key);
    else openVersePickers.delete(key);
  });

  const summary = document.createElement("summary");
  summary.textContent =
    effective.length === verseNumbers.length
      ? "All verses"
      : effective.length === 0
        ? "No verses selected"
        : `Verses: ${formatVerseRanges(effective)}`;
  details.appendChild(summary);

  function applyVerses(verses) {
    setSelectedVerses(verseSelections, key, verses, verseNumbers);
    onChange();
  }

  const first = verseNumbers[0];
  const last = verseNumbers[verseNumbers.length - 1];

  const actions = document.createElement("div");
  actions.className = "verse-actions";

  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = "btn tiny";
  allBtn.textContent = "All";
  allBtn.disabled = !isChecked;
  allBtn.addEventListener("click", () => applyVerses(verseNumbers));

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "btn tiny";
  clearBtn.textContent = "Clear";
  clearBtn.disabled = !isChecked;
  clearBtn.addEventListener("click", () => applyVerses([]));

  const rangeStart = document.createElement("input");
  rangeStart.type = "number";
  rangeStart.className = "verse-range-input";
  rangeStart.min = String(first);
  rangeStart.max = String(last);
  rangeStart.placeholder = String(first);
  rangeStart.disabled = !isChecked;
  rangeStart.setAttribute("aria-label", "Range start verse");

  const rangeEnd = document.createElement("input");
  rangeEnd.type = "number";
  rangeEnd.className = "verse-range-input";
  rangeEnd.min = String(first);
  rangeEnd.max = String(last);
  rangeEnd.placeholder = String(last);
  rangeEnd.disabled = !isChecked;
  rangeEnd.setAttribute("aria-label", "Range end verse");

  const rangeBtn = document.createElement("button");
  rangeBtn.type = "button";
  rangeBtn.className = "btn tiny";
  rangeBtn.textContent = "Apply Range";
  rangeBtn.disabled = !isChecked;
  rangeBtn.addEventListener("click", () => {
    const start = Number(rangeStart.value) || first;
    const end = Number(rangeEnd.value) || last;
    const [lo, hi] = start <= end ? [start, end] : [end, start];
    applyVerses(verseNumbers.filter((v) => v >= lo && v <= hi));
  });

  actions.append(allBtn, clearBtn, rangeStart, document.createTextNode("to"), rangeEnd, rangeBtn);
  details.appendChild(actions);

  const grid = document.createElement("div");
  grid.className = "verse-grid";
  for (const verse of verseNumbers) {
    const verseLabel = document.createElement("label");
    verseLabel.className = "verse-check";
    const verseCheckbox = document.createElement("input");
    verseCheckbox.type = "checkbox";
    verseCheckbox.checked = effectiveSet.has(verse);
    verseCheckbox.disabled = !isChecked;
    verseCheckbox.addEventListener("change", () => {
      const next = new Set(getSelectedVerses(verseSelections, key, verseNumbers));
      if (verseCheckbox.checked) next.add(verse);
      else next.delete(verse);
      applyVerses([...next]);
    });
    verseLabel.appendChild(verseCheckbox);
    verseLabel.appendChild(document.createTextNode(String(verse)));
    grid.appendChild(verseLabel);
  }
  details.appendChild(grid);

  return details;
}

/** Compact "last studied" hint for a chapter row -- e.g. "3d ago · 82%" -- or null if this section has no practice history yet. */
function renderHistoryBadge(practiceHistory, key) {
  const attempt = lastAttempt(practiceHistory, key);
  if (!attempt) return null;
  const badge = document.createElement("span");
  badge.className = "chapter-history";
  const accuracy = lastAccuracy(practiceHistory, key);
  badge.textContent = accuracy !== null ? `${formatRelativeDate(attempt.date)} · ${Math.round(accuracy * 100)}%` : formatRelativeDate(attempt.date);
  badge.title = accuracy !== null ? `Last practiced ${formatRelativeDate(attempt.date)}, ${Math.round(accuracy * 100)}% accuracy` : `Last practiced ${formatRelativeDate(attempt.date)}`;
  return badge;
}

function renderBookTree(manifest, selected, verseSelections, onChange, practiceHistory) {
  const tree = buildBookTree(manifest);
  const container = document.getElementById("bookTree");
  container.innerHTML = "";

  for (const { book, chapters } of tree) {
    const details = document.createElement("details");
    details.className = "book-group";
    details.open = openBooks.has(book);
    details.addEventListener("toggle", () => {
      if (details.open) openBooks.add(book);
      else openBooks.delete(book);
    });

    const summary = document.createElement("summary");
    const bookCheckbox = document.createElement("input");
    bookCheckbox.type = "checkbox";
    bookCheckbox.setAttribute("aria-label", `Select all of ${book}`);
    const state = bookSelectionState(selected, chapters);
    bookCheckbox.checked = state === "all";
    bookCheckbox.indeterminate = state === "some";
    bookCheckbox.addEventListener("click", (event) => {
      event.stopPropagation();
      setBookSelected(selected, chapters, event.target.checked);
      onChange();
    });
    summary.appendChild(bookCheckbox);
    summary.appendChild(document.createTextNode(` ${book}`));
    details.appendChild(summary);

    const list = document.createElement("div");
    list.className = "chapter-list";
    for (const chapter of chapters) {
      const item = document.createElement("div");
      item.className = "chapter-item";

      const label = document.createElement("label");
      label.className = "chapter-check";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.has(chapter.key);
      checkbox.addEventListener("change", () => {
        toggleKey(selected, chapter.key);
        onChange();
      });
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(chapter.label));
      item.appendChild(label);

      const historyBadge = renderHistoryBadge(practiceHistory, chapter.key);
      if (historyBadge) item.appendChild(historyBadge);

      const versePicker = renderVersePicker(chapter, selected, verseSelections, onChange);
      if (versePicker) item.appendChild(versePicker);

      list.appendChild(item);
    }
    details.appendChild(list);
    container.appendChild(details);
  }
}

/**
 * Updates the small badge next to the style <select> to reflect whichever
 * style is currently selected -- the church-fit emoji, with the full
 * phrase as a `title` (mouse hover), an `aria-label` (since `title` alone
 * is announced inconsistently by screen readers), and a click-to-toggle
 * popover (see wireStyleFitBadge below) for touch devices that can't
 * hover at all. This badge is the only place the phrase lives now that
 * it's out of the <option> text -- see AI_TODO.md's UI-cleanup note:
 * putting the full "<emoji> <phrase>" text in every <option> (the
 * original design) made the closed <select> render far too wide on
 * mobile, since it sizes to its longest option.
 */
function updateStyleFitBadge(manifest, styleId) {
  const badge = document.getElementById("styleFitBadge");
  const tooltip = document.getElementById("styleFitTooltip");
  const style = manifest.styles.find((s) => s.id === styleId);
  const description = style?.churchFit ? churchFitDescription(style.churchFit) : "";
  badge.textContent = style?.churchFit ? churchFitEmoji(style.churchFit) : "";
  badge.title = description;
  badge.setAttribute("aria-label", description ? `Church fit: ${description}` : "");
  badge.hidden = !description;
  tooltip.textContent = description;
  tooltip.hidden = true; // switching style closes any already-open popover rather than leaving stale text showing
}

/** One-time wiring for the badge's click-to-toggle popover (the `title`/`aria-label` set by updateStyleFitBadge cover mouse hover and screen readers, but a touch device can't hover at all -- this is the tap equivalent). Closes on a second click, a click elsewhere, or Escape. */
function wireStyleFitBadge() {
  const badge = document.getElementById("styleFitBadge");
  const tooltip = document.getElementById("styleFitTooltip");
  badge.addEventListener("click", (event) => {
    event.stopPropagation();
    tooltip.hidden = !tooltip.hidden;
  });
  document.addEventListener("click", (event) => {
    if (!tooltip.hidden && event.target !== badge) tooltip.hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") tooltip.hidden = true;
  });
}
wireStyleFitBadge();

function renderStyleOptions(manifest, selectedStyleId) {
  const select = document.getElementById("styleSelect");
  select.innerHTML = "";
  for (const style of manifest.styles) {
    const option = document.createElement("option");
    option.value = style.id;
    // Just "<vibe emoji> <label>" -- the church-fit phrase used to be
    // appended here too, but that made the closed <select> render far too
    // wide on mobile (it sizes to its longest option's text). The emoji +
    // full phrase now live in the #styleFitBadge next to the dropdown
    // (updateStyleFitBadge) instead, plus a per-option `title` here as a
    // bonus hover tooltip on desktop browsers that render one (most do;
    // it's inert, not broken, on ones that don't -- the badge is the
    // reliable source either way).
    const vibe = style.emoji ? `${style.emoji} ` : "";
    // Take count (AI_TODO.md item 1) -- lets a Pathfinder know before
    // drilling into Customize Genre Mix whether this style even has
    // alternate takes worth exploring there; picking a specific take only
    // happens by painting it in the mix editor, not from this selector.
    const takeCount = maxTakeCountForStyle(manifest, style.id);
    const takeNote = takeCount > 1 ? ` (${takeCount} takes)` : "";
    option.textContent = `${vibe}${style.label}${takeNote}`;
    if (style.churchFit) option.title = churchFitDescription(style.churchFit);
    select.appendChild(option);
  }
  select.value = selectedStyleId;
  updateStyleFitBadge(manifest, selectedStyleId);
  return select;
}

function renderFallbackNote(manifest, fallbacks) {
  const note = document.getElementById("fallbackNote");
  if (fallbacks.length === 0) {
    note.hidden = true;
    return;
  }
  const labelFor = (id) => manifest.styles.find((s) => s.id === id)?.label ?? id;
  const describe = (f) =>
    f.usedStyle ? `${f.label} (using ${labelFor(f.usedStyle)} instead)` : `${f.label} (no audio available anywhere)`;
  note.textContent =
    "Some of your mix isn't available as chosen, so it'll play differently there: " + fallbacks.map(describe).join("; ") + ".";
  note.hidden = false;
}

function initSelectionUi(manifest, manifestUrl) {
  const state = loadState();
  // manifestUrl is a real URL for a URL-loaded manifest, or a synthetic
  // `upload:<uuid>` identifier for one loaded via the gate's upload button
  // (see gate.js's isUploadIdentifier) -- either way it's now stable across
  // visits (AI_TODO.md item 7), so a repeat upload of the exact same
  // remembered library (not a fresh upload, which always gets its own new
  // uuid -- see gate.js's attemptUpload) counts as "the same library" here
  // just like a repeat URL load does.
  const sameLibrary = manifestUrl !== null && state.manifestUrl === manifestUrl;
  // A local-folder-loaded manifest (gate.js's isLocalIdentifier) reads
  // straight off disk via local-library.js -- no network, no Range
  // requests, and no offline cache to manage (the source *is* already
  // local), so both get skipped below wherever this is true.
  const isLocalLibrary = isLocalIdentifier(manifestUrl);
  const playlists = sameLibrary && state.playlists.length ? state.playlists : [createPlaylistRecord("My Playlist")];
  let activePlaylistId =
    sameLibrary && findPlaylist(playlists, state.activePlaylistId) ? state.activePlaylistId : playlists[0].id;

  const importedRecord = tryImportPlaylistFromUrl();
  if (importedRecord) {
    playlists.push(importedRecord);
    activePlaylistId = importedRecord.id;
  }

  // Practice history is global (not scoped to `sameLibrary` like the
  // playlists above) -- a section studied under one manifest keeps its
  // history even if the Pathfinder later switches libraries, since
  // sectionKey is manifest-independent (see history.js).
  let practiceHistory = state.history ?? {};

  // Karaoke Controls (AI_TODO.md item 4) app-wide default -- also global,
  // not scoped to `sameLibrary`, same reasoning as practiceHistory: a
  // Pathfinder's preferred pitch/speed/etc. isn't tied to which library
  // they're browsing.
  let appKaraokeControls = state.karaokeControls;

  function persistFullState() {
    saveState({
      schemaVersion: SCHEMA_VERSION,
      manifestUrl,
      playlists,
      activePlaylistId,
      history: practiceHistory,
      karaokeControls: appKaraokeControls,
      karaokeTextScale,
    });
  }

  // Live, in-memory working copies of the active playlist's data -- same
  // shapes (Set/Map/mix-with-a-Map) the app always used for "the
  // selection," just rebuilt from whichever playlist record is active
  // instead of built once at startup. Reassigned wholesale by
  // loadActivePlaylistIntoMemory() on every playlist switch; every
  // handler below reads these `let` bindings directly (not a destructured
  // copy), so a reassignment is visible everywhere without extra plumbing.
  let selected, verseSelections, mix;

  function loadActivePlaylistIntoMemory() {
    const record = findPlaylist(playlists, activePlaylistId);
    selected = createSelectionState(record.selectedSectionKeys);
    verseSelections = createVerseSelections(record.verseSelections);
    const initialStyleId = record.activeStyle || manifest.styles[0].id;
    mix = record.mix ? fromSerializable(record.mix, manifest) : createMix(initialStyleId);
    syncMixToSelection(mix, manifest, selected);
  }
  loadActivePlaylistIntoMemory();

  /**
   * Writes the in-memory selection/verseSelections/mix -- and the Karaoke
   * Mode controls declared further down (hintLevelInput/rampCheckbox/
   * lengthMatchedCheckbox/scoredCheckbox/scoredInputSelect) -- back into the
   * active playlist's record and persists the whole collection. Safe to
   * reference those later-declared consts here: this function is only ever
   * *called* from event handlers (after the whole synchronous setup below
   * has finished and they're assigned), never during initial setup itself.
   */
  function persistActivePlaylist() {
    const record = findPlaylist(playlists, activePlaylistId);
    record.selectedSectionKeys = [...selected];
    record.verseSelections = serializeVerseSelections(verseSelections);
    record.activeStyle = mix.defaultStyleId;
    record.mix = toSerializable(mix);
    record.studyOptions = {
      blankPercent: Math.min(100, Math.max(0, Number(hintLevelInput.value) || 0)),
      rampOnRepeat: rampCheckbox.checked,
      lengthMatched: lengthMatchedCheckbox.checked,
      scored: scoredCheckbox.checked,
      scoredInput: scoredInputSelect.value,
      duckVocals: duckVocalsCheckbox.checked,
      nameThatPassageHelp: Math.min(100, Math.max(0, Number(ntpHelpSlider.value) || 0)),
      nameThatPassageInput: ntpInputSelect.value,
    };
    persistFullState();
  }

  /** Records one study attempt for `key` and persists it immediately -- passed into each study mode as onAttempt. */
  function logAttempt(key, mode, accuracy) {
    practiceHistory = recordAttempt(practiceHistory, key, mode, accuracy);
    persistFullState();
  }

  const styleSelect = renderStyleOptions(manifest, mix.defaultStyleId);
  const mixEditorContainer = document.getElementById("mixEditor");
  const toggleMixEditorBtn = document.getElementById("toggleMixEditorBtn");
  let mixEditorHandle = null;

  function renderMixEditorIfOpen() {
    mixEditorHandle?.unmount();
    mixEditorHandle = null;
    if (mixEditorContainer.hidden) return;
    mixEditorHandle = mountMixEditor(mixEditorContainer, manifest, mix, selected, () => {
      persistActivePlaylist();
    });
  }

  function rerender() {
    syncMixToSelection(mix, manifest, selected);
    persistActivePlaylist();
    renderBookTree(manifest, selected, verseSelections, rerender, practiceHistory);
    renderSummary(selected, manifest, verseSelections);
    renderMixEditorIfOpen();
    renderControlsScopeSongOptions();
    syncControlsPanelFromState();
  }

  document.getElementById("selectAllBtn").addEventListener("click", () => {
    for (const { chapters } of buildBookTree(manifest)) setBookSelected(selected, chapters, true);
    rerender();
  });
  document.getElementById("selectNoneBtn").addEventListener("click", () => {
    selected.clear();
    rerender();
  });

  toggleMixEditorBtn.addEventListener("click", () => {
    mixEditorContainer.hidden = !mixEditorContainer.hidden;
    toggleMixEditorBtn.textContent = mixEditorContainer.hidden ? "Customize Genre Mix" : "Hide Genre Mix";
    renderMixEditorIfOpen();
  });

  styleSelect.addEventListener("change", () => {
    setDefaultStyle(mix, styleSelect.value);
    updateStyleFitBadge(manifest, styleSelect.value);
    persistActivePlaylist();
    renderMixEditorIfOpen();
  });

  renderBookTree(manifest, selected, verseSelections, rerender, practiceHistory);
  renderSummary(selected, manifest, verseSelections);

  // --- Playlist switcher: create / rename / duplicate / delete / select active ---
  const playlistSelect = document.getElementById("playlistSelect");

  function renderPlaylistSelect() {
    playlistSelect.innerHTML = "";
    for (const p of playlists) {
      const option = document.createElement("option");
      option.value = p.id;
      option.textContent = p.name;
      playlistSelect.appendChild(option);
    }
    playlistSelect.value = activePlaylistId;
  }

  /** Persists whatever's currently in memory into its playlist first, then switches the active playlist and re-renders everything that depends on it. */
  function switchToPlaylist(id) {
    if (id !== activePlaylistId) persistActivePlaylist();
    activePlaylistId = id;
    loadActivePlaylistIntoMemory();
    styleSelect.value = mix.defaultStyleId; // same manifest/style list across playlists -- just move the selection
    updateStyleFitBadge(manifest, mix.defaultStyleId);
    syncStudyOptionsFromActivePlaylist();
    renderPlaylistSelect();
    renderBookTree(manifest, selected, verseSelections, rerender, practiceHistory);
    renderSummary(selected, manifest, verseSelections);
    renderMixEditorIfOpen();
    renderControlsScopeSongOptions();
    syncControlsPanelFromState();
    persistActivePlaylist(); // record the new activePlaylistId itself
  }

  renderPlaylistSelect();
  playlistSelect.addEventListener("change", () => switchToPlaylist(playlistSelect.value));

  document.getElementById("newPlaylistBtn").addEventListener("click", () => {
    const defaultName = `Playlist ${playlists.length + 1}`;
    const name = prompt("Name this playlist:", defaultName);
    if (name === null) return; // cancelled
    const record = createPlaylistRecord(name.trim() || defaultName);
    playlists.push(record);
    switchToPlaylist(record.id);
  });

  document.getElementById("renamePlaylistBtn").addEventListener("click", () => {
    const current = findPlaylist(playlists, activePlaylistId);
    const name = prompt("Rename this playlist:", current.name);
    if (name === null) return;
    renamePlaylist(playlists, activePlaylistId, name);
    renderPlaylistSelect();
    persistActivePlaylist();
  });

  document.getElementById("duplicatePlaylistBtn").addEventListener("click", () => {
    persistActivePlaylist(); // the copy should reflect the latest in-memory edits, not the last-saved snapshot
    const copy = duplicatePlaylist(playlists, activePlaylistId);
    if (copy) switchToPlaylist(copy.id);
  });

  document.getElementById("deletePlaylistBtn").addEventListener("click", () => {
    const current = findPlaylist(playlists, activePlaylistId);
    if (!confirm(`Delete "${current.name}"? This can't be undone.`)) return;
    activePlaylistId = deletePlaylist(playlists, activePlaylistId);
    loadActivePlaylistIntoMemory();
    styleSelect.value = mix.defaultStyleId;
    updateStyleFitBadge(manifest, mix.defaultStyleId);
    syncStudyOptionsFromActivePlaylist();
    renderPlaylistSelect();
    renderBookTree(manifest, selected, verseSelections, rerender, practiceHistory);
    renderSummary(selected, manifest, verseSelections);
    renderMixEditorIfOpen();
    renderControlsScopeSongOptions();
    syncControlsPanelFromState();
    persistActivePlaylist();
  });

  // A synthetic `upload:<uuid>` or `local:<uuid>` manifestUrl (AI_TODO.md
  // item 7 -- see gate.js's isUploadIdentifier/isLocalIdentifier) has no
  // meaning to any other browser, so neither is ever something the share
  // dialog can offer to bundle -- same "can't share this library" posture
  // as the old always-null upload case.
  const shareableManifestUrl = isUploadIdentifier(manifestUrl) || isLocalLibrary ? null : manifestUrl;

  // --- Sharing: link/QR (tiered by payload size) or a downloadable file, with an explicit per-share privacy choice -- see AI_TODO.md item 5 ---
  const shareDialog = document.getElementById("shareDialog");
  const shareDialogPlaylistName = document.getElementById("shareDialogPlaylistName");
  const shareIncludeLibraryCheckbox = document.getElementById("shareIncludeLibraryCheckbox");
  const shareLinkInput = document.getElementById("shareLinkInput");
  const shareLinkRow = shareLinkInput.closest(".style-select-row");
  const copyShareLinkBtn = document.getElementById("copyShareLinkBtn");
  const shareQrContainer = document.getElementById("shareQrContainer");
  const shareFileNote = document.getElementById("shareFileNote");
  const downloadShareFileBtn = document.getElementById("downloadShareFileBtn");

  function currentSharePayload() {
    persistActivePlaylist(); // share whatever's actually selected right now, not a stale snapshot
    const record = findPlaylist(playlists, activePlaylistId);
    return serializePlaylistForShare(record, {
      includeManifestUrl: shareIncludeLibraryCheckbox.checked,
      manifestUrl: shareableManifestUrl,
    });
  }

  function updateShareDialog() {
    const payload = currentSharePayload();
    const fitsQr = encodedByteLength(payload) <= QR_SAFE_BYTE_LIMIT;

    shareLinkRow.hidden = !fitsQr;
    shareQrContainer.hidden = !fitsQr;
    shareFileNote.hidden = fitsQr;

    if (!fitsQr) {
      shareQrContainer.innerHTML = "";
      shareFileNote.textContent =
        "This playlist's custom genre mix is too large for a reliable link/QR code -- download it as a file and share that instead.";
      return;
    }

    const url = new URL(window.location.href);
    url.search = "";
    if (shareIncludeLibraryCheckbox.checked && shareableManifestUrl) url.searchParams.set(MANIFEST_URL_PARAM, shareableManifestUrl);
    url.searchParams.set(PLAYLIST_URL_PARAM, encodePlaylistPayload(payload));
    const link = url.toString();
    shareLinkInput.value = link;
    shareQrContainer.innerHTML = renderQrCodeSvg(link);
  }

  document.getElementById("sharePlaylistBtn").addEventListener("click", () => {
    shareDialogPlaylistName.textContent = findPlaylist(playlists, activePlaylistId).name;
    shareIncludeLibraryCheckbox.checked = false;
    // A library loaded via the gate's upload button (see gate.js) has no
    // shareable URL to bundle into a share link -- disable rather than
    // leave a checkbox that would silently do nothing when checked.
    shareIncludeLibraryCheckbox.disabled = !shareableManifestUrl;
    shareIncludeLibraryCheckbox.title = shareableManifestUrl
      ? ""
      : "This library was loaded from an uploaded file, not a link, so there's no library link to include.";
    updateShareDialog();
    shareDialog.showModal();
  });
  shareIncludeLibraryCheckbox.addEventListener("change", updateShareDialog);

  copyShareLinkBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(shareLinkInput.value);
      const original = copyShareLinkBtn.textContent;
      copyShareLinkBtn.textContent = "Copied!";
      setTimeout(() => {
        copyShareLinkBtn.textContent = original;
      }, 1500);
    } catch {
      shareLinkInput.select(); // clipboard API unavailable/denied -- fall back to select-and-Ctrl+C
    }
  });

  downloadShareFileBtn.addEventListener("click", () => {
    const payload = currentSharePayload();
    const name = findPlaylist(playlists, activePlaylistId).name;
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[^\w -]+/g, "_") || "playlist"}.playlist.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // --- Import a playlist from a previously-exported file ---
  const importPlaylistBtn = document.getElementById("importPlaylistBtn");
  const importPlaylistFile = document.getElementById("importPlaylistFile");
  const importPlaylistError = document.getElementById("importPlaylistError");

  importPlaylistBtn.addEventListener("click", () => importPlaylistFile.click());
  importPlaylistFile.addEventListener("change", async () => {
    const file = importPlaylistFile.files?.[0];
    importPlaylistFile.value = "";
    if (!file) return;
    try {
      const record = recordFromSharedPayload(JSON.parse(await file.text()));
      playlists.push(record);
      switchToPlaylist(record.id);
      importPlaylistError.hidden = true;
    } catch (e) {
      importPlaylistError.textContent = `Couldn't import that file: ${e.message}`;
      importPlaylistError.hidden = false;
    }
  });

  // --- Offline storage management (AI_TODO.md item 7): usage + clear
  // actions for both the opportunistic and explicit-download caches, plus
  // the explicit "download this playlist" action itself. The opportunistic
  // cache fills up on its own as the Pathfinder studies normally (see the
  // engine.on("blockchange") hook below); this panel is only for seeing/
  // managing what's accumulated and for the deliberate download. ---
  const offlinePanelEl = document.getElementById("offlinePanel");
  // Meaningless when the library's already reading straight off local disk
  // -- there's nothing to fetch ahead of time or cache for a network outage.
  offlinePanelEl.hidden = isLocalLibrary;

  const offlineOpportunisticUsageEl = document.getElementById("offlineOpportunisticUsage");
  const offlineClearOpportunisticBtn = document.getElementById("offlineClearOpportunisticBtn");
  const offlineDownloadUsageEl = document.getElementById("offlineDownloadUsage");
  const offlineClearDownloadsBtn = document.getElementById("offlineClearDownloadsBtn");
  const offlineDownloadPlaylistBtn = document.getElementById("offlineDownloadPlaylistBtn");
  const offlineDownloadStatusEl = document.getElementById("offlineDownloadStatus");

  function refreshOfflineUsage() {
    offlineOpportunisticUsageEl.textContent = formatCacheUsage(cacheUsage(CACHE_KIND.OPPORTUNISTIC));
    offlineDownloadUsageEl.textContent = formatCacheUsage(cacheUsage(CACHE_KIND.DOWNLOAD));
  }
  refreshOfflineUsage();

  offlineClearOpportunisticBtn.addEventListener("click", async () => {
    await clearCache(CACHE_KIND.OPPORTUNISTIC);
    refreshOfflineUsage();
  });

  offlineClearDownloadsBtn.addEventListener("click", async () => {
    if (!confirm("Delete every recording downloaded for offline use? You can download them again later.")) return;
    await clearCache(CACHE_KIND.DOWNLOAD);
    refreshOfflineUsage();
  });

  offlineDownloadPlaylistBtn.addEventListener("click", async () => {
    if (selected.size === 0) {
      alert("Select at least one chapter or verse range first.");
      return;
    }
    const verseFilter = buildVerseFilter(selected, verseSelections);
    const program = buildProgram(manifest, mix, selected, verseFilter);
    offlineDownloadPlaylistBtn.disabled = true;
    offlineDownloadStatusEl.hidden = false;
    try {
      await downloadBlocksForOffline(program.blocks, (done, total) => {
        offlineDownloadStatusEl.textContent = total > 0 ? `Downloading… ${done} / ${total} recordings` : "Nothing to download.";
      });
      offlineDownloadStatusEl.textContent = "Download complete -- this playlist's current mix is now available offline.";
    } catch (e) {
      offlineDownloadStatusEl.textContent = `Download failed: ${e.message}`;
    } finally {
      offlineDownloadPlaylistBtn.disabled = false;
      refreshOfflineUsage();
    }
  });

  const engine = createPlaybackEngine();

  // AI_TODO.md item 7 (offline support): transparently serves a cached
  // blob: URL in place of a block's remote instrumental/vocal URLs when
  // one's available (setUrlResolver), and opportunistically caches
  // whatever's actually playing in the background as blocks change --
  // shared across every mode that drives this one engine instance (Karaoke
  // Mode, Sleep Mode, Name that Passage), so this single wiring point
  // covers all of them. A local-folder library resolves every block's path
  // straight off disk instead (local-library.js) -- there's no remote URL to
  // cache a copy of, so opportunistic caching is skipped entirely for it.
  if (isLocalLibrary) {
    engine.setUrlResolver({ resolve: resolveLocalUrlSync, prime: primeLocalResolverCache });
  } else {
    engine.setUrlResolver({ resolve: resolveUrlSync, prime: primeResolverCache });
  }
  engine.on("blockchange", (block) => {
    if (block && !isLocalLibrary) cacheOpportunistically(block.instrumentalUrl, block.vocalUrl).then(refreshOfflineUsage);
  });

  // Vibe emoji only here, not the full church-fit phrase (AI_TODO.md item
  // 7 -- lock-screen/scrubber space is limited, per its own caution).
  const styleLabelFor = (id) => {
    const style = manifest.styles.find((s) => s.id === id);
    if (!style) return id;
    return style.emoji ? `${style.emoji} ${style.label}` : style.label;
  };
  let unmountStudyView = null;
  let unmountPlayerControls = null;

  // --- Karaoke Mode options (redesigned: one slider + a few checkboxes,
  // replacing the old mode/mask-style dropdowns -- Disappearing Word's
  // separate "vanish ahead of playback" mechanic is gone for good, folded
  // into the slider) ---
  const hintLevelSlider = document.getElementById("hintLevelSlider");
  const hintLevelInput = document.getElementById("hintLevelInput");
  const rampCheckbox = document.getElementById("rampCheckbox");
  const lengthMatchedCheckbox = document.getElementById("lengthMatchedCheckbox");
  const duckVocalsCheckbox = document.getElementById("duckVocalsCheckbox");
  const scoredCheckbox = document.getElementById("scoredCheckbox");
  const scoredOptionsRow = document.getElementById("scoredOptionsRow");
  const scoredInputSelect = document.getElementById("scoredInputSelect");
  const ntpHelpSlider = document.getElementById("ntpHelpSlider");
  const ntpInputSelect = document.getElementById("ntpInputSelect");
  const reviewSourceSelect = document.getElementById("reviewSourceSelect");

  // Slider and the "enter the percent directly" number input always show
  // the same value -- either one can drive it.
  hintLevelSlider.addEventListener("input", () => {
    hintLevelInput.value = hintLevelSlider.value;
  });
  hintLevelInput.addEventListener("input", () => {
    const clamped = Math.min(100, Math.max(0, Number(hintLevelInput.value) || 0));
    hintLevelSlider.value = String(clamped);
  });

  function updateScoredOptionsVisibility() {
    scoredOptionsRow.hidden = !scoredCheckbox.checked;
  }

  /**
   * Sets every Karaoke Mode control from the active playlist's
   * studyOptions (falling back to defaultStudyOptions() for a record that
   * predates this field -- pre-release, no migration, see AI_TODO.md's own
   * note on this). scoredInput auto-detects by browser capability (voice
   * where supported, keyboard otherwise) only when the playlist has never
   * had an explicit choice recorded (`scoredInput` still null) -- once a
   * Pathfinder picks one, it's a per-playlist choice like everything else
   * here, not re-guessed on every load.
   */
  function syncStudyOptionsFromActivePlaylist() {
    const record = findPlaylist(playlists, activePlaylistId);
    const options = record.studyOptions ?? defaultStudyOptions();
    hintLevelSlider.value = String(options.blankPercent);
    hintLevelInput.value = String(options.blankPercent);
    rampCheckbox.checked = options.rampOnRepeat;
    lengthMatchedCheckbox.checked = options.lengthMatched;
    duckVocalsCheckbox.checked = options.duckVocals ?? false;
    scoredCheckbox.checked = options.scored;
    scoredInputSelect.value = options.scoredInput ?? (isSingAlongSupported() ? "singalong" : "typeahead");
    updateScoredOptionsVisibility();
    ntpHelpSlider.value = String(options.nameThatPassageHelp ?? 100);
    ntpInputSelect.value = options.nameThatPassageInput ?? (isSingAlongSupported() ? "voice" : "typed");
  }
  syncStudyOptionsFromActivePlaylist();

  for (const control of [
    hintLevelSlider,
    hintLevelInput,
    rampCheckbox,
    lengthMatchedCheckbox,
    duckVocalsCheckbox,
    scoredInputSelect,
    ntpHelpSlider,
    ntpInputSelect,
  ]) {
    control.addEventListener("change", () => persistActivePlaylist());
  }
  scoredCheckbox.addEventListener("change", () => {
    updateScoredOptionsVisibility();
    persistActivePlaylist();
  });

  // --- Karaoke Controls (AI_TODO.md item 4): pitch/speed/key-lock/count-in/
  // reverb, resolved through three tiers (app default -> playlist override
  // -> section/"song" override). The scope selector below decides which
  // tier a slider change writes to; every control always *displays* the
  // fully-resolved value for whichever tier is currently selected, so a
  // Pathfinder switching scopes sees a coherent live preview rather than
  // raw, possibly-unset override fields. ---
  const controlsScopeSelect = document.getElementById("controlsScopeSelect");
  const controlsScopeSongSelect = document.getElementById("controlsScopeSongSelect");
  const clearControlsOverrideBtn = document.getElementById("clearControlsOverrideBtn");
  const pitchSlider = document.getElementById("pitchSlider");
  const pitchValueLabel = document.getElementById("pitchValueLabel");
  const rateSlider = document.getElementById("rateSlider");
  const rateValueLabel = document.getElementById("rateValueLabel");
  const keyLockCheckbox = document.getElementById("keyLockCheckbox");
  const countInSlider = document.getElementById("countInSlider");
  const countInValueLabel = document.getElementById("countInValueLabel");
  const reverbSlider = document.getElementById("reverbSlider");
  const reverbValueLabel = document.getElementById("reverbValueLabel");

  // Study panel text size (AI_TODO.md item 9) -- its own persisted value,
  // independent of the three-tier Karaoke Controls above and of Sleep
  // Mode's own slider (wired where mountSleepMode is called below).
  const studyTextSizeSlider = document.getElementById("studyTextSizeSlider");
  const studyTextSizeValueLabel = document.getElementById("studyTextSizeValueLabel");
  const karaokeViewEl = document.getElementById("karaokeView");
  let karaokeTextScale = { study: 1, sleep: 1, ...state.karaokeTextScale };
  studyTextSizeSlider.value = String(karaokeTextScale.study);
  studyTextSizeValueLabel.textContent = `${Math.round(karaokeTextScale.study * 100)}%`;
  karaokeViewEl.style.setProperty("--karaoke-font-scale", String(karaokeTextScale.study));
  studyTextSizeSlider.addEventListener("input", () => {
    const scale = Number(studyTextSizeSlider.value);
    karaokeTextScale = { ...karaokeTextScale, study: scale };
    studyTextSizeValueLabel.textContent = `${Math.round(scale * 100)}%`;
    karaokeViewEl.style.setProperty("--karaoke-font-scale", String(scale));
    persistFullState();
  });

  function renderControlsScopeSongOptions() {
    const previous = controlsScopeSongSelect.value;
    controlsScopeSongSelect.innerHTML = "";
    for (const key of selected) {
      const section = findSection(manifest, key);
      if (!section) continue;
      const option = document.createElement("option");
      option.value = key;
      option.textContent = passageLabel(section);
      controlsScopeSongSelect.appendChild(option);
    }
    if ([...controlsScopeSongSelect.options].some((o) => o.value === previous)) controlsScopeSongSelect.value = previous;
  }

  function songKeyForScope() {
    return controlsScopeSelect.value === "song" ? controlsScopeSongSelect.value || null : null;
  }

  /** The fully-resolved settings for whichever tier the scope selector currently points at -- what the sliders should display right now. */
  function resolvedControlsForDisplay() {
    const record = findPlaylist(playlists, activePlaylistId);
    const scope = controlsScopeSelect.value;
    if (scope === "app") return { ...appKaraokeControls };
    if (scope === "playlist") return resolveKaraokeControls(appKaraokeControls, record.karaokeControlsOverride, null);
    const songKey = songKeyForScope();
    const sectionOverride = songKey ? record.karaokeControlsSectionOverrides?.[songKey] : null;
    return resolveKaraokeControls(appKaraokeControls, record.karaokeControlsOverride, sectionOverride);
  }

  function updateControlLabels(resolved) {
    pitchValueLabel.textContent = resolved.pitchSemitones === 0 ? "Normal" : `${resolved.pitchSemitones > 0 ? "+" : ""}${resolved.pitchSemitones} st`;
    rateValueLabel.textContent = `${Math.round(resolved.rate * 100)}%`;
    countInValueLabel.textContent = resolved.countInSeconds === 0 ? "Off" : `${resolved.countInSeconds}s`;
    reverbValueLabel.textContent = resolved.reverbAmount === 0 ? "Off" : `${Math.round(resolved.reverbAmount * 100)}%`;
  }

  function updateClearOverrideButton() {
    const record = findPlaylist(playlists, activePlaylistId);
    const scope = controlsScopeSelect.value;
    let hasOverride = false;
    if (scope === "playlist") hasOverride = Object.keys(record.karaokeControlsOverride ?? {}).length > 0;
    else if (scope === "song") {
      const songKey = songKeyForScope();
      hasOverride = !!songKey && Object.keys(record.karaokeControlsSectionOverrides?.[songKey] ?? {}).length > 0;
    }
    clearControlsOverrideBtn.hidden = scope === "app";
    clearControlsOverrideBtn.disabled = !hasOverride;
  }

  function syncControlsPanelFromState() {
    const resolved = resolvedControlsForDisplay();
    pitchSlider.value = String(resolved.pitchSemitones);
    rateSlider.value = String(resolved.rate);
    keyLockCheckbox.checked = resolved.keyLock;
    countInSlider.value = String(resolved.countInSeconds);
    reverbSlider.value = String(resolved.reverbAmount);
    updateControlLabels(resolved);
    updateClearOverrideButton();
  }

  /** Writes one field's new value into whichever tier the scope selector currently points at -- app default (a direct edit), or a *partial* update to the playlist/section override object (only this field, leaving whatever else that tier has already customized untouched). */
  function writeControlChange(field, value) {
    const scope = controlsScopeSelect.value;
    const clamped = clampKaraokeControls({ [field]: value });
    if (scope === "app") {
      appKaraokeControls = { ...appKaraokeControls, ...clamped };
    } else if (scope === "playlist") {
      const record = findPlaylist(playlists, activePlaylistId);
      record.karaokeControlsOverride = { ...(record.karaokeControlsOverride ?? {}), ...clamped };
    } else {
      const songKey = songKeyForScope();
      if (!songKey) return;
      const record = findPlaylist(playlists, activePlaylistId);
      record.karaokeControlsSectionOverrides = {
        ...(record.karaokeControlsSectionOverrides ?? {}),
        [songKey]: { ...(record.karaokeControlsSectionOverrides?.[songKey] ?? {}), ...clamped },
      };
    }
    persistFullState();
    syncControlsPanelFromState();
  }

  controlsScopeSelect.addEventListener("change", () => {
    controlsScopeSongSelect.hidden = controlsScopeSelect.value !== "song";
    syncControlsPanelFromState();
  });
  controlsScopeSongSelect.addEventListener("change", () => syncControlsPanelFromState());

  clearControlsOverrideBtn.addEventListener("click", () => {
    const scope = controlsScopeSelect.value;
    const record = findPlaylist(playlists, activePlaylistId);
    if (scope === "playlist") {
      record.karaokeControlsOverride = {};
    } else if (scope === "song") {
      const songKey = songKeyForScope();
      if (songKey) {
        const rest = { ...(record.karaokeControlsSectionOverrides ?? {}) };
        delete rest[songKey];
        record.karaokeControlsSectionOverrides = rest;
      }
    }
    persistFullState();
    syncControlsPanelFromState();
  });

  pitchSlider.addEventListener("input", () => writeControlChange("pitchSemitones", Number(pitchSlider.value)));
  rateSlider.addEventListener("input", () => writeControlChange("rate", Number(rateSlider.value)));
  keyLockCheckbox.addEventListener("change", () => writeControlChange("keyLock", keyLockCheckbox.checked));
  countInSlider.addEventListener("input", () => writeControlChange("countInSeconds", Number(countInSlider.value)));
  reverbSlider.addEventListener("input", () => writeControlChange("reverbAmount", Number(reverbSlider.value)));

  renderControlsScopeSongOptions();
  syncControlsPanelFromState();

  // Live-resolves per block's actual section -- shared across every study
  // mode and Sleep Mode alike, since they all drive the same `engine`
  // instance (this is also how Sleep Mode "inherits" these settings per
  // AI_TODO.md's decision, with no extra wiring needed there).
  engine.setKaraokeControlsResolver((sectionKey) => {
    const record = findPlaylist(playlists, activePlaylistId);
    return resolveKaraokeControls(appKaraokeControls, record.karaokeControlsOverride, record.karaokeControlsSectionOverrides?.[sectionKey]);
  });

  mountAbLoopPicker(document.getElementById("abLoopPicker"), engine, manifest, {
    clearLoopBtn: document.getElementById("clearLoopBtn"),
  });

  /**
   * Shared tail end of both "Start Studying" and "Review Mode" -- everything
   * from a built `program` onward (mode selection, engine wiring, player
   * controls) is identical between them; only how `program`/`displayMix`/
   * `verseFilter` get built up front differs (one playlist's own selection
   * vs. a merged cross-playlist set, see the Review Mode handler below).
   * `displayMix` only drives cosmetic per-word style tinting in the word
   * stream (word-stream.js's colorsForSection) -- it's never used to pick
   * actual audio, that's already baked into `program`'s blocks.
   */
  function launchKaraokeStudy(program, displayMix, verseFilter) {
    renderFallbackNote(manifest, program.fallbacks);

    unmountStudyView?.();
    unmountPlayerControls?.();
    unmountStudyView = null;
    unmountPlayerControls = null;

    const karaokeView = document.getElementById("karaokeView");
    const playerControls = document.getElementById("playerControls");

    if (scoredCheckbox.checked && scoredInputSelect.value === "typeahead") {
      playerControls.innerHTML = "";
      unmountStudyView = mountTypeAhead(karaokeView, program, () => lengthMatchedCheckbox.checked, logAttempt);
      return;
    }

    engine.loadProgram(program);

    if (scoredCheckbox.checked) {
      unmountStudyView = mountSingAlong(karaokeView, engine, manifest, displayMix, verseFilter, logAttempt);
    } else {
      const getUnscoredOptions = () => ({
        blankFraction: Math.min(100, Math.max(0, Number(hintLevelInput.value) || 0)) / 100,
        rampOnRepeat: rampCheckbox.checked,
        lengthMatched: lengthMatchedCheckbox.checked,
        duckVocals: duckVocalsCheckbox.checked,
      });
      unmountStudyView = mountUnscored(karaokeView, engine, manifest, displayMix, getUnscoredOptions, verseFilter, logAttempt);
    }
    unmountPlayerControls = mountPlayerControls(playerControls, engine, { styleLabelFor });
    engine.play();
  }

  document.getElementById("startKaraokeBtn").addEventListener("click", () => {
    if (selected.size === 0) {
      renderFallbackNote(manifest, []);
      alert("Select at least one chapter or verse range first.");
      return;
    }
    const verseFilter = buildVerseFilter(selected, verseSelections);
    const program = buildProgram(manifest, mix, selected, verseFilter);
    launchKaraokeStudy(program, mix, verseFilter);
  });

  /**
   * Cross-passage review/drill (AI_TODO.md item 8): a shuffled Karaoke Mode
   * program pulled from every playlist's own selection (or, narrowed by
   * `reviewSourceSelect`, only sections with logged practice history), not
   * just the active playlist. Each section keeps its own owning playlist's
   * mix -- whatever genre customization the Pathfinder already did for it --
   * rather than flattening everything to the active playlist's style.
   *
   * "Owning" playlist for a section = the first one (in playlists' stored
   * order) that has it selected, so a section selected in more than one
   * playlist is only included once, not duplicated per playlist.
   */
  document.getElementById("startReviewBtn").addEventListener("click", () => {
    persistActivePlaylist(); // the active playlist's record needs to reflect any just-made changes before scanning across playlists

    const onlyHistory = reviewSourceSelect.value === "history";
    const claimed = new Set();
    const blocks = [];
    const fallbacks = [];
    const displayMix = { defaultStyleId: mix.defaultStyleId, sections: new Map() };
    const verseFilter = new Map();

    for (const record of playlists) {
      const keys = record.selectedSectionKeys.filter(
        (k) => !claimed.has(k) && (!onlyHistory || (practiceHistory[k]?.length ?? 0) > 0)
      );
      if (keys.length === 0) continue;
      keys.forEach((k) => claimed.add(k));

      const recordMix = record.mix ? fromSerializable(record.mix, manifest) : createMix(record.activeStyle || manifest.styles[0].id);
      const recordVerseFilter = buildVerseFilter(new Set(keys), createVerseSelections(record.verseSelections));
      const recordProgram = buildProgram(manifest, recordMix, keys, recordVerseFilter);
      blocks.push(...recordProgram.blocks);
      fallbacks.push(...recordProgram.fallbacks);
      for (const k of keys) {
        displayMix.sections.set(k, recordMix.sections.get(k));
        if (recordVerseFilter.has(k)) verseFilter.set(k, recordVerseFilter.get(k));
      }
    }

    if (blocks.length === 0) {
      alert(
        onlyHistory
          ? 'No passages with practice history yet — study something first, or switch to "Every selected passage."'
          : "No passages selected in any playlist yet."
      );
      return;
    }

    launchKaraokeStudy(shuffleBySection({ blocks, fallbacks }), displayMix, verseFilter);
  });

  document.getElementById("sleepModeBtn").addEventListener("click", () => {
    if (selected.size === 0) {
      alert("Select at least one chapter or verse range first.");
      return;
    }
    const verseFilter = buildVerseFilter(selected, verseSelections);
    const program = buildProgram(manifest, mix, selected, verseFilter);
    unmountStudyView?.();
    unmountPlayerControls?.();
    unmountStudyView = null;
    unmountPlayerControls = null;
    document.getElementById("karaokeView").innerHTML = "";
    document.getElementById("playerControls").innerHTML = "";
    const record = findPlaylist(playlists, activePlaylistId);
    const { instrumentalVolume = 1, vocalVolume = 1 } = record.studyOptions ?? defaultStudyOptions();
    mountSleepMode(engine, program, manifest, mix, {
      styleLabelFor,
      verseFilter,
      instrumentalVolume,
      vocalVolume,
      onVolumesChange: (volumes) => {
        record.studyOptions = { ...(record.studyOptions ?? defaultStudyOptions()), ...volumes };
        persistFullState();
      },
      textScale: karaokeTextScale.sleep,
      onTextScaleChange: (scale) => {
        karaokeTextScale = { ...karaokeTextScale, sleep: scale };
        persistFullState();
      },
    });
  });

  document.getElementById("startNameThatPassageBtn").addEventListener("click", () => {
    if (selected.size === 0) {
      alert("Select at least one chapter or verse range first.");
      return;
    }
    const verseFilter = buildVerseFilter(selected, verseSelections);
    unmountStudyView?.();
    unmountPlayerControls?.();
    unmountStudyView = null;
    unmountPlayerControls = null;
    const karaokeView = document.getElementById("karaokeView");
    document.getElementById("playerControls").innerHTML = "";
    const getNtpOptions = () => ({
      helpLevel: Math.min(100, Math.max(0, Number(ntpHelpSlider.value) || 0)) / 100,
      inputMethod: ntpInputSelect.value,
    });
    unmountStudyView = mountNameThatPassage(
      karaokeView,
      engine,
      manifest,
      mix,
      selected,
      verseFilter,
      getNtpOptions,
      logAttempt,
      (fallbacks) => renderFallbackNote(manifest, fallbacks)
    );
  });
}

initGate({
  onUnlocked(manifest, manifestUrl) {
    initSelectionUi(manifest, manifestUrl);
  },
});
