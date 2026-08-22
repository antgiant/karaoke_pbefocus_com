import { colorForStyle } from "./constants.js";
import { canonicalWords, listTakes, orderedSections, passageLabel, sectionKey } from "./library.js";
import { makePaintId, maxTakeCount, paintRange, parsePaintId } from "./mix.js";
import { churchFitDescription, churchFitEmoji } from "./style-fit.js";

// Sections start expanded (immediately usable for painting); this tracks
// which ones the Pathfinder has explicitly collapsed, persisted across
// remounts (main.js unmounts/remounts this editor on every selection
// change) so collapsing one while you keep painting doesn't re-expand it.
const collapsedSections = new Set();

// How long a take-preview clip plays before auto-stopping (AI_TODO.md item
// 1's "hear a take before picking it" requirement) -- long enough to get a
// feel for the recording's character, short enough to stay a quick compare
// rather than a full listen.
const PREVIEW_SECONDS = 6;

/**
 * The genre "paint" UI: one word-chip strip per selected section (verse
 * numbers, chapter title, each verse its own line -- same Bible-style
 * layout as the study/playback views), a style palette above it. Pick a
 * style, then either tap a single word or drag across a range to paint it
 * -- built on Pointer Events (not the HTML5 Drag-and-Drop API) so the exact
 * same code path drives mouse and touch.
 *
 * Takes are painted the same way as any other style (AI_TODO.md item 1) --
 * a style with more than one take (anywhere in the currently-selected
 * sections) gets one palette swatch per take rather than a separate
 * take-selector control layered on top. Each section still gets its own
 * small preview row so the Pathfinder can hear a take before painting it
 * (mix.js's paint-id model doesn't carry audio, only which take a run
 * requests -- previewing needs the section's actual recording).
 *
 * Touch note: chips call releasePointerCapture on pointerdown to opt out of
 * the browser's implicit touch capture, which otherwise pins all pointer
 * events to the chip the drag started on and would make pointerenter on
 * sibling chips never fire during a touch drag.
 */
export function mountMixEditor(container, manifest, mix, selectedKeys, onChange) {
  container.innerHTML = "";
  container.className = "mix-editor";

  let activePaintId = mix.defaultStyleId; // mix.defaultStyleId is always rank 0 (a plain style id) -- see mix.js
  let dragging = false;
  let dragSectionKey = null;
  let dragStart = null;
  let dragEnd = null;

  // Undo/redo history for paint strokes only (AI_TODO.md item 10) -- one
  // entry per committed drag/tap gesture, storing the section's *prior*
  // values for the painted range so an undo can restore them exactly (a run
  // may have spanned several different styles/takes before the stroke).
  // Session-only: this array lives in this closure, so it's gone the moment
  // main.js unmounts/remounts the editor (e.g. on a selection change).
  const undoStack = [];
  const redoStack = [];

  // One shared preview pair, reused for every take-preview button in every
  // section -- only one preview should ever play at once.
  const previewInstrumentalEl = new Audio();
  const previewVocalEl = new Audio();
  let previewStopTimer = null;

  function stopPreview() {
    previewInstrumentalEl.pause();
    previewVocalEl.pause();
    if (previewStopTimer !== null) clearTimeout(previewStopTimer);
    previewStopTimer = null;
  }

  function playPreview(recording) {
    stopPreview();
    previewInstrumentalEl.src = recording.instrumentalUrl;
    previewVocalEl.src = recording.vocalUrl;
    const startTime = recording.words.find((w) => w.verse !== null)?.start ?? 0;
    const startBoth = () => {
      previewInstrumentalEl.currentTime = startTime;
      previewVocalEl.currentTime = startTime;
      previewInstrumentalEl.play().catch(() => {});
      previewVocalEl.play().catch(() => {});
    };
    if (previewInstrumentalEl.readyState >= 1) startBoth();
    else previewInstrumentalEl.addEventListener("loadedmetadata", startBoth, { once: true });
    previewStopTimer = setTimeout(stopPreview, PREVIEW_SECONDS * 1000);
  }

  const palette = document.createElement("div");
  palette.className = "style-palette";
  const swatchButtons = new Map(); // paintId -> button
  for (const style of manifest.styles) {
    const takeCount = maxTakeCount(manifest, mix, style.id);
    for (let rank = 0; rank < takeCount; rank++) {
      const id = makePaintId(style.id, rank);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "style-swatch";
      btn.style.setProperty("--swatch-color", colorForStyle(style.id, manifest.styles));
      // Richer than the main style <select>'s plain-text treatment (see
      // AI_TODO.md item 7) since this is a real button, not a native
      // <option> -- a title tooltip carries the full plain-language
      // description, and the church-fit emoji gets its own badge rather than
      // being folded into the text.
      btn.title = churchFitDescription(style.churchFit);
      const label = style.emoji ? `${style.emoji} ${style.label}` : style.label;
      btn.textContent = takeCount > 1 ? `${label} · Take ${rank + 1}` : label;
      if (style.churchFit) {
        const badge = document.createElement("span");
        badge.className = "style-swatch-fit";
        badge.textContent = churchFitEmoji(style.churchFit);
        badge.setAttribute("aria-hidden", "true"); // decorative -- the same info is in the button's title
        btn.appendChild(badge);
      }
      btn.addEventListener("click", () => setActivePaint(id));
      swatchButtons.set(id, btn);
      palette.appendChild(btn);
    }
  }
  container.appendChild(palette);

  const historyToolbar = document.createElement("div");
  historyToolbar.className = "mix-history-toolbar";
  const undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.className = "btn secondary tiny";
  undoBtn.textContent = "↶ Undo";
  const redoBtn = document.createElement("button");
  redoBtn.type = "button";
  redoBtn.className = "btn secondary tiny";
  redoBtn.textContent = "↷ Redo";
  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);
  historyToolbar.append(undoBtn, redoBtn);
  container.appendChild(historyToolbar);

  function updateHistoryButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }
  updateHistoryButtons();

  /** Restores `entry`'s snapshot into its section, refreshes those chips, and returns the inverse entry (the range's values just before this restore) so the caller can push it onto the opposite stack. */
  function applyHistoryEntry(entry) {
    const assignment = mix.sections.get(entry.sectionKey);
    if (!assignment) return null;
    const { startIndex, endIndex, values } = entry;
    const inverseValues = assignment.slice(startIndex, endIndex + 1);
    for (let i = startIndex; i <= endIndex; i++) assignment[i] = values[i - startIndex];
    sectionEls.get(entry.sectionKey)?.refresh();
    return { sectionKey: entry.sectionKey, startIndex, endIndex, values: inverseValues };
  }

  function undo() {
    const entry = undoStack.pop();
    if (!entry) return;
    const inverse = applyHistoryEntry(entry);
    if (inverse) redoStack.push(inverse);
    updateHistoryButtons();
    onChange();
  }

  function redo() {
    const entry = redoStack.pop();
    if (!entry) return;
    const inverse = applyHistoryEntry(entry);
    if (inverse) undoStack.push(inverse);
    updateHistoryButtons();
    onChange();
  }

  const hint = document.createElement("p");
  hint.className = "mix-editor-hint";
  hint.textContent = "Pick a style above, then tap a word to paint it, or drag across a range.";
  container.appendChild(hint);

  const sectionsEl = document.createElement("div");
  sectionsEl.className = "mix-sections";
  container.appendChild(sectionsEl);

  function setActivePaint(id) {
    activePaintId = id;
    for (const [pid, btn] of swatchButtons) btn.classList.toggle("active", pid === id);
  }
  setActivePaint(activePaintId);

  const sectionEls = new Map();

  function renderSection(section) {
    const key = sectionKey(section);
    const canonical = canonicalWords(section);
    const assignment = mix.sections.get(key);

    const wrap = document.createElement("details");
    wrap.className = "mix-section";
    wrap.open = !collapsedSections.has(key);
    wrap.addEventListener("toggle", () => {
      if (wrap.open) collapsedSections.delete(key);
      else collapsedSections.add(key);
    });

    const summary = document.createElement("summary");
    summary.className = "mix-section-heading";
    summary.textContent = passageLabel(section);
    wrap.appendChild(summary);

    const takePreview = document.createElement("div");
    takePreview.className = "mix-take-preview";
    wrap.appendChild(takePreview);

    /**
     * One "🔊 Preview: [Take 1] [Take 2] ..." row per style actually
     * painted somewhere in this section that has more than one take here
     * (not every style in the manifest -- only ones relevant to what's
     * currently here, and only for the styles/sections where there's
     * actually a choice to make). Lets the Pathfinder hear each candidate
     * take before painting it, rather than choosing blind off an arbitrary
     * ordinal (AI_TODO.md item 1).
     */
    function renderTakePreview() {
      takePreview.innerHTML = "";
      const stylesInUse = [...new Set(assignment.map((id) => parsePaintId(id).styleId))];
      for (const styleId of stylesInUse) {
        const takes = listTakes(section, styleId);
        if (takes.length < 2) continue;

        const styleLabel = manifest.styles.find((s) => s.id === styleId)?.label ?? styleId;
        const row = document.createElement("div");
        row.className = "mix-take-preview-row";
        const label = document.createElement("span");
        label.className = "mix-take-preview-label";
        label.textContent = `🔊 ${styleLabel}:`;
        row.appendChild(label);
        takes.forEach((recording, i) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "btn tiny mix-take-preview-btn";
          btn.textContent = `Take ${i + 1}`;
          btn.addEventListener("click", () => playPreview(recording));
          row.appendChild(btn);
        });
        takePreview.appendChild(row);
      }
    }
    renderTakePreview();

    const strip = document.createElement("div");
    strip.className = "word-strip";
    wrap.appendChild(strip);

    /** Sets a chip's color/tooltip/take-badge from its current paint id -- shared by initial render and refresh() after a repaint. */
    function applyChipStyle(chip, i) {
      const { styleId, takeRank } = parsePaintId(assignment[i]);
      chip.style.setProperty("--chip-color", colorForStyle(styleId, manifest.styles));
      const label = manifest.styles.find((s) => s.id === styleId)?.label ?? styleId;
      chip.title = takeRank > 0 ? `${label} — Take ${takeRank + 1}` : label;
      chip.classList.toggle("word-chip-alt-take", takeRank > 0);
    }

    const chips = [];
    let verseLine = null;
    let openVerse;
    canonical.forEach((w, i) => {
      if (verseLine === null || w.verse !== openVerse) {
        openVerse = w.verse;
        verseLine = document.createElement("div");
        verseLine.className = "mix-verse-line";
        const num = document.createElement("sup");
        num.className = "verse-num";
        num.textContent = String(openVerse);
        verseLine.appendChild(num);
        strip.appendChild(verseLine);
      }

      const chip = document.createElement("span");
      chip.className = "word-chip";
      chip.textContent = w.word;
      chip.dataset.index = String(i);
      applyChipStyle(chip, i);

      chip.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        try {
          chip.releasePointerCapture(event.pointerId);
        } catch {
          // Not all browsers implicitly capture on touch; nothing to release.
        }
        dragging = true;
        dragSectionKey = key;
        dragStart = dragEnd = i;
        paintPreview();
      });
      chip.addEventListener("pointerenter", () => {
        if (dragging && dragSectionKey === key) {
          dragEnd = i;
          paintPreview();
        }
      });
      verseLine.appendChild(chip);
      chips.push(chip);
    });

    function paintPreview() {
      if (dragSectionKey !== key) return;
      const lo = Math.min(dragStart, dragEnd);
      const hi = Math.max(dragStart, dragEnd);
      chips.forEach((chip, i) => chip.classList.toggle("selecting", i >= lo && i <= hi));
    }

    sectionEls.set(key, {
      refresh: () => {
        chips.forEach((chip, i) => applyChipStyle(chip, i));
        renderTakePreview(); // a paint can introduce/remove which styles (and their take counts) are in use here
      },
      clearSelection: () => chips.forEach((chip) => chip.classList.remove("selecting")),
    });

    return wrap;
  }

  function render() {
    sectionsEl.innerHTML = "";
    sectionEls.clear();
    for (const section of orderedSections(manifest)) {
      const key = sectionKey(section);
      if (!selectedKeys.has(key) || !mix.sections.has(key)) continue;
      sectionsEl.appendChild(renderSection(section));
    }
  }

  function commitDrag() {
    if (!dragging || dragSectionKey === null) return;
    const assignment = mix.sections.get(dragSectionKey);
    const lo = Math.min(dragStart, dragEnd);
    const hi = Math.max(dragStart, dragEnd);
    const before = assignment?.slice(lo, hi + 1) ?? [];
    paintRange(mix, dragSectionKey, dragStart, dragEnd, activePaintId);
    if (before.some((paintId) => paintId !== activePaintId)) {
      undoStack.push({ sectionKey: dragSectionKey, startIndex: lo, endIndex: hi, values: before });
      redoStack.length = 0;
      updateHistoryButtons();
    }
    sectionEls.get(dragSectionKey)?.refresh();
    sectionEls.get(dragSectionKey)?.clearSelection();
    dragging = false;
    dragSectionKey = null;
    onChange();
  }

  function cancelDrag() {
    sectionEls.get(dragSectionKey)?.clearSelection();
    dragging = false;
    dragSectionKey = null;
  }

  window.addEventListener("pointerup", commitDrag);
  window.addEventListener("pointercancel", cancelDrag);

  render();

  return {
    unmount() {
      window.removeEventListener("pointerup", commitDrag);
      window.removeEventListener("pointercancel", cancelDrag);
      stopPreview();
    },
  };
}
