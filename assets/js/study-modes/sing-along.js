import { createScorer } from "../stt-score.js";

export function isSingAlongSupported() {
  return typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/**
 * Sing-along scoring: the Pathfinder sings with the track while the mic is
 * captured and scored against the expected words (stt-score.js). Off by
 * default and only requests the microphone when explicitly started -- a
 * different privacy surface than the gated song content, since the
 * Pathfinder's own voice leaves the device for whichever cloud recognition
 * service the browser uses. Feature-detects and shows a plain explanation
 * instead of a mic button on browsers without SpeechRecognition (notably
 * Firefox).
 */
export function mountSingAlong(container, engine) {
  container.innerHTML = "";
  container.className = "singalong-view";

  if (!isSingAlongSupported()) {
    const note = document.createElement("p");
    note.className = "fallback-note";
    note.hidden = false;
    note.textContent =
      "Sing-along scoring needs a browser with speech recognition support (Chrome or Edge) -- " +
      "it isn't available in this browser.";
    container.appendChild(note);
    return function unmount() {};
  }

  const privacyNote = document.createElement("p");
  privacyNote.className = "fallback-note";
  privacyNote.hidden = false;
  privacyNote.textContent =
    "Turning this on sends your microphone audio to your browser's speech recognition service " +
    "while it's listening. It only starts when you press “Start Singing.”";

  const heading = document.createElement("p");
  heading.className = "karaoke-heading";
  const stream = document.createElement("div");
  stream.className = "karaoke-stream";
  const scoreEl = document.createElement("p");
  scoreEl.className = "singalong-score";
  const micBtn = document.createElement("button");
  micBtn.type = "button";
  micBtn.className = "btn";
  micBtn.textContent = "Start Singing";
  const statusEl = document.createElement("p");
  statusEl.className = "singalong-status";

  container.append(privacyNote, heading, stream, scoreEl, micBtn, statusEl);

  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let listening = false;
  let userStopped = false;

  let currentBlock = null;
  let scorer = null;
  let wordEls = [];
  let scriptureIndexMap = []; // scriptureIndexMap[i] = index into wordEls for the i-th scripture word

  function renderBlock(block) {
    currentBlock = block;
    stream.innerHTML = "";
    heading.textContent = block ? block.label : "";
    scriptureIndexMap = [];
    wordEls = (block?.words ?? []).map((w, i) => {
      const span = document.createElement("span");
      span.className = "karaoke-word" + (w.verse === null ? " filler" : "");
      span.textContent = `${w.word} `;
      stream.appendChild(span);
      if (w.verse !== null) scriptureIndexMap.push(i);
      return span;
    });
    scorer = block ? createScorer((block.words ?? []).filter((w) => w.verse !== null)) : null;
    updateScoreDisplay();
  }

  function updateScoreDisplay() {
    if (!scorer) {
      scoreEl.textContent = "";
      return;
    }
    const { matchedCount, total, accuracy, perWord } = scorer.getScore();
    scoreEl.textContent = `Score: ${matchedCount}/${total} words (${Math.round(accuracy * 100)}%)`;
    perWord.forEach((info, i) => {
      const el = wordEls[scriptureIndexMap[i]];
      if (el) el.classList.toggle("hit", info.matched);
    });
  }

  const unsubscribeBlockchange = engine.on("blockchange", (block) => renderBlock(block));
  const initial = engine.getState();
  if (initial.block) renderBlock(initial.block);

  function startRecognition() {
    recognition = new SpeechRecognitionCtor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal && scorer) {
          scorer.submitRecognizedPhrase(result[0].transcript);
          updateScoreDisplay();
        }
      }
    };

    recognition.onerror = (event) => {
      statusEl.textContent = `Speech recognition error: ${event.error}. Stopped listening.`;
      listening = false;
      micBtn.textContent = "Start Singing";
    };

    recognition.onend = () => {
      // continuous mode can still time out on silence -- restart unless the Pathfinder pressed stop.
      if (listening && !userStopped) {
        try {
          recognition.start();
        } catch {
          // already starting/started -- ignore.
        }
      }
    };

    userStopped = false;
    try {
      recognition.start();
      listening = true;
      statusEl.textContent = "Listening…";
      micBtn.textContent = "Stop Singing";
    } catch (e) {
      statusEl.textContent = `Couldn't start listening: ${e.message}`;
    }
  }

  function stopRecognition() {
    userStopped = true;
    listening = false;
    recognition?.stop();
    micBtn.textContent = "Start Singing";
    statusEl.textContent = "";
  }

  micBtn.addEventListener("click", () => {
    if (listening) stopRecognition();
    else startRecognition();
  });

  return function unmount() {
    unsubscribeBlockchange();
    stopRecognition();
  };
}
