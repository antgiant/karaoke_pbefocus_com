import { wordIndexAtTime } from "../playback-engine.js";
import { createWordStream } from "./word-stream.js";

/** Words vanish immediately after being sung, instead of just dimming -- only upcoming text stays readable. */
export function mountDisappearingWord(container, engine) {
  const stream = createWordStream(container);
  let currentBlock = null;

  function renderBlock(block) {
    currentBlock = block;
    stream.renderBlock(block, (w) => ({ text: w.word }));
  }

  const unsubscribers = [
    engine.on("blockchange", (block) => renderBlock(block)),
    engine.on("timeupdate", (t, block) => {
      if (block !== currentBlock) renderBlock(block);
      stream.highlight(wordIndexAtTime(block.words, t), {
        onPastWord: (el, isPast) => el.classList.toggle("gone", isPast),
      });
    }),
  ];

  const initial = engine.getState();
  if (initial.block) renderBlock(initial.block);

  return function unmount() {
    for (const off of unsubscribers) off();
  };
}
