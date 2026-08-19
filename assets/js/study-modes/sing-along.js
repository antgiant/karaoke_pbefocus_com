import { createScorer } from "../stt-score.js";
import { createPassageView } from "./word-stream.js";

export function isSingAlongSupported() {
  return typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/**
 * Sing-along scoring: the Pathfinder sings with the track while the mic is
 * captured and scored against the expected words (stt-score.js), scored
 * against the canonical/reference text rather than any one recording's own
 * transcript -- the audio changes per genre, but what they're supposed to
 * sing doesn't. Off by default and only requests the microphone when
 * explicitly started -- a different privacy surface than the gated song
 * content, since the Pathfinder's own voice leaves the device for whichever
 * cloud recognition service the browser uses. Feature-detects and shows a
 * plain explanation instead of a mic button on browsers without
 * SpeechRecognition (notably Firefox).
 */
export function mountSingAlong(container, engine, manifest, mix) {
  if (!isSingAlongSupported()) {
    container.innerHTML = "";
    const note = document.createElement("p");
    note.className = "fallback-note";
    note.hidden = false;
    note.textContent =
      "Sing-along scoring needs a browser with speech recognition support (Chrome or Edge) -- " +
      "it isn't available in this browser.";
    container.appendChild(note);
    return function unmount() {};
  }

  const view = createPassageView(container, engine, manifest, mix);
  view.setRenderWord((w) => ({ text: w.word }));

  const privacyNote = document.createElement("p");
  privacyNote.className = "fallback-note";
  privacyNote.hidden = false;
  privacyNote.textContent =
    "Turning this on sends your microphone audio to your browser's speech recognition service " +
    "while it's listening. It only starts when you press “Start Singing.”";

  const scoreEl = document.createElement("p");
  scoreEl.className = "singalong-score";
  const micBtn = document.createElement("button");
  micBtn.type = "button";
  micBtn.className = "btn";
  micBtn.textContent = "Start Singing";
  const statusEl = document.createElement("p");
  statusEl.className = "singalong-status";

  container.prepend(privacyNote);
  container.append(scoreEl, micBtn, statusEl);

  let scorer = null;

  function updateScoreDisplay() {
    if (!scorer) {
      scoreEl.textContent = "";
      return;
    }
    const { matchedCount, total, accuracy, perWord } = scorer.getScore();
    scoreEl.textContent = `Score: ${matchedCount}/${total} words (${Math.round(accuracy * 100)}%)`;
    perWord.forEach((info, i) => view.markWord(i, "hit", info.matched));
  }

  view.setOnSectionChange((section, canonical) => {
    scorer = section ? createScorer(canonical) : null;
    updateScoreDisplay();
  });

  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let listening = false;
  let userStopped = false;

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
    view.unmount();
    stopRecognition();
  };
}
