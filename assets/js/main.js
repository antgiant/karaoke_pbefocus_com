import { buildBookTree, formatDuration, formatVerseRanges } from "./library.js";
import { churchFitText } from "./style-fit.js";
import { initGate } from "./gate.js";
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
import { createMix, fromSerializable, setDefaultStyle, setDefaultTakeRank, syncMixToSelection, toSerializable } from "./mix.js";
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
import { buildProgram } from "./program-builder.js";
import { createPlaybackEngine } from "./playback-engine.js";
import { mountUnscored } from "./study-modes/unscored.js";
import { mountTypeAhead } from "./study-modes/type-ahead.js";
import { mountSingAlong, isSingAlongSupported } from "./study-modes/sing-along.js";
import { mountSleepMode } from "./sleep-mode.js";
import { mountPlayerControls } from "./player-controls.js";

/** A shared-playlist payload -> a fresh playlist record (no id assigned by the payload; the importer always gets a new one, same as any other new playlist). */
function recordFromSharedPayload(payload) {
  const shared = deserializePlaylistFromShare(payload);
  const record = createPlaylistRecord(shared.name);
  record.selectedSectionKeys = shared.selectedSectionKeys;
  record.verseSelections = shared.verseSelections;
  record.activeStyle = shared.activeStyle;
  record.mix = shared.mix;
  if (shared.studyOptions) record.studyOptions = shared.studyOptions;
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

function renderBookTree(manifest, selected, verseSelections, onChange) {
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

      const versePicker = renderVersePicker(chapter, selected, verseSelections, onChange);
      if (versePicker) item.appendChild(versePicker);

      list.appendChild(item);
    }
    details.appendChild(list);
    container.appendChild(details);
  }
}

function renderStyleOptions(manifest, selectedStyleId) {
  const select = document.getElementById("styleSelect");
  select.innerHTML = "";
  for (const style of manifest.styles) {
    const option = document.createElement("option");
    option.value = style.id;
    // "<vibe emoji> <label> — <church-fit emoji + phrase>" -- self-contained
    // plain text (see AI_TODO.md item 7): a native <option> can't carry a
    // separate tooltip, so both pieces of signal have to live in the text
    // itself. Degrades to just the label if a style has no emoji/churchFit
    // (e.g. a manifest built before this field existed).
    const vibe = style.emoji ? `${style.emoji} ` : "";
    const fit = style.churchFit ? ` — ${churchFitText(style.churchFit)}` : "";
    option.textContent = `${vibe}${style.label}${fit}`;
    select.appendChild(option);
  }
  select.value = selectedStyleId;
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
  const sameLibrary = state.manifestUrl === manifestUrl;
  const playlists = sameLibrary && state.playlists.length ? state.playlists : [createPlaylistRecord("My Playlist")];
  let activePlaylistId =
    sameLibrary && findPlaylist(playlists, state.activePlaylistId) ? state.activePlaylistId : playlists[0].id;

  const importedRecord = tryImportPlaylistFromUrl();
  if (importedRecord) {
    playlists.push(importedRecord);
    activePlaylistId = importedRecord.id;
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
    };
    saveState({ schemaVersion: SCHEMA_VERSION, manifestUrl, playlists, activePlaylistId });
  }

  const styleSelect = renderStyleOptions(manifest, mix.defaultStyleId);
  const defaultTakeCheckbox = document.getElementById("defaultTakeCheckbox");
  defaultTakeCheckbox.checked = (mix.defaultTakeRank ?? 0) > 0;
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
    renderBookTree(manifest, selected, verseSelections, rerender);
    renderSummary(selected, manifest, verseSelections);
    renderMixEditorIfOpen();
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
    persistActivePlaylist();
    renderMixEditorIfOpen();
  });

  defaultTakeCheckbox.addEventListener("change", () => {
    setDefaultTakeRank(mix, defaultTakeCheckbox.checked ? 1 : 0);
    persistActivePlaylist();
    renderMixEditorIfOpen(); // section-level take controls with no override of their own follow this default
  });

  renderBookTree(manifest, selected, verseSelections, rerender);
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
    defaultTakeCheckbox.checked = (mix.defaultTakeRank ?? 0) > 0;
    syncStudyOptionsFromActivePlaylist();
    renderPlaylistSelect();
    renderBookTree(manifest, selected, verseSelections, rerender);
    renderSummary(selected, manifest, verseSelections);
    renderMixEditorIfOpen();
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
    defaultTakeCheckbox.checked = (mix.defaultTakeRank ?? 0) > 0;
    syncStudyOptionsFromActivePlaylist();
    renderPlaylistSelect();
    renderBookTree(manifest, selected, verseSelections, rerender);
    renderSummary(selected, manifest, verseSelections);
    renderMixEditorIfOpen();
    persistActivePlaylist();
  });

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
      manifestUrl,
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
    if (shareIncludeLibraryCheckbox.checked && manifestUrl) url.searchParams.set(MANIFEST_URL_PARAM, manifestUrl);
    url.searchParams.set(PLAYLIST_URL_PARAM, encodePlaylistPayload(payload));
    const link = url.toString();
    shareLinkInput.value = link;
    shareQrContainer.innerHTML = renderQrCodeSvg(link);
  }

  document.getElementById("sharePlaylistBtn").addEventListener("click", () => {
    shareDialogPlaylistName.textContent = findPlaylist(playlists, activePlaylistId).name;
    shareIncludeLibraryCheckbox.checked = false;
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

  const engine = createPlaybackEngine();
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
  const scoredCheckbox = document.getElementById("scoredCheckbox");
  const scoredOptionsRow = document.getElementById("scoredOptionsRow");
  const scoredInputSelect = document.getElementById("scoredInputSelect");

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
    scoredCheckbox.checked = options.scored;
    scoredInputSelect.value = options.scoredInput ?? (isSingAlongSupported() ? "singalong" : "typeahead");
    updateScoredOptionsVisibility();
  }
  syncStudyOptionsFromActivePlaylist();

  for (const control of [hintLevelSlider, hintLevelInput, rampCheckbox, lengthMatchedCheckbox, scoredInputSelect]) {
    control.addEventListener("change", () => persistActivePlaylist());
  }
  scoredCheckbox.addEventListener("change", () => {
    updateScoredOptionsVisibility();
    persistActivePlaylist();
  });

  document.getElementById("startKaraokeBtn").addEventListener("click", () => {
    if (selected.size === 0) {
      renderFallbackNote(manifest, []);
      alert("Select at least one chapter or verse range first.");
      return;
    }
    const verseFilter = buildVerseFilter(selected, verseSelections);
    const program = buildProgram(manifest, mix, selected, verseFilter);
    renderFallbackNote(manifest, program.fallbacks);

    unmountStudyView?.();
    unmountPlayerControls?.();
    unmountStudyView = null;
    unmountPlayerControls = null;

    const karaokeView = document.getElementById("karaokeView");
    const playerControls = document.getElementById("playerControls");

    if (scoredCheckbox.checked && scoredInputSelect.value === "typeahead") {
      playerControls.innerHTML = "";
      unmountStudyView = mountTypeAhead(karaokeView, program, () => lengthMatchedCheckbox.checked);
      return;
    }

    engine.loadProgram(program);

    if (scoredCheckbox.checked) {
      unmountStudyView = mountSingAlong(karaokeView, engine, manifest, mix, verseFilter);
    } else {
      const getUnscoredOptions = () => ({
        blankFraction: Math.min(100, Math.max(0, Number(hintLevelInput.value) || 0)) / 100,
        rampOnRepeat: rampCheckbox.checked,
        lengthMatched: lengthMatchedCheckbox.checked,
      });
      unmountStudyView = mountUnscored(karaokeView, engine, manifest, mix, getUnscoredOptions, verseFilter);
    }
    unmountPlayerControls = mountPlayerControls(playerControls, engine, { styleLabelFor });
    engine.play();
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
    mountSleepMode(engine, program, manifest, mix, { styleLabelFor, verseFilter });
  });
}

initGate({
  onUnlocked(manifest, manifestUrl) {
    initSelectionUi(manifest, manifestUrl);
  },
});
