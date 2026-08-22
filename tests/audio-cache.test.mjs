import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installDom, uninstallDom } from "./helpers/dom.mjs";
import { installFakeCaches, uninstallFakeCaches, makeFetch } from "./helpers/fake-caches.mjs";
import {
  CACHE_KIND,
  cacheKeyedUrl,
  cacheOpportunistically,
  cacheUsage,
  clearCache,
  downloadBlocksForOffline,
  formatCacheUsage,
  isCached,
  pickEvictions,
  primeResolverCache,
  resolveUrlSync,
  usageFor,
} from "../assets/js/offline/audio-cache.js";

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

test("usageFor: sums bytes and counts entries in an index bucket", () => {
  assert.deepEqual(usageFor({}), { bytes: 0, count: 0 });
  assert.deepEqual(usageFor({ a: { bytes: 100 }, b: { bytes: 250 } }), { bytes: 350, count: 2 });
});

test("formatCacheUsage: nothing cached vs. a real total", () => {
  assert.equal(formatCacheUsage({ bytes: 0, count: 0 }), "Nothing cached yet");
  assert.equal(formatCacheUsage({ bytes: 5 * 1024 * 1024, count: 2 }), "5 MB across 2 recordings");
  assert.equal(formatCacheUsage({ bytes: 1024 * 1024, count: 1 }), "1 MB across 1 recording");
  assert.equal(formatCacheUsage({ bytes: 2.5 * 1024 * 1024 * 1024, count: 40 }), "2.5 GB across 40 recordings");
});

test("pickEvictions: under the cap evicts nothing", () => {
  const entries = [{ url: "a", bytes: 100, lastUsed: 1 }, { url: "b", bytes: 100, lastUsed: 2 }];
  assert.deepEqual(pickEvictions(entries, 1000), []);
});

test("pickEvictions: over the cap evicts oldest-lastUsed-first, only as much as needed", () => {
  const entries = [
    { url: "oldest", bytes: 100, lastUsed: 1 },
    { url: "middle", bytes: 100, lastUsed: 2 },
    { url: "newest", bytes: 100, lastUsed: 3 },
  ];
  assert.deepEqual(pickEvictions(entries, 250), ["oldest"]);
  assert.deepEqual(pickEvictions(entries, 150), ["oldest", "middle"]);
  assert.deepEqual(pickEvictions(entries, 0), ["oldest", "middle", "newest"]);
});

test("cacheOpportunistically: stores both stems and they become reflected in isCached/cacheUsage", async () => {
  const fetchImpl = makeFetch({ "https://host/a.instrumental.m4a": 1000, "https://host/a.vocal.m4a": 500 });
  installFakeCaches({ fetchImpl });
  await cacheOpportunistically("https://host/a.instrumental.m4a", "https://host/a.vocal.m4a");
  assert.equal(isCached(CACHE_KIND.OPPORTUNISTIC, "https://host/a.instrumental.m4a"), true);
  assert.equal(isCached(CACHE_KIND.OPPORTUNISTIC, "https://host/a.vocal.m4a"), true);
  assert.deepEqual(cacheUsage(CACHE_KIND.OPPORTUNISTIC), { bytes: 1500, count: 2 });
});

test("cacheOpportunistically: a fetch failure never throws -- best-effort", async () => {
  const fetchImpl = makeFetch({ "https://host/bad.instrumental.m4a": "error" });
  installFakeCaches({ fetchImpl });
  await assert.doesNotReject(cacheOpportunistically("https://host/bad.instrumental.m4a", "https://host/bad.vocal.m4a"));
  assert.equal(isCached(CACHE_KIND.OPPORTUNISTIC, "https://host/bad.instrumental.m4a"), false);
});

test("cacheKeyedUrl: caches by a stable key distinct from the fetched URL (the OneDrive case -- offline/onedrive-library.js), and a hit never calls getUrl again", async () => {
  let mintCount = 0;
  const getUrl = () => {
    mintCount += 1;
    return "https://cdn.example/ephemeral-download-1";
  };
  const fetchImpl = makeFetch({ "https://cdn.example/ephemeral-download-1": 800 });
  installFakeCaches({ fetchImpl });

  await cacheKeyedUrl(CACHE_KIND.OPPORTUNISTIC, "Style/Recording.instrumental.m4a", getUrl);
  assert.equal(mintCount, 1);
  assert.equal(isCached(CACHE_KIND.OPPORTUNISTIC, "Style/Recording.instrumental.m4a"), true);
  assert.match(resolveUrlSync("Style/Recording.instrumental.m4a"), /^blob:/);

  // A second call for the same key must be a pure cache hit: no re-fetch of a
  // fresh (possibly differently-named) ephemeral URL, i.e. getUrl not called again.
  await cacheKeyedUrl(CACHE_KIND.OPPORTUNISTIC, "Style/Recording.instrumental.m4a", getUrl);
  assert.equal(mintCount, 1, "a cache hit must not call getUrl again");
});

test("downloadBlocksForOffline: dedupes repeated blocks and reports progress once per unique pair", async () => {
  const blocks = [
    { instrumentalUrl: "https://host/x.instrumental.m4a", vocalUrl: "https://host/x.vocal.m4a" },
    { instrumentalUrl: "https://host/x.instrumental.m4a", vocalUrl: "https://host/x.vocal.m4a" }, // same recording repeated -- should only fetch once
    { instrumentalUrl: "https://host/y.instrumental.m4a", vocalUrl: "https://host/y.vocal.m4a" },
  ];
  const progressCalls = [];
  await downloadBlocksForOffline(blocks, (done, total) => progressCalls.push([done, total]));
  assert.deepEqual(progressCalls, [[0, 2], [1, 2], [2, 2]]);
  assert.equal(isCached(CACHE_KIND.DOWNLOAD, "https://host/x.instrumental.m4a"), true);
  assert.equal(isCached(CACHE_KIND.DOWNLOAD, "https://host/y.vocal.m4a"), true);
});

test("downloadBlocksForOffline: a real fetch failure rethrows -- a deliberate user action should surface errors", async () => {
  const fetchImpl = makeFetch({ "https://host/broken.instrumental.m4a": "error" });
  installFakeCaches({ fetchImpl });
  const blocks = [{ instrumentalUrl: "https://host/broken.instrumental.m4a", vocalUrl: "https://host/broken.vocal.m4a" }];
  await assert.rejects(downloadBlocksForOffline(blocks), /Failed to fetch/);
});

test("clearCache: removes both the Cache Storage entries and the usage index for that kind only", async () => {
  await cacheOpportunistically("https://host/keep.instrumental.m4a", "https://host/keep.vocal.m4a");
  const blocks = [{ instrumentalUrl: "https://host/dl.instrumental.m4a", vocalUrl: "https://host/dl.vocal.m4a" }];
  await downloadBlocksForOffline(blocks);

  await clearCache(CACHE_KIND.OPPORTUNISTIC);
  assert.deepEqual(cacheUsage(CACHE_KIND.OPPORTUNISTIC), { bytes: 0, count: 0 });
  assert.deepEqual(cacheUsage(CACHE_KIND.DOWNLOAD), { bytes: 2048, count: 2 });
});

test("resolveUrlSync/primeResolverCache: an already-cached track resolves to a blob: URL after priming; an uncached one falls back to its remote URL", async () => {
  await cacheOpportunistically("https://host/primed.instrumental.m4a", "https://host/primed.vocal.m4a");
  await primeResolverCache([
    { instrumentalUrl: "https://host/primed.instrumental.m4a", vocalUrl: "https://host/primed.vocal.m4a" },
    { instrumentalUrl: "https://host/never-cached.instrumental.m4a", vocalUrl: "https://host/never-cached.vocal.m4a" },
  ]);
  assert.match(resolveUrlSync("https://host/primed.instrumental.m4a"), /^blob:/);
  assert.equal(resolveUrlSync("https://host/never-cached.instrumental.m4a"), "https://host/never-cached.instrumental.m4a");
});
