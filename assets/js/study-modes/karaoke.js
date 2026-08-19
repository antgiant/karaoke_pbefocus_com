import { wordIndexAtTime } from "../playback-engine.js";

/**
 * Standard karaoke renderer: shows the current block's words, highlighting
 * the one being sung and dimming ones already sung. Reused as-is by sleep
 * mode (just wrapped in a different color skin), so this stays focused on
 * DOM structure/classes only -- no styling decisions beyond class names.
 */
export function mountKaraoke(container, engine) {
  container.innerHTML = "";
  container.className = "karaoke-view";

  const heading = document.createElement("p");
  heading.className = "karaoke-heading";
  const stream = document.createElement("div");
  stream.className = "karaoke-stream";
  container.append(heading, stream);

  let wordEls = [];
  let currentBlock = null;
  let lastIndex = -1;

  function renderBlock(block) {
    currentBlock = block;
    lastIndex = -1;
    stream.innerHTML = "";
    if (!block) {
      heading.textContent = "";
      return;
    }
    heading.textContent = block.label;
    wordEls = block.words.map((w) => {
      const span = document.createElement("span");
      span.className = "karaoke-word" + (w.verse === null ? " filler" : "");
      span.textContent = w.word + " ";
      stream.appendChild(span);
      return span;
    });
  }

  function highlight(index) {
    if (index === lastIndex) return;
    for (let i = 0; i < wordEls.length; i++) {
      wordEls[i].classList.toggle("sung", i < index);
      wordEls[i].classList.toggle("active", i === index);
    }
    if (index >= 0 && wordEls[index]) {
      wordEls[index].scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    }
    lastIndex = index;
  }

  const unsubscribers = [
    engine.on("blockchange", (block) => renderBlock(block)),
    engine.on("timeupdate", (t, block) => {
      if (block !== currentBlock) renderBlock(block);
      highlight(wordIndexAtTime(block.words, t));
    }),
  ];

  const initial = engine.getState();
  if (initial.block) renderBlock(initial.block);

  return function unmount() {
    for (const off of unsubscribers) off();
  };
}
