import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

test("version.js fills the footer's version element", async () => {
  const dom = new JSDOM('<span id="appVersion"></span>');
  globalThis.document = dom.window.document;
  const { APP_VERSION } = await import("../assets/js/version.js");
  assert.match(APP_VERSION, /^(dev|\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7})$/);
  assert.equal(dom.window.document.getElementById("appVersion").textContent, APP_VERSION === "dev" ? "dev build" : `v${APP_VERSION}`);
  delete globalThis.document;
});

test("index.html has the footer element and loads version.js", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /id="appVersion"/);
  assert.match(html, /assets\/js\/version\.js/);
});
