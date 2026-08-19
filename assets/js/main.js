import { buildBookTree, formatDuration } from "./library.js";
import { initGate } from "./gate.js";
import { loadState, saveState } from "./storage.js";
import {
  bookSelectionState,
  createSelectionState,
  setBookSelected,
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
import { mountPlayerControls } from "./player-controls.js";

function persistAppState(manifestUrl, selected, mix) {
  const state = loadState();
  saveState({
    ...state,
    manifestUrl,
    selectedSectionKeys: [...selected],
    activeStyle: mix.defaultStyleId,
    mix: toSerializable(mix),
  });
}

function renderSummary(selected, manifest) {
  const { sectionCount, wordCount, estimatedSeconds } = summarize(selected, manifest);
  document.getElementById("summarySectionCount").textContent = sectionCount;
  document.getElementById("summaryWordCount").textContent = wordCount.toLocaleString();
  document.getElementById("summaryDuration").textContent = `~${formatDuration(estimatedSeconds)}`;
}

const openBooks = new Set();

function renderBookTree(manifest, selected, onChange) {
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
      list.appendChild(label);
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
  note.textContent =
    "Some of your mix isn't available as chosen, so it'll play in a different style instead: " +
    fallbacks.map((f) => `${f.label} (using ${labelFor(f.usedStyle)})`).join("; ") + ".";
  note.hidden = false;
}

function initSelectionUi(manifest, manifestUrl) {
  const state = loadState();
  const sameLibrary = state.manifestUrl === manifestUrl;
  const selected = createSelectionState(sameLibrary ? state.selectedSectionKeys : []);

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
      persistAppState(manifestUrl, selected, mix);
    });
  }

  function rerender() {
    syncMixToSelection(mix, manifest, selected);
    persistAppState(manifestUrl, selected, mix);
    renderBookTree(manifest, selected, rerender);
    renderSummary(selected, manifest);
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
    persistAppState(manifestUrl, selected, mix);
    renderMixEditorIfOpen();
  });

  renderBookTree(manifest, selected, rerender);
  renderSummary(selected, manifest);

  const engine = createPlaybackEngine();
  const styleLabelFor = (id) => manifest.styles.find((s) => s.id === id)?.label ?? id;
  let unmountStudyView = null;
  let unmountPlayerControls = null;

  const modeSelect = document.getElementById("modeSelect");
  const hintLevelSelect = document.getElementById("hintLevelSelect");
  const hintLevelLabel = document.getElementById("hintLevelLabel");
  modeSelect.addEventListener("change", () => {
    const showHint = modeSelect.value === "invisible";
    hintLevelSelect.hidden = !showHint;
    hintLevelLabel.hidden = !showHint;
  });

  document.getElementById("startKaraokeBtn").addEventListener("click", () => {
    if (selected.size === 0) {
      renderFallbackNote(manifest, []);
      alert("Select at least one chapter or verse range first.");
      return;
    }
    const program = buildProgram(manifest, mix, selected);
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
      unmountStudyView = mountTypeAhead(karaokeView, program);
      return;
    }

    engine.loadProgram(program);
    if (mode === "disappearing") unmountStudyView = mountDisappearingWord(karaokeView, engine);
    else if (mode === "invisible") unmountStudyView = mountInvisibleWord(karaokeView, engine, () => Number(hintLevelSelect.value));
    else if (mode === "blackout") unmountStudyView = mountBlackoutRamp(karaokeView, engine);
    else if (mode === "singalong") unmountStudyView = mountSingAlong(karaokeView, engine);
    else unmountStudyView = mountKaraoke(karaokeView, engine);
    unmountPlayerControls = mountPlayerControls(playerControls, engine, { styleLabelFor });
    engine.play();
  });
}

initGate({
  onUnlocked(manifest, manifestUrl) {
    initSelectionUi(manifest, manifestUrl);
  },
});
