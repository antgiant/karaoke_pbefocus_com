// Drives a program (see program-builder.js) through two source "slots"
// played back-to-back, with a volume crossfade over the seam between
// blocks (different recordings, so it's a smoothing touch, not a promise of
// a studio-seamless splice -- see the mix-editor UX notes in the plan).
//
// Every recording in the library is a separated instrumental/vocal stem
// pair (scripts/separate_stems.py + build_manifest.py -- see AGENTS.md; the
// original single-track full mix is deleted once separation succeeds, so
// there's no plain-audio fallback to fall back to). Every block therefore
// always plays through a *pair* of <audio> elements (instrumental + vocal)
// kept in sync. Normally both play at the same volume -- together they
// sound like the original full mix. A caller that's opted into vocal
// ducking (see setVocalDuckPredicate, used by Karaoke Mode's "fade out the
// sung words when blanked" checkbox, study-modes/unscored.js) additionally
// fades the vocal element's own volume toward 0 while the current word is
// "blanked" per the duck predicate -- true "guess the words" recall, not
// just "don't read ahead" (Karaoke Mode's existing visual-only blanking).
// Every caller that never sets a duck predicate (Sleep Mode, Sing-Along,
// Type Ahead) just hears both tracks at full volume throughout.

const SEGMENT_CROSSFADE_SECONDS = 0.35; // same-style segment boundary (a click-avoidance blip, not a real transition)
const GENRE_CROSSFADE_SECONDS = 1.5; // the style actually changes between blocks -- "jumping between genres" deserves an audible, deliberate fade
const DUCK_TIME_CONSTANT_SECONDS = 0.12; // how quickly the vocal track fades toward its target when a word's blanked state changes -- fast enough to feel word-synced, slow enough not to click
const STEM_RESYNC_DRIFT_SECONDS = 0.15; // if the vocal/instrumental pair drift apart by more than this, snap them back together

// AI_TODO.md item 4 (Karaoke Controls): neutral settings applied whenever no
// resolver is registered (setKaraokeControlsResolver, mirroring
// setVocalDuckPredicate's opt-in shape) -- every existing caller that
// predates this feature keeps behaving exactly as before.
const NEUTRAL_CONTROLS = { pitchSemitones: 0, rate: 1, keyLock: true, countInSeconds: 0, reverbAmount: 0 };

// Shared echo/reverb send tuning -- a simple feedback delay line, not a
// convolution reverb (which would need a synthesized or shipped impulse
// response file). One shared network per AudioContext, not per source pair
// -- both slots' wet sends feed the same "room" so an in-flight crossfade
// blends into one tail rather than two independent ones fighting.
const REVERB_DELAY_SECONDS = 0.18;
const REVERB_FEEDBACK = 0.35;

/** Builds the shared reverb/echo send network for one AudioContext: a delay line with feedback for a repeating tail, plus an input gain every source's wet send connects into and an output already wired to `masterOut` (see createMasterBus). */
function createReverbNetwork(audioContext, masterOut) {
  const input = audioContext.createGain();
  const delay = audioContext.createDelay(1);
  delay.delayTime.value = REVERB_DELAY_SECONDS;
  const feedback = audioContext.createGain();
  feedback.gain.value = REVERB_FEEDBACK;
  input.connect(delay);
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(masterOut);
  return input;
}

/**
 * Every recording's instrumental+vocal stems are separated (and each
 * individually loudness-rescaled) by scripts/separate_stems.py, which has
 * no way to know the two will be summed back together at full volume on
 * playback (see the file-top comment) -- and now that instrumental/vocal
 * can also be independently boosted (setStemTrackVolumes/Karaoke Controls'
 * instrumentalVolume+vocalVolume), the combined peak depends on whatever
 * mix the Pathfinder has dialed in, not just the source material. So the
 * combined signal can exceed 0dBFS in a way no fixed per-stem mastering
 * step could have anticipated, regardless of how it's balanced.
 *
 * Two things were tried and rejected before this: a plain
 * DynamicsCompressorNode alone wasn't enough -- it has no true lookahead,
 * so a genuinely sharp transient can still punch through in the few
 * milliseconds before its gain reduction engages (confirmed live:
 * occasional pops survived). Adding a WaveShaperNode soft-clip after it
 * made things *worse* -- its curve had to start bending well below 0dBFS
 * to have any safety margin at all, which meant it was audibly coloring
 * ordinary loud (non-clipping) passages, not just the rare true peak.
 *
 * audio/limiter-processor.js fixes the root issue directly with a real
 * lookahead limiter: it delays the signal by a few ms while computing gain
 * reduction from the *undelayed* input, so by the time any given sample
 * reaches the front of that delay it's already been reduced -- true
 * zero-overshoot limiting, not a reactive one (see that file's doc comment
 * for the algorithm; audio/limiter-math.js is the same math extracted into
 * a plain, unit-tested module -- tests/limiter-math.test.mjs).
 *
 * Like the pitch-shift worklet, the AudioWorkletNode itself can't be
 * constructed until its module's loaded, so this returns a plain GainNode
 * every source connects into immediately (never itself needing to be
 * rewired) that falls back to a direct connection to `destination` until
 * the limiter's ready, then gets spliced in front of it -- same
 * connect-now-rewire-later shape as wireIntoAudioGraph's pitchNode.
 */
function createMasterBus(audioContext, limiterReady) {
  const masterGain = audioContext.createGain();
  masterGain.connect(audioContext.destination);
  limiterReady.then((limiterNode) => {
    if (!limiterNode) return; // module failed to load -- stay on the direct fallback rather than breaking playback, matching wireIntoAudioGraph's own inert-fallback philosophy
    masterGain.disconnect(audioContext.destination);
    masterGain.connect(limiterNode);
    limiterNode.connect(audioContext.destination);
  });
  return masterGain;
}

/** Binary search: index of the last word whose start <= t, or -1 before the first word. */
export function wordIndexAtTime(words, t) {
  let lo = 0;
  let hi = words.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

/**
 * How long the crossfade into `nextBlock` should run, given the block
 * currently playing. A block boundary where the *style* changes ("jumping
 * between genres," e.g. a Customize Genre Mix paint boundary) gets a
 * longer, more deliberate fade than the default -- same-style segment
 * boundaries (e.g. a per-word alignment-gap patch mid-run) stay a short,
 * click-avoidance blip. Never longer than the outgoing block's own
 * duration, so a very short segment can't schedule a crossfade that
 * outlives the block it's fading out of.
 */
export function crossfadeSecondsFor(prevBlock, nextBlock) {
  if (!prevBlock || !nextBlock) return SEGMENT_CROSSFADE_SECONDS;
  const wanted = prevBlock.style !== nextBlock.style ? GENRE_CROSSFADE_SECONDS : SEGMENT_CROSSFADE_SECONDS;
  const duration = prevBlock.outTime - prevBlock.inTime;
  return Math.min(wanted, Math.max(0.05, duration));
}

/** 0 (fade the vocal to silent) or 1 (full volume) for the word at time `t` in `block`, per `duckPredicate(canonicalWordIndex)` -- 1 whenever there's no predicate, no word at `t`, or that word never made it into the canonical alignment (see program-builder.js's per-word fallback notes) rather than guessing. */
export function duckTargetFor(block, t, duckPredicate) {
  if (!duckPredicate) return 1;
  const idx = wordIndexAtTime(block.words, t);
  const word = idx >= 0 ? block.words[idx] : null;
  const canonicalIdx = word ? block.canonicalIndexMap.get(word) : undefined;
  const isBlanked = canonicalIdx !== undefined && duckPredicate(canonicalIdx);
  return isBlanked ? 0 : 1;
}

/**
 * Seeks an <audio> element to `time` and resolves once it's actually landed
 * there -- NOT the same as resolving right after assigning `.currentTime`.
 * On a server without Range support (seeking requires the browser to have
 * already buffered up to that point, since it can't request a byte range),
 * assigning currentTime before enough data has downloaded is silently
 * ignored -- it just reverts to wherever it already was instead of
 * throwing or rejecting, so a single blind assignment is not reliable for
 * any target time beyond what's buffered yet. This verifies the seek
 * actually landed close to the target and keeps retrying as more data
 * streams in, with an 8s safety net so a seek that genuinely never sticks
 * (a slow host, a truncated file) doesn't hang forever.
 */
export function seekReliably(el, time) {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId = null;

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      el.removeEventListener("seeked", onSeeked);
      el.removeEventListener("progress", onProgress);
      el.removeEventListener("loadedmetadata", start);
      el.removeEventListener("error", finish);
      resolve();
    }

    function trySeek() {
      try {
        el.currentTime = time;
      } catch {
        // not seekable yet -- onProgress retries once more data has buffered.
      }
    }

    function onSeeked() {
      if (Math.abs(el.currentTime - time) < 0.75) finish();
    }

    function onProgress() {
      if (!settled) trySeek();
    }

    function start() {
      el.addEventListener("seeked", onSeeked);
      el.addEventListener("progress", onProgress);
      trySeek();
    }

    // A source that fails to load (404, network error, unsupported format)
    // never fires loadedmetadata -- without this listener, start() would
    // never run, and relying on the 8s timeout alone wouldn't help either
    // since it used to only get scheduled from inside start(). Both gaps
    // meant one bad recording hung this promise (and everything awaiting
    // it, i.e. all playback) forever instead of just skipping past it.
    el.addEventListener("error", finish, { once: true });

    if (el.readyState >= 1) start();
    else el.addEventListener("loadedmetadata", start, { once: true });

    timeoutId = setTimeout(finish, 8000);
  });
}

/**
 * Wires one <audio> element into `audioContext`'s graph for true pitch
 * shift (AI_TODO.md item 4): source -> pitch node (vendored, see
 * vendor/soundtouch/) -> trackGain -> [dry: masterOut] + [wet: reverbInput,
 * the shared echo/reverb send]. Envelope/duck/track-balance volume
 * (makeSource's applyVolumes) goes through trackGain's AudioParam rather
 * than the element's own .volume -- see trackGain's own doc comment below
 * for why.
 *
 * `useFormantCorrection` picks which vendored pitch node this element gets:
 * plain `SoundTouchNode` (instrumental), or `FormantCorrectionNode`
 * (vocal) -- the latter's LPC-based formant preservation keeps a shifted
 * voice sounding like a voice instead of "chipmunking" at larger shifts,
 * something formants only apply to in the first place, so the instrumental
 * stem has no use for the extra CPU cost. See makeSource's call site.
 *
 * The pitch node can't be created until its vendored AudioWorkletProcessor
 * has finished loading (audioWorklet.addModule is async, done once per
 * processor for the whole engine -- see createPlaybackEngine). Until then
 * this connects the element straight to destination/the reverb send (pitch
 * shift is simply inert -- effectively pitchSemitones=0 -- for whatever's
 * already playing when the app first loads) and rewires itself once the
 * module resolves. Returns null (every method below becomes a no-op) if
 * the browser has no Web Audio support at all -- pitch shift/reverb just
 * don't do anything rather than breaking playback.
 */
function wireIntoAudioGraph(el, audioContext, workletReady, reverbInput, masterOut, useFormantCorrection) {
  if (!audioContext) return null;
  const sourceNode = audioContext.createMediaElementSource(el);
  // Envelope/duck/track-balance volume (makeSource's applyVolumes) is
  // driven through this GainNode's AudioParam rather than the element's own
  // .volume, even though .volume is nominally still respected once an
  // element feeds a MediaElementAudioSourceNode. In practice, on Safari,
  // it isn't reliable: applyVolumes() gets called up to ~60x/sec (every
  // tick() -- stepDuck runs unconditionally, not just while a duck fade is
  // actually in progress), and that frequency of .volume writes on a
  // captured element causes real, audible glitches/pitch instability on
  // Safari specifically (confirmed live: it got dramatically better the
  // instant the tab lost focus and requestAnimationFrame -- and therefore
  // the write frequency -- got throttled). A GainNode's gain param is a
  // proper Web Audio automation target, built for exactly this frequency
  // of change, and unlike .volume never touches the element/decoder at
  // all. See makeSource's applyVolumes for the no-Web-Audio-support
  // fallback (setGain won't exist there, so .volume is still used).
  const trackGain = audioContext.createGain();
  const wetGain = audioContext.createGain();
  wetGain.gain.value = 0;
  trackGain.connect(masterOut);
  trackGain.connect(wetGain);
  wetGain.connect(reverbInput);
  let pitchNode = null;
  let pendingPitchSemitones = 0; // set(...) before the worklet's ready -- applied the instant it is, see below
  sourceNode.connect(trackGain);

  // The pitch node class is imported dynamically, not statically at
  // file-top, because `class ... extends AudioWorkletNode` (in the vendored
  // module) evaluates the global `AudioWorkletNode` the instant the module
  // loads -- a static top-level import would crash under the test suite's
  // jsdom environment, which has no AudioWorkletNode, even though this
  // callback itself only ever runs (see the `if (!audioContext) return
  // null` guard above) when a real browser AudioContext exists.
  workletReady.then(async () => {
    const PitchNodeClass = useFormantCorrection
      ? (await import("./vendor/soundtouch/formant-correction/FormantCorrectionNode.js")).FormantCorrectionNode
      : (await import("./vendor/soundtouch/SoundTouchNode.js")).SoundTouchNode;
    pitchNode = new PitchNodeClass({ context: audioContext });
    if (useFormantCorrection) pitchNode.formantStrength.value = 1; // full correction -- see this function's doc comment
    sourceNode.disconnect(trackGain);
    sourceNode.connect(pitchNode);
    pitchNode.connect(trackGain);
    if (pendingPitchSemitones !== 0) pitchNode.pitchSemitones.value = pendingPitchSemitones;
  });

  return {
    setPitchSemitones(semitones) {
      pendingPitchSemitones = semitones;
      if (pitchNode) pitchNode.pitchSemitones.value = semitones;
    },
    setReverbAmount(amount) {
      wetGain.gain.value = amount;
    },
    setGain(value) {
      trackGain.gain.value = value;
    },
  };
}

/** A synced instrumental+vocal pair -- every block plays through one of these (see the file-top comment). Normally both elements play at the same volume (envelopeVolume); a caller that's set a duck predicate additionally scales the vocal element by duckFactor, faded toward its target over DUCK_TIME_CONSTANT_SECONDS. Timing (word-level ducking) is driven by the block's own recording.words, since both stems share the original recording's word timing. */
function makeSource(audioContext, soundtouchWorkletReady, formantWorkletReady, reverbInput, masterOut) {
  const instrumentalEl = new Audio();
  const vocalEl = new Audio();
  instrumentalEl.preload = "auto";
  vocalEl.preload = "auto";
  instrumentalEl.crossOrigin = "anonymous"; // required for createMediaElementSource to read cross-origin audio into the Web Audio graph at all -- silently produces silence (not an error) without this if the host doesn't send CORS headers
  vocalEl.crossOrigin = "anonymous";
  let envelopeVolume = 0;
  let duckFactor = 1; // 1 = vocal at full volume, 0 = fully faded out
  let duckTarget = 1;
  // Flat, Pathfinder-set per-track multipliers (Sleep Mode's instrumental/
  // vocal volume sliders, AI_TODO.md item 2) -- independent of both
  // envelopeVolume (the crossfade's own volume, shared by both tracks) and
  // duckFactor (Karaoke Mode's per-word duck-predicate fade). Default 1
  // (full volume) so a caller that never sets these hears the normal mix,
  // same as before this existed.
  let instrumentalTrackVolume = 1;
  let vocalTrackVolume = 1;

  const instrumentalGraph = wireIntoAudioGraph(instrumentalEl, audioContext, soundtouchWorkletReady, reverbInput, masterOut, false);
  const vocalGraph = wireIntoAudioGraph(vocalEl, audioContext, formantWorkletReady, reverbInput, masterOut, true);

  // Prefer each graph's GainNode (see wireIntoAudioGraph's doc comment on
  // why -- Safari specifically doesn't tolerate frequent .volume writes on
  // an element that's been captured by createMediaElementSource). Only
  // falls back to the element's own .volume when there's no Web Audio
  // graph at all (wireIntoAudioGraph returns null -- unsupported browser),
  // never both at once, which would double-attenuate.
  function applyVolumes() {
    const instrumentalValue = envelopeVolume * instrumentalTrackVolume;
    const vocalValue = envelopeVolume * duckFactor * vocalTrackVolume;
    if (instrumentalGraph) instrumentalGraph.setGain(instrumentalValue);
    else instrumentalEl.volume = instrumentalValue;
    if (vocalGraph) vocalGraph.setGain(vocalValue);
    else vocalEl.volume = vocalValue;
  }

  return {
    get src() {
      return instrumentalEl.src;
    },
    get currentTime() {
      return instrumentalEl.currentTime;
    },
    get ended() {
      return instrumentalEl.ended;
    },
    get volume() {
      return envelopeVolume;
    },
    setUrls(instrumentalUrl, vocalUrl) {
      if (instrumentalEl.src !== instrumentalUrl) instrumentalEl.src = instrumentalUrl;
      if (vocalEl.src !== vocalUrl) vocalEl.src = vocalUrl;
    },
    load() {
      instrumentalEl.load();
      vocalEl.load();
    },
    unload() {
      for (const el of [instrumentalEl, vocalEl]) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
    },
    async seekAndPlay(time) {
      await Promise.all([seekReliably(instrumentalEl, time), seekReliably(vocalEl, time)]);
      instrumentalEl.play().catch(() => {});
      vocalEl.play().catch(() => {});
      duckFactor = duckTarget = 1; // start audible -- the first tick() after blockchange sets the real target
      applyVolumes();
    },
    play() {
      instrumentalEl.play().catch(() => {});
      vocalEl.play().catch(() => {});
    },
    pause() {
      instrumentalEl.pause();
      vocalEl.pause();
    },
    setVolume(v) {
      envelopeVolume = v;
      applyVolumes();
    },
    /** Fades the vocal element toward 0 (blanked) or 1 (audible) over DUCK_TIME_CONSTANT_SECONDS -- called every animation frame while this source is the active one and a duck predicate is set. */
    setDuckTarget(target) {
      duckTarget = target;
    },
    stepDuck(dtSeconds) {
      const rate = 1 - Math.exp(-dtSeconds / DUCK_TIME_CONSTANT_SECONDS);
      duckFactor += (duckTarget - duckFactor) * rate;
      applyVolumes();
    },
    resyncIfDrifted() {
      if (Math.abs(vocalEl.currentTime - instrumentalEl.currentTime) > STEM_RESYNC_DRIFT_SECONDS) {
        vocalEl.currentTime = instrumentalEl.currentTime;
      }
    },
    setTrackVolumes({ instrumental, vocal }) {
      if (instrumental !== undefined) instrumentalTrackVolume = instrumental;
      if (vocal !== undefined) vocalTrackVolume = vocal;
      applyVolumes();
    },
    /**
     * AI_TODO.md item 4: `rate` is native HTMLMediaElement.playbackRate
     * (tempo). `keyLock` (DJ-software convention) sets preservesPitch --
     * true holds pitch fixed as rate changes, false lets pitch follow rate
     * naturally (vinyl-style). `pitchSemitones` is an *additional*,
     * independent shift applied by the Web Audio pitch-shift node on top of
     * whichever of the above is in effect -- true "key change" without
     * touching tempo, the thing neither playbackRate nor preservesPitch can
     * do alone (see AI_TODO.md's "Pitch scope" decision).
     */
    setPitchAndRate({ pitchSemitones, rate, keyLock }) {
      for (const el of [instrumentalEl, vocalEl]) {
        el.playbackRate = rate;
        el.preservesPitch = keyLock;
        el.mozPreservesPitch = keyLock; // legacy Firefox
        el.webkitPreservesPitch = keyLock; // legacy Safari/WebKit
      }
      instrumentalGraph?.setPitchSemitones(pitchSemitones);
      vocalGraph?.setPitchSemitones(pitchSemitones);
    },
    setReverbAmount(amount) {
      instrumentalGraph?.setReverbAmount(amount);
      vocalGraph?.setReverbAmount(amount);
    },
  };
}

export function createPlaybackEngine() {
  // One AudioContext (and its pitch-shift AudioWorklet modules + shared
  // reverb send) for the whole engine, both slots' sources routed through
  // it -- see wireIntoAudioGraph/createReverbNetwork. Constructed
  // defensively: a browser with no Web Audio support at all just gets inert
  // pitch-shift/reverb (see wireIntoAudioGraph's null-audioContext path)
  // rather than broken playback.
  let audioContext = null;
  try {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (AudioContextCtor) audioContext = new AudioContextCtor();
  } catch {
    audioContext = null;
  }
  // Two separate pitch-shift processors -- see wireIntoAudioGraph's doc
  // comment on useFormantCorrection for why the instrumental and vocal
  // stems use different ones.
  const soundtouchWorkletReady = audioContext
    ? audioContext.audioWorklet.addModule(new URL("./vendor/soundtouch/soundtouch-processor.js", import.meta.url)).catch(() => {})
    : Promise.resolve();
  const formantWorkletReady = audioContext
    ? audioContext.audioWorklet
        .addModule(new URL("./vendor/soundtouch/formant-correction/formant-correction-processor.js", import.meta.url))
        .catch(() => {})
    : Promise.resolve();
  // Resolves to the constructed limiter AudioWorkletNode once its module's
  // loaded, or null on failure/no Web Audio support -- see
  // createMasterBus's doc comment for why every source routes through this
  // even at default (unshifted, non-ducked, unboosted) playback.
  const limiterReady = audioContext
    ? audioContext.audioWorklet
        .addModule(new URL("./audio/limiter-processor.js", import.meta.url))
        .then(() => new AudioWorkletNode(audioContext, "limiter-processor", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] }))
        .catch(() => null)
    : Promise.resolve(null);
  const masterOut = audioContext ? createMasterBus(audioContext, limiterReady) : null;
  const reverbInput = audioContext ? createReverbNetwork(audioContext, masterOut) : null;

  // Two slots (today's "active"/"standby" elements), each a synced
  // instrumental+vocal pair -- see makeSource().
  const slots = [
    makeSource(audioContext, soundtouchWorkletReady, formantWorkletReady, reverbInput, masterOut),
    makeSource(audioContext, soundtouchWorkletReady, formantWorkletReady, reverbInput, masterOut),
  ];

  let activeIdx = 0;
  let program = { blocks: [] };
  let blockIndex = -1;
  let crossfading = false;
  let currentCrossfadeSeconds = SEGMENT_CROSSFADE_SECONDS;
  let isPlaying = false;
  let rafHandle = null;
  let lastFrameTime = null;
  let masterVolume = 1; // external multiplier (e.g. sleep mode's fade-out), on top of crossfade's own volume math
  let duckPredicate = null; // (canonicalWordIndex) => boolean, or null -- see setVocalDuckPredicate

  // AI_TODO.md item 7 (offline support) -- caller-supplied, mirroring
  // setVocalDuckPredicate/setKaraokeControlsResolver's opt-in shape: see
  // setUrlResolver below for what these do. Identity/no-op defaults so an
  // engine nobody's wired this up for behaves exactly as it did before this
  // feature existed.
  let urlResolver = (url) => url;
  let primeUrls = () => Promise.resolve();
  let resolverReady = Promise.resolve();

  // AI_TODO.md item 4 (Karaoke Controls) -- caller-supplied, mirroring
  // setVocalDuckPredicate's opt-in shape: resolves a block's section to its
  // effective (already three-tier-resolved) pitch/rate/keyLock/countIn/
  // reverb settings. Defaults to NEUTRAL_CONTROLS so an engine nobody's
  // wired this up for behaves exactly as it did before this feature existed.
  let controlsResolver = () => NEUTRAL_CONTROLS;
  // A/B loop / section repeat -- deliberately session-only engine state, not
  // part of the persisted settings model (see karaoke-controls.js's doc
  // comment). null = no loop active.
  let loopRange = null; // {startBlockIndex, startTime, endBlockIndex, endTime} | null
  let loopSeeking = false; // guards against re-triggering the restart every frame while the seek/skip back to the loop start is still in flight
  // Count-in (AI_TODO.md item 4): while set, updateDucking forces the
  // active block's vocal silent (reusing the existing duck-fade machinery,
  // so it fades in smoothly rather than clicking on) until playback reaches
  // countInEndTime -- see playFromBlock.
  let countInBlock = null;
  let countInEndTime = null;

  function applyControlsToSource(source, sectionKey) {
    const resolved = controlsResolver(sectionKey) ?? NEUTRAL_CONTROLS;
    source.setPitchAndRate(resolved);
    source.setReverbAmount(resolved.reverbAmount);
    return resolved;
  }

  const listeners = { blockchange: [], timeupdate: [], ended: [], playstate: [] };
  function emit(event, ...args) {
    for (const fn of listeners[event]) fn(...args);
  }

  const activeSource = () => slots[activeIdx];
  const standbySource = () => slots[1 - activeIdx];
  const currentBlock = () => program.blocks[blockIndex] ?? null;

  function preloadNext() {
    const next = program.blocks[blockIndex + 1];
    if (!next) return;
    const source = standbySource();
    source.setUrls(urlResolver(next.instrumentalUrl), urlResolver(next.vocalUrl));
    source.setVolume(0);
    source.load();
    applyControlsToSource(source, next.sectionKey);
  }

  function cancelLoop() {
    if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    rafHandle = null;
    lastFrameTime = null;
  }

  function beginCrossfade() {
    crossfading = true;
    const next = program.blocks[blockIndex + 1];
    currentCrossfadeSeconds = crossfadeSecondsFor(currentBlock(), next);
    const source = standbySource(); // already loaded by preloadNext()
    source.setVolume(0);
    source.seekAndPlay(next.inTime);
  }

  function advanceCrossfade(timeLeft) {
    const progress = Math.min(1, Math.max(0, 1 - timeLeft / currentCrossfadeSeconds));
    activeSource().setVolume((1 - progress) * masterVolume);
    standbySource().setVolume(progress * masterVolume);
  }

  function completeCrossfade() {
    activeSource().pause();
    activeIdx = 1 - activeIdx;
    activeSource().setVolume(masterVolume);
    blockIndex += 1;
    crossfading = false;
    emit("blockchange", currentBlock(), blockIndex);
    preloadNext();
  }

  function finish() {
    isPlaying = false;
    cancelLoop();
    for (const slot of slots) slot.pause();
    emit("ended");
    emit("playstate", false);
  }

  /** Moves `source`'s vocal element's volume toward 0 (blanked) or 1 (audible) based on which word `t` currently falls in and the duck predicate -- or, while `block` is mid-count-in, forced silent regardless of the predicate (see countInBlock/countInEndTime). */
  function updateDucking(source, block, t, dtSeconds) {
    const target = block === countInBlock && t < countInEndTime ? 0 : duckTargetFor(block, t, duckPredicate);
    source.setDuckTarget(target);
    source.stepDuck(dtSeconds);
    source.resyncIfDrifted();
  }

  function tick(now) {
    const block = currentBlock();
    if (!block) return;
    const dtSeconds = lastFrameTime === null ? 1 / 60 : Math.min(0.25, Math.max(0, (now - lastFrameTime) / 1000));
    lastFrameTime = now;

    const source = activeSource();
    const t = source.currentTime;
    emit("timeupdate", t, block, blockIndex);
    updateDucking(source, block, t, dtSeconds);

    // A/B loop: jump back to the loop's start the instant playback reaches
    // its end, before any of the normal crossfade/atEnd handling below gets
    // a chance to run against a `t` that's sitting right at (or past) the
    // loop's end point -- guarded by loopSeeking so this only fires once
    // per lap, and skips the normal branch entirely while the restart
    // (an async seek/skip) is still in flight, so a stale, still-past-due
    // `t` can't also trigger a spurious crossfade/finish on the same tick.
    if (loopRange && !loopSeeking && blockIndex === loopRange.endBlockIndex && t >= loopRange.endTime) {
      loopSeeking = true;
      const resume = () => {
        loopSeeking = false;
      };
      if (loopRange.startBlockIndex === blockIndex) {
        source.seekAndPlay(loopRange.startTime).then(resume);
        rafHandle = requestAnimationFrame(tick); // same-block seek doesn't touch rafHandle itself, unlike playFromBlock below
      } else {
        playFromBlock(loopRange.startBlockIndex, loopRange.startTime).then(resume); // manages rafHandle itself
      }
      return;
    }
    if (loopSeeking) {
      rafHandle = requestAnimationFrame(tick);
      return;
    }

    const timeLeft = block.outTime - t;
    const atEnd = timeLeft <= 0 || source.ended;

    if (crossfading) {
      advanceCrossfade(timeLeft);
      const standbyBlock = program.blocks[blockIndex + 1];
      if (standbyBlock) updateDucking(standbySource(), standbyBlock, standbySource().currentTime, dtSeconds);
      if (atEnd) {
        completeCrossfade();
        if (!program.blocks[blockIndex]) {
          finish();
          return;
        }
      }
    } else {
      const next = program.blocks[blockIndex + 1];
      const upcoming = next ? crossfadeSecondsFor(block, next) : SEGMENT_CROSSFADE_SECONDS;
      if (timeLeft <= upcoming && next) {
        beginCrossfade();
      } else if (atEnd) {
        finish();
        return;
      }
    }

    rafHandle = requestAnimationFrame(tick);
  }

  async function playFromBlock(index, seekTime, { applyCountIn = false } = {}) {
    if (index < 0 || index >= program.blocks.length) return;
    await resolverReady; // AI_TODO.md item 7: let a fully-offline session's very first block resolve to its cached copy before racing playback against it -- see setUrlResolver
    cancelLoop();
    const block = program.blocks[index];
    const resolvedInstrumentalUrl = urlResolver(block.instrumentalUrl);
    const resolvedVocalUrl = urlResolver(block.vocalUrl);

    // If the standby slot already has this exact block loading/loaded (from
    // a prior preloadNext()), swap to it instead of starting a second,
    // concurrent fetch of the same URL -- some servers (and this is
    // reproducible against a plain dev server without Range support) never
    // resolve loadedmetadata for a second simultaneous request to an
    // identical URL, which would otherwise hang a manual skip forever.
    // Compared against the *resolved* URL -- preloadNext() also resolves
    // before assigning src, so this must match on the same value or an
    // offline-cached block would always (wrongly) look like a fresh source.
    const standbyMatches = standbySource().src === resolvedInstrumentalUrl;

    let source;
    if (standbyMatches) {
      activeSource().pause();
      activeIdx = 1 - activeIdx;
      source = activeSource();
    } else {
      for (const slot of slots) slot.pause();
      source = activeSource();
      source.setUrls(resolvedInstrumentalUrl, resolvedVocalUrl);
    }

    // Applied to whichever source will actually play `block` -- must run
    // after the standby-swap above settles which slot that is, not before,
    // or a swap would leave settings on the slot that's about to become
    // standby instead of the one about to play.
    const resolved = applyControlsToSource(source, block.sectionKey);
    const time = seekTime ?? block.inTime;
    // Count-in (AI_TODO.md item 4): only for a genuinely fresh start
    // (applyCountIn, set solely by play() when blockIndex was -1) -- never
    // for a manual skip/seek or an A/B loop restart, which would otherwise
    // insert an unwanted instrumental-only stretch every single lap.
    //
    // NOT implemented as "start earlier and seek into pre-roll audio" --
    // every real recording checked (scripts/build_manifest.py's output)
    // has its first word's timestamp at or extremely near 0, meaning the
    // stem files are trimmed tight to content with no instrumental lead-in
    // to seek into; seeking to a negative/nonexistent time is simply a
    // no-op, silently defeating the feature (caught by testing this against
    // real recordings, not assumed). Instead, playback starts at the
    // block's normal inTime as always, and the vocal is held silent for the
    // block's own first countInSeconds -- reusing the existing duck-fade
    // machinery below -- so the Pathfinder still hears instrumental-only
    // for a few seconds before the vocal joins, just without inventing time
    // that doesn't exist in the source audio.
    const countIn = applyCountIn ? resolved.countInSeconds : 0;
    if (countIn > 0) {
      countInBlock = block;
      countInEndTime = block.inTime + countIn;
    } else {
      countInBlock = null;
      countInEndTime = null;
    }

    blockIndex = index;
    crossfading = false;
    await source.seekAndPlay(time);
    activeSource().setVolume(masterVolume);
    isPlaying = true;
    emit("blockchange", block, blockIndex);
    emit("playstate", true);
    preloadNext();
    rafHandle = requestAnimationFrame(tick);
  }

  return {
    on(event, fn) {
      listeners[event].push(fn);
      return () => {
        listeners[event] = listeners[event].filter((f) => f !== fn);
      };
    },

    loadProgram(newProgram) {
      cancelLoop();
      for (const slot of slots) slot.unload();
      program = newProgram;
      blockIndex = -1;
      crossfading = false;
      isPlaying = false;
      // A loop range is block-index/time pairs scoped to whatever program
      // was loaded when it was set -- those indices/times could coincidentally
      // still fall within a *different* program's bounds and trigger a
      // spurious restart there, so a fresh program always starts loop-free
      // rather than carrying one over silently.
      loopRange = null;
      loopSeeking = false;
      // AI_TODO.md item 7: kicked off here so it has the whole time between
      // loadProgram() and the first playFromBlock() call to resolve --
      // .catch keeps a priming failure from hanging playback forever, just
      // falling back to whatever urlResolver returns for an unresolved URL.
      resolverReady = Promise.resolve(primeUrls(newProgram.blocks)).catch(() => {});
    },

    /**
     * Opt-in offline-cache hook (AI_TODO.md item 7), mirroring
     * setVocalDuckPredicate/setKaraokeControlsResolver's shape:
     * `resolve(url)` synchronously substitutes a locally-cached URL (e.g. a
     * blob: object URL) for whatever setUrls would otherwise assign, and
     * `prime(blocks)` is awaited once per loadProgram() call -- see
     * resolverReady above -- so a fully-offline session's very first block
     * can still resolve to its cached copy rather than racing playback
     * against it. Pass nothing (the default) to leave every URL exactly as
     * buildProgram gave it, i.e. no behavior change for a caller that never
     * opts in.
     */
    setUrlResolver({ resolve, prime } = {}) {
      urlResolver = resolve ?? ((url) => url);
      primeUrls = prime ?? (() => Promise.resolve());
    },

    /**
     * Opts into per-word vocal ducking -- `predicate(canonicalWordIndex)`
     * returns true for a word that should be silent in the vocal track
     * right now. Pass null (the default) to turn ducking off; the vocal
     * track then just plays at full volume alongside the instrumental
     * throughout, same as any block during a stretch with no blanked words.
     * Only takes effect for blocks loaded *after* the call -- study-modes/
     * unscored.js calls this once per section change, which is always
     * before the next block starts.
     */
    setVocalDuckPredicate(predicate) {
      duckPredicate = predicate ?? null;
    },

    /**
     * AI_TODO.md item 4: `resolver(sectionKey)` must return a complete
     * {pitchSemitones, rate, keyLock, countInSeconds, reverbAmount} object
     * (the caller's already-resolved three-tier settings, see
     * karaoke-controls.js's resolveKaraokeControls) -- called whenever a
     * block is about to become active or gets preloaded into standby.
     * Pass null/omit to go back to NEUTRAL_CONTROLS for every block.
     */
    setKaraokeControlsResolver(resolver) {
      controlsResolver = resolver ?? (() => NEUTRAL_CONTROLS);
    },

    /** A/B loop (AI_TODO.md item 4) -- see the loopRange/loopSeeking doc comments in tick(). Pass null to clear an active loop. */
    setLoopRange(range) {
      loopRange = range ?? null;
      loopSeeking = false;
    },

    /**
     * Resumes the shared AudioContext without touching playback state --
     * play() does this too, but always as a prelude to starting/resuming
     * block playback from wherever blockIndex is. A mode that wants to jump
     * straight to an arbitrary block+time via skipToBlock() (e.g.
     * name-that-passage.js's "Play Sample", which may be the very first
     * playback of the session) needs the resume on its own, from inside its
     * own user-gesture handler, without also triggering play()'s block-0
     * fresh-start branch.
     */
    resumeAudioContext() {
      return audioContext?.resume().catch(() => {});
    },

    play() {
      audioContext?.resume().catch(() => {}); // must be called from inside a user-gesture handler to satisfy autoplay policy -- play() always is
      if (blockIndex === -1) {
        playFromBlock(0, undefined, { applyCountIn: true });
        return;
      }
      isPlaying = true;
      activeSource().play();
      if (crossfading) standbySource().play();
      cancelLoop();
      rafHandle = requestAnimationFrame(tick);
      emit("playstate", true);
    },

    pause() {
      isPlaying = false;
      cancelLoop();
      activeSource().pause();
      if (crossfading) standbySource().pause();
      emit("playstate", false);
    },

    toggle() {
      if (isPlaying) this.pause();
      else this.play();
    },

    skipToBlock(index, time) {
      playFromBlock(index, time);
    },

    /** Read-only reference to the current program's blocks -- used by the passage view to map a clicked word to a (blockIndex, time). */
    getProgramBlocks() {
      return program.blocks;
    },

    skipToNextBlock() {
      if (blockIndex + 1 < program.blocks.length) playFromBlock(blockIndex + 1);
    },

    skipToPreviousBlock() {
      if (blockIndex > 0) playFromBlock(blockIndex - 1);
    },

    /**
     * Flat per-track volume multipliers (0-1 each), independent of the
     * crossfade envelope and any duck predicate -- Sleep Mode's
     * instrumental/vocal sliders (AI_TODO.md item 2). Applies to both slots
     * immediately (not just the currently-active one), so a block that's
     * mid-preload in the standby slot -- or becomes active later via a
     * crossfade -- already reflects it rather than only picking it up on
     * its next explicit setVolume() call.
     */
    setStemTrackVolumes(opts) {
      for (const slot of slots) slot.setTrackVolumes(opts);
    },

    /** External multiplier on top of the crossfade's own volume math -- e.g. sleep mode's fade-out. */
    setMasterVolume(v) {
      masterVolume = Math.min(1, Math.max(0, v));
      if (crossfading) {
        // Re-derive each source's crossfade progress from its current volume rather than
        // recomputing from time, so an in-flight fade keeps its relative balance.
        const priorTotal = activeSource().volume + standbySource().volume;
        const standbyShare = priorTotal > 0 ? standbySource().volume / priorTotal : 0;
        activeSource().setVolume((1 - standbyShare) * masterVolume);
        standbySource().setVolume(standbyShare * masterVolume);
      } else {
        activeSource().setVolume(masterVolume);
      }
    },

    getState() {
      const block = currentBlock();
      const source = block ? activeSource() : null;
      return {
        isPlaying,
        blockIndex,
        block,
        totalBlocks: program.blocks.length,
        currentTimeInBlock: source ? source.currentTime : 0,
        wordIndex: source ? wordIndexAtTime(block.words, source.currentTime) : -1,
      };
    },
  };
}
