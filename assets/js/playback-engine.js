// Drives a program (see program-builder.js) through two <audio> elements
// played back-to-back, with a short volume crossfade over the seam between
// blocks (different recordings, so it's a smoothing touch, not a promise of
// a studio-seamless splice -- see the mix-editor UX notes in the plan).

const CROSSFADE_SECONDS = 0.35;

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

export function createPlaybackEngine() {
  const elements = [new Audio(), new Audio()];
  for (const el of elements) el.preload = "auto";

  let activeIdx = 0;
  let program = { blocks: [] };
  let blockIndex = -1;
  let crossfading = false;
  let isPlaying = false;
  let rafHandle = null;
  let masterVolume = 1; // external multiplier (e.g. sleep mode's fade-out), on top of crossfade's own volume math

  const listeners = { blockchange: [], timeupdate: [], ended: [], playstate: [] };
  function emit(event, ...args) {
    for (const fn of listeners[event]) fn(...args);
  }

  const activeEl = () => elements[activeIdx];
  const standbyEl = () => elements[1 - activeIdx];
  const currentBlock = () => program.blocks[blockIndex] ?? null;

  function seekAndPlay(el, time) {
    return new Promise((resolve) => {
      function onReady() {
        el.removeEventListener("loadedmetadata", onReady);
        try {
          el.currentTime = time;
        } catch {
          // metadata not ready in some browsers even at readyState 1 -- next tick's
          // timeupdate-driven logic tolerates a slightly-off start time.
        }
        el.play().catch(() => {});
        resolve();
      }
      if (el.readyState >= 1) onReady();
      else el.addEventListener("loadedmetadata", onReady);
    });
  }

  function preloadNext() {
    const next = program.blocks[blockIndex + 1];
    if (!next) return;
    const el = standbyEl();
    if (el.src !== next.audioUrl) el.src = next.audioUrl;
    el.volume = 0;
    el.load();
  }

  function cancelLoop() {
    if (rafHandle !== null) cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }

  function beginCrossfade() {
    crossfading = true;
    const next = program.blocks[blockIndex + 1];
    const el = standbyEl();
    el.volume = 0;
    seekAndPlay(el, next.inTime);
  }

  function advanceCrossfade(timeLeft) {
    const progress = Math.min(1, Math.max(0, 1 - timeLeft / CROSSFADE_SECONDS));
    activeEl().volume = (1 - progress) * masterVolume;
    standbyEl().volume = progress * masterVolume;
  }

  function completeCrossfade() {
    activeEl().pause();
    activeIdx = 1 - activeIdx;
    activeEl().volume = masterVolume;
    blockIndex += 1;
    crossfading = false;
    emit("blockchange", currentBlock(), blockIndex);
    preloadNext();
  }

  function finish() {
    isPlaying = false;
    cancelLoop();
    for (const el of elements) el.pause();
    emit("ended");
    emit("playstate", false);
  }

  function tick() {
    const block = currentBlock();
    if (!block) return;
    const el = activeEl();
    const t = el.currentTime;
    emit("timeupdate", t, block, blockIndex);

    const timeLeft = block.outTime - t;
    const atEnd = timeLeft <= 0 || el.ended;

    if (crossfading) {
      advanceCrossfade(timeLeft);
      if (atEnd) {
        completeCrossfade();
        if (!program.blocks[blockIndex]) {
          finish();
          return;
        }
      }
    } else if (timeLeft <= CROSSFADE_SECONDS && blockIndex + 1 < program.blocks.length) {
      beginCrossfade();
    } else if (atEnd) {
      finish();
      return;
    }

    rafHandle = requestAnimationFrame(tick);
  }

  async function playFromBlock(index) {
    if (index < 0 || index >= program.blocks.length) return;
    cancelLoop();
    const block = program.blocks[index];

    // If the standby element already has this exact URL loading/loaded (from
    // a prior preloadNext()), swap to it instead of starting a second,
    // concurrent fetch of the same URL on the other element -- some servers
    // (and this is reproducible against a plain dev server without Range
    // support) never resolve loadedmetadata for a second simultaneous
    // request to an identical URL, which would otherwise hang a manual
    // skip forever.
    let el;
    if (standbyEl().src === block.audioUrl) {
      activeEl().pause();
      activeIdx = 1 - activeIdx;
      el = activeEl();
    } else {
      for (const other of elements) other.pause();
      el = activeEl();
      if (el.src !== block.audioUrl) el.src = block.audioUrl;
    }

    blockIndex = index;
    crossfading = false;
    await seekAndPlay(el, block.inTime);
    activeEl().volume = masterVolume;
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
      for (const el of elements) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
      program = newProgram;
      blockIndex = -1;
      crossfading = false;
      isPlaying = false;
    },

    play() {
      if (blockIndex === -1) {
        playFromBlock(0);
        return;
      }
      isPlaying = true;
      activeEl().play().catch(() => {});
      if (crossfading) standbyEl().play().catch(() => {});
      cancelLoop();
      rafHandle = requestAnimationFrame(tick);
      emit("playstate", true);
    },

    pause() {
      isPlaying = false;
      cancelLoop();
      activeEl().pause();
      if (crossfading) standbyEl().pause();
      emit("playstate", false);
    },

    toggle() {
      if (isPlaying) this.pause();
      else this.play();
    },

    skipToBlock(index) {
      playFromBlock(index);
    },

    skipToNextBlock() {
      if (blockIndex + 1 < program.blocks.length) playFromBlock(blockIndex + 1);
    },

    skipToPreviousBlock() {
      if (blockIndex > 0) playFromBlock(blockIndex - 1);
    },

    /** External multiplier on top of the crossfade's own volume math -- e.g. sleep mode's fade-out. */
    setMasterVolume(v) {
      masterVolume = Math.min(1, Math.max(0, v));
      if (crossfading) {
        // Re-derive each element's crossfade progress from its current volume rather than
        // recomputing from time, so an in-flight fade keeps its relative balance.
        const priorTotal = activeEl().volume + standbyEl().volume;
        const standbyShare = priorTotal > 0 ? standbyEl().volume / priorTotal : 0;
        activeEl().volume = (1 - standbyShare) * masterVolume;
        standbyEl().volume = standbyShare * masterVolume;
      } else {
        activeEl().volume = masterVolume;
      }
    },

    getState() {
      const block = currentBlock();
      return {
        isPlaying,
        blockIndex,
        block,
        totalBlocks: program.blocks.length,
        currentTimeInBlock: block ? activeEl().currentTime : 0,
        wordIndex: block ? wordIndexAtTime(block.words, activeEl().currentTime) : -1,
      };
    },
  };
}
