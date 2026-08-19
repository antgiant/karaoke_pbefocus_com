import { buildBookTree, formatDuration, formatVerseRanges } from "./library.js";
import { initGate } from "./gate.js";
import { loadState, saveState } from "./storage.js";
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
import { mountMixEditor } from "./mix-editor.js";
import { buildProgram } from "./program-builder.js";
import { createPlaybackEngine } from "./playback-engine.js";
import { mountKaraoke } from "./study-modes/karaoke.js";
import { mountDisappearingWord } from "./study-modes/disappearing-word.js";
import { mountInvisibleWord } from "./study-modes/invisible-word.js";
import { mountBlackoutRamp } from "./study-modes/blackout-ramp.js";
import { mountTypeAhead } from "./study-modes/type-ahead.js";
import { mountSingAlong } from "./study-modes/sing-along.js";
import { mountSleepMode } from "./sleep-mode.js";
import { mountPlayerControls } from "./player-controls.js";

function persistAppState(manifestUrl, selected, verseSelections, mix) {
  const state = loadState();
  saveState({
    ...state,
    manifestUrl,
    selectedSectionKeys: [...selected],
    verseSelections: serializeVerseSelections(verseSelections),
    activeStyle: mix.defaultStyleId,
    mix: toSerializable(mix),
  });
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
    option.textContent = style.label;
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
  const selected = createSelectionState(sameLibrary ? state.selectedSectionKeys : []);
  const verseSelections = createVerseSelections(sameLibrary ? state.verseSelections : {});

  const initialStyleId = (sameLibrary && state.activeStyle) || manifest.styles[0].id;
  const mix = sameLibrary && state.mix ? fromSerializable(state.mix, manifest) : createMix(initialStyleId);
  syncMixToSelection(mix, manifest, selected);

  const styleSelect = renderStyleOptions(manifest, mix.defaultStyleId);
  const mixEditorContainer = document.getElementById("mixEditor");
  const toggleMixEditorBtn = document.getElementById("toggleMixEditorBtn");
  let mixEditorHandle = null;

  function renderMixEditorIfOpen() {
    mixEditorHandle?.unmount();
    mixEditorHandle = null;
    if (mixEditorContainer.hidden) return;
    mixEditorHandle = mountMixEditor(mixEditorContainer, manifest, mix, selected, () => {
      persistAppState(manifestUrl, selected, verseSelections, mix);
    });
  }

  function rerender() {
    syncMixToSelection(mix, manifest, selected);
    persistAppState(manifestUrl, selected, verseSelections, mix);
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
    persistAppState(manifestUrl, selected, verseSelections, mix);
    renderMixEditorIfOpen();
  });

  renderBookTree(manifest, selected, verseSelections, rerender);
  renderSummary(selected, manifest, verseSelections);

  const engine = createPlaybackEngine();
  const styleLabelFor = (id) => manifest.styles.find((s) => s.id === id)?.label ?? id;
  let unmountStudyView = null;
  let unmountPlayerControls = null;

  const modeSelect = document.getElementById("modeSelect");
  const hintLevelInput = document.getElementById("hintLevelInput");
  const hintLevelLabel = document.getElementById("hintLevelLabel");
  const hintLevelPercentSign = document.getElementById("hintLevelPercentSign");
  const lookaheadSelect = document.getElementById("lookaheadSelect");
  const lookaheadLabel = document.getElementById("lookaheadLabel");
  const lengthMatchedRow = document.getElementById("lengthMatchedRow");
  const lengthMatchedCheckbox = document.getElementById("lengthMatchedCheckbox");
  modeSelect.addEventListener("change", () => {
    const showHint = modeSelect.value === "invisible";
    hintLevelInput.hidden = !showHint;
    hintLevelLabel.hidden = !showHint;
    hintLevelPercentSign.hidden = !showHint;
    const showLookahead = modeSelect.value === "disappearing";
    lookaheadSelect.hidden = !showLookahead;
    lookaheadLabel.hidden = !showLookahead;
    lengthMatchedRow.hidden = !["invisible", "blackout", "typeahead"].includes(modeSelect.value);
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
    const mode = modeSelect.value;

    if (mode === "typeahead") {
      playerControls.innerHTML = "";
      unmountStudyView = mountTypeAhead(karaokeView, program, () => lengthMatchedCheckbox.checked);
      return;
    }

    engine.loadProgram(program);
    const getLengthMatched = () => lengthMatchedCheckbox.checked;
    if (mode === "disappearing")
      unmountStudyView = mountDisappearingWord(karaokeView, engine, manifest, mix, () => Number(lookaheadSelect.value), verseFilter);
    else if (mode === "invisible")
      unmountStudyView = mountInvisibleWord(
        karaokeView, engine, manifest, mix,
        () => Math.min(100, Math.max(0, Number(hintLevelInput.value) || 0)) / 100,
        getLengthMatched,
        verseFilter
      );
    else if (mode === "blackout") unmountStudyView = mountBlackoutRamp(karaokeView, engine, manifest, mix, getLengthMatched, verseFilter);
    else if (mode === "singalong") unmountStudyView = mountSingAlong(karaokeView, engine, manifest, mix, verseFilter);
    else unmountStudyView = mountKaraoke(karaokeView, engine, manifest, mix, verseFilter);
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
