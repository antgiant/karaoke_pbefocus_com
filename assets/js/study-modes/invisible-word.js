import { wordIndexAtTime } from "../playback-engine.js";
import { maskedText, shouldHint } from "./masking.js";
import { createWordStream } from "./word-stream.js";

/**
 * Words are blanked before they're sung (forcing recall ahead of the audio)
 * and reveal their real text once reached. getRevealFraction() controls
 * what fraction of scripture words are given away as hints from the start
 * (0 = fully blind, 1 = effectively standard karaoke).
 */
export function mountInvisibleWord(container, engine, getRevealFraction = () => 0.15) {
  const stream = createWordStream(container);
  let currentBlock = null;
  let revealed = new Set();

  function renderBlock(block) {
    currentBlock = block;
    revealed = new Set();
    const revealFraction = getRevealFraction();
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
