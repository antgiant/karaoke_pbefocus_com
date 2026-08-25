import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeFakeRoot } from "./helpers/fake-fs.mjs";
import { validateManifest } from "../assets/js/library.js";
import {
  isLocalIdentifier,
  isFileSystemAccessSupported,
  readManifestFromHandle,
  readWordsAtPath,
  setActiveRoot,
  resolveUrlSync,
  primeResolverCache,
} from "../assets/js/offline/local-library.js";

let objectUrlCounter = 0;
beforeEach(() => {
  globalThis.URL.createObjectURL = (file) => `blob:test-${file.name}-${objectUrlCounter++}`;
});

test("isLocalIdentifier: distinguishes a synthetic local-folder identifier from a real URL or upload identifier", () => {
  assert.equal(isLocalIdentifier("local:abc-123"), true);
  assert.equal(isLocalIdentifier("upload:abc-123"), false);
  assert.equal(isLocalIdentifier("https://host/library.json"), false);
  assert.equal(isLocalIdentifier(null), false);
});

test("isFileSystemAccessSupported: reflects window.showDirectoryPicker's presence", () => {
  const previous = globalThis.window;
  globalThis.window = {};
  assert.equal(isFileSystemAccessSupported(), false);
  globalThis.window = { showDirectoryPicker: () => {} };
  assert.equal(isFileSystemAccessSupported(), true);
  globalThis.window = previous;
});

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

test("readManifestFromHandle: reads and validates manifest.local.json from the picked folder's root", async () => {
  const root = makeFakeRoot({ "manifest.local.json": JSON.stringify(VALID_MANIFEST) });
  const manifest = await readManifestFromHandle(root, validateManifest);
  assert.deepEqual(manifest, VALID_MANIFEST);
});

test("readManifestFromHandle: missing manifest.local.json rejects with a message pointing at how to generate one", async () => {
  const root = makeFakeRoot({});
  await assert.rejects(readManifestFromHandle(root, validateManifest), /No "manifest\.local\.json" found/);
});

test("readManifestFromHandle: a file handle that can't actually be read (e.g. a cloud-sync placeholder still hydrating) rejects with a distinct, actionable message -- not the 'not found' or 'invalid JSON' ones", async () => {
  const ioError = new Error("NetworkError: the requested file could not be read, typically due to permission problems");
  const root = makeFakeRoot({ "manifest.local.json": ioError });
  await assert.rejects(readManifestFromHandle(root, validateManifest), /Could not read "manifest\.local\.json".*cloud-synced/s);
});

test("readManifestFromHandle: invalid JSON rejects with a clear message", async () => {
  const root = makeFakeRoot({ "manifest.local.json": "{not json" });
  await assert.rejects(readManifestFromHandle(root, validateManifest), /did not contain valid JSON/);
});

test("readManifestFromHandle: valid JSON failing manifest validation rejects with validateManifest's reason", async () => {
  const root = makeFakeRoot({ "manifest.local.json": JSON.stringify({ styles: [] }) });
  await assert.rejects(readManifestFromHandle(root, validateManifest), /isn't a valid library manifest/);
});

test("primeResolverCache + resolveUrlSync: resolves nested relative paths to blob: URLs", async () => {
  const root = makeFakeRoot({
    PBE_2026_2027_Broadway: {
      "Mark 6_30-56 (NKJV) (14).instrumental.m4a": "instrumental-bytes",
      "Mark 6_30-56 (NKJV) (14).vocal.m4a": "vocal-bytes",
    },
  });
  setActiveRoot(root);
  const instrumentalUrl = "PBE_2026_2027_Broadway/Mark 6_30-56 (NKJV) (14).instrumental.m4a";
  const vocalUrl = "PBE_2026_2027_Broadway/Mark 6_30-56 (NKJV) (14).vocal.m4a";

  // Before priming, an unresolved path just passes through unchanged.
  assert.equal(resolveUrlSync(instrumentalUrl), instrumentalUrl);

  await primeResolverCache([{ instrumentalUrl, vocalUrl }]);
  assert.match(resolveUrlSync(instrumentalUrl), /^blob:/);
  assert.match(resolveUrlSync(vocalUrl), /^blob:/);
  assert.notEqual(resolveUrlSync(instrumentalUrl), resolveUrlSync(vocalUrl));
});

test("primeResolverCache: a path that no longer exists in the picked folder rejects (no fallback -- see local-library.js's file-top comment)", async () => {
  const root = makeFakeRoot({ PBE_2026_2027_Broadway: {} });
  setActiveRoot(root);
  const missingUrl = "PBE_2026_2027_Broadway/does-not-exist.m4a";
  await assert.rejects(primeResolverCache([{ instrumentalUrl: missingUrl, vocalUrl: missingUrl }]));
});

test("setActiveRoot: switching folders clears any previously resolved blob: URLs", async () => {
  const rootA = makeFakeRoot({ "a.m4a": "a-bytes" });
  setActiveRoot(rootA);
  await primeResolverCache([{ instrumentalUrl: "a.m4a", vocalUrl: "a.m4a" }]);
  assert.match(resolveUrlSync("a.m4a"), /^blob:/);

  const rootB = makeFakeRoot({});
  setActiveRoot(rootB);
  assert.equal(resolveUrlSync("a.m4a"), "a.m4a", "stale entry from the old root must not leak into the new one");
});

test("readWordsAtPath: reads and parses a recording's word-timing sidecar (wordsUrl) straight off disk", async () => {
  const wordsJson = { text: "In the beginning", words: [{ word: "In", start: 0, end: 0.3, verse: 1 }] };
  const root = makeFakeRoot({
    PBE_2026_2027_Broadway: { "Mark 1.json": JSON.stringify(wordsJson) },
  });
  setActiveRoot(root);
  const json = await readWordsAtPath("PBE_2026_2027_Broadway/Mark 1.json");
  assert.deepEqual(json, wordsJson);
});

test("readWordsAtPath: no active local library folder rejects with a clear message", async () => {
  setActiveRoot(null);
  await assert.rejects(readWordsAtPath("anything.json"), /No local library folder is active/);
});
