import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDoc, docsEqual, emptyMeta, mergeDocs, toSyncDoc, MAX_ATTEMPTS_PER_SECTION } from "../assets/js/cloud/sync-state.js";
import { DocSync } from "../assets/vendor/pbe-storage/sync/engine.js";
import { MemoryBackend } from "../assets/vendor/pbe-storage/providers/memory.js";
import { stableStringify } from "../assets/vendor/pbe-storage/envelope.js";

const playlist = (id, name, extra = {}) => ({ id, name, selectedSectionKeys: [], verseSelections: {}, activeStyle: null, mix: null, studyOptions: {}, karaokeControlsOverride: {}, karaokeControlsSectionOverrides: {}, ...extra });
const controls = (extra = {}) => ({ pitchSemitones: 0, rate: 1, keyLock: true, countInSeconds: 0, reverbAmount: 0, ...extra });
const stateOf = (overrides = {}) => ({
  schemaVersion: 2,
  manifestUrl: "https://private.example/library.json",
  playlists: [playlist("a", "Alpha")],
  activePlaylistId: "a",
  history: {},
  karaokeControls: controls(),
  karaokeTextScale: { study: 1, sleep: 1 },
  ...overrides,
});
const names = (s) => s.playlists.map((p) => p.name);

test("first stamping: every record gets the current time; an unchanged state keeps its stamps", () => {
  const first = toSyncDoc(stateOf(), emptyMeta(), 100);
  assert.equal(first.doc.playlists[0].updatedAt, 100);
  assert.equal(first.doc.controls.rate.t, 100);
  const again = toSyncDoc(stateOf(), first.meta, 999);
  assert.equal(again.doc.playlists[0].updatedAt, 100);
  assert.equal(again.doc.controls.rate.t, 100);
  assert.ok(docsEqual(first.doc, again.doc));
});

test("an edit restamps only the record that changed", () => {
  const s = stateOf({ playlists: [playlist("a", "Alpha"), playlist("b", "Beta")] });
  const first = toSyncDoc(s, emptyMeta(), 100);
  const edited = stateOf({ playlists: [playlist("a", "Alpha"), playlist("b", "Beta", { selectedSectionKeys: ["Mark|1"] })], karaokeControls: controls({ rate: 1.2 }) });
  const next = toSyncDoc(edited, first.meta, 200);
  const stamp = (id) => next.doc.playlists.find((p) => p.id === id).updatedAt;
  assert.equal(stamp("a"), 100);
  assert.equal(stamp("b"), 200);
  assert.equal(next.doc.controls.rate.t, 200);
  assert.equal(next.doc.controls.pitchSemitones.t, 100);
});

test("a removed playlist becomes a tombstone that keeps its original creation time", () => {
  const first = toSyncDoc(stateOf({ playlists: [playlist("a", "Alpha"), playlist("b", "Beta")] }), emptyMeta(), 100);
  const next = toSyncDoc(stateOf({ playlists: [playlist("a", "Alpha")] }), first.meta, 300);
  const tomb = next.doc.playlists.find((p) => p.id === "b");
  assert.equal(tomb.deleted, true);
  assert.equal(tomb.record, null);
  assert.equal(tomb.updatedAt, 300);
  assert.equal(tomb.createdAt, 100);
  const later = toSyncDoc(stateOf({ playlists: [playlist("a", "Alpha")] }), next.meta, 900);
  assert.equal(later.doc.playlists.find((p) => p.id === "b").updatedAt, 300); // tombstone time is stable
});

test("device-local fields never enter the document", () => {
  const { doc } = toSyncDoc(stateOf(), emptyMeta(), 1);
  const text = JSON.stringify(doc);
  assert.ok(!text.includes("private.example"));
  assert.ok(!text.includes("activePlaylistId"));
});

test("applying a document makes the state and sidecar agree, so it is not mistaken for a local edit", () => {
  const remote = toSyncDoc(stateOf({ playlists: [playlist("a", "Alpha renamed"), playlist("c", "Gamma")], karaokeControls: controls({ rate: 1.3 }) }), emptyMeta(), 500).doc;
  const local = stateOf();
  const { doc: localDoc, meta } = toSyncDoc(local, emptyMeta(), 100);
  const merged = mergeDocs(localDoc, remote);
  const applied = applyDoc(local, merged, meta);
  assert.deepEqual(names(applied.state), ["Alpha renamed", "Gamma"]);
  assert.equal(applied.state.karaokeControls.rate, 1.3);
  assert.equal(applied.state.manifestUrl, local.manifestUrl);
  assert.equal(applied.state.activePlaylistId, "a");
  const restamp = toSyncDoc(applied.state, applied.meta, 9999);
  assert.ok(docsEqual(restamp.doc, merged));
});

test("active playlist falls back when its playlist was deleted elsewhere", () => {
  const local = stateOf({ playlists: [playlist("a", "Alpha"), playlist("b", "Beta")], activePlaylistId: "b" });
  const { doc, meta } = toSyncDoc(local, emptyMeta(), 100);
  const remote = toSyncDoc(stateOf({ playlists: [playlist("a", "Alpha")] }), toSyncDoc(local, emptyMeta(), 100).meta, 500).doc;
  const applied = applyDoc(local, mergeDocs(doc, remote), meta);
  assert.deepEqual(names(applied.state), ["Alpha"]);
  assert.equal(applied.state.activePlaylistId, "a");
});

test("history: attempts from both devices are kept once each, in date order, capped per section", () => {
  const att = (n) => ({ date: `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`, mode: "karaoke", accuracy: null });
  const a = toSyncDoc(stateOf({ history: { k: [att(1), att(2)] } }), emptyMeta(), 1).doc;
  const b = toSyncDoc(stateOf({ history: { k: [att(2), att(3)] } }), emptyMeta(), 1).doc;
  assert.deepEqual(mergeDocs(a, b).history.k.map((x) => x.date.slice(8, 10)), ["01", "02", "03"]);
  const many = Array.from({ length: 70 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), mode: "karaoke", accuracy: null }));
  const big = toSyncDoc(stateOf({ history: { k: many } }), emptyMeta(), 1).doc;
  assert.equal(big.history.k.length, MAX_ATTEMPTS_PER_SECTION);
  assert.equal(big.history.k.at(-1).date, many.at(-1).date);
});

test("mergeDocs is commutative, associative and idempotent", () => {
  const mk = (seed) => {
    const s = stateOf({ playlists: [playlist("a", `A${seed}`), playlist(`p${seed}`, `P${seed}`)], karaokeControls: controls({ rate: 1 + seed / 10 }), history: { k: [{ date: `2026-02-0${seed}T00:00:00.000Z`, mode: "karaoke", accuracy: null }] } });
    return toSyncDoc(s, emptyMeta(), 100 + seed).doc;
  };
  const [a, b, c] = [mk(1), mk(2), mk(3)];
  const same = (x, y) => assert.equal(stableStringify(x), stableStringify(y));
  same(mergeDocs(a, b), mergeDocs(b, a));
  same(mergeDocs(mergeDocs(a, b), c), mergeDocs(a, mergeDocs(b, c)));
  same(mergeDocs(a, a), a);
});

test("two devices converge through the real sync engine, including edits, deletes and offline gaps", async () => {
  const cloud = new MemoryBackend();
  const p1 = cloud.createProvider("me");
  const root = await p1.createRoot("PBE data");
  const folder = await p1.ensureFolder(root, "karaoke");
  const dev = (id) => ({ sync: new DocSync({ provider: p1, folder, app: "karaoke", deviceId: id }), state: stateOf(), meta: emptyMeta(), t: 0 });
  const laptop = dev("laptop01");
  const phone = dev("phone001");

  async function round(d, now) {
    const { doc, meta } = toSyncDoc(d.state, d.meta, now);
    const r = await d.sync.sync("state", { schema: 1, local: doc, merge: mergeDocs });
    if (r.changed) { const applied = applyDoc(d.state, r.merged, meta); d.state = applied.state; d.meta = applied.meta; } else d.meta = meta;
  }

  await round(laptop, 10); await round(phone, 11);
  assert.deepEqual(names(phone.state), ["Alpha"]);

  laptop.state.playlists.push(playlist("l1", "Laptop list"));
  phone.state.playlists[0] = playlist("a", "Alpha renamed on phone");
  phone.state.karaokeControls = controls({ pitchSemitones: 2 });
  await round(laptop, 20); await round(phone, 21); await round(laptop, 22);
  assert.deepEqual(names(laptop.state), names(phone.state));
  assert.deepEqual(names(laptop.state).sort(), ["Alpha renamed on phone", "Laptop list"]);
  assert.equal(laptop.state.karaokeControls.pitchSemitones, 2);

  laptop.state.playlists = laptop.state.playlists.filter((p) => p.id !== "l1"); // delete
  await round(laptop, 30); await round(phone, 31);
  assert.deepEqual(names(phone.state), ["Alpha renamed on phone"]);

  // phone edits offline several times, laptop edits the same playlist later: the later edit wins everywhere
  phone.state.playlists[0] = playlist("a", "Phone offline edit");
  laptop.state.playlists[0] = playlist("a", "Laptop later edit");
  await round(phone, 40);
  await round(laptop, 50); await round(phone, 51); await round(laptop, 52);
  assert.deepEqual(names(phone.state), ["Laptop later edit"]);
  assert.equal(stableStringify(laptop.state.playlists), stableStringify(phone.state.playlists));
  assert.equal(laptop.state.manifestUrl, "https://private.example/library.json");
});
