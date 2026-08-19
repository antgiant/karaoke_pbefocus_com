import { sectionKey } from "../library.js";
import { selectHintedIndices } from "./blank-priority.js";
import { maskedText } from "./masking.js";
import { createPassageView } from "./word-stream.js";

const BASE_REVEAL = 0.6;
const STEP_PER_REPEAT = 0.2;
const MIN_REVEAL = 0;

/**
 * Same blank-until-sung mechanic as invisible-word mode (including the
 * blank-priority.js word selection, not uniform randomness), but the
 * reveal fraction ratchets down every time the *same section* comes around
 * again (tracked per playthrough of this mounted session) --
 * spaced-repetition style drilling: easy the first time, blanker on each
 * replay.
 */
export function mountBlackoutRamp(container, engine, manifest, mix, getLengthMatched = () => false) {
  const view = createPassageView(container, engine, manifest, mix);
  const playCounts = new Map();
  let revealed = new Set();
  let hinted = new Set();

  view.setOnSectionChange((section, canonical) => {
    revealed = new Set();
    if (!section) {
      hinted = new Set();
      return;
    }
    const key = sectionKey(section);
    const count = playCounts.get(key) ?? 0;
    playCounts.set(key, count + 1);
    const revealFraction = Math.max(MIN_REVEAL, BASE_REVEAL - count * STEP_PER_REPEAT);
    hinted = selectHintedIndices(canonical, revealFraction);
  });

  view.setRenderWord((w, i) => {
    if (hinted.has(i)) {
      revealed.add(i);
      return { text: w.word };
    }
    return { text: maskedText(w.word, getLengthMatched()), extraClass: "blanked" };
  });

  view.setOnPastWord((el, isPast, i, word) => {
    el.classList.toggle("sung", isPast);
    if (isPast && !revealed.has(i)) {
      el.textContent = `${word.word} `;
      el.classList.remove("blanked");
      revealed.add(i);
    }
  });

  return view.unmount;
}
