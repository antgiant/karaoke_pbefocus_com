import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serializePlaylistForShare,
  deserializePlaylistFromShare,
  encodePlaylistPayload,
  decodePlaylistPayload,
  encodedByteLength,
} from "../assets/js/share.js";

function makeRecord(overrides = {}) {
  return {
    id: "unused-by-share-format", // the importer assigns a fresh id, not carried in the payload
    name: "Mark Drill",
    selectedSectionKeys: ["Mark|1|null|null", "Mark|2|null|null"],
    verseSelections: { "Mark|1|null|null": [3, 4, 5] },
    activeStyle: "hiphop",
    mix: {
      defaultStyleId: "hiphop",
      sections: {
        "Mark|1|null|null": ["hiphop", "hiphop", "hiphop", "polka", "polka"],
        "Mark|2|null|null": ["indiepop", "indiepop"],
      },
    },
    ...overrides,
  };
}

test("serializePlaylistForShare: run-length-encodes repetitive style runs instead of one entry per word", () => {
  const record = makeRecord();
  const payload = serializePlaylistForShare(record);
  assert.deepEqual(payload.styleDict.sort(), ["hiphop", "indiepop", "polka"].sort());
  const runs = payload.mix.sections["Mark|1|null|null"];
  assert.equal(runs.length, 2, "5 words in 2 runs (3 hiphop, 2 polka), not 5 separate entries");
  const totalWords = runs.reduce((sum, [, count]) => sum + count, 0);
  assert.equal(totalWords, 5);
});

test("a section painted with take-variant paint ids (AI_TODO.md item 1) round-trips through share/import like any other style id", () => {
  const record = makeRecord({
    mix: {
      defaultStyleId: "hiphop",
      sections: { "Mark|1|null|null": ["hiphop", "hiphop::take2", "polka", "polka::take3"] },
    },
  });
  const restored = deserializePlaylistFromShare(serializePlaylistForShare(record));
  assert.deepEqual(restored.mix.sections["Mark|1|null|null"], ["hiphop", "hiphop::take2", "polka", "polka::take3"]);
});

test("Karaoke Mode settings (studyOptions) round-trip through share/import", () => {
  const record = makeRecord({
    studyOptions: { blankPercent: 65, rampOnRepeat: true, lengthMatched: true, scored: true, scoredInput: "typeahead" },
  });
  const restored = deserializePlaylistFromShare(serializePlaylistForShare(record));
  assert.deepEqual(restored.studyOptions, record.studyOptions);
});

test("studyOptions is null (not thrown) when the record/payload has none -- the importer falls back to its own default, not this module's", () => {
  const record = makeRecord(); // no studyOptions
  const restored = deserializePlaylistFromShare(serializePlaylistForShare(record));
  assert.equal(restored.studyOptions, null);
});

test("serializePlaylistForShare -> deserializePlaylistFromShare round-trips a full playlist exactly", () => {
  const record = makeRecord();
  const payload = serializePlaylistForShare(record);
  const restored = deserializePlaylistFromShare(payload);
  assert.equal(restored.name, record.name);
  assert.deepEqual(restored.selectedSectionKeys, record.selectedSectionKeys);
  assert.deepEqual(restored.verseSelections, record.verseSelections);
  assert.equal(restored.activeStyle, record.activeStyle);
  assert.deepEqual(restored.mix, record.mix);
});

test("serializePlaylistForShare: worst case (every word a different style) still round-trips correctly, just without size benefit", () => {
  const record = makeRecord({
    mix: {
      defaultStyleId: "hiphop",
      sections: { "Mark|1|null|null": ["hiphop", "polka", "indiepop", "hiphop"] },
    },
  });
  const restored = deserializePlaylistFromShare(serializePlaylistForShare(record));
  assert.deepEqual(restored.mix.sections["Mark|1|null|null"], ["hiphop", "polka", "indiepop", "hiphop"]);
});

test("privacy: manifestUrl is omitted by default, and only included when explicitly opted in", () => {
  const record = makeRecord();
  const withoutUrl = serializePlaylistForShare(record, { manifestUrl: "https://example.com/library.json" });
  assert.equal("manifestUrl" in withoutUrl, false, "opting in requires includeManifestUrl:true, not just passing a URL");
  assert.equal(deserializePlaylistFromShare(withoutUrl).manifestUrl, null);

  const withUrl = serializePlaylistForShare(record, { includeManifestUrl: true, manifestUrl: "https://example.com/library.json" });
  assert.equal(withUrl.manifestUrl, "https://example.com/library.json");
  assert.equal(deserializePlaylistFromShare(withUrl).manifestUrl, "https://example.com/library.json");
});

test("privacy: includeManifestUrl:true with no manifestUrl given still omits it (nothing to leak)", () => {
  const payload = serializePlaylistForShare(makeRecord(), { includeManifestUrl: true, manifestUrl: null });
  assert.equal("manifestUrl" in payload, false);
});

test("a null mix (playlist with no chapters selected yet) serializes and round-trips as null", () => {
  const record = makeRecord({ mix: null, activeStyle: null });
  const restored = deserializePlaylistFromShare(serializePlaylistForShare(record));
  assert.equal(restored.mix, null);
  assert.equal(restored.activeStyle, null);
});

test("the local style dictionary is independent of manifest style order -- indices are payload-scoped, not global", () => {
  // Two playlists using an overlapping-but-differently-ordered set of styles
  // must each get their own dictionary, not share indices with each other
  // or depend on any external ordering.
  const recordA = makeRecord({ activeStyle: null, mix: { defaultStyleId: "polka", sections: { s: ["polka", "hiphop"] } } });
  const recordB = makeRecord({ activeStyle: null, mix: { defaultStyleId: "hiphop", sections: { s: ["hiphop", "polka"] } } });
  const payloadA = serializePlaylistForShare(recordA);
  const payloadB = serializePlaylistForShare(recordB);
  assert.deepEqual(payloadA.styleDict, ["polka", "hiphop"]);
  assert.deepEqual(payloadB.styleDict, ["hiphop", "polka"]);
  assert.deepEqual(deserializePlaylistFromShare(payloadA).mix.sections.s, ["polka", "hiphop"]);
  assert.deepEqual(deserializePlaylistFromShare(payloadB).mix.sections.s, ["hiphop", "polka"]);
});

test("encodePlaylistPayload -> decodePlaylistPayload round-trips, is URL-safe, and handles non-ASCII names", () => {
  const payload = serializePlaylistForShare(makeRecord({ name: "Marc 1 — étude 🎵" }));
  const encoded = encodePlaylistPayload(payload);
  assert.doesNotMatch(encoded, /[+/=]/, "must be URL-safe: no +, /, or = padding characters");
  const decoded = decodePlaylistPayload(encoded);
  assert.deepEqual(decoded, payload);
  assert.equal(decoded.name, "Marc 1 — étude 🎵");
});

test("decodePlaylistPayload throws on malformed input rather than silently returning garbage", () => {
  assert.throws(() => decodePlaylistPayload("not-valid-base64url-json!!!"));
});

test("deserializePlaylistFromShare rejects an unrecognized payload format/version", () => {
  assert.throws(() => deserializePlaylistFromShare({ v: 99, name: "x" }), /format/i);
  assert.throws(() => deserializePlaylistFromShare(null));
});

test("encodedByteLength reports the actual URL/QR payload size, and RLE keeps a realistically repetitive large mix well under the QR-safe heuristic", () => {
  // A large-ish passage (300 words) painted in 3 big ranges -- the
  // realistic case (a Pathfinder paints whole sections, not word-by-word).
  const bigAssignment = [
    ...Array(120).fill("hiphop"),
    ...Array(100).fill("polka"),
    ...Array(80).fill("indiepop"),
  ];
  const record = makeRecord({ mix: { defaultStyleId: "hiphop", sections: { "Mark|1-16|null|null": bigAssignment } } });
  const payload = serializePlaylistForShare(record);
  const runs = payload.mix.sections["Mark|1-16|null|null"];
  assert.equal(runs.length, 3, "300 repetitive words collapse to 3 runs");
  const size = encodedByteLength(payload);
  assert.ok(size < 1500, `expected a realistically-painted 300-word playlist to comfortably fit the QR-safe heuristic, got ${size} bytes`);
});
