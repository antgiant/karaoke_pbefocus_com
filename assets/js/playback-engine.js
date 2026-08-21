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

/** A synced instrumental+vocal pair -- every block plays through one of these (see the file-top comment). Normally both elements play at the same volume (envelopeVolume); a caller that's set a duck predicate additionally scales the vocal element by duckFactor, faded toward its target over DUCK_TIME_CONSTANT_SECONDS. Timing (word-level ducking) is driven by the block's own recording.words, since both stems share the original recording's word timing. */
function makeSource() {
  const instrumentalEl = new Audio();
  const vocalEl = new Audio();
  instrumentalEl.preload = "auto";
  vocalEl.preload = "auto";
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

  function applyVolumes() {
    instrumentalEl.volume = envelopeVolume * instrumentalTrackVolume;
    vocalEl.volume = envelopeVolume * duckFactor * vocalTrackVolume;
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
  };
}

export function createPlaybackEngine() {
  // Two slots (today's "active"/"standby" elements), each a synced
  // instrumental+vocal pair -- see makeSource().
  const slots = [makeSource(), makeSource()];

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
    source.setUrls(next.instrumentalUrl, next.vocalUrl);
    source.setVolume(0);
    source.load();
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

  /** Moves `source`'s vocal element's volume toward 0 (blanked) or 1 (audible) based on which word `t` currently falls in and the duck predicate. */
  function updateDucking(source, block, t, dtSeconds) {
    source.setDuckTarget(duckTargetFor(block, t, duckPredicate));
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

  async function playFromBlock(index, seekTime) {
    if (index < 0 || index >= program.blocks.length) return;
    cancelLoop();
    const block = program.blocks[index];
    const time = seekTime ?? block.inTime;

    // If the standby slot already has this exact block loading/loaded (from
    // a prior preloadNext()), swap to it instead of starting a second,
    // concurrent fetch of the same URL -- some servers (and this is
    // reproducible against a plain dev server without Range support) never
    // resolve loadedmetadata for a second simultaneous request to an
    // identical URL, which would otherwise hang a manual skip forever.
    const standbyMatches = standbySource().src === block.instrumentalUrl;

    let source;
    if (standbyMatches) {
      activeSource().pause();
      activeIdx = 1 - activeIdx;
      source = activeSource();
    } else {
      for (const slot of slots) slot.pause();
      source = activeSource();
      source.setUrls(block.instrumentalUrl, block.vocalUrl);
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

    play() {
      if (blockIndex === -1) {
        playFromBlock(0);
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
