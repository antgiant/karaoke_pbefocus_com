import { canonicalWords, findSection, passageLabel } from "./library.js";
import { loopRangeForCanonicalIndices } from "./karaoke-controls.js";

/**
 * The A/B loop word-picker (AI_TODO.md item 4): drag across words to loop
 * just that range, mirroring mix-editor.js's own drag-to-select word-chip
 * strip (same Pointer Events approach, same word-chip/word-strip/
 * mix-verse-line CSS classes -- this reuses that visual language rather
 * than inventing a second one) but painting a loop range instead of a
 * genre.
 *
 * Deliberately NOT part of the persisted three-tier settings model (see
 * karaoke-controls.js's doc comment) -- it's a live "drill this bit right
 * now" aid scoped to whatever's actually playing, so it tracks the
 * engine's current section reactively (blockchange) rather than asking the
 * Pathfinder to pick a song up front the way the settings scope selector
 * does. Disabled/empty until something is actually playing.
 */
export function mountAbLoopPicker(container, engine, manifest, { loopThisBlockBtn, clearLoopBtn }) {
  container.innerHTML = "";
  container.className = "word-strip ab-loop-picker";

  let currentSectionKey = null;
  let canonical = [];
  let chips = [];
  let dragging = false;
  let dragStart = null;
  let dragEnd = null;
  let loopActive = false;

  function setButtonsEnabled(hasBlock) {
    loopThisBlockBtn.disabled = !hasBlock;
    clearLoopBtn.disabled = !hasBlock || !loopActive;
  }

  function highlightRange(lo, hi) {
    chips.forEach((chip, i) => chip.classList.toggle("in-loop", loopActive && i >= lo && i <= hi));
  }

  function previewRange(lo, hi) {
    chips.forEach((chip, i) => chip.classList.toggle("selecting", i >= lo && i <= hi));
  }

  function clearPreview() {
    for (const chip of chips) chip.classList.remove("selecting");
  }

  function renderSection(sectionKey) {
    currentSectionKey = sectionKey;
    const section = sectionKey ? findSection(manifest, sectionKey) : null;
    canonical = section ? canonicalWords(section) : [];
    container.innerHTML = "";
    chips = [];
    loopActive = false;

    if (!section) {
      setButtonsEnabled(false);
      return;
    }

    const heading = document.createElement("p");
    heading.className = "mix-editor-hint";
    heading.textContent = `Looping within: ${passageLabel(section)}`;
    container.appendChild(heading);

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
        container.appendChild(verseLine);
      }

      const chip = document.createElement("span");
      chip.className = "word-chip loop-word-chip";
      chip.textContent = w.word;

      chip.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        try {
          chip.releasePointerCapture(event.pointerId);
        } catch {
          // Not all browsers implicitly capture on touch; nothing to release.
        }
        dragging = true;
        dragStart = dragEnd = i;
        previewRange(i, i);
      });
      chip.addEventListener("pointerenter", () => {
        if (!dragging) return;
        dragEnd = i;
        previewRange(Math.min(dragStart, dragEnd), Math.max(dragStart, dragEnd));
      });

      verseLine.appendChild(chip);
      chips.push(chip);
    });

    setButtonsEnabled(true);
  }

  function commitDrag() {
    if (!dragging) return;
    dragging = false;
    clearPreview();
    const lo = Math.min(dragStart, dragEnd);
    const hi = Math.max(dragStart, dragEnd);
    const range = loopRangeForCanonicalIndices(engine.getProgramBlocks(), currentSectionKey, lo, hi);
    if (!range) return;
    engine.setLoopRange(range);
    loopActive = true;
    highlightRange(lo, hi);
    setButtonsEnabled(true);
  }

  function cancelDrag() {
    dragging = false;
    clearPreview();
  }

  loopThisBlockBtn.addEventListener("click", () => {
    const { block, blockIndex } = engine.getState();
    if (!block) return;
    engine.setLoopRange({ startBlockIndex: blockIndex, startTime: block.inTime, endBlockIndex: blockIndex, endTime: block.outTime });
    loopActive = true;
    const indices = [...block.canonicalIndexMap.values()];
    if (indices.length > 0) highlightRange(Math.min(...indices), Math.max(...indices));
    setButtonsEnabled(true);
  });

  clearLoopBtn.addEventListener("click", () => {
    engine.setLoopRange(null);
    loopActive = false;
    highlightRange(-1, -1);
    setButtonsEnabled(!!engine.getState().block);
  });

  window.addEventListener("pointerup", commitDrag);
  window.addEventListener("pointercancel", cancelDrag);

  const unsubscribers = [
    engine.on("blockchange", (block) => {
      const sectionKey = block?.sectionKey ?? null;
      if (sectionKey !== currentSectionKey) renderSection(sectionKey);
      else setButtonsEnabled(true);
    }),
    engine.on("ended", () => renderSection(null)),
  ];

  const initial = engine.getState();
  renderSection(initial.block?.sectionKey ?? null);

  return {
    unmount() {
      for (const off of unsubscribers) off();
      window.removeEventListener("pointerup", commitDrag);
      window.removeEventListener("pointercancel", cancelDrag);
    },
  };
}
