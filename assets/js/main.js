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

function persistSelection(manifestUrl, selected) {
  const state = loadState();
  saveState({ ...state, manifestUrl, selectedSectionKeys: [...selected] });
}

function renderSummary(selected, manifest) {
  const { sectionCount, wordCount, estimatedSeconds } = summarize(selected, manifest);
  document.getElementById("summarySectionCount").textContent = sectionCount;
  document.getElementById("summaryWordCount").textContent = wordCount.toLocaleString();
  document.getElementById("summaryDuration").textContent = `~${formatDuration(estimatedSeconds)}`;
}

function renderBookTree(manifest, selected, manifestUrl) {
  const tree = buildBookTree(manifest);
  const container = document.getElementById("bookTree");
  container.innerHTML = "";

  for (const { book, chapters } of tree) {
    const details = document.createElement("details");
    details.className = "book-group";
    details.open = false;

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
      persistSelection(manifestUrl, selected);
      renderBookTree(manifest, selected, manifestUrl);
      renderSummary(selected, manifest);
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
        persistSelection(manifestUrl, selected);
        renderBookTree(manifest, selected, manifestUrl);
        renderSummary(selected, manifest);
      });
      label.appendChild(checkbox);
      label.appendChild(document.createTextNode(chapter.label));
      list.appendChild(label);
    }
    details.appendChild(list);
    container.appendChild(details);
  }
}

function initSelectionUi(manifest, manifestUrl) {
  const state = loadState();
  const relevantKeys = state.manifestUrl === manifestUrl ? state.selectedSectionKeys : [];
  const selected = createSelectionState(relevantKeys);

  document.getElementById("selectAllBtn").addEventListener("click", () => {
    for (const { chapters } of buildBookTree(manifest)) setBookSelected(selected, chapters, true);
    persistSelection(manifestUrl, selected);
    renderBookTree(manifest, selected, manifestUrl);
    renderSummary(selected, manifest);
  });
  document.getElementById("selectNoneBtn").addEventListener("click", () => {
    selected.clear();
    persistSelection(manifestUrl, selected);
    renderBookTree(manifest, selected, manifestUrl);
    renderSummary(selected, manifest);
  });

  renderBookTree(manifest, selected, manifestUrl);
  renderSummary(selected, manifest);
}

initGate({
  onUnlocked(manifest, manifestUrl) {
    initSelectionUi(manifest, manifestUrl);
  },
});
