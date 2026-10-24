// Cloud sync orchestration for Karaoke: connects the shared connection registry and sync engine (assets/vendor/pbe-storage) to this
// app's own state (sync-state.js). No DOM in here -- the storage dialog (storage-panel.js) drives it, and everything it touches is
// injected so it can be tested with the in-memory provider.
//
// Local storage stays the source of truth for the UI. When the person has chosen OneDrive or Google Drive as their storage, a
// background loop merges this device's state with the other devices' copies and applies the result back.

import { DocSync } from "../../vendor/pbe-storage/sync/engine.js";
import { SyncController } from "../../vendor/pbe-storage/sync/controller.js";
import { stableStringify } from "../../vendor/pbe-storage/envelope.js";
import { applyDoc, emptyMeta, mergeDocs, SYNC_SCHEMA, toSyncDoc } from "./sync-state.js";

export const META_KEY = "pbe-karaoke:sync-meta:v1";
export const NAMESPACE = "karaoke";
export const DOC = "state";

export function createCloud({ registry, loadState, saveState, storage, deviceId, now = Date.now, timers, chooseFolder, onChange = () => {}, pollMs = 60_000, debounceMs = 2000 }) {
  let applyState = (state) => saveState(state);
  let applying = false;
  let docSync;
  let docSyncKey = "";
  let lastError;
  let needsFolder = false;

  const readMeta = () => {
    try { return JSON.parse(storage.getItem(META_KEY) || "null") || emptyMeta(); } catch { return emptyMeta(); }
  };
  const writeMeta = (meta) => {
    try { storage.setItem(META_KEY, JSON.stringify(meta)); } catch { /* storage blocked: stamps are re-derived next time */ }
  };

  const syncTarget = () => {
    const primary = registry.primary();
    if (primary === "local" || !registry.isConnected(primary)) return null;
    const root = registry.folderFor(primary);
    return root ? { primary, root } : null;
  };

  async function runOnce() {
    const target = syncTarget();
    if (!target) return;
    const provider = registry.providerFor(target.primary);
    const key = `${target.primary}:${target.root.id}`;
    if (!docSync || docSyncKey !== key) {
      const folder = await provider.ensureFolder(target.root, NAMESPACE);
      docSync = new DocSync({ provider, folder, app: "karaoke", deviceId, now });
      docSyncKey = key;
    }
    const before = loadState();
    const { doc, meta } = toSyncDoc(before, readMeta(), now());
    writeMeta(meta);
    const result = await docSync.sync(DOC, { schema: SYNC_SCHEMA, local: doc, merge: mergeDocs });
    if (!result.changed) return;
    const current = loadState();
    if (stableStringify(current) !== stableStringify(before)) {
      // The person edited while this round was in flight. Applying now would overwrite that edit, so leave the merge for the next round.
      controller.request();
      return;
    }
    const applied = applyDoc(current, result.merged, meta);
    writeMeta(applied.meta);
    applying = true;
    try { applyState(applied.state); } finally { applying = false; }
  }

  const controller = new SyncController({
    run: async () => {
      try {
        await runOnce();
        lastError = undefined;
      } catch (e) {
        lastError = e;
        docSync = undefined; // a failed provider call may mean an expired folder or token: rebuild next time
        throw e;
      } finally {
        onChange();
      }
    },
    debounceMs,
    pollMs,
    timers,
    now,
    onStatus: () => onChange(),
  });

  function restart() {
    controller.stop();
    docSync = undefined;
    needsFolder = false;
    const primary = registry.primary();
    if (primary !== "local" && registry.isConnected(primary)) {
      if (!registry.folderFor(primary)) needsFolder = true;
      else controller.start();
    }
    onChange();
  }

  /** Finds this person's folder on `provider`: the one already in the cookie, else the pointer saved in their cloud account. */
  async function resolveFolder(provider) {
    const inCookie = registry.folderFor(provider);
    if (inCookie) return inCookie;
    const instance = registry.providerFor(provider);
    let pointer;
    try { pointer = await instance.readPointer?.(); } catch { pointer = undefined; }
    const folder = pointer && pointer.folder;
    if (folder && folder.provider === provider) {
      try {
        await instance.list(folder); // is it still there, and may we open it?
        registry.setFolder(provider, folder);
        return folder;
      } catch { /* gone or no access: ask again */ }
    }
    return undefined;
  }

  return {
    controller,

    /** Call once at start-up, after registry.init(). */
    start() { restart(); },

    /** Replaces how a merged state reaches the running app (main.js swaps in one that also refreshes the screen). */
    setApplier(fn) { applyState = fn; },

    /** Call after every local save. */
    noteChange() {
      if (!applying) controller.request();
    },

    async syncNow() {
      if (!syncTarget()) return;
      await controller.runNow();
    },

    async connect(provider) {
      const account = await registry.connect(provider);
      onChange();
      return account;
    },

    async disconnect(provider) {
      await registry.disconnect(provider);
      restart();
    },

    async signOutAll() {
      await registry.signOutAll();
      restart();
    },

    /**
     * Makes `provider` the person's own storage: finds or asks for the folder, then starts syncing (first round merges with whatever is
     * already there, so nothing is lost either way). Resolves false if they declined to choose a folder.
     */
    async useForMyData(provider) {
      if (!registry.isConnected(provider)) throw new Error(`Connect ${provider} first`);
      let folder = await resolveFolder(provider);
      if (!folder) {
        folder = await chooseFolder(provider, registry.providerFor(provider));
        if (!folder) return false;
        registry.setFolder(provider, folder);
      }
      registry.setPrimary(provider);
      try { await registry.providerFor(provider).writePointer?.({ folder }); } catch { /* the pointer only helps other devices */ }
      restart();
      void controller.runNow();
      return true;
    },

    /** Lets the person pick a different folder for the provider they already use. Existing data stays where it was. */
    async changeFolder() {
      const primary = registry.primary();
      if (primary === "local" || !registry.isConnected(primary)) return false;
      const folder = await chooseFolder(primary, registry.providerFor(primary));
      if (!folder) return false;
      registry.setFolder(primary, folder);
      try { await registry.providerFor(primary).writePointer?.({ folder }); } catch { /* ignore */ }
      restart();
      void controller.runNow();
      return true;
    },

    useLocalOnly() {
      registry.setPrimary("local");
      restart();
    },

    /** Brings this tab in line with the sign-in cookie (call on focus), then re-evaluates sync. */
    async reconcile() {
      const before = `${registry.primary()}|${registry.status().map((s) => s.connected).join()}`;
      await registry.reconcile();
      const after = `${registry.primary()}|${registry.status().map((s) => s.connected).join()}`;
      if (before !== after) restart();
    },

    /** Everything the storage dialog shows. */
    snapshot() {
      const primary = registry.primary();
      const folder = primary === "local" ? undefined : registry.folderFor(primary);
      return {
        primary,
        connections: registry.status(),
        folderName: folder && folder.name,
        needsFolder,
        sync: { ...controller.state },
        error: lastError,
      };
    },
  };
}
