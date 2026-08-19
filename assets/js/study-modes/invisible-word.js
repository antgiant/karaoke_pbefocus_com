import { selectHintedIndices } from "./blank-priority.js";
import { maskedText } from "./masking.js";
import { createPassageView } from "./word-stream.js";

/**
 * Words are blanked before they're sung (forcing recall ahead of the audio)
 * and reveal their real text once reached. getRevealFraction() controls
 * what fraction of words are given away as hints from the start (0 = fully
 * blind, 1 = effectively standard karaoke) -- which words those are comes
 * from blank-priority.js (ported from pbe-practice-engine), not uniform
 * randomness, so the words revealed are consistently the least
 * meaning-bearing ones (articles, pronouns, connectives) and the words kept
 * blanked longest are the ones that actually carry the verse's content.
 */
export function mountInvisibleWord(container, engine, manifest, mix, getRevealFraction = () => 0.15, getLengthMatched = () => false) {
  const view = createPassageView(container, engine, manifest, mix);
  let revealed = new Set();
  let hinted = new Set();

  view.setOnSectionChange((section, canonical) => {
    revealed = new Set();
    hinted = canonical ? selectHintedIndices(canonical, getRevealFraction()) : new Set();
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
