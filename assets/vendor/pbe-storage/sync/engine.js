// Per-device files, merged on read (docs/unified-storage-plan.md, section 3.5).
//
// Each device writes ONLY its own file for a document (`<doc>.<deviceId>.json`) and merges everyone else's on every sync. That
// avoids write conflicts entirely, which matters because Google Drive has no conditional write. A device always uploads the full
// merged state, so a file that was overwritten or lost is rebuilt by the next sync from any device that still holds the data.

import { EnvelopeError, decodeEnvelope, encodeEnvelope, makeEnvelope, stableStringify } from "../envelope.js";
import { ErrorKind, StorageError } from "../errors.js";

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class DocSync {
  /**
   * @param {{ provider: object, folder: object, app: string, deviceId: string, now?: () => number, readOnly?: boolean }} opts
   *  `folder` is the folder (space/namespace) this document lives in; `readOnly` skips uploads (viewers).
   */
  constructor({ provider, folder, app, deviceId, now = Date.now, readOnly = false }) {
    this.provider = provider;
    this.folder = folder;
    this.app = app;
    this.deviceId = deviceId;
    this.now = now;
    this.readOnly = readOnly;
    /** entry id -> { tag, envelope } so an unchanged remote file is not downloaded again */
    this.cache = new Map();
    /** doc -> canonical string of the data this device last uploaded */
    this.lastPushed = new Map();
  }

  fileName(doc) {
    return `${doc}.${this.deviceId}.json`;
  }

  /** The device id a file name belongs to for `doc`, or null if it is not one of its files. */
  deviceOf(name, doc) {
    const m = new RegExp(`^${escapeRegExp(doc)}\\.([A-Za-z0-9_-]{4,32})\\.json$`).exec(name);
    return m ? m[1] : null;
  }

  /** Asks the provider whether this account may write here, and remembers the answer. */
  async refreshAccess() {
    if (typeof this.provider.access !== "function") return;
    const role = await this.provider.access(this.folder);
    this.readOnly = role === "viewer";
  }

  /**
   * One sync round for one document.
   * @param {string} doc document name, for example "state"
   * @param {{ kind?: string, schema: number, local: unknown, merge: (a: unknown, b: unknown) => unknown }} opts
   *  `merge(local, remote)` must be commutative, associative and idempotent (see merge.js).
   * @returns {Promise<{ merged: unknown, changed: boolean, remotes: number, pushed: boolean, skipped: string[], newerSchema: boolean }>}
   */
  async sync(doc, { kind = doc, schema, local, merge }) {
    const entries = await this.provider.list(this.folder);
    const own = this.fileName(doc);
    const mine = entries.find((e) => !e.folder && e.name === own);
    const others = entries.filter((e) => !e.folder && e.name !== own && this.deviceOf(e.name, doc) !== null);

    const live = new Set(others.map((e) => e.id));
    for (const id of [...this.cache.keys()]) if (!live.has(id) && !(mine && mine.id === id)) this.cache.delete(id);

    const skipped = [];
    let newerSchema = false;
    const remotes = [];
    for (const entry of others) {
      let cached = this.cache.get(entry.id);
      if (!cached || cached.tag !== entry.tag) {
        try {
          const envelope = decodeEnvelope(await this.provider.read(this.folder, entry));
          cached = { tag: entry.tag, envelope };
          this.cache.set(entry.id, cached);
        } catch (e) {
          if (e instanceof EnvelopeError) { skipped.push(entry.name); continue; }
          if (e instanceof StorageError && e.kind === ErrorKind.notFound) { skipped.push(entry.name); continue; }
          throw e;
        }
      }
      const env = cached.envelope;
      if (env.kind !== kind || env.app !== this.app) { skipped.push(entry.name); continue; }
      if (env.schema > schema) { newerSchema = true; continue; }
      remotes.push(env);
    }

    let merged = local;
    for (const env of remotes) merged = merge(merged, env.data);
    const changed = stableStringify(merged) !== stableStringify(local);
    const pushed = await this.pushIfChanged(doc, { kind, schema, data: merged, mine });
    return { merged, changed, remotes: remotes.length, pushed, skipped, newerSchema };
  }

  async pushIfChanged(doc, { kind, schema, data, mine }) {
    if (this.readOnly) return false;
    const canonical = stableStringify(data);
    if (this.lastPushed.get(doc) === canonical && mine) return false;
    if (mine && !this.lastPushed.has(doc)) {
      // A fresh process: skip the upload when the file already holds exactly this data.
      try {
        const env = decodeEnvelope(await this.provider.read(this.folder, mine));
        if (env.kind === kind && env.schema === schema && stableStringify(env.data) === canonical) {
          this.lastPushed.set(doc, canonical);
          return false;
        }
      } catch { /* unreadable own file: overwrite it */ }
    }
    const bytes = encodeEnvelope(makeEnvelope({ app: this.app, kind, schema, deviceId: this.deviceId, updatedAt: this.now(), data }));
    try {
      const entry = await this.provider.write(this.folder, this.fileName(doc), bytes, mine);
      this.cache.set(entry.id, { tag: entry.tag, envelope: decodeEnvelope(bytes) });
    } catch (e) {
      if (e instanceof StorageError && e.kind === ErrorKind.forbidden) {
        this.readOnly = true; // a viewer: keep reading, stop writing
        return false;
      }
      throw e;
    }
    this.lastPushed.set(doc, canonical);
    return true;
  }
}
