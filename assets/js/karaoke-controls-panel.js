import { canonicalWords, findSection, passageLabel } from "./library.js";
import { loopRangeForCanonicalIndices, verseRangesForSection } from "./karaoke-controls.js";

/**
 * The A/B loop picker (AI_TODO.md item 4): verse and whole-chapter buttons
 * are the primary way to set a loop -- one click loops everything currently
 * sung under that verse number, or the entire passage currently playing,
 * for drilling a hard bit repeatedly. (An earlier version of this picker
 * let a Pathfinder drag-select an arbitrary word range instead; that was
 * replaced with this coarser, faster verse/chapter granularity, which is
 * what's actually needed for most repeat-drilling and doesn't require
 * precise word-by-word dragging to hit the right boundary.)
 *
 * Deliberately NOT part of the persisted three-tier settings model (see
 * karaoke-controls.js's doc comment) -- it's a live "drill this bit right
 * now" aid scoped to whatever's actually playing, so it tracks the
 * engine's current section reactively (blockchange) rather than asking the
 * Pathfinder to pick a song up front the way the settings scope selector
 * does. Disabled/empty until something is actually playing.
 */
export function mountAbLoopPicker(container, engine, manifest, { clearLoopBtn }) {
  container.innerHTML = "";
  container.className = "ab-loop-picker";

  let currentSectionKey = null;
  let canonical = [];
  let buttons = []; // {el, startIndex, endIndex}

  function setActiveButton(startIndex, endIndex) {
    for (const b of buttons) b.el.classList.toggle("active", b.startIndex === startIndex && b.endIndex === endIndex);
  }

  function clearActiveButton() {
    for (const b of buttons) b.el.classList.remove("active");
  }

  function applyLoop(startIndex, endIndex) {
    const range = loopRangeForCanonicalIndices(engine.getProgramBlocks(), currentSectionKey, startIndex, endIndex);
    if (!range) return;
    engine.setLoopRange(range);
    setActiveButton(startIndex, endIndex);
    clearLoopBtn.disabled = false;
  }

  function makeButton(label, startIndex, endIndex, extraClass = "") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `btn tiny secondary loop-scope-btn${extraClass ? ` ${extraClass}` : ""}`;
    btn.textContent = label;
    btn.addEventListener("click", () => applyLoop(startIndex, endIndex));
    buttons.push({ el: btn, startIndex, endIndex });
    return btn;
  }

  function renderSection(sectionKey) {
    currentSectionKey = sectionKey;
    const section = sectionKey ? findSection(manifest, sectionKey) : null;
    canonical = section ? canonicalWords(section) : [];
    container.innerHTML = "";
    buttons = [];
    clearLoopBtn.disabled = true;

    if (!section) return;

    const heading = document.createElement("p");
    heading.className = "mix-editor-hint";
    heading.textContent = `Looping within: ${passageLabel(section)}`;
    container.appendChild(heading);

    const row = document.createElement("div");
    row.className = "loop-scope-row";
    if (canonical.length > 0) row.appendChild(makeButton("Whole Chapter", 0, canonical.length - 1, "loop-scope-chapter"));
    for (const { verse, startIndex, endIndex } of verseRangesForSection(canonical)) {
      row.appendChild(makeButton(`Verse ${verse}`, startIndex, endIndex));
    }
    container.appendChild(row);
  }

  clearLoopBtn.addEventListener("click", () => {
    engine.setLoopRange(null);
    clearActiveButton();
    clearLoopBtn.disabled = true;
  });

  const unsubscribers = [
    engine.on("blockchange", (block) => {
      const sectionKey = block?.sectionKey ?? null;
      if (sectionKey !== currentSectionKey) renderSection(sectionKey);
    }),
    engine.on("ended", () => renderSection(null)),
  ];

  const initial = engine.getState();
  renderSection(initial.block?.sectionKey ?? null);

  return {
    unmount() {
      for (const off of unsubscribers) off();
    },
  };
}
