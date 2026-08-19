import { wordIndexAtTime } from "../playback-engine.js";
import { maskedText, shouldHint } from "./masking.js";
import { createWordStream } from "./word-stream.js";

const BASE_REVEAL = 0.6;
const STEP_PER_REPEAT = 0.2;
const MIN_REVEAL = 0;

/**
 * Same blank-until-sung mechanic as invisible-word mode, but the reveal
 * fraction ratchets down every time the *same section* comes around again
 * (tracked per playthrough of this mounted session) -- spaced-repetition
 * style drilling: easy the first time, blanker on each replay.
 */
export function mountBlackoutRamp(container, engine) {
  const stream = createWordStream(container);
  let currentBlock = null;
  let revealed = new Set();
  const playCounts = new Map();

  function renderBlock(block) {
    currentBlock = block;
    revealed = new Set();
    if (!block) {
      stream.renderBlock(block, () => ({ text: "" }));
      return;
    }
    const count = playCounts.get(block.sectionKey) ?? 0;
    playCounts.set(block.sectionKey, count + 1);
    const revealFraction = Math.max(MIN_REVEAL, BASE_REVEAL - count * STEP_PER_REPEAT);

    stream.renderBlock(block, (w, i) => {
      const hinted = w.verse === null || shouldHint(i, revealFraction);
      if (hinted) revealed.add(i);
      return hinted ? { text: w.word } : { text: maskedText(w.word), extraClass: "blanked" };
    });
  }

  const unsubscribers = [
    engine.on("blockchange", (block) => renderBlock(block)),
    engine.on("timeupdate", (t, block) => {
      if (block !== currentBlock) renderBlock(block);
      const index = wordIndexAtTime(block.words, t);
      stream.highlight(index, {
        onPastWord: (el, isPast, i) => {
          el.classList.toggle("sung", isPast);
          if (isPast && !revealed.has(i)) {
            el.textContent = `${block.words[i].word} `;
            el.classList.remove("blanked");
            revealed.add(i);
          }
        },
      });
    }),
  ];

  const initial = engine.getState();
  if (initial.block) renderBlock(initial.block);

  return function unmount() {
    for (const off of unsubscribers) off();
  };
}
