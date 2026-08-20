import { sectionKey } from "../library.js";
import { selectHintedIndices } from "./blank-priority.js";
import { maskedText } from "./masking.js";
import { createPassageView } from "./word-stream.js";

const RAMP_STEP_PER_REPEAT = 0.2;

/**
 * Unscored study mode ("Karaoke Mode" in the UI): one blank-until-sung
 * masking engine driven by getOptions() -> { blankFraction, rampOnRepeat,
 * lengthMatched }.
 *
 * blankFraction (0-1) is the single control for how much of the passage
 * starts blanked: 0 = nothing blanked (plain karaoke -- every word visible
 * the whole time, the UI's "Karaoke" slider end), 1 = everything blanked
 * until sung (the "Memorized" end, a full recall test). Whichever words
 * stay revealed at a given fraction are chosen by blank-priority.js
 * (semantically important words blanked first/longest), not uniform
 * randomness.
 *
 * This used to be three separate study modes (Standard Karaoke,
 * Disappearing Word, Invisible Word/Blackout Ramp) with a mask-style
 * picker between them. Disappearing Word's "vanish ahead of playback"
 * mechanic has been removed entirely (a deliberate product decision, not
 * an oversight) -- blankFraction=0 already covers plain karaoke, so the
 * mask-style picker collapsed into this one slider.
 *
 * rampOnRepeat ratchets blankFraction *up* on each replay of the *same*
 * section (spaced-repetition style: starts wherever the slider is set,
 * gets harder each time around, capped at fully blanked) -- the old
 * "Blackout Ramp" behavior, now just a checkbox alongside the slider
 * rather than a separate mode.
 *
 * getOptions().duckVocals additionally fades a blanked word's *sung* audio
 * toward silence, not just its on-screen text -- true "guess the words"
 * recall. See playback-engine.js's setVocalDuckPredicate.
 */
export function mountUnscored(container, engine, manifest, mix, getOptions, verseFilter) {
  const view = createPassageView(container, engine, manifest, mix, verseFilter);
  const playCounts = new Map();
  let revealed = new Set();
  let hinted = new Set();

  // Read once, here, rather than live via getOptions() on every call --
  // there's no UI path to flip this checkbox *while* Karaoke Mode is
  // already playing (it lives in the setup panel; changing it only takes
  // effect on the next "Start Studying" click, which tears down this mount
  // and creates a fresh one). Registered immediately -- before onSectionChange
  // has fired even once -- rather than reactively inside it below, because
  // of an ordering constraint: the engine loads a block's stem pair
  // *before* it emits "blockchange" (a block has to be loaded before
  // anything can react to it starting), but onSectionChange only fires
  // *from* that same blockchange event. A predicate set reactively there
  // would always be one block too late -- the very first block of every
  // section would incorrectly play its vocal undimmed even with duckVocals
  // on. The closure below still reads live
  // `hinted`, so it's accurate by the time it's actually *called* (from
  // playback-engine.js's tick(), well after this section's own
  // onSectionChange has already run and updated `hinted`) -- only the
  // enabled/disabled decision itself is fixed at mount time.
  if (getOptions().duckVocals) {
    engine.setVocalDuckPredicate((canonicalIdx) => !hinted.has(canonicalIdx));
  }

  view.setOnSectionChange((section, canonical) => {
    revealed = new Set();
    if (!section) {
      hinted = new Set();
      return;
    }
    const { blankFraction = 0, rampOnRepeat } = getOptions();
    let effectiveBlank = blankFraction;
    if (rampOnRepeat) {
      const key = sectionKey(section);
      const count = playCounts.get(key) ?? 0;
      playCounts.set(key, count + 1);
      effectiveBlank = Math.min(1, blankFraction + count * RAMP_STEP_PER_REPEAT);
    }
    hinted = selectHintedIndices(canonical, 1 - effectiveBlank);
  });

  view.setRenderWord((w, i) => {
    if (hinted.has(i)) {
      revealed.add(i);
      return { text: w.word };
    }
    return { text: maskedText(w.word, getOptions().lengthMatched), extraClass: "blanked" };
  });

  view.setOnPastWord((el, isPast, i, word) => {
    el.classList.toggle("sung", isPast);
    if (isPast && !revealed.has(i)) {
      el.textContent = `${word.word} `;
      el.classList.remove("blanked");
      revealed.add(i);
    }
  });

  return function unmount() {
    engine.setVocalDuckPredicate(null);
    view.unmount();
  };
}
