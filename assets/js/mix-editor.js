import { colorForStyle } from "./constants.js";
import { canonicalWords, listTakes, orderedSections, passageLabel, sectionKey } from "./library.js";
import { getTakeRank, paintRange, setTakeRank } from "./mix.js";
import { churchFitDescription, churchFitEmoji } from "./style-fit.js";

// Sections start expanded (immediately usable for painting); this tracks
// which ones the Pathfinder has explicitly collapsed, persisted across
// remounts (main.js unmounts/remounts this editor on every selection
// change) so collapsing one while you keep painting doesn't re-expand it.
const collapsedSections = new Set();

/**
 * The genre "paint" UI: one word-chip strip per selected section (verse
 * numbers, chapter title, each verse its own line -- same Bible-style
 * layout as the study/playback views), a style palette above it. Pick a
 * style, then either tap a single word or drag across a range to paint it
 * -- built on Pointer Events (not the HTML5 Drag-and-Drop API) so the exact
 * same code path drives mouse and touch.
 *
 * Touch note: chips call releasePointerCapture on pointerdown to opt out of
 * the browser's implicit touch capture, which otherwise pins all pointer
 * events to the chip the drag started on and would make pointerenter on
 * sibling chips never fire during a touch drag.
 */
export function mountMixEditor(container, manifest, mix, selectedKeys, onChange) {
  container.innerHTML = "";
  container.className = "mix-editor";

  let activeStyleId = mix.defaultStyleId;
  let dragging = false;
  let dragSectionKey = null;
  let dragStart = null;
  let dragEnd = null;

  const palette = document.createElement("div");
  palette.className = "style-palette";
  const swatchButtons = new Map();
  for (const style of manifest.styles) {
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
    btn.textContent = style.emoji ? `${style.emoji} ${style.label}` : style.label;
    if (style.churchFit) {
      const badge = document.createElement("span");
      badge.className = "style-swatch-fit";
      badge.textContent = churchFitEmoji(style.churchFit);
      badge.setAttribute("aria-hidden", "true"); // decorative -- the same info is in the button's title
      btn.appendChild(badge);
    }
    btn.addEventListener("click", () => setActiveStyle(style.id));
    swatchButtons.set(style.id, btn);
    palette.appendChild(btn);
  }
  container.appendChild(palette);

  const hint = document.createElement("p");
  hint.className = "mix-editor-hint";
  hint.textContent = "Pick a style above, then tap a word to paint it, or drag across a range.";
  container.appendChild(hint);

  const sectionsEl = document.createElement("div");
  sectionsEl.className = "mix-sections";
  container.appendChild(sectionsEl);

  function setActiveStyle(styleId) {
    activeStyleId = styleId;
    for (const [id, btn] of swatchButtons) btn.classList.toggle("active", id === styleId);
  }
  setActiveStyle(activeStyleId);

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

    const takeControls = document.createElement("div");
    takeControls.className = "mix-take-controls";
    wrap.appendChild(takeControls);

    /**
     * One take control per style actually painted somewhere in this
     * section (not every style in the manifest -- only ones relevant to
     * what's currently here), each addressing that specific (section,
     * style) pair -- see AI_TODO.md item 6. A style with only one take has
     * nothing to choose, so it gets no control at all; exactly two takes
     * (the common case -- see build_manifest.py/AI_TODO.md's own count)
     * gets a plain checkbox toggle; three or more gets a <select> so a
     * rarer extra take isn't silently unreachable.
     */
    function renderTakeControls() {
      takeControls.innerHTML = "";
      const stylesInUse = [...new Set(assignment)];
      for (const styleId of stylesInUse) {
        const takes = listTakes(section, styleId);
        if (takes.length < 2) continue;

        const styleLabel = manifest.styles.find((s) => s.id === styleId)?.label ?? styleId;
        const rank = getTakeRank(mix, key, styleId);

        if (takes.length === 2) {
          const label = document.createElement("label");
          label.className = "inline-checkbox mix-take-control";
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = rank >= 1;
          checkbox.addEventListener("change", () => {
            setTakeRank(mix, key, styleId, checkbox.checked ? 1 : 0);
            onChange();
          });
          label.append(checkbox, ` ${styleLabel}: alternate take`);
          takeControls.appendChild(label);
        } else {
          const label = document.createElement("label");
          label.className = "mix-take-control";
          label.textContent = `${styleLabel} take: `;
          const select = document.createElement("select");
          takes.forEach((recording, i) => {
            const option = document.createElement("option");
            option.value = String(i);
            option.textContent = `Take ${i + 1}`;
            select.appendChild(option);
          });
          select.value = String(Math.min(rank, takes.length - 1));
          select.addEventListener("change", () => {
            setTakeRank(mix, key, styleId, Number(select.value));
            onChange();
          });
          label.appendChild(select);
          takeControls.appendChild(label);
        }
      }
    }
    renderTakeControls();

    const strip = document.createElement("div");
    strip.className = "word-strip";
    wrap.appendChild(strip);

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
      chip.style.setProperty("--chip-color", colorForStyle(assignment[i], manifest.styles));

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
        chips.forEach((chip, i) => chip.style.setProperty("--chip-color", colorForStyle(assignment[i], manifest.styles)));
        renderTakeControls(); // a paint can introduce/remove which styles are in use, and so which take controls apply
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
    paintRange(mix, dragSectionKey, dragStart, dragEnd, activeStyleId);
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
    },
  };
}
