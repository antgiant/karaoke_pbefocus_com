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
 */
export function mountUnscored(container, engine, manifest, mix, getOptions, verseFilter) {
  const view = createPassageView(container, engine, manifest, mix, verseFilter);
  const playCounts = new Map();
  let revealed = new Set();
  let hinted = new Set();

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

  return view.unmount;
}
