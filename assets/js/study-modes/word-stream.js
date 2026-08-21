import { colorForStyle } from "../constants.js";
import { canonicalWords, findSection, passageLabel } from "../library.js";
import { getRuns, parsePaintId } from "../mix.js";
import { wordIndexAtTime } from "../playback-engine.js";
import { stripTrailingVerseAnnouncement } from "./number-words.js";

// How many words make up one displayed line -- modeled on a typical karaoke
// line length (short enough to read at a glance, long enough to not feel
// choppy). A line never spans two verses even if that leaves it shorter
// than this (see buildLines) -- scripture verse boundaries are meaningful
// to a Pathfinder, a mid-verse line break isn't.
export const WORDS_PER_LINE = 8;

// Must match the CSS transition duration on .karaoke-line-group (styles.css)
// -- kept as one constant here so the JS timeout that removes the outgoing
// group and the CSS animation it's timed against can't drift apart.
export const LINE_TRANSITION_MS = 300;

/**
 * Splits a section's canonical words into fixed-size, verse-respecting
 * lines for the windowed karaoke display (see createPassageView below).
 * Verses outside `allowedVerses` (the per-chapter verse-filter narrowing)
 * are skipped entirely -- their words never become part of any line, the
 * same "just don't address it" treatment the old full-passage view gave
 * hidden verses.
 *
 * Returns { lines, lineOfIndex } where lines[n] = {verse, isVerseStart,
 * indices: number[]} (canonical indices, in order) and lineOfIndex is a
 * canonicalIndex -> line-number Map for O(1) lookup during playback.
 */
export function buildLines(canonical, allowedVerses, wordsPerLine = WORDS_PER_LINE) {
  const lines = [];
  const lineOfIndex = new Map();
  let currentVerse = null;
  let currentLine = null;

  canonical.forEach((w, i) => {
    if (allowedVerses && !allowedVerses.has(w.verse)) return;
    const verseChanged = w.verse !== currentVerse;
    if (currentLine === null || verseChanged || currentLine.indices.length >= wordsPerLine) {
      currentVerse = w.verse;
      currentLine = { verse: w.verse, isVerseStart: verseChanged, indices: [] };
      lines.push(currentLine);
    }
    currentLine.indices.push(i);
    lineOfIndex.set(i, lines.length - 1);
  });

  return { lines, lineOfIndex };
}

/**
 * Shared renderer for every engine-driven study mode (karaoke,
 * disappearing-word, invisible-word, blackout-ramp, sing-along): a
 * windowed, 2-line karaoke display (current line + a dimmed preview of the
 * next one) modeled on standard karaoke players -- not the whole passage
 * at once. This is what keeps a long passage from fighting a Pathfinder's
 * ability to interact with the page: there's nothing to scroll past
 * anymore, since only one line's worth of words is ever the "active" one.
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
 * recording is actually playing. It's only shown when its anchor word is
 * in the currently-displayed window -- filler tied to a line that's not on
 * screen right now is simply not shown, the same as any other off-window
 * content.
 *
 * A Pathfinder can also step through lines manually (Previous/Next
 * buttons) independent of playback -- doing so pauses the engine, so
 * browsing never fights what's actually playing. Resuming playback lets
 * the normal timeupdate-driven highlight() take back over on its own.
 * Passing `hideNav: true` (Sleep Mode -- see AI_TODO.md item 3) omits these
 * buttons entirely rather than just disabling them.
 *
 * `typing: true` (also Sleep Mode) swaps the windowing from
 * current-line+next-line-preview to previous-line (dimmed, fully sung) +
 * current-line, and renders the current line's words as individually
 * fading-in letters timed to each word's actual start/end -- a typing
 * effect locked to the audio rather than a fixed type-speed constant. Every
 * word gets a per-letter span (built once, toggled via a "shown" class) so
 * the line's full width is laid out immediately -- no reflow as letters
 * reveal, only opacity changes.
 *
 * Each mode supplies renderWord()/onPastWord() to customize how a word
 * looks without needing to know any of this section/mix/seeking/windowing
 * plumbing. Both are only ever invoked for words in the currently-rendered
 * window, not the whole passage -- masking modes (invisible-word,
 * blackout-ramp) naturally end up with less to compute per call than they
 * did against a full passage.
 */
export function createPassageView(container, engine, manifest, mix, verseFilter, { typing = false, hideNav = false } = {}) {
  container.innerHTML = "";
  container.className = "karaoke-view";
  const heading = document.createElement("p");
  heading.className = "karaoke-heading";
  const stream = document.createElement("div");
  // karaoke-window (not just karaoke-stream) so its clipping/fixed-height
  // CSS doesn't also hit type-ahead.js's own unrelated, non-windowed reuse
  // of .karaoke-stream for its growing multi-word display.
  stream.className = "karaoke-stream karaoke-window";
  const nav = document.createElement("div");
  nav.className = "karaoke-line-nav";
  nav.hidden = true;
  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "btn tiny";
  prevBtn.textContent = "‹ Previous line";
  prevBtn.setAttribute("aria-label", "Previous line (pauses playback)");
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "btn tiny";
  nextBtn.textContent = "Next line ›";
  nextBtn.setAttribute("aria-label", "Next line (pauses playback)");
  nav.append(prevBtn, nextBtn);
  container.append(heading, stream);
  if (!hideNav) container.append(nav);

  let renderWordFn = (w) => ({ text: w.word });
  let onPastWordFn = null;
  let onSectionChangeFn = null;

  let currentSectionKey = null;
  let canonical = [];
  let lines = [];
  let lineOfIndex = new Map();
  let displayedLineIndex = null;
  let wordEls = []; // sparse, canonical.length-sized: only currently-rendered indices are non-null
  let typingLetterEls = []; // sparse, canonical.length-sized, typing mode only: canonicalIndex -> that word's ordered per-letter spans
  let renderedIndices = []; // canonical indices in the current window (current + next line), for highlight()
  let location = []; // location[i] = {programIndex, time} | null, for click-to-seek
  let lastActiveIndex = -1;
  let activeFillerBlock = null;
  let fillerEls = [];
  let outgoingGroup = null;
  let outgoingTimer = null;

  function colorsForSection(sectionKey) {
    if (!mix) return null;
    const runs = getRuns(mix, sectionKey);
    if (runs.length <= 1) return null; // uniform style -- no tinting needed
    const colors = new Array(canonical.length).fill(null);
    for (const run of runs) {
      // run.styleId is actually a paint id (style + optional take, see
      // mix.js) -- colorForStyle needs the real manifest style id.
      const styleId = parsePaintId(run.styleId).styleId;
      for (let i = run.startIndex; i <= run.endIndex && i < colors.length; i++) colors[i] = styleId;
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

  let colors = null;

  function buildWordSpan(i) {
    const w = canonical[i];
    const { text, extraClass } = renderWordFn(w, i);
    const span = document.createElement("span");
    span.className = "karaoke-word" + (typing ? " typing-word" : "") + (extraClass ? ` ${extraClass}` : "");

    if (typing) {
      // Every letter (plus a trailing space, itself a "letter" so the
      // typing effect finishes it too) is in the DOM from the start,
      // opacity-hidden -- see the createPassageView doc comment for why
      // this avoids reflow as letters reveal.
      const letters = [];
      for (const ch of `${text} `) {
        const letterEl = document.createElement("span");
        letterEl.className = "letter";
        letterEl.textContent = ch;
        span.appendChild(letterEl);
        letters.push(letterEl);
      }
      typingLetterEls[i] = letters;
    } else {
      span.textContent = `${text} `;
    }

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

    wordEls[i] = span;
    return span;
  }

  /** Builds one .karaoke-line element (a verse-num marker if this line starts a new verse, then its words). */
  function buildLineElement(lineIndex, roleClass) {
    const line = lines[lineIndex];
    const el = document.createElement("p");
    el.className = `karaoke-line ${roleClass}`;
    if (line.isVerseStart) {
      const num = document.createElement("sup");
      num.className = "verse-num";
      num.textContent = String(line.verse);
      el.appendChild(num);
    }
    for (const i of line.indices) el.appendChild(buildWordSpan(i));
    return el;
  }

  function updateNavButtons() {
    nav.hidden = lines.length === 0;
    prevBtn.disabled = displayedLineIndex === null || displayedLineIndex <= 0;
    nextBtn.disabled = displayedLineIndex === null || displayedLineIndex >= lines.length - 1;
  }

  /** Swaps the displayed window to start at `lineIndex` (current line) + `lineIndex + 1` (preview). */
  function showWindow(lineIndex, { animate }) {
    if (lines.length === 0) {
      displayedLineIndex = null;
      renderedIndices = [];
      updateNavButtons();
      return;
    }
    const clamped = Math.min(Math.max(lineIndex, 0), lines.length - 1);
    if (clamped === displayedLineIndex) return;

    if (outgoingTimer !== null) {
      clearTimeout(outgoingTimer);
      outgoingGroup?.remove();
      outgoingTimer = null;
      outgoingGroup = null;
    }

    const previousGroup = animate ? stream.firstElementChild : null;

    const group = document.createElement("div");
    group.className = "karaoke-line-group";
    if (typing) {
      group.append(
        ...(clamped - 1 >= 0 ? [buildLineElement(clamped - 1, "previous-line")] : []),
        buildLineElement(clamped, "current-line")
      );
    } else {
      group.append(
        buildLineElement(clamped, "current-line"),
        ...(clamped + 1 < lines.length ? [buildLineElement(clamped + 1, "next-line")] : [])
      );
    }

    displayedLineIndex = clamped;
    renderedIndices = typing
      ? [...(lines[clamped - 1]?.indices ?? []), ...lines[clamped].indices]
      : [...lines[clamped].indices, ...(lines[clamped + 1]?.indices ?? [])];
    lastActiveIndex = -1; // force the next highlight() call to re-toggle .active/onPastWord on the new elements

    if (previousGroup) {
      previousGroup.classList.add("leaving");
      outgoingGroup = previousGroup;
      outgoingTimer = setTimeout(() => {
        previousGroup.remove();
        outgoingGroup = null;
        outgoingTimer = null;
      }, LINE_TRANSITION_MS);
      stream.appendChild(group);
    } else {
      stream.innerHTML = "";
      stream.appendChild(group);
    }

    updateNavButtons();
  }

  function renderSection(sectionKey) {
    currentSectionKey = sectionKey;
    const section = findSection(manifest, sectionKey);
    canonical = section ? canonicalWords(section) : [];
    location = section ? buildLocationMap(sectionKey) : [];
    colors = section ? colorsForSection(sectionKey) : null;
    lastActiveIndex = -1;
    activeFillerBlock = null;
    fillerEls = [];
    wordEls = new Array(canonical.length).fill(null);
    typingLetterEls = new Array(canonical.length).fill(null);

    const allowedVerses = verseFilter?.get(sectionKey) ?? null;
    const built = buildLines(canonical, allowedVerses);
    lines = built.lines;
    lineOfIndex = built.lineOfIndex;
    displayedLineIndex = null;

    heading.textContent = section ? passageLabel(section) : "";
    onSectionChangeFn?.(section, canonical);

    showWindow(0, { animate: false });
  }

  function clearFiller() {
    for (const el of fillerEls) el.remove();
    fillerEls = [];
  }

  /** Shows the spoken filler actually present in the currently-playing block, positioned right before wherever it falls in the passage -- only for anchor words in the currently-rendered window; filler for an off-window word just isn't shown. */
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

    if (canonicalIndex >= 0) {
      const targetLine = lineOfIndex.get(canonicalIndex);
      if (targetLine !== undefined && targetLine !== displayedLineIndex) {
        showWindow(targetLine, { animate: true });
      }
    }

    for (const i of renderedIndices) {
      const isPast = i < canonicalIndex;
      wordEls[i].classList.toggle("active", i === canonicalIndex);
      if (typing) {
        // Snap fully shown (past/previous line) or fully hidden (current
        // line, not reached yet) on every ci change -- the active word's
        // letter-by-letter reveal is driven per-tick by updateTypingProgress
        // below instead, so it's excluded here rather than being forced to
        // "hidden" and immediately fought over by that call in the same tick.
        if (i !== canonicalIndex) {
          for (const letterEl of typingLetterEls[i]) letterEl.classList.toggle("shown", isPast);
        }
      }
      if (onPastWordFn) onPastWordFn(wordEls[i], isPast, i, canonical[i], canonicalIndex);
      else wordEls[i].classList.toggle("sung", isPast);
    }
    lastActiveIndex = canonicalIndex;
  }

  /** Typing mode only: reveals the currently-singing word's letters in proportion to elapsed time across its known start/end -- called every timeupdate tick (unlike highlight(), which short-circuits when the active index hasn't changed) so the reveal animates smoothly within one word, not just at word boundaries. */
  function updateTypingProgress(canonicalIndex, word, t) {
    const letters = typingLetterEls[canonicalIndex];
    if (!letters) return;
    const duration = Math.max(0.001, word.end - word.start);
    const fraction = Math.min(1, Math.max(0, (t - word.start) / duration));
    const shownCount = Math.round(fraction * letters.length);
    letters.forEach((letterEl, idx) => letterEl.classList.toggle("shown", idx < shownCount));
  }

  prevBtn.addEventListener("click", () => {
    if (displayedLineIndex === null) return;
    engine.pause();
    showWindow(displayedLineIndex - 1, { animate: true });
  });
  nextBtn.addEventListener("click", () => {
    if (displayedLineIndex === null) return;
    engine.pause();
    showWindow(displayedLineIndex + 1, { animate: true });
  });

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
      const word = wordIdxInBlock >= 0 ? block.words[wordIdxInBlock] : null;
      const ci = word ? (block.canonicalIndexMap.get(word) ?? -1) : -1;
      highlight(ci);
      if (typing && ci >= 0) updateTypingProgress(ci, word, t);
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
    /** Toggles a class on a specific canonical-index word, independent of playback position (e.g. sing-along hit/miss). No-ops if that word isn't in the currently-displayed window. */
    markWord(index, className, on = true) {
      wordEls[index]?.classList.toggle(className, on);
    },
    unmount() {
      for (const off of unsubscribers) off();
      if (outgoingTimer !== null) clearTimeout(outgoingTimer);
    },
  };
}
