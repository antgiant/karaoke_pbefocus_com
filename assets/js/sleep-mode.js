import { shuffleBySection } from "./program-builder.js";
import { mountKaraoke } from "./study-modes/karaoke.js";
import { mountPlayerControls } from "./player-controls.js";

const SLEEP_TIMER_OPTIONS = [
  { value: "0", label: "No timer" },
  { value: "900", label: "15 minutes" },
  { value: "1800", label: "30 minutes" },
  { value: "2700", label: "45 minutes" },
  { value: "3600", label: "60 minutes" },
];

const FADE_SECONDS = 8;

/**
 * A full-viewport, deliberately non-theme-following night skin around the
 * same karaoke word display and transport used elsewhere -- same content,
 * hands-off and dark-room-friendly. Reuses mountKaraoke/mountPlayerControls
 * rather than re-implementing rendering, and layers a sleep timer +
 * MediaSession (lock-screen controls, so playback survives a locked
 * screen) on top. Returns an exit() function that tears everything down.
 */
export function mountSleepMode(engine, program, manifest, mix, { styleLabelFor = (id) => id, verseFilter } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "sleep-overlay";

  const topbar = document.createElement("div");
  topbar.className = "sleep-topbar";
  const timerLabel = document.createElement("label");
  timerLabel.textContent = "Sleep timer";
  const timerSelect = document.createElement("select");
  timerSelect.className = "sleep-timer-select";
  for (const opt of SLEEP_TIMER_OPTIONS) {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.label;
    timerSelect.appendChild(option);
  }
  const shuffleLabel = document.createElement("label");
  shuffleLabel.className = "sleep-shuffle-toggle";
  const shuffleCheckbox = document.createElement("input");
  shuffleCheckbox.type = "checkbox";
  shuffleLabel.append(shuffleCheckbox, document.createTextNode(" 🔀 Shuffle"));

  const exitBtn = document.createElement("button");
  exitBtn.type = "button";
  exitBtn.className = "btn secondary";
  exitBtn.textContent = "Exit Sleep Mode";
  topbar.append(timerLabel, timerSelect, shuffleLabel, exitBtn);

  const karaokeContainer = document.createElement("div");
  const controlsContainer = document.createElement("div");
  overlay.append(topbar, karaokeContainer, controlsContainer);
  document.body.appendChild(overlay);
  document.body.classList.add("sleep-mode-active");

  let fadeTimeoutId = null;
  let fadeRafId = null;

  function clearTimers() {
    if (fadeTimeoutId !== null) clearTimeout(fadeTimeoutId);
    if (fadeRafId !== null) cancelAnimationFrame(fadeRafId);
    fadeTimeoutId = null;
    fadeRafId = null;
  }

  function beginFadeOut() {
    const start = performance.now();
    function step(now) {
      const elapsed = (now - start) / 1000;
      const v = Math.max(0, 1 - elapsed / FADE_SECONDS);
      engine.setMasterVolume(v);
      if (v > 0) {
        fadeRafId = requestAnimationFrame(step);
      } else {
        engine.pause();
        engine.setMasterVolume(1);
      }
    }
    fadeRafId = requestAnimationFrame(step);
  }

  function scheduleTimer(seconds) {
    clearTimers();
    if (!seconds) return;
    fadeTimeoutId = setTimeout(beginFadeOut, Math.max(0, seconds - FADE_SECONDS) * 1000);
  }

  timerSelect.addEventListener("change", () => scheduleTimer(Number(timerSelect.value)));

  let cleanupMediaSession = () => {};
  if ("mediaSession" in navigator) {
    const updateMetadata = (block) => {
      if (!block) return;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: block.label,
        artist: styleLabelFor(block.style),
        album: "PBE Playlist",
      });
    };
    const offBlockchange = engine.on("blockchange", updateMetadata);
    navigator.mediaSession.setActionHandler("play", () => engine.play());
    navigator.mediaSession.setActionHandler("pause", () => engine.pause());
    navigator.mediaSession.setActionHandler("previoustrack", () => engine.skipToPreviousBlock());
    navigator.mediaSession.setActionHandler("nexttrack", () => engine.skipToNextBlock());

    cleanupMediaSession = () => {
      offBlockchange();
      for (const action of ["play", "pause", "previoustrack", "nexttrack"]) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // unsupported action on this browser -- nothing to clean up.
        }
      }
      navigator.mediaSession.metadata = null;
    };
  }

  function loadAndPlay() {
    engine.loadProgram(shuffleCheckbox.checked ? shuffleBySection(program) : program);
    engine.play();
  }

  // loadProgram (not play) before mounting: mountPlayerControls has no
  // initial-state fallback, only live event subscriptions, so calling
  // play() before it's mounted would fire the first "playstate" event into
  // nobody and leave the Play/Pause button stuck showing "Play" while
  // actually playing.
  engine.loadProgram(program);
  const unmountKaraoke = mountKaraoke(karaokeContainer, engine, manifest, mix, verseFilter);
  const unmountControls = mountPlayerControls(controlsContainer, engine, { styleLabelFor });
  engine.play();

  shuffleCheckbox.addEventListener("change", loadAndPlay);

  // Sleep mode loops the selection by default -- it's meant to play through
  // to fall asleep to, not stop partway through the night. Re-shuffles each
  // lap if shuffle is on, so it's not the same order all night. The sleep
  // timer's fade-out still ends things on schedule (that calls pause(), not
  // something that fires "ended", so it doesn't fight this).
  const offEnded = engine.on("ended", loadAndPlay);

  function exit() {
    clearTimers();
    offEnded();
    engine.pause();
    engine.setMasterVolume(1);
    unmountKaraoke();
    unmountControls();
    cleanupMediaSession();
    overlay.remove();
    document.body.classList.remove("sleep-mode-active");
  }

  exitBtn.addEventListener("click", exit);

  return exit;
}
