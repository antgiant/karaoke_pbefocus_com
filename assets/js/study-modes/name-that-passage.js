import { findSection, passageLabel } from "../library.js";
import { buildProgram } from "../program-builder.js";
import { createPassageView } from "./word-stream.js";
import { isSingAlongSupported } from "./sing-along.js";

// AI_TODO.md item 6: "Name that Passage" -- play a short sample from a
// random point in a random section, quiz the Pathfinder on which passage
// (book + chapter) it is. Deliberately audio-first, reusing the shared
// engine/mix/reverb/pitch machinery rather than a bespoke player.
const SAMPLE_DURATION_SECONDS = 7;

// A sample starting in the final stretch of a section would get cut short
// almost immediately by SAMPLE_DURATION_SECONDS -- keep offsets at least
// this far from the section's end when there's enough section to spare.
const MIN_TAIL_SECONDS = 3;

/** Lowercase, trimmed, whitespace-collapsed -- the only normalization the answer-matching decision calls for (strict: no abbreviation/spoken-form tolerance). */
export function normalizeGuess(text) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** "book + chapter is close enough" (AI_TODO.md's decided answer-strictness) -- verse is never part of the expected answer. */
export function referenceAnswer(section) {
  return `${section.book} ${section.chapter}`.toLowerCase();
}

export function isCorrectGuess(guessText, section) {
  return normalizeGuess(guessText) === referenceAnswer(section);
}

export function pickRandomSectionKey(sectionKeys) {
  const arr = [...sectionKeys];
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Picks a random (programIndex, time) to start a sample at, out of every
 * word across `programBlocks` (a single section's blocks -- same shape
 * `engine.getProgramBlocks()` returns). Filters out offsets within
 * `minTailSeconds` of the section's end first; falls back to the
 * unfiltered pool if that empties it (a section shorter than the tail
 * guard itself).
 */
export function pickSampleLocation(programBlocks, { minTailSeconds = MIN_TAIL_SECONDS } = {}) {
  const all = [];
  programBlocks.forEach((block, programIndex) => {
    for (const w of block.words) all.push({ programIndex, time: w.start });
  });
  if (all.length === 0) return null;
  const lastOutTime = programBlocks[programBlocks.length - 1].outTime;
  const filtered = all.filter((loc) => loc.time <= lastOutTime - minTailSeconds);
  const pool = filtered.length > 0 ? filtered : all;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * getOptions() -> { helpLevel, inputMethod }. helpLevel (0-1) is a single
 * fade covering both how present the vocal is (engine.setStemTrackVolumes)
 * and how visible the karaoke words are -- 1 = full audio + words shown
 * (easy), 0 = instrumental-only + no words (hardest, pure melody
 * recognition), matching AI_TODO.md's decided difficulty range as one
 * continuous control rather than two independent switches. inputMethod is
 * read once at mount time ("typed"/"voice"), same rationale unscored.js
 * uses for its own mount-time-only options: there's no UI path to change it
 * mid-round, only via a fresh mount.
 *
 * onFallback, if given, is called with each round's `program.fallbacks`
 * (see main.js's renderFallbackNote) -- optional because tests/callers that
 * don't care about the fallback-audio note can just omit it.
 */
export function mountNameThatPassage(container, engine, manifest, mix, sectionKeys, verseFilter, getOptions, onAttempt, onFallback) {
  container.innerHTML = "";
  container.className = "ntp-view";

  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "btn";
  playBtn.textContent = "▶ Play Sample";

  const passageWrap = document.createElement("div");
  passageWrap.className = "ntp-passage-wrap";

  const guessRow = document.createElement("div");
  guessRow.className = "ntp-guess-row";
  const guessInput = document.createElement("input");
  guessInput.type = "text";
  guessInput.placeholder = 'Book and chapter, e.g. "John 3"';
  guessInput.className = "ntp-guess-input";
  const guessBtn = document.createElement("button");
  guessBtn.type = "button";
  guessBtn.className = "btn";
  guessBtn.textContent = "Guess";
  const micBtn = document.createElement("button");
  micBtn.type = "button";
  micBtn.className = "btn secondary";
  micBtn.textContent = "🎤 Speak your guess";

  const { inputMethod = "typed" } = getOptions();
  const useVoice = inputMethod === "voice" && isSingAlongSupported();
  if (useVoice) {
    guessRow.append(micBtn);
  } else {
    guessRow.append(guessInput, guessBtn);
    if (inputMethod === "voice") {
      const note = document.createElement("p");
      note.className = "fallback-note";
      note.hidden = false;
      note.textContent =
        "Voice guessing needs a browser with speech recognition support (Chrome or Edge) -- using typed input instead.";
      container.append(note);
    }
  }

  const feedbackEl = document.createElement("p");
  feedbackEl.className = "fallback-note ntp-feedback";
  feedbackEl.hidden = true;

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "btn secondary";
  nextBtn.textContent = "Next passage ›";
  nextBtn.hidden = true;

  container.append(playBtn, passageWrap, guessRow, feedbackEl, nextBtn);

  let view = null;
  let currentSection = null;
  let currentKey = null;
  let sampleLocation = null;
  let sampleTimeout = null;
  let recognition = null;
  let answered = false;

  function clearSampleTimeout() {
    if (sampleTimeout !== null) {
      clearTimeout(sampleTimeout);
      sampleTimeout = null;
    }
  }

  const SpeechRecognitionCtor = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

  function stopRecognition() {
    recognition?.stop();
    recognition = null;
    micBtn.textContent = "🎤 Speak your guess";
  }

  function startRecognition() {
    if (!SpeechRecognitionCtor || answered) return;
    recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript) submitGuess(transcript);
    };
    recognition.onerror = () => {
      micBtn.textContent = "🎤 Speak your guess";
    };
    recognition.onend = () => {
      micBtn.textContent = "🎤 Speak your guess";
    };
    try {
      recognition.start();
      micBtn.textContent = "🎤 Listening…";
    } catch {
      // already starting/started -- ignore.
    }
  }

  function applyHelpLevel() {
    const { helpLevel = 1 } = getOptions();
    engine.setStemTrackVolumes({ instrumental: 1, vocal: helpLevel });
    passageWrap.style.opacity = String(helpLevel);
    passageWrap.style.visibility = helpLevel > 0 ? "visible" : "hidden";
  }

  function submitGuess(text) {
    if (answered || !currentSection) return;
    answered = true;
    clearSampleTimeout();
    engine.pause();
    stopRecognition();
    const correct = isCorrectGuess(text, currentSection);
    feedbackEl.hidden = false;
    feedbackEl.classList.toggle("ntp-correct", correct);
    feedbackEl.classList.toggle("ntp-incorrect", !correct);
    feedbackEl.textContent = correct ? `Correct — ${passageLabel(currentSection)}.` : `Not quite — it was ${passageLabel(currentSection)}.`;
    guessInput.disabled = true;
    guessBtn.disabled = true;
    micBtn.disabled = true;
    nextBtn.hidden = false;
    onAttempt?.(currentKey, "namethatpassage", correct ? 1 : 0);
  }

  function startRound() {
    clearSampleTimeout();
    stopRecognition();
    answered = false;
    feedbackEl.hidden = true;
    nextBtn.hidden = true;
    guessInput.value = "";
    guessInput.disabled = false;
    guessBtn.disabled = false;
    micBtn.disabled = false;

    currentKey = pickRandomSectionKey(sectionKeys);
    currentSection = findSection(manifest, currentKey);
    const program = buildProgram(manifest, mix, [currentKey], verseFilter);
    onFallback?.(program.fallbacks);
    engine.loadProgram(program);

    view?.unmount();
    passageWrap.innerHTML = "";
    view = createPassageView(passageWrap, engine, manifest, mix, verseFilter, { hideNav: true });
    // createPassageView hard-overwrites container.className to "karaoke-view"
    // (see word-stream.js) -- re-add our own class each round so the
    // .ntp-passage-wrap opacity transition (help-level fade) still applies.
    passageWrap.classList.add("ntp-passage-wrap");
    // createPassageView always shows passageLabel(section) in its heading --
    // that's exactly the answer to this quiz, so it can never be allowed on
    // screen before/without a guess.
    passageWrap.querySelector(".karaoke-heading")?.remove();

    applyHelpLevel();
    sampleLocation = pickSampleLocation(program.blocks);
  }

  playBtn.addEventListener("click", () => {
    if (!sampleLocation) return;
    engine.resumeAudioContext?.();
    applyHelpLevel();
    clearSampleTimeout();
    engine.skipToBlock(sampleLocation.programIndex, sampleLocation.time);
    sampleTimeout = setTimeout(() => {
      engine.pause();
      sampleTimeout = null;
    }, SAMPLE_DURATION_SECONDS * 1000);
  });

  guessBtn.addEventListener("click", () => submitGuess(guessInput.value));
  guessInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitGuess(guessInput.value);
    }
  });
  micBtn.addEventListener("click", () => startRecognition());
  nextBtn.addEventListener("click", startRound);

  startRound();

  return function unmount() {
    clearSampleTimeout();
    stopRecognition();
    engine.pause();
    engine.setStemTrackVolumes({ instrumental: 1, vocal: 1 }); // the engine is shared -- don't leave this mode's balance applied to whatever plays next
    view?.unmount();
    container.innerHTML = "";
  };
}
