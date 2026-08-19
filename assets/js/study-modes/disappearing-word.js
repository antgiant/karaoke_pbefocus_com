import { createPassageView } from "./word-stream.js";

/**
 * Words vanish instead of just dimming. getLookahead() controls how far
 * ahead of the actual playback position the vanish boundary sits: 0 (the
 * default) hides only words already sung -- the currently-playing word
 * stays visible until it finishes. 1 hides the currently-playing word too,
 * as soon as it starts. 2 also hides the next upcoming word, etc. -- each
 * step forces recall one word further ahead of the audio.
 */
export function mountDisappearingWord(container, engine, manifest, mix, getLookahead = () => 0) {
  const view = createPassageView(container, engine, manifest, mix);
  view.setRenderWord((w) => ({ text: w.word }));
  view.setOnPastWord((el, isPast, i, word, activeIndex) => {
    const gone = activeIndex >= 0 && i < activeIndex + getLookahead();
    el.classList.toggle("gone", gone);
  });
  return view.unmount;
}
