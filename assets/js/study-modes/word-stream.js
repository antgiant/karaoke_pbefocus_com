/**
 * Shared DOM plumbing for every passive (audio-drives-the-UI) study mode:
 * renders a block's words as spans and tracks which one is "active" as
 * playback advances. Each mode supplies how a word should look via
 * renderWord()/onPastWord() -- this module only owns the chip lifecycle.
 */
export function createWordStream(container) {
  container.innerHTML = "";
  container.className = "karaoke-view";
  const heading = document.createElement("p");
  heading.className = "karaoke-heading";
  const stream = document.createElement("div");
  stream.className = "karaoke-stream";
  container.append(heading, stream);

  let wordEls = [];
  let lastIndex = -1;

  return {
    /** renderWord(word, index) -> { text, extraClass? } */
    renderBlock(block, renderWord) {
      lastIndex = -1;
      stream.innerHTML = "";
      heading.textContent = block ? block.label : "";
      wordEls = (block?.words ?? []).map((w, i) => {
        const span = document.createElement("span");
        const { text, extraClass } = renderWord(w, i);
        span.className = "karaoke-word" + (w.verse === null ? " filler" : "") + (extraClass ? ` ${extraClass}` : "");
        span.textContent = `${text} `;
        stream.appendChild(span);
        return span;
      });
    },

    /** onPastWord(el, isPast, index) lets a mode customize past-word treatment; defaults to dimming ("sung"). */
    highlight(index, { onPastWord } = {}) {
      if (index === lastIndex) return;
      for (let i = 0; i < wordEls.length; i++) {
        const isPast = i < index;
        wordEls[i].classList.toggle("active", i === index);
        if (onPastWord) onPastWord(wordEls[i], isPast, i);
        else wordEls[i].classList.toggle("sung", isPast);
      }
      if (index >= 0 && wordEls[index]) {
        wordEls[index].scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
      }
      lastIndex = index;
    },
  };
}
