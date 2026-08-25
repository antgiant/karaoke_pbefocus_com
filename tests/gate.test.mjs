import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchManifest, isUploadIdentifier, readManifestFile } from "../assets/js/gate.js";
import { installDom, uninstallDom } from "./helpers/dom.mjs";
import { installFakeCaches, makeFetch, uninstallFakeCaches } from "./helpers/fake-caches.mjs";
import { loadManifest } from "../assets/js/offline/manifest-cache.js";

function fileOf(text) {
  return new File([text], "library.json", { type: "application/json" });
}

const VALID_MANIFEST = {
  styles: [{ id: "hiphop", label: "Hip Hop" }],
  sections: [
    {
      book: "Mark",
      chapter: 1,
      wordCount: 0,
      verseNumbers: [],
      recordings: [{ style: "hiphop", take: 1, wordsUrl: "Mark 1.json" }],
    },
  ],
};

test("readManifestFile: a well-formed manifest file resolves to the parsed manifest", async () => {
  const manifest = await readManifestFile(fileOf(JSON.stringify(VALID_MANIFEST)));
  assert.deepEqual(manifest, VALID_MANIFEST);
});

test("readManifestFile: invalid JSON rejects with a message naming the problem", async () => {
  await assert.rejects(readManifestFile(fileOf("{not json")), /did not contain valid JSON/);
});

test("readManifestFile: valid JSON that fails manifest validation rejects with validateManifest's reason", async () => {
  await assert.rejects(readManifestFile(fileOf(JSON.stringify({ styles: [] }))), /isn't a valid library manifest/);
});

test("isUploadIdentifier: distinguishes a synthetic upload identifier from a real URL", () => {
  assert.equal(isUploadIdentifier("upload:abc-123"), true);
  assert.equal(isUploadIdentifier("https://host/library.json"), false);
  assert.equal(isUploadIdentifier(null), false);
});

function jsonResponse(json, { ok = true, status = 200 } = {}) {
  return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
}

test("fetchManifest: AI_TODO.md item 7 -- persists a successful fetch, then falls back to that persisted copy the next time the network fails", async () => {
  installDom();
  installFakeCaches();
  try {
    globalThis.fetch = () => Promise.resolve(jsonResponse(VALID_MANIFEST));
    const manifest = await fetchManifest("https://host/library.json");
    assert.deepEqual(manifest, VALID_MANIFEST);
    assert.deepEqual(await loadManifest("https://host/library.json"), VALID_MANIFEST);

    globalThis.fetch = () => Promise.reject(new Error("network down"));
    const offlineManifest = await fetchManifest("https://host/library.json");
    assert.deepEqual(offlineManifest, VALID_MANIFEST, "falls back to the copy persisted on the earlier successful fetch");
  } finally {
    uninstallFakeCaches();
    uninstallDom();
  }
});

test("fetchManifest: network failure with nothing persisted yet still rejects with the original message", async () => {
  installDom();
  installFakeCaches();
  try {
    globalThis.fetch = () => Promise.reject(new Error("network down"));
    await assert.rejects(fetchManifest("https://host/never-fetched.json"), /Could not reach that URL/);
  } finally {
    uninstallFakeCaches();
    uninstallDom();
  }
});
