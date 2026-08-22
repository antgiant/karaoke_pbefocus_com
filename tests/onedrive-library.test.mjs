import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installDom, uninstallDom } from "./helpers/dom.mjs";
import { installFakeCaches, uninstallFakeCaches } from "./helpers/fake-caches.mjs";
import { validateManifest } from "../assets/js/library.js";
import {
  isOneDriveShareLink,
  signIn,
  resolveOneDriveFolder,
  readManifestFromOneDrive,
  setActiveRoot,
  resolveUrlSync,
  primeResolverCache,
} from "../assets/js/offline/onedrive-library.js";

const SHARE_URL = "https://1drv.ms/f/c/abc123/fakeshare";
const VALID_MANIFEST = {
  styles: [{ id: "hiphop", label: "Hip Hop" }],
  sections: [
    {
      book: "Mark",
      chapter: 1,
      recordings: [
        { style: "hiphop", take: 1, instrumentalUrl: "Style/Mark 1.instrumental.m4a", vocalUrl: "Style/Mark 1.vocal.m4a", words: [] },
      ],
    },
  ],
};

/**
 * A fake Graph + CDN backend keyed by request URL, with a call log for
 * assertions. `retry429` (optional: {matchesSubstring, count}) returns a
 * 429 for the first `count` requests whose URL contains
 * `matchesSubstring` -- a substring match rather than an exact URL,
 * deliberately, so tests don't have to hand-compute the exact
 * `u!<base64url>`-encoded shares URL themselves.
 */
function makeGraphFetch({ retry429 } = {}) {
  const calls = [];
  let retriesLeft = retry429?.count ?? 0;
  const fetchImpl = async (request) => {
    const url = typeof request === "string" ? request : request.url;
    calls.push(url);
    if (retriesLeft > 0 && url.includes(retry429.matchesSubstring)) {
      retriesLeft -= 1;
      return new Response("", { status: 429, headers: { "Retry-After": "0" } });
    }
    if (url.includes("/shares/") && url.includes("/driveItem")) {
      return Response.json({ id: "root1", name: "PBE_2026_2027", folder: {}, parentReference: { driveId: "drive1" } });
    }
    if (url.includes("/drives/drive1/items/root1/children")) {
      return Response.json({
        value: [
          { id: "style1", name: "Style", folder: {} },
          { id: "manifest1", name: "manifest.local.json", size: 10 },
        ],
      });
    }
    if (url.includes("/drives/drive1/items/style1/children")) {
      return Response.json({
        value: [
          { id: "instr1", name: "Mark 1.instrumental.m4a", size: 100 },
          { id: "vocal1", name: "Mark 1.vocal.m4a", size: 50 },
        ],
      });
    }
    if (url.includes("/items/manifest1?")) {
      return Response.json({ "@microsoft.graph.downloadUrl": "https://cdn.example/manifest1" });
    }
    if (url === "https://cdn.example/manifest1") {
      return Response.json(VALID_MANIFEST);
    }
    if (url.includes("/items/instr1?")) {
      return Response.json({ "@microsoft.graph.downloadUrl": "https://cdn.example/instr1" });
    }
    if (url === "https://cdn.example/instr1") {
      return new Response(new Uint8Array(1000), { status: 200 });
    }
    if (url.includes("/items/vocal1?")) {
      return Response.json({ "@microsoft.graph.downloadUrl": "https://cdn.example/vocal1" });
    }
    if (url === "https://cdn.example/vocal1") {
      return new Response(new Uint8Array(500), { status: 200 });
    }
    throw new Error(`fake fetch: no stub for ${url}`);
  };
  return { fetchImpl, calls };
}

class FakePublicClientApplication {
  constructor() {
    this.accounts = [];
  }
  async initialize() {}
  getAllAccounts() {
    return this.accounts;
  }
  async acquireTokenSilent() {
    throw new Error("no cached session");
  }
  async loginPopup() {
    this.accounts = [{ homeAccountId: "fake" }];
    return { accessToken: "fake-token" };
  }
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
  window.msal = { PublicClientApplication: FakePublicClientApplication };
});

test("isOneDriveShareLink: recognizes 1drv.ms/onedrive.live.com/sharepoint.com, rejects everything else", () => {
  assert.equal(isOneDriveShareLink("https://1drv.ms/f/c/abc/xyz"), true);
  assert.equal(isOneDriveShareLink("https://onedrive.live.com/?id=abc"), true);
  assert.equal(isOneDriveShareLink("https://contoso.sharepoint.com/:f:/g/abc"), true);
  assert.equal(isOneDriveShareLink("https://example.com/library.json"), false);
  assert.equal(isOneDriveShareLink("not a url"), false);
  assert.equal(isOneDriveShareLink(null), false);
});

test("signIn: no cached account falls back to the interactive popup and returns its token", async () => {
  const token = await signIn();
  assert.equal(token, "fake-token");
});

test("resolveOneDriveFolder + readManifestFromOneDrive: walks the shared folder and reads/validates manifest.local.json", async () => {
  const { fetchImpl } = makeGraphFetch();
  installFakeCaches({ fetchImpl });
  const root = await resolveOneDriveFolder(SHARE_URL, "fake-token");
  const manifest = await readManifestFromOneDrive(root, "fake-token", validateManifest);
  assert.deepEqual(manifest, VALID_MANIFEST);
  assert.deepEqual([...root.entries.keys()].sort(), ["Style/Mark 1.instrumental.m4a", "Style/Mark 1.vocal.m4a", "manifest.local.json"]);
});

test("readManifestFromOneDrive: falls back to the cached copy when a later fetch fails, same posture as gate.js's fetchManifest for a hosted URL", async () => {
  const { fetchImpl } = makeGraphFetch();
  installFakeCaches({ fetchImpl });
  const root = await resolveOneDriveFolder(SHARE_URL, "fake-token");
  const first = await readManifestFromOneDrive(root, "fake-token", validateManifest);
  assert.deepEqual(first, VALID_MANIFEST);

  // Swap only globalThis.fetch, not the whole fake Cache Storage (installFakeCaches
  // would wipe the manifest just cached above -- exactly what this test needs to survive).
  globalThis.fetch = async (request) => {
    const url = typeof request === "string" ? request : request.url;
    if (url === "https://cdn.example/manifest1") throw new Error("network down");
    return fetchImpl(request);
  };
  const second = await readManifestFromOneDrive(root, "fake-token", validateManifest);
  assert.deepEqual(second, VALID_MANIFEST, "should fall back to the cached manifest, not throw");
});

test("resolveOneDriveFolder: a repeat call for the same share URL hits the cached index, not Graph again", async () => {
  const { fetchImpl, calls } = makeGraphFetch();
  installFakeCaches({ fetchImpl });
  await resolveOneDriveFolder(SHARE_URL, "fake-token");
  const callsAfterFirst = calls.length;
  await resolveOneDriveFolder(SHARE_URL, "fake-token");
  assert.equal(calls.length, callsAfterFirst, "second resolve should be a pure cache hit -- no new Graph calls");
});

test("429 handling: retries after Retry-After and still succeeds", async () => {
  const { fetchImpl } = makeGraphFetch({ retry429: { matchesSubstring: "/driveItem", count: 2 } });
  installFakeCaches({ fetchImpl });
  const statuses = [];
  const root = await resolveOneDriveFolder(SHARE_URL, "fake-token", (msg) => statuses.push(msg));
  assert.ok(root.entries.size > 0);
  assert.ok(statuses.length >= 2, "onRetry should fire once per 429 before succeeding");
});

test("429 handling: exhausting the retry budget throws a clear, specific error", async () => {
  const { fetchImpl } = makeGraphFetch({ retry429: { matchesSubstring: "/driveItem", count: 10 } });
  installFakeCaches({ fetchImpl });
  await assert.rejects(resolveOneDriveFolder(SHARE_URL, "fake-token"), /temporarily busy/);
});

test("primeResolverCache + resolveUrlSync: mints, fetches, and caches each recording; a repeat prime never re-mints", async () => {
  const { fetchImpl, calls } = makeGraphFetch();
  installFakeCaches({ fetchImpl });
  const root = await resolveOneDriveFolder(SHARE_URL, "fake-token");
  setActiveRoot(root, "fake-token");
  const blocks = [{ instrumentalUrl: "Style/Mark 1.instrumental.m4a", vocalUrl: "Style/Mark 1.vocal.m4a" }];

  await primeResolverCache(blocks);
  assert.match(resolveUrlSync("Style/Mark 1.instrumental.m4a"), /^blob:/);
  assert.match(resolveUrlSync("Style/Mark 1.vocal.m4a"), /^blob:/);

  const mintCallsAfterFirst = calls.filter((u) => u.includes("/items/instr1?") || u.includes("/items/vocal1?")).length;
  await primeResolverCache(blocks);
  const mintCallsAfterSecond = calls.filter((u) => u.includes("/items/instr1?") || u.includes("/items/vocal1?")).length;
  assert.equal(mintCallsAfterSecond, mintCallsAfterFirst, "an already-cached recording must not mint a fresh download URL again");
});
