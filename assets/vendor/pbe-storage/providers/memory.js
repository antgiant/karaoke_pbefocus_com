// An in-memory provider for tests. One MemoryBackend plays "the cloud"; each person gets their own provider instance on it.
// `visibility` imitates the two real providers:
//   "all"  (OneDrive-like)  a person sees every file in a folder they can open.
//   "own"  (Google drive.file-like) a person sees only files they created or picked one by one, plus the folders they can open.

import { ErrorKind, StorageError } from "../errors.js";

export class MemoryBackend {
  constructor() {
    this.nodes = new Map();
    this.seq = 0;
    this.clock = 1_000;
    this.failNext = [];
    /** userId -> the settings pointer that person saved (like the app-private file on OneDrive/Google) */
    this.pointers = new Map();
  }

  nextId() {
    return `m${++this.seq}`;
  }

  tick() {
    return ++this.clock;
  }

  /** Makes the next backend call fail with the given StorageError (for offline and error tests). */
  injectFailure(error) {
    this.failNext.push(error);
  }

  maybeFail() {
    const e = this.failNext.shift();
    if (e) throw e;
  }

  /** @returns {MemoryProvider} */
  createProvider(userId, { visibility = "all", name = "memory" } = {}) {
    return new MemoryProvider(this, userId, visibility, name);
  }
}

export class MemoryProvider {
  /** `name` is the provider id stamped on the folder references it hands out (tests use "microsoft" or "google" to stand in for them). */
  constructor(backend, userId, visibility, name = "memory") {
    this.name = name;
    this.kind = "memory";
    this.label = "Memory";
    this.backend = backend;
    this.userId = userId;
    this.visibility = visibility;
    this.picked = new Set();
  }

  account() {
    return { id: this.userId, name: this.userId };
  }

  /** Creates a top-level folder owned by this person. */
  async createRoot(name) {
    this.backend.maybeFail();
    const id = this.backend.nextId();
    this.backend.nodes.set(id, { id, name, parent: null, folder: true, owner: this.userId, grants: new Map(), tag: "v1", modified: this.backend.tick() });
    return { provider: this.name, id, name };
  }

  /** Gives another person access to a folder. */
  share(folder, userId, role) {
    this.node(folder.id).grants.set(userId, role);
  }

  /** Imitates the Google Picker: this person's app may now see this one file. */
  pick(entryOrId) {
    this.picked.add(typeof entryOrId === "string" ? entryOrId : entryOrId.id);
  }

  node(id) {
    const n = this.backend.nodes.get(id);
    if (!n) throw new StorageError(ErrorKind.notFound, `No such item ${id}`, { status: 404 });
    return n;
  }

  roleOn(node) {
    if (node.owner === this.userId) return "owner";
    return node.grants.get(this.userId) || "none";
  }

  /** @returns {Promise<"owner"|"editor"|"viewer"|"none">} */
  async access(folder) {
    this.backend.maybeFail();
    const n = this.backend.nodes.get(folder.id);
    return n ? this.roleOn(n) : "none";
  }

  canOpen(folderNode) {
    return this.roleOn(folderNode) !== "none";
  }

  visible(child) {
    if (child.folder) return true;
    if (this.visibility === "all") return true;
    return child.owner === this.userId || this.picked.has(child.id);
  }

  toEntry(n) {
    return { id: n.id, name: n.name, tag: n.tag, modified: n.modified, size: n.bytes ? n.bytes.length : 0, folder: n.folder };
  }

  async list(folder) {
    this.backend.maybeFail();
    const parent = this.node(folder.id);
    if (!this.canOpen(parent)) throw new StorageError(ErrorKind.notFound, "Folder not accessible", { status: 404 });
    return [...this.backend.nodes.values()].filter((n) => n.parent === parent.id && this.visible(n)).map((n) => this.toEntry(n));
  }

  async ensureFolder(parent, name) {
    this.backend.maybeFail();
    const p = this.node(parent.id);
    const existing = [...this.backend.nodes.values()].find((n) => n.parent === p.id && n.folder && n.name === name);
    if (existing) return { provider: this.name, id: existing.id, name };
    if (!["owner", "editor"].includes(this.roleOn(p))) throw new StorageError(ErrorKind.forbidden, "Read-only folder", { status: 403 });
    const id = this.backend.nextId();
    this.backend.nodes.set(id, { id, name, parent: p.id, folder: true, owner: this.userId, grants: new Map(), tag: "v1", modified: this.backend.tick() });
    return { provider: this.name, id, name };
  }

  async read(folder, entry) {
    this.backend.maybeFail();
    const n = this.node(entry.id);
    if (n.parent !== folder.id || !this.visible(n)) throw new StorageError(ErrorKind.notFound, "File not accessible", { status: 404 });
    return new Uint8Array(n.bytes);
  }

  async write(folder, name, bytes, existing) {
    this.backend.maybeFail();
    const parent = this.node(folder.id);
    if (!["owner", "editor"].includes(this.roleOn(parent))) throw new StorageError(ErrorKind.forbidden, "Read-only folder", { status: 403 });
    if (existing) {
      const n = this.node(existing.id);
      if (!this.visible(n)) throw new StorageError(ErrorKind.notFound, "File not accessible", { status: 404 });
      n.bytes = new Uint8Array(bytes);
      n.tag = `v${Number(n.tag.slice(1)) + 1}`;
      n.modified = this.backend.tick();
      return this.toEntry(n);
    }
    const id = this.backend.nextId();
    const n = { id, name, parent: parent.id, folder: false, owner: this.userId, bytes: new Uint8Array(bytes), tag: "v1", modified: this.backend.tick() };
    this.backend.nodes.set(id, n);
    return this.toEntry(n);
  }

  async readPointer() {
    this.backend.maybeFail();
    return this.backend.pointers.has(this.userId) ? structuredClone(this.backend.pointers.get(this.userId)) : undefined;
  }

  async writePointer(value) {
    this.backend.maybeFail();
    this.backend.pointers.set(this.userId, structuredClone(value));
  }

  async remove(folder, entry) {
    this.backend.maybeFail();
    const n = this.node(entry.id);
    if (n.owner !== this.userId) throw new StorageError(ErrorKind.forbidden, "Only the owner of a file removes it", { status: 403 });
    this.backend.nodes.delete(n.id);
  }
}
