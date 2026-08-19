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
      timeoutId = setTimeout(finish, 8000);
    }

    if (el.readyState >= 1) start();
    else el.addEventListener("loadedmetadata", start, { once: true });
  });
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

  async function seekAndPlay(el, time) {
    await seekReliably(el, time);
    el.play().catch(() => {});
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

  async function playFromBlock(index, seekTime) {
    if (index < 0 || index >= program.blocks.length) return;
    cancelLoop();
    const block = program.blocks[index];
    const time = seekTime ?? block.inTime;

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
    await seekAndPlay(el, time);
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
