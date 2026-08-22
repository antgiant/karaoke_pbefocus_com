// Minimal File System Access API stand-in for tests exercising
// assets/js/offline/local-library.js -- Node has no real
// FileSystemDirectoryHandle, so this builds one from a plain nested object,
// e.g. { "manifest.local.json": "...", "PBE_2026_2027": { "style": { "file.m4a": "bytes" } } }.
// String leaf values become file contents (readable via file.text()); a File's
// contents are also readable as bytes via a minimal .arrayBuffer() shim below,
// which is all local-library.js's getFile().getFile() path actually needs.

class FakeFileHandle {
  constructor(name, content) {
    this.kind = "file";
    this.name = name;
    this._content = content;
  }
  async getFile() {
    const content = this._content;
    return {
      name: this.name,
      async text() {
        return content;
      },
    };
  }
}

class FakeDirectoryHandle {
  constructor(name, tree) {
    this.kind = "directory";
    this.name = name;
    this._tree = tree;
  }
  async getDirectoryHandle(name) {
    const entry = this._tree[name];
    if (entry === undefined || typeof entry === "string") {
      const err = new Error(`No such directory: ${name}`);
      err.name = "NotFoundError";
      throw err;
    }
    return new FakeDirectoryHandle(name, entry);
  }
  async getFileHandle(name) {
    const entry = this._tree[name];
    if (typeof entry !== "string") {
      const err = new Error(`No such file: ${name}`);
      err.name = "NotFoundError";
      throw err;
    }
    return new FakeFileHandle(name, entry);
  }
}

/** Builds a fake root FileSystemDirectoryHandle from a nested plain object -- see this file's top comment. */
export function makeFakeRoot(tree) {
  return new FakeDirectoryHandle("root", tree);
}
