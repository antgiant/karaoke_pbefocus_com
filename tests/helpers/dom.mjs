// Minimal jsdom bootstrap shared by any test that exercises DOM-touching
// app code (assets/js/study-modes/word-stream.js and friends). Installs a
// fresh `document`/`window`/etc. onto globalThis for the duration of one
// test file -- call installDom() once at the top of the file and
// uninstallDom() in an `after()` hook so it doesn't leak into other files
// run in the same `node --test` process.
import { JSDOM } from "jsdom";

const GLOBAL_KEYS = ["window", "document", "HTMLElement", "Node", "Event", "KeyboardEvent", "MouseEvent", "localStorage"];

let previous = null;

export function installDom() {
  // A real http(s) URL, not the default about:blank -- localStorage throws
  // "not available for opaque origins" without one (storage.js tests need it).
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  previous = Object.fromEntries(GLOBAL_KEYS.map((k) => [k, globalThis[k]]));
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.localStorage = dom.window.localStorage;
  return dom;
}

export function uninstallDom() {
  for (const k of GLOBAL_KEYS) globalThis[k] = previous[k];
  previous = null;
}
