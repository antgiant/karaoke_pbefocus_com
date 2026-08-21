import { shuffleBySection } from "./program-builder.js";
import { mountUnscored } from "./study-modes/unscored.js";
import { mountPlayerControls } from "./player-controls.js";

// Plain karaoke, no masking -- blankFraction 0 (see study-modes/unscored.js),
// same as what the old, now-retired karaoke.js did (see AI_TODO.md item 2).
// Sleep Mode is for passive, hands-off listening, so it deliberately always
// uses this regardless of whatever Karaoke Mode settings a Pathfinder has
// picked for active study. typing/hideNav (AI_TODO.md item 3) are also
// Sleep-Mode-only: a typing-effect two-line display (previous line dimmed,
// current line typed in) with no Previous/Next line buttons -- passive
// hands-off viewing has no use for manual line stepping.
const PLAIN_KARAOKE_OPTIONS = () => ({ blankFraction: 0, typing: true, hideNav: true });

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
 * hands-off and dark-room-friendly. Reuses mountUnscored (plain, unmasked)
 * /mountPlayerControls rather than re-implementing rendering, and layers a
 * sleep timer +
 * MediaSession (lock-screen controls, so playback survives a locked
 * screen) on top. Returns an exit() function that tears everything down.
 */
export function mountSleepMode(
  engine,
  program,
  manifest,
  mix,
  {
    styleLabelFor = (id) => id,
    verseFilter,
    instrumentalVolume = 1,
    vocalVolume = 1,
    onVolumesChange,
    textScale = 1,
    onTextScaleChange,
  } = {}
) {
  const overlay = document.createElement("div");
  overlay.className = "sleep-overlay";
  overlay.style.setProperty("--karaoke-font-scale", String(textScale));

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

  // Independent instrumental/vocal volume sliders (AI_TODO.md item 2) --
  // 0% just mutes the vocal <audio> element's volume rather than stopping
  // it from loading (see the decided scope), so switching back up doesn't
  // need to re-fetch anything. Persisted per playlist via onVolumesChange,
  // same tier as the rest of Karaoke Mode's studyOptions.
  function makeVolumeControl(labelText, initialPercent) {
    const label = document.createElement("label");
    label.className = "sleep-volume-control";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = String(initialPercent);
    label.append(`${labelText} `, slider);
    return { label, slider };
  }
  const instrumentalControl = makeVolumeControl("🎹", Math.round(instrumentalVolume * 100));
  const vocalControl = makeVolumeControl("🎤", Math.round(vocalVolume * 100));

  function applyTrackVolumes() {
    engine.setStemTrackVolumes({
      instrumental: Number(instrumentalControl.slider.value) / 100,
      vocal: Number(vocalControl.slider.value) / 100,
    });
  }
  applyTrackVolumes();
  for (const { slider } of [instrumentalControl, vocalControl]) {
    slider.addEventListener("input", applyTrackVolumes);
    slider.addEventListener("change", () => {
      onVolumesChange?.({
        instrumentalVolume: Number(instrumentalControl.slider.value) / 100,
        vocalVolume: Number(vocalControl.slider.value) / 100,
      });
    });
  }

  // Text size (AI_TODO.md item 9) -- Sleep Mode's own scale, independent of
  // the Study panel's: a phone propped up across a dark room wants a
  // different size than one held close during active study.
  const textSizeLabel = document.createElement("label");
  textSizeLabel.className = "sleep-volume-control";
  const textSizeSlider = document.createElement("input");
  textSizeSlider.type = "range";
  textSizeSlider.min = "0.7";
  textSizeSlider.max = "1.8";
  textSizeSlider.step = "0.05";
  textSizeSlider.value = String(textScale);
  textSizeSlider.setAttribute("aria-label", "Karaoke word display text size");
  textSizeLabel.append("🔠 ", textSizeSlider);
  textSizeSlider.addEventListener("input", () => {
    overlay.style.setProperty("--karaoke-font-scale", textSizeSlider.value);
    onTextScaleChange?.(Number(textSizeSlider.value));
  });

  const exitBtn = document.createElement("button");
  exitBtn.type = "button";
  exitBtn.className = "btn secondary";
  exitBtn.textContent = "Exit Sleep Mode";
  topbar.append(
    timerLabel,
    timerSelect,
    shuffleLabel,
    instrumentalControl.label,
    vocalControl.label,
    textSizeLabel,
    exitBtn
  );

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
        album: "PBE Karaoke",
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
  const unmountKaraoke = mountUnscored(karaokeContainer, engine, manifest, mix, PLAIN_KARAOKE_OPTIONS, verseFilter);
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
    engine.setStemTrackVolumes({ instrumental: 1, vocal: 1 }); // the engine is shared -- don't leave Sleep Mode's balance applied to whatever plays next
    unmountKaraoke();
    unmountControls();
    cleanupMediaSession();
    overlay.remove();
    document.body.classList.remove("sleep-mode-active");
  }

  exitBtn.addEventListener("click", exit);

  return exit;
}
