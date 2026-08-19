import { colorForStyle } from "../constants.js";
import { canonicalWords, findSection, passageLabel } from "../library.js";
import { getRuns } from "../mix.js";
import { wordIndexAtTime } from "../playback-engine.js";
import { stripTrailingVerseAnnouncement } from "./number-words.js";

/**
 * Shared renderer for every engine-driven study mode (karaoke,
 * disappearing-word, invisible-word, blackout-ramp, sing-along): always
 * shows the *complete* passage for the currently active section -- grouped
 * into verses with verse-number markers, like a printed Bible -- rather
 * than just whatever word range the currently-playing audio block happens
 * to cover. For a mixed-genre section that means words from parts not
 * currently playing are still shown, tinted by whichever style they're
 * assigned to.
 *
 * Word-to-canonical-index mapping is NOT recomputed here -- it's read
 * directly off each program block's `canonicalIndexMap` (built once in
 * program-builder.js from the *full* recording). Re-deriving it from a
 * block's own time-sliced word array was the bug that broke both
 * highlighting and click-seeking whenever a genre run started or ended
 * mid-verse: position-within-verse has to be counted across the whole
 * take, not reset at wherever a slice happens to start.
 *
 * Clicking (or Enter/Space-activating) a word seeks playback there,
 * including across a genre boundary into a different block/recording --
 * built from a canonical-index -> {programIndex, time} lookup over every
 * block belonging to the active section.
 *
 * Spoken filler (chapter titles, spoken verse-number callouts -- anything
 * not part of the canonical/addressable text) belongs to whichever
 * recording is actually playing, so it's shown only for the currently
 * active block, inserted right before wherever it falls and removed again
 * when a different block becomes active.
 *
 * Each mode supplies renderWord()/onPastWord() to customize how a word
 * looks without needing to know any of this section/mix/seeking plumbing.
 */
export function createPassageView(container, engine, manifest, mix) {
  container.innerHTML = "";
  container.className = "karaoke-view";
  const heading = document.createElement("p");
  heading.className = "karaoke-heading";
  const stream = document.createElement("div");
  stream.className = "karaoke-stream";
  container.append(heading, stream);

  let renderWordFn = (w) => ({ text: w.word });
  let onPastWordFn = null;
  let onSectionChangeFn = null;

  let currentSectionKey = null;
  let canonical = [];
  let wordEls = [];
  let location = []; // location[i] = {programIndex, time} | null, for click-to-seek
  let lastActiveIndex = -1;
  let activeFillerBlock = null;
  let fillerEls = [];

  function colorsForSection(sectionKey) {
    if (!mix) return null;
    const runs = getRuns(mix, sectionKey);
    if (runs.length <= 1) return null; // uniform style -- no tinting needed
    const colors = new Array(canonical.length).fill(null);
    for (const run of runs) {
      for (let i = run.startIndex; i <= run.endIndex && i < colors.length; i++) colors[i] = run.styleId;
    }
    return colors;
  }

  function buildLocationMap(sectionKey) {
    const map = new Array(canonical.length).fill(null);
    const blocks = engine.getProgramBlocks();
    blocks.forEach((block, programIndex) => {
      if (block.sectionKey !== sectionKey) return;
      block.words.forEach((w) => {
        const ci = block.canonicalIndexMap.get(w);
        if (ci !== undefined) map[ci] = { programIndex, time: w.start };
      });
    });
    return map;
  }

  function renderSection(sectionKey) {
    currentSectionKey = sectionKey;
    const section = findSection(manifest, sectionKey);
    canonical = section ? canonicalWords(section) : [];
    location = section ? buildLocationMap(sectionKey) : [];
    const colors = section ? colorsForSection(sectionKey) : null;
    lastActiveIndex = -1;
    activeFillerBlock = null;
    fillerEls = [];

    heading.textContent = section ? passageLabel(section) : "";
    stream.innerHTML = "";
    wordEls = [];
    onSectionChangeFn?.(section, canonical);

    let openVerse;
    let verseEl = null;
    canonical.forEach((w, i) => {
      if (verseEl === null || w.verse !== openVerse) {
        openVerse = w.verse;
        verseEl = document.createElement("p");
        verseEl.className = "karaoke-verse";
        const num = document.createElement("sup");
        num.className = "verse-num";
        num.textContent = String(openVerse);
        verseEl.appendChild(num);
        stream.appendChild(verseEl);
      }

      const { text, extraClass } = renderWordFn(w, i);
      const span = document.createElement("span");
      span.className = "karaoke-word" + (extraClass ? ` ${extraClass}` : "");
      span.textContent = `${text} `;

      const loc = location[i];
      if (loc) {
        span.classList.add("clickable");
        span.tabIndex = 0;
        span.setAttribute("role", "button");
        span.setAttribute("aria-label", `Jump playback to "${w.word}"`);
        const seek = () => engine.skipToBlock(loc.programIndex, loc.time);
        span.addEventListener("click", seek);
        span.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            seek();
          }
        });
      }

      if (colors && colors[i]) {
        span.classList.add("genre-colored");
        span.style.setProperty("--word-color", colorForStyle(colors[i], manifest.styles));
      }

      verseEl.appendChild(span);
      wordEls.push(span);
    });
  }

  function clearFiller() {
    for (const el of fillerEls) el.remove();
    fillerEls = [];
  }

  /** Shows the spoken filler actually present in the currently-playing block, positioned right before wherever it falls in the passage. */
  function updateFillerForBlock(block) {
    if (block === activeFillerBlock) return;
    clearFiller();
    activeFillerBlock = block;
    if (!block) return;

    let pending = [];
    let lastRealIndex = -1;
    const flushBefore = (anchorEl, targetVerse) => {
      const toShow = stripTrailingVerseAnnouncement(pending, targetVerse);
      for (const w of toShow) {
        const span = document.createElement("span");
        span.className = "karaoke-word filler";
        span.textContent = `${w.word} `;
        anchorEl.parentNode.insertBefore(span, anchorEl);
        fillerEls.push(span);
      }
      pending = [];
    };

    for (const w of block.words) {
      const ci = block.canonicalIndexMap.get(w);
      if (ci === undefined) {
        pending.push(w);
        continue;
      }
      if (pending.length > 0 && wordEls[ci]) flushBefore(wordEls[ci], canonical[ci]?.verse);
      pending = [];
      lastRealIndex = ci;
    }
    if (pending.length > 0 && lastRealIndex >= 0 && wordEls[lastRealIndex]) {
      // Trailing filler after this block's last real word (e.g. a closing refrain) -- append right after it.
      const anchor = wordEls[lastRealIndex];
      let insertPoint = anchor.nextSibling;
      for (const w of pending) {
        const span = document.createElement("span");
        span.className = "karaoke-word filler";
        span.textContent = `${w.word} `;
        anchor.parentNode.insertBefore(span, insertPoint);
        fillerEls.push(span);
      }
    }
  }

  function highlight(canonicalIndex) {
    if (canonicalIndex === lastActiveIndex) return;
    for (let i = 0; i < wordEls.length; i++) {
      const isPast = i < canonicalIndex;
      wordEls[i].classList.toggle("active", i === canonicalIndex);
      if (onPastWordFn) onPastWordFn(wordEls[i], isPast, i, canonical[i], canonicalIndex);
      else wordEls[i].classList.toggle("sung", isPast);
    }
    // Only nudge the scroll position when the active word has actually left
    // the visible area -- scrolling on every single word (this fires roughly
    // once per second during playback) would otherwise fight a Pathfinder
    // trying to manually scroll or click elsewhere in the passage while
    // audio keeps playing.
    if (canonicalIndex >= 0 && wordEls[canonicalIndex] && !isReasonablyInView(wordEls[canonicalIndex])) {
      wordEls[canonicalIndex].scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }
    lastActiveIndex = canonicalIndex;
  }

  function isReasonablyInView(el) {
    const rect = el.getBoundingClientRect();
    const margin = window.innerHeight * 0.15;
    return rect.top >= margin && rect.bottom <= window.innerHeight - margin;
  }

  const unsubscribers = [
    engine.on("blockchange", (block) => {
      if (block && block.sectionKey !== currentSectionKey) renderSection(block.sectionKey);
      updateFillerForBlock(block);
    }),
    engine.on("timeupdate", (t, block) => {
      if (!block) return;
      if (block.sectionKey !== currentSectionKey) renderSection(block.sectionKey);
      updateFillerForBlock(block);
      const wordIdxInBlock = wordIndexAtTime(block.words, t);
      const ci = wordIdxInBlock >= 0 ? (block.canonicalIndexMap.get(block.words[wordIdxInBlock]) ?? -1) : -1;
      highlight(ci);
    }),
  ];

  const initial = engine.getState();
  if (initial.block) {
    renderSection(initial.block.sectionKey);
    updateFillerForBlock(initial.block);
  }

  return {
    setRenderWord(fn) {
      renderWordFn = fn;
    },
    setOnPastWord(fn) {
      onPastWordFn = fn;
    },
    setOnSectionChange(fn) {
      onSectionChangeFn = fn;
    },
    getCanonical() {
      return canonical;
    },
    /** Toggles a class on a specific canonical-index word, independent of playback position (e.g. sing-along hit/miss). */
    markWord(index, className, on = true) {
      wordEls[index]?.classList.toggle(className, on);
    },
    unmount() {
      for (const off of unsubscribers) off();
    },
  };
}
