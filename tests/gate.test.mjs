import { test } from "node:test";
import assert from "node:assert/strict";
import { readManifestFile } from "../assets/js/gate.js";

function fileOf(text) {
  return new File([text], "library.json", { type: "application/json" });
}

const VALID_MANIFEST = {
  styles: [{ id: "hiphop", label: "Hip Hop" }],
  sections: [{ book: "Mark", chapter: 1, recordings: [{ style: "hiphop", take: 1, words: [] }] }],
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
