import { colorForStyle } from "./constants.js";
import { canonicalWords, orderedSections, passageLabel, sectionKey } from "./library.js";
import { paintRange } from "./mix.js";

/**
 * The genre "paint" UI: one word-chip strip per selected section, a style
 * palette above it. Pick a style, then either tap a single word or drag
 * across a range to paint it -- built on Pointer Events (not the HTML5
 * Drag-and-Drop API) so the exact same code path drives mouse and touch.
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
    btn.textContent = style.label;
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

    const wrap = document.createElement("div");
    wrap.className = "mix-section";
    const heading = document.createElement("p");
    heading.className = "mix-section-heading";
    heading.textContent = passageLabel(section);
    wrap.appendChild(heading);

    const strip = document.createElement("div");
    strip.className = "word-strip";
    wrap.appendChild(strip);

    const chips = canonical.map((w, i) => {
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
      strip.appendChild(chip);
      return chip;
    });

    function paintPreview() {
      if (dragSectionKey !== key) return;
      const lo = Math.min(dragStart, dragEnd);
      const hi = Math.max(dragStart, dragEnd);
      chips.forEach((chip, i) => chip.classList.toggle("selecting", i >= lo && i <= hi));
    }

    sectionEls.set(key, {
      refresh: () => chips.forEach((chip, i) => chip.style.setProperty("--chip-color", colorForStyle(assignment[i], manifest.styles))),
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
