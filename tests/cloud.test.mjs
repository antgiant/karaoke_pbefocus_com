import { test } from "node:test";
import assert from "node:assert/strict";
import { createCloud } from "../assets/js/cloud/cloud.js";
import { ConnectionRegistry, memoryStore } from "../assets/vendor/pbe-storage/registry.js";
import { CookieStore } from "../assets/vendor/pbe-storage/cookie.js";
import { MemoryBackend } from "../assets/vendor/pbe-storage/providers/memory.js";
import { ErrorKind, StorageError } from "../assets/vendor/pbe-storage/errors.js";

const playlist = (id, name) => ({ id, name, selectedSectionKeys: [], verseSelections: {}, activeStyle: null, mix: null, studyOptions: {}, karaokeControlsOverride: {}, karaokeControlsSectionOverrides: {} });
const freshState = () => ({
  schemaVersion: 2,
  manifestUrl: "https://private.example/library.json",
  playlists: [playlist("a", "Alpha")],
  activePlaylistId: "a",
  history: {},
  karaokeControls: { pitchSemitones: 0, rate: 1, keyLock: true, countInSeconds: 0, reverbAmount: 0 },
  karaokeTextScale: { study: 1, sleep: 1 },
});

/** One device: its own localStorage, its own copy of the app state, and (optionally) a cookie jar shared with other tabs. */
function device({ backend, user = "me", deviceId, jar = { value: "" }, chooser, clock = { t: 1000 } }) {
  const cookieDoc = { get cookie() { return jar.value; }, set cookie(v) { jar.value = v.split(";")[0]; } };
  const local = memoryStore();
  const appState = { current: freshState() };
  const provider = backend.createProvider(user, { name: "microsoft" });
  const auth = {
    restore: async () => undefined,
    signIn: async () => { auth.signed = true; },
    signOut: async () => {},
    forget: async () => {},
    canAutoSignIn: () => true,
    autoSignIn: async () => ({ id: user, name: user }),
    getToken: async () => "t",
  };
  auth.restore = async () => (auth.signed ? { id: user, name: user } : undefined);
  const registry = new ConnectionRegistry({
    cookie: new CookieStore({ document: cookieDoc, secure: false, now: () => clock.t }),
    providers: { microsoft: { label: "OneDrive", auth, createProvider: () => provider } },
    store: local,
    now: () => clock.t,
  });
  const applied = [];
  const cloud = createCloud({
    registry,
    loadState: () => structuredClone(appState.current),
    saveState: (s) => { appState.current = structuredClone(s); },
    storage: local,
    deviceId,
    now: () => clock.t,
    timers: { setTimeout: () => 0, clearTimeout: () => {} }, // rounds are run by hand (syncNow); no real timers to keep the process alive
    chooseFolder: chooser ?? (async (_p, inst) => inst.createRoot("My PBE data")),
  });
  cloud.setApplier((s) => { applied.push(s); appState.current = structuredClone(s); });
  return { cloud, registry, appState, applied, provider, clock, jar, local };
}

async function connectAndUse(d) {
  await d.registry.init();
  await d.cloud.connect("microsoft");
  return d.cloud.useForMyData("microsoft");
}

test("local-only does nothing: no provider calls and no folder", async () => {
  const backend = new MemoryBackend();
  const d = device({ backend, deviceId: "dev00001" });
  await d.registry.init();
  d.cloud.start();
  await d.cloud.syncNow();
  assert.equal(backend.nodes.size, 0);
  assert.equal(d.cloud.snapshot().primary, "local");
});

test("choosing OneDrive creates the person's folder, a karaoke subfolder and this device's file", async () => {
  const backend = new MemoryBackend();
  const d = device({ backend, deviceId: "dev00001" });
  assert.equal(await connectAndUse(d), true);
  await d.cloud.syncNow();
  const names = [...backend.nodes.values()].map((n) => n.name);
  assert.ok(names.includes("My PBE data"));
  assert.ok(names.includes("karaoke"));
  assert.ok(names.includes("state.dev00001.json"));
  assert.equal(d.cloud.snapshot().primary, "microsoft");
  assert.equal(d.cloud.snapshot().folderName, "My PBE data");
  assert.equal(d.cloud.snapshot().sync.status, "idle");
});

test("declining to choose a folder leaves the person on local storage", async () => {
  const backend = new MemoryBackend();
  const d = device({ backend, deviceId: "dev00001", chooser: async () => null });
  await d.registry.init();
  await d.cloud.connect("microsoft");
  assert.equal(await d.cloud.useForMyData("microsoft"), false);
  assert.equal(d.cloud.snapshot().primary, "local");
  assert.equal(backend.nodes.size, 0);
});

test("a second device finds the folder from the saved pointer and receives the first device's data", async () => {
  const backend = new MemoryBackend();
  const laptop = device({ backend, deviceId: "laptop01" });
  laptop.appState.current.playlists.push(playlist("b", "From laptop"));
  await connectAndUse(laptop);
  await laptop.cloud.syncNow();

  let asked = 0;
  const phone = device({ backend, deviceId: "phone001", chooser: async () => { asked++; return null; } }); // its own cookie jar: no folder yet
  assert.equal(await connectAndUse(phone), true);
  assert.equal(asked, 0); // the pointer in the cloud account told it where to look
  await phone.cloud.syncNow();
  assert.deepEqual(phone.appState.current.playlists.map((p) => p.name).sort(), ["Alpha", "From laptop"]);
  assert.ok(phone.applied.length >= 1);
  assert.equal(phone.appState.current.manifestUrl, "https://private.example/library.json");
});

test("edits on one device reach the other, and deletes stick", async () => {
  const backend = new MemoryBackend();
  const laptop = device({ backend, deviceId: "laptop01" });
  const phone = device({ backend, deviceId: "phone001" });
  await connectAndUse(laptop); await laptop.cloud.syncNow();
  await connectAndUse(phone); await phone.cloud.syncNow();

  laptop.clock.t = 2000;
  laptop.appState.current.playlists[0] = playlist("a", "Alpha (laptop edit)");
  laptop.appState.current.playlists.push(playlist("n", "New"));
  await laptop.cloud.syncNow();
  phone.clock.t = 2100;
  await phone.cloud.syncNow();
  assert.deepEqual(phone.appState.current.playlists.map((p) => p.name), ["Alpha (laptop edit)", "New"]);

  phone.clock.t = 3000;
  phone.appState.current.playlists = phone.appState.current.playlists.filter((p) => p.id !== "n");
  await phone.cloud.syncNow();
  laptop.clock.t = 3100;
  await laptop.cloud.syncNow();
  assert.deepEqual(laptop.appState.current.playlists.map((p) => p.name), ["Alpha (laptop edit)"]);
});

test("an edit made while a sync is in flight is not overwritten by the merge", async () => {
  const backend = new MemoryBackend();
  const laptop = device({ backend, deviceId: "laptop01" });
  const phone = device({ backend, deviceId: "phone001" });
  await connectAndUse(laptop); await laptop.cloud.syncNow();
  await connectAndUse(phone);

  laptop.clock.t = 2000;
  laptop.appState.current.playlists.push(playlist("n", "Laptop new"));
  await laptop.cloud.syncNow();

  // While the phone syncs, the person edits on the phone (simulated inside its first read of the cloud).
  const read = phone.provider.read.bind(phone.provider);
  let edited = false;
  phone.provider.read = async (...args) => {
    if (!edited) { edited = true; phone.appState.current.playlists[0] = playlist("a", "Typed meanwhile"); }
    return read(...args);
  };
  phone.clock.t = 2100;
  await phone.cloud.syncNow();
  assert.equal(phone.appState.current.playlists[0].name, "Typed meanwhile");
  assert.equal(phone.applied.length, 0); // merge deferred to the next round
  phone.clock.t = 2200;
  await phone.cloud.syncNow();
  assert.deepEqual(phone.appState.current.playlists.map((p) => p.name).sort(), ["Laptop new", "Typed meanwhile"]);
});

test("applying remote data does not itself trigger another sync", async () => {
  const backend = new MemoryBackend();
  const d = device({ backend, deviceId: "dev00001" });
  await connectAndUse(d);
  let requests = 0;
  const original = d.cloud.controller.request.bind(d.cloud.controller);
  d.cloud.controller.request = () => { requests++; original(); };
  d.cloud.setApplier((s) => { d.appState.current = s; d.cloud.noteChange(); }); // an applier that saves, like the real one
  const other = device({ backend, deviceId: "dev00002" });
  other.appState.current.playlists.push(playlist("z", "Z"));
  await connectAndUse(other); await other.cloud.syncNow();
  d.clock.t = 2000;
  await d.cloud.syncNow();
  assert.ok(d.appState.current.playlists.some((p) => p.id === "z"));
  assert.equal(requests, 0);
  d.cloud.noteChange();
  assert.equal(requests, 1);
});

test("a cloud failure is reported, keeps local data, and the next round recovers", async () => {
  const backend = new MemoryBackend();
  const d = device({ backend, deviceId: "dev00001" });
  await connectAndUse(d); await d.cloud.syncNow();
  backend.injectFailure(new StorageError(ErrorKind.network, "offline"));
  d.appState.current.playlists.push(playlist("n", "Offline add"));
  await d.cloud.syncNow();
  assert.equal(d.cloud.snapshot().sync.status, "error");
  assert.ok(d.cloud.snapshot().error);
  assert.equal(d.appState.current.playlists.length, 2);
  await d.cloud.syncNow();
  assert.equal(d.cloud.snapshot().sync.status, "idle");
  assert.equal(d.cloud.snapshot().error, undefined);
});

test("signing out stops syncing but keeps local data; going back to local-only stops it too", async () => {
  const backend = new MemoryBackend();
  const d = device({ backend, deviceId: "dev00001" });
  await connectAndUse(d); await d.cloud.syncNow();
  const before = backend.nodes.size;
  await d.cloud.signOutAll();
  assert.equal(d.cloud.snapshot().primary, "local");
  d.appState.current.playlists.push(playlist("n", "After sign-out"));
  await d.cloud.syncNow();
  assert.equal(backend.nodes.size, before);
  assert.equal(d.appState.current.playlists.length, 2);
});

test("switching to local-only keeps the cloud files and stops syncing", async () => {
  const backend = new MemoryBackend();
  const d = device({ backend, deviceId: "dev00001" });
  await connectAndUse(d); await d.cloud.syncNow();
  const before = backend.nodes.size;
  d.cloud.useLocalOnly();
  d.appState.current.playlists.push(playlist("n", "Local only"));
  await d.cloud.syncNow();
  assert.equal(backend.nodes.size, before);
  assert.equal(d.cloud.snapshot().primary, "local");
});

test("changeFolder points sync at the new folder and leaves the old one alone", async () => {
  const backend = new MemoryBackend();
  let n = 0;
  const d = device({ backend, deviceId: "dev00001", chooser: async (_p, inst) => inst.createRoot(`Folder ${++n}`) });
  await connectAndUse(d); await d.cloud.syncNow();
  assert.equal(await d.cloud.changeFolder(), true);
  await d.cloud.syncNow();
  assert.equal(d.cloud.snapshot().folderName, "Folder 2");
  const files = [...backend.nodes.values()].filter((x) => x.name === "state.dev00001.json");
  assert.equal(files.length, 2);
});
