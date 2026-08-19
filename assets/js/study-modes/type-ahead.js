/**
 * Type-ahead mode: plays a block up to each scripture word, pauses, and
 * waits for the Pathfinder to type that upcoming word correctly before
 * continuing into it -- active recall, not passive highlighting.
 *
 * This drives its own single <audio> element rather than the shared
 * crossfade playback-engine: that engine is built for continuous
 * multi-block playback and has no concept of "pause and wait right here,"
 * whereas type-ahead is inherently stop-start, so grafting pause points
 * onto the shared engine's per-frame tick loop would fight its own
 * auto-advance logic. Takes the program directly instead of an engine.
 */
import { maskedText } from "./masking.js";

export function mountTypeAhead(container, program) {
  container.innerHTML = "";
  container.className = "typeahead-view";

  const heading = document.createElement("p");
  heading.className = "karaoke-heading";
  const stream = document.createElement("div");
  stream.className = "karaoke-stream";
  const form = document.createElement("form");
  form.className = "typeahead-form";
  const input = document.createElement("input");
  input.type = "text";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.placeholder = "Type the next word…";
  input.disabled = true;
  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "btn";
  submitBtn.textContent = "Check";
  const feedback = document.createElement("span");
  feedback.className = "typeahead-feedback";
  form.append(input, submitBtn, feedback);
  container.append(heading, stream, form);

  const audio = new Audio();
  let wordEls = [];
  let words = [];
  let revealed = new Set();
  let cancelled = false;

  // Attached once, for the form's whole lifetime -- guarantees a native
  // submit (page navigation, losing all state) can never slip through in
  // the brief window before the first prompt is armed, or between prompts.
  let onSubmitAttempt = null;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onSubmitAttempt?.();
  });

  function normalize(s) {
    return (s || "").toLowerCase().replace(/[^a-z0-9']/g, "");
  }

  function renderWords(block) {
    stream.innerHTML = "";
    heading.textContent = block ? block.label : "";
    words = block ? block.words : [];
    revealed = new Set();
    // Scripture words stay masked until reached -- otherwise the answer is
    // just sitting on the page, defeating the point of typing it from memory.
    wordEls = words.map((w) => {
      const span = document.createElement("span");
      const masked = w.verse !== null;
      span.className = "karaoke-word" + (w.verse === null ? " filler" : "") + (masked ? " blanked" : "");
      span.textContent = masked ? `${maskedText(w.word)} ` : `${w.word} `;
      span.dataset.word = w.word;
      stream.appendChild(span);
      return span;
    });
  }

  function highlightThrough(index) {
    for (let i = 0; i < wordEls.length; i++) {
      const isPast = i < index;
      wordEls[i].classList.toggle("sung", isPast);
      wordEls[i].classList.toggle("active", i === index);
      if (isPast && !revealed.has(i)) {
        wordEls[i].textContent = `${words[i].word} `;
        wordEls[i].classList.remove("blanked");
        revealed.add(i);
      }
    }
    if (index >= 0 && wordEls[index]) wordEls[index].scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  function playUntil(stopTime) {
    return new Promise((resolve) => {
      if (cancelled || audio.currentTime >= stopTime) {
        resolve();
        return;
      }
      audio.play().catch(() => {});
      function check() {
        if (cancelled) {
          resolve();
          return;
        }
        let idx = -1;
        for (let i = 0; i < words.length; i++) {
          if (words[i].start <= audio.currentTime) idx = i;
          else break;
        }
        highlightThrough(idx);
        if (audio.currentTime >= stopTime || audio.ended) {
          audio.pause();
          resolve();
          return;
        }
        requestAnimationFrame(check);
      }
      requestAnimationFrame(check);
    });
  }

  function waitForCorrectInput(expectedWord) {
    return new Promise((resolve) => {
      input.value = "";
      input.disabled = false;
      feedback.textContent = "";
      feedback.className = "typeahead-feedback";
      input.focus();

      onSubmitAttempt = () => {
        if (cancelled) {
          onSubmitAttempt = null;
          resolve();
          return;
        }
        if (normalize(input.value) === normalize(expectedWord)) {
          onSubmitAttempt = null;
          input.disabled = true;
          feedback.textContent = "";
          resolve();
        } else {
          feedback.textContent = "Try again";
          feedback.className = "typeahead-feedback error";
          input.value = "";
          input.focus();
        }
      };
    });
  }

  async function loadMetadata(url) {
    if (audio.src === url && audio.readyState >= 1) return;
    audio.src = url;
    await new Promise((resolve) => {
      if (audio.readyState >= 1) resolve();
      else audio.addEventListener("loadedmetadata", resolve, { once: true });
    });
  }

  async function runBlock(index) {
    if (cancelled) return;
    const block = program.blocks[index];
    if (!block) {
      heading.textContent = "Finished!";
      stream.innerHTML = "";
      form.hidden = true;
      return;
    }
    form.hidden = false;
    renderWords(block);
    await loadMetadata(block.audioUrl);
    if (cancelled) return;
    audio.currentTime = block.inTime;

    const scriptureIndices = words.map((w, i) => (w.verse !== null ? i : -1)).filter((i) => i >= 0);

    let pos = 0;
    if (scriptureIndices.length > 0) {
      await playUntil(words[scriptureIndices[0]].end); // first scripture word plays free, for context
      pos = 1;
    }
    while (pos < scriptureIndices.length) {
      if (cancelled) return;
      const targetIndex = scriptureIndices[pos];
      await playUntil(words[targetIndex].start);
      if (cancelled) return;
      await waitForCorrectInput(words[targetIndex].word);
      if (cancelled) return;
      await playUntil(words[targetIndex].end);
      pos += 1;
    }
    await playUntil(block.outTime);
    if (cancelled) return;
    runBlock(index + 1);
  }

  runBlock(0);

  return function unmount() {
    cancelled = true;
    audio.pause();
  };
}
