import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installDom, uninstallDom } from "./helpers/dom.mjs";
import { installFakeCaches, uninstallFakeCaches } from "./helpers/fake-caches.mjs";
import { clearManifestCache, loadManifest, saveManifest, uploadCacheKey } from "../assets/js/offline/manifest-cache.js";

before(() => {
  installDom();
  installFakeCaches();
});
after(() => {
  uninstallFakeCaches();
  uninstallDom();
});

const MANIFEST = { styles: [{ id: "hiphop", label: "Hip Hop" }], sections: [] };

test("saveManifest/loadManifest: round-trips a manifest by key", async () => {
  await saveManifest("https://host/library.json", MANIFEST);
  const loaded = await loadManifest("https://host/library.json");
  assert.deepEqual(loaded, MANIFEST);
});

test("loadManifest: a key that was never saved resolves to null, not an error", async () => {
  const loaded = await loadManifest("https://host/never-saved.json");
  assert.equal(loaded, null);
});

test("uploadCacheKey: a same-origin, http(s)-shaped key -- Cache Storage rejects non-http(s) request URLs", () => {
  const key = uploadCacheKey("abc-123");
  const parsed = new URL(key);
  assert.ok(parsed.protocol === "http:" || parsed.protocol === "https:");
  assert.ok(key.includes("abc-123"));
});

test("clearManifestCache: an already-saved manifest is gone afterward", async () => {
  await saveManifest("https://host/to-clear.json", MANIFEST);
  await clearManifestCache();
  const loaded = await loadManifest("https://host/to-clear.json");
  assert.equal(loaded, null);
});
