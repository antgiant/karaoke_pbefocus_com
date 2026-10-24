import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installDom, uninstallDom } from "./helpers/dom.mjs";

before(() => installDom());
after(() => uninstallDom());

const { mountStoragePanel, buttonLabel, ago, TEXT } = await import("../assets/js/cloud/storage-panel.js");
const { createFolderChooser } = await import("../assets/js/cloud/folder-chooser.js");

const snap = (over = {}) => ({
  primary: "local",
  connections: [{ provider: "microsoft", label: "OneDrive", connected: false, needsReconnect: false, primary: false }, { provider: "google", label: "Google Drive", connected: false, needsReconnect: false, primary: false }],
  folderName: undefined,
  needsFolder: false,
  sync: { status: "idle", lastSyncedAt: undefined, failures: 0 },
  error: undefined,
  ...over,
});

function fakeCloud(initial) {
  const calls = [];
  const cloud = {
    current: initial,
    calls,
    snapshot: () => cloud.current,
    connect: async (p) => { calls.push(["connect", p]); },
    useForMyData: async (p) => { calls.push(["useForMyData", p]); },
    syncNow: async () => { calls.push(["syncNow"]); },
    changeFolder: async () => { calls.push(["changeFolder"]); },
    useLocalOnly: () => { calls.push(["useLocalOnly"]); },
    disconnect: async (p) => { calls.push(["disconnect", p]); },
    signOutAll: async () => { calls.push(["signOutAll"]); },
  };
  return cloud;
}

function mount(cloud) {
  document.body.innerHTML = '<button id="b"></button><dialog id="d"><div id="body"></div></dialog>';
  const dialog = document.getElementById("d");
  dialog.showModal = () => dialog.setAttribute("open", "");
  dialog.close = () => dialog.removeAttribute("open");
  const body = document.getElementById("body");
  const button = document.getElementById("b");
  const panel = mountStoragePanel({ document, button, dialog, body, cloud, now: () => 10_000_000 });
  return { panel, body, button, dialog };
}
const flush = () => new Promise((r) => setImmediate(r));
const click = (root, selector) => { root.querySelector(selector).click(); return flush(); };
const text = (root) => root.textContent.replace(/\s+/g, " ");

test("button labels reflect where data lives and the sync state", () => {
  assert.equal(buttonLabel(snap()), "Storage: this device");
  assert.equal(buttonLabel(snap({ primary: "microsoft" })), "Storage: OneDrive");
  assert.equal(buttonLabel(snap({ primary: "google", sync: { status: "syncing" } })), "Storage: Google Drive ⟳");
  assert.equal(buttonLabel(snap({ primary: "microsoft", sync: { status: "error" } })), "Storage: OneDrive ⚠");
});

test("ago formats elapsed time", () => {
  assert.equal(ago(1000, 2000), "just now");
  assert.equal(ago(0, 5 * 60_000), "5 min ago");
  assert.equal(ago(0, 3 * 3600_000), "3 h ago");
  assert.equal(ago(0, 2 * 86400_000), "2 d ago");
});

test("local-only dialog offers OneDrive and Google, and Google shows the single-user warning first", async () => {
  const cloud = fakeCloud(snap());
  const { body, button, dialog } = mount(cloud);
  assert.equal(button.textContent, "Storage: this device");
  button.click();
  assert.equal(dialog.hasAttribute("open"), true);
  assert.match(text(body), /saved on this device only/);
  await click(body, "#storageGoogleBtn");
  assert.match(text(body), /can't be used for shared folders/);
  assert.equal(cloud.calls.length, 0); // nothing connected until they confirm
  await click(body, "#storageGoogleContinueBtn");
  assert.deepEqual(cloud.calls, [["connect", "google"], ["useForMyData", "google"]]);
});

test("Use OneDrive instead from the Google warning goes to OneDrive", async () => {
  const cloud = fakeCloud(snap());
  const { body } = mount(cloud);
  await click(body, "#storageGoogleBtn");
  await click(body, "#storageUseOneDriveBtn");
  assert.deepEqual(cloud.calls, [["connect", "microsoft"], ["useForMyData", "microsoft"]]);
});

test("cancelling the Google warning changes nothing", async () => {
  const cloud = fakeCloud(snap());
  const { body } = mount(cloud);
  await click(body, "#storageGoogleBtn");
  await click(body, "#storageGoogleCancelBtn");
  assert.match(text(body), /Where your data lives/);
  assert.equal(cloud.calls.length, 0);
});

test("an already connected provider is not asked to sign in again", async () => {
  const cloud = fakeCloud(snap({ connections: [{ provider: "microsoft", label: "OneDrive", connected: true, account: { name: "me@outlook.com" }, needsReconnect: false, primary: false }, { provider: "google", label: "Google Drive", connected: false, needsReconnect: false, primary: false }] }));
  const { body } = mount(cloud);
  await click(body, "#storageOneDriveBtn");
  assert.deepEqual(cloud.calls, [["useForMyData", "microsoft"]]);
  assert.match(text(body), /OneDrive — me@outlook\.com/);
});

test("when syncing to OneDrive: the folder, last sync time and actions are shown", async () => {
  const cloud = fakeCloud(snap({ primary: "microsoft", folderName: "My PBE", sync: { status: "idle", lastSyncedAt: 10_000_000 - 120_000 }, connections: [{ provider: "microsoft", label: "OneDrive", connected: true, account: { name: "me@outlook.com" }, needsReconnect: false, primary: true }] }));
  const { body } = mount(cloud);
  assert.match(text(body), /backed up to OneDrive, in the folder “My PBE”\. Last synced 2 min ago\./);
  await click(body, "#storageSyncBtn");
  await click(body, "#storageFolderBtn");
  await click(body, "#storageLocalBtn");
  assert.deepEqual(cloud.calls.map((c) => c[0]), ["syncNow", "changeFolder", "useLocalOnly"]);
});

test("Google as storage repeats the single-user note", () => {
  const cloud = fakeCloud(snap({ primary: "google", folderName: "PBE Focus data", connections: [{ provider: "google", label: "Google Drive", connected: true, account: { name: "me@gmail.com" }, needsReconnect: false, primary: true }] }));
  const { body } = mount(cloud);
  assert.match(text(body), new RegExp(TEXT.googleWarning.slice(0, 40)));
});

test("a connection that needs reconnecting shows Reconnect; disconnect and sign out everything work", async () => {
  const cloud = fakeCloud(snap({ primary: "microsoft", folderName: "F", connections: [{ provider: "microsoft", label: "OneDrive", connected: false, needsReconnect: true, account: undefined, primary: true }] }));
  const { body } = mount(cloud);
  assert.match(text(body), /needs reconnecting/);
  await click(body, "#reconnect-microsoft");
  await click(body, "#disconnect-microsoft");
  await click(body, "#storageSignOutAllBtn");
  assert.deepEqual(cloud.calls, [["connect", "microsoft"], ["disconnect", "microsoft"], ["signOutAll"]]);
});

test("errors from an action are shown, and a folder-less connection asks for a folder", async () => {
  const cloud = fakeCloud(snap({ primary: "microsoft", needsFolder: true, connections: [{ provider: "microsoft", label: "OneDrive", connected: true, account: { name: "m" }, needsReconnect: false, primary: true }] }));
  cloud.useForMyData = async () => { throw new Error("Network request failed"); };
  const { body } = mount(cloud);
  assert.match(text(body), /Choose a folder to finish setting up/);
  await click(body, "#storageChooseBtn");
  assert.match(text(body), /Something went wrong: Network request failed/);
});

test("the dialog is not redrawn while the folder chooser is using it", async () => {
  const cloud = fakeCloud(snap());
  const { panel, body } = mount(cloud);
  body.dataset.chooser = "1";
  body.innerHTML = "<p id='chooser'>choosing</p>";
  panel.render();
  assert.ok(body.querySelector("#chooser"));
});

// ---- folder chooser -------------------------------------------------------------------------------------------

function fakeOneDrive() {
  const tree = { null: [{ id: "1", name: "Documents", driveId: "D" }, { id: "2", name: "Music", driveId: "D" }], 1: [{ id: "3", name: "PBE", driveId: "D" }], 2: [], 3: [] };
  const created = [];
  return {
    created,
    browse: async (folder) => tree[folder ? folder.id : "null"].map((f) => ({ provider: "microsoft", ...f })),
    createFolder: async (name, parent) => { const f = { provider: "microsoft", id: `n${created.length + 1}`, driveId: "D", name }; created.push([name, parent && parent.id]); tree[f.id] = []; return f; },
  };
}

test("OneDrive chooser: browse into a folder and use it", async () => {
  document.body.innerHTML = '<div id="c"><p>original</p></div>';
  const container = document.getElementById("c");
  const choose = createFolderChooser({ document, container });
  const result = choose("microsoft", fakeOneDrive());
  await flush();
  assert.equal(container.dataset.chooser, "1");
  assert.match(text(container), /Documents/);
  assert.equal(container.querySelector("#folderUseBtn").disabled, true); // nothing chosen at the top level
  container.querySelector(".folder-open").click(); await flush();
  assert.match(text(container), /My OneDrive \/ Documents/);
  container.querySelector(".folder-open").click(); await flush(); // into PBE
  container.querySelector("#folderUseBtn").click();
  const folder = await result;
  assert.equal(folder.name, "PBE");
  assert.equal(container.dataset.chooser, undefined);
  assert.equal(container.textContent, "original"); // the dialog content is restored
});

test("OneDrive chooser: Back goes up, Cancel returns null, New folder creates inside the current folder", async () => {
  document.body.innerHTML = '<div id="c"></div>';
  const container = document.getElementById("c");
  const od = fakeOneDrive();
  const choose = createFolderChooser({ document, container, ask: () => "My new folder" });
  const result = choose("microsoft", od);
  await flush();
  container.querySelector(".folder-open").click(); await flush();
  container.querySelector("#folderNewBtn").click(); await flush();
  assert.deepEqual(od.created, [["My new folder", "1"]]);
  assert.match(text(container), /Documents \/ My new folder/);
  container.querySelector("#folderUpBtn").click(); await flush();
  assert.match(text(container), /My OneDrive \/ Documents/);
  assert.doesNotMatch(text(container), /My new folder/);
  container.querySelector("#folderCancelBtn").click();
  assert.equal(await result, null);
});

test("OneDrive chooser: a failing listing shows the error instead of hanging", async () => {
  document.body.innerHTML = '<div id="c"></div>';
  const container = document.getElementById("c");
  const choose = createFolderChooser({ document, container });
  const result = choose("microsoft", { browse: async () => { throw new Error("Not signed in"); } });
  await flush();
  assert.match(text(container), /Not signed in/);
  container.querySelector("#folderCancelBtn").click();
  assert.equal(await result, null);
});

test("Google chooser: create a folder for me, or pick one with the Picker", async () => {
  document.body.innerHTML = '<div id="c"></div>';
  const container = document.getElementById("c");
  const instance = { createFolder: async (name) => ({ provider: "google", id: "G1", name }) };
  let pickArgs;
  const choose = createFolderChooser({ document, container, google: { getToken: async () => "tok", apiKey: "K", appId: "A" }, pick: async (a) => { pickArgs = a; return { provider: "google", id: "P1", name: "Mine" }; } });

  let result = choose("google", instance);
  container.querySelector("#folderCreateBtn").click();
  assert.equal((await result).name, "PBE Focus data");

  result = choose("google", instance);
  container.querySelector("#folderPickBtn").click();
  assert.equal((await result).id, "P1");
  assert.deepEqual([pickArgs.token, pickArgs.apiKey, pickArgs.appId], ["tok", "K", "A"]);

  result = choose("google", instance);
  container.querySelector("#folderCancelBtn").click();
  assert.equal(await result, null);
});
