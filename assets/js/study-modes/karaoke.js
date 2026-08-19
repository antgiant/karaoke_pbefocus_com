import { createPassageView } from "./word-stream.js";

/** Standard karaoke: highlight the current word, dim ones already sung. */
export function mountKaraoke(container, engine, manifest, mix) {
  const view = createPassageView(container, engine, manifest, mix);
  view.setRenderWord((w) => ({ text: w.word }));
  return view.unmount;
}
