import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installDom, uninstallDom } from "./helpers/dom.mjs";
import { installFakeCaches } from "./helpers/fake-caches.mjs";
import { validateManifest } from "../assets/js/library.js";
import {
  isGoogleDriveShareLink,
  resolveGoogleDriveFolder,
  readManifestFromGoogleDrive,
  readWordsAtPath,
  setActiveRoot,
  resolveUrlSync,
  primeResolverCache,
} from "../assets/js/offline/googledrive-library.js";

const SHARE_URL = "https://drive.google.com/drive/folders/root1";
const VALID_MANIFEST = {
  styles: [{ id: "hiphop", label: "Hip Hop" }],
  sections: [
    {
      book: "Mark",
      chapter: 1,
      wordCount: 0,
      verseNumbers: [],
      recordings: [
        {
          style: "hiphop",
          take: 1,
          instrumentalUrl: "Style/Mark 1.instrumental.m4a",
          vocalUrl: "Style/Mark 1.vocal.m4a",
          wordsUrl: "Style/Mark 1.json",
        },
      ],
    },
  ],
};

/**
 * A fake Drive API + media backend keyed by request URL, with a call log
 * for assertions. `rateLimit` (optional: {matchesSubstring, count,
 * status}) returns a rate-limit-shaped error for the first `count`
 * requests whose URL contains `matchesSubstring`.
 */
function makeDriveFetch({ rateLimit } = {}) {
  const calls = [];
  let retriesLeft = rateLimit?.count ?? 0;
  const fetchImpl = async (request) => {
    const url = typeof request === "string" ? request : request.url;
    calls.push(url);
    if (retriesLeft > 0 && url.includes(rateLimit.matchesSubstring)) {
      retriesLeft -= 1;
      return new Response(JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } }), {
        status: rateLimit.status ?? 403,
      });
    }
    if (url.includes("/files/root1?")) {
      return Response.json({ id: "root1", name: "PBE_2026_2027", mimeType: "application/vnd.google-apps.folder" });
    }
    if (url.includes("/files/notafolder?")) {
      return Response.json({ id: "notafolder", name: "manifest.local.json", mimeType: "application/json" });
    }
    if (url.includes("/files?") && url.includes("root1")) {
      return Response.json({
        files: [
          { id: "style1", name: "Style", mimeType: "application/vnd.google-apps.folder" },
          { id: "manifest1", name: "manifest.local.json", mimeType: "application/json" },
        ],
      });
    }
    if (url.includes("/files?") && url.includes("style1")) {
      return Response.json({
        files: [
          { id: "instr1", name: "Mark 1.instrumental.m4a", mimeType: "audio/mp4" },
          { id: "vocal1", name: "Mark 1.vocal.m4a", mimeType: "audio/mp4" },
          { id: "words1", name: "Mark 1.json", mimeType: "application/json" },
        ],
      });
    }
    if (url.includes("/files/manifest1?alt=media")) {
      return Response.json(VALID_MANIFEST);
    }
    if (url.includes("/files/instr1?alt=media")) {
      return new Response(new Uint8Array(1000), { status: 200 });
    }
    if (url.includes("/files/vocal1?alt=media")) {
      return new Response(new Uint8Array(500), { status: 200 });
    }
    if (url.includes("/files/words1?alt=media")) {
      return Response.json({ text: "In the beginning", words: [{ word: "In", start: 0, end: 0.3, verse: 1 }] });
    }
    throw new Error(`fake fetch: no stub for ${url}`);
  };
  return { fetchImpl, calls };
}

before(() => {
  installDom();
});
after(() => {
  uninstallDom();
});
beforeEach(() => {
  localStorage.clear();
  installFakeCaches();
});

test("isGoogleDriveShareLink: recognizes drive.google.com, rejects everything else", () => {
  assert.equal(isGoogleDriveShareLink("https://drive.google.com/drive/folders/abc123"), true);
  assert.equal(isGoogleDriveShareLink("https://drive.google.com/drive/u/0/folders/abc123"), true);
  assert.equal(isGoogleDriveShareLink("https://drive.google.com/open?id=abc123"), true);
  assert.equal(isGoogleDriveShareLink("https://drive.google.com/drive/folders/abc123?resourcekey=0-xyz"), true);
  assert.equal(isGoogleDriveShareLink("https://example.com/library.json"), false);
  assert.equal(isGoogleDriveShareLink("https://1drv.ms/f/c/abc/xyz"), false);
  assert.equal(isGoogleDriveShareLink("not a url"), false);
  assert.equal(isGoogleDriveShareLink(null), false);
});

test("resolveGoogleDriveFolder + readManifestFromGoogleDrive: walks the shared folder and reads/validates manifest.local.json", async () => {
  const { fetchImpl } = makeDriveFetch();
  installFakeCaches({ fetchImpl });
  const root = await resolveGoogleDriveFolder(SHARE_URL);
  const manifest = await readManifestFromGoogleDrive(root, validateManifest);
  assert.deepEqual(manifest, VALID_MANIFEST);
  assert.deepEqual(
    [...root.entries.keys()].sort(),
    ["Style/Mark 1.instrumental.m4a", "Style/Mark 1.json", "Style/Mark 1.vocal.m4a", "manifest.local.json"]
  );
});

test("resolveGoogleDriveFolder: rejects a link pointing at a file, not a folder", async () => {
  const { fetchImpl } = makeDriveFetch();
  installFakeCaches({ fetchImpl });
  await assert.rejects(resolveGoogleDriveFolder("https://drive.google.com/drive/folders/notafolder"), /points at a file, not a folder/);
});

test("readManifestFromGoogleDrive: falls back to the cached copy when a later fetch fails, same posture as gate.js's fetchManifest for a hosted URL", async () => {
  const { fetchImpl } = makeDriveFetch();
  installFakeCaches({ fetchImpl });
  const root = await resolveGoogleDriveFolder(SHARE_URL);
  const first = await readManifestFromGoogleDrive(root, validateManifest);
  assert.deepEqual(first, VALID_MANIFEST);

  // Swap only globalThis.fetch, not the whole fake Cache Storage (installFakeCaches
  // would wipe the manifest just cached above -- exactly what this test needs to survive).
  globalThis.fetch = async (request) => {
    const url = typeof request === "string" ? request : request.url;
    if (url.includes("/files/manifest1?alt=media")) throw new Error("network down");
    return fetchImpl(request);
  };
  const second = await readManifestFromGoogleDrive(root, validateManifest);
  assert.deepEqual(second, VALID_MANIFEST, "should fall back to the cached manifest, not throw");
});

test("resolveGoogleDriveFolder: a repeat call for the same share URL hits the cached index, not the Drive API again", async () => {
  const { fetchImpl, calls } = makeDriveFetch();
  installFakeCaches({ fetchImpl });
  await resolveGoogleDriveFolder(SHARE_URL);
  const callsAfterFirst = calls.length;
  await resolveGoogleDriveFolder(SHARE_URL);
  assert.equal(calls.length, callsAfterFirst, "second resolve should be a pure cache hit -- no new Drive API calls");
});

test("rate-limit handling: retries a rateLimitExceeded 403 with backoff and still succeeds", async () => {
  const { fetchImpl } = makeDriveFetch({ rateLimit: { matchesSubstring: "/files/root1?", count: 2 } });
  installFakeCaches({ fetchImpl });
  const statuses = [];
  const root = await resolveGoogleDriveFolder(SHARE_URL, (msg) => statuses.push(msg));
  assert.ok(root.entries.size > 0);
  assert.ok(statuses.length >= 2, "onRetry should fire once per rate-limited attempt before succeeding");
});

test("rate-limit handling: exhausting the retry budget throws a clear, specific error", async () => {
  const { fetchImpl } = makeDriveFetch({ rateLimit: { matchesSubstring: "/files/root1?", count: 10 } });
  installFakeCaches({ fetchImpl });
  await assert.rejects(resolveGoogleDriveFolder(SHARE_URL), /temporarily busy/);
});

test("rate-limit handling: a plain (non-rate-limit) 403 is not retried -- surfaces immediately", async () => {
  const fetchImpl = async (request) => {
    const url = typeof request === "string" ? request : request.url;
    if (url.includes("/files/root1?")) {
      return new Response(JSON.stringify({ error: { errors: [{ reason: "forbidden" }] } }), { status: 403 });
    }
    throw new Error(`fake fetch: no stub for ${url}`);
  };
  installFakeCaches({ fetchImpl });
  const statuses = [];
  await assert.rejects(resolveGoogleDriveFolder(SHARE_URL, (msg) => statuses.push(msg)), /HTTP 403/);
  assert.equal(statuses.length, 0, "a non-rate-limit 403 must not trigger a retry/backoff at all");
});

test("primeResolverCache + resolveUrlSync: fetches and caches each recording; a repeat prime never re-fetches", async () => {
  const { fetchImpl, calls } = makeDriveFetch();
  installFakeCaches({ fetchImpl });
  const root = await resolveGoogleDriveFolder(SHARE_URL);
  setActiveRoot(root);
  const blocks = [{ instrumentalUrl: "Style/Mark 1.instrumental.m4a", vocalUrl: "Style/Mark 1.vocal.m4a" }];

  await primeResolverCache(blocks);
  assert.match(resolveUrlSync("Style/Mark 1.instrumental.m4a"), /^blob:/);
  assert.match(resolveUrlSync("Style/Mark 1.vocal.m4a"), /^blob:/);

  const mediaCallsAfterFirst = calls.filter((u) => u.includes("alt=media") && (u.includes("instr1") || u.includes("vocal1"))).length;
  await primeResolverCache(blocks);
  const mediaCallsAfterSecond = calls.filter((u) => u.includes("alt=media") && (u.includes("instr1") || u.includes("vocal1"))).length;
  assert.equal(mediaCallsAfterSecond, mediaCallsAfterFirst, "an already-cached recording must not be fetched again");
});

test("readWordsAtPath: fetches, caches, and parses a recording's word-timing sidecar (wordsUrl); a repeat read never re-fetches", async () => {
  const { fetchImpl, calls } = makeDriveFetch();
  installFakeCaches({ fetchImpl });
  const root = await resolveGoogleDriveFolder(SHARE_URL);
  setActiveRoot(root);

  const json = await readWordsAtPath("Style/Mark 1.json");
  assert.deepEqual(json, { text: "In the beginning", words: [{ word: "In", start: 0, end: 0.3, verse: 1 }] });

  const mediaCallsAfterFirst = calls.filter((u) => u.includes("/files/words1?alt=media")).length;
  await readWordsAtPath("Style/Mark 1.json");
  const mediaCallsAfterSecond = calls.filter((u) => u.includes("/files/words1?alt=media")).length;
  assert.equal(mediaCallsAfterSecond, mediaCallsAfterFirst, "an already-cached sidecar must not be fetched again");
});
