// OneDrive through Microsoft Graph (scope Files.ReadWrite.All). Verified in the Phase 0 tests: folder sharing by link, everyone sees
// everyone's files, no per-file picking. See docs/unified-storage-plan.md, sections 3.9 and 3.10.
//
// Folder references are { provider: "microsoft", id, driveId, name }; a folder shared by someone else lives on THEIR drive, so the
// driveId always travels with the id.

import { ErrorKind, StorageError } from "../errors.js";
import { Http, describeJsonError } from "./http.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const SELECT = "$select=id,name,folder,file,remoteItem,parentReference,size,eTag,lastModifiedDateTime";
const MAX_SIMPLE_UPLOAD = 4 * 1024 * 1024;
const POINTER = "pbe-pointer.json";

/** A listing entry may be a shortcut or "shared with me" stub (remoteItem) that lives on another drive. */
function refOf(item) {
  const r = item.remoteItem || item;
  const driveId = (r.parentReference && r.parentReference.driveId) || (item.parentReference && item.parentReference.driveId);
  return { id: r.id, driveId, isFolder: Boolean(r.folder || item.folder) };
}

const enc = (s) => encodeURIComponent(s);

export class OneDriveProvider {
  /** @param {{ getToken: () => Promise<string>, fetch?: typeof fetch, sleep?: (ms: number) => Promise<void> }} opts */
  constructor({ getToken, fetch: fetchFn, sleep, maxRetries }) {
    this.kind = "onedrive";
    this.label = "OneDrive";
    this.http = new Http({ getToken, fetch: fetchFn, sleep, maxRetries, describe: describeJsonError });
  }

  folderRef(item, fallbackName) {
    const r = refOf(item);
    return { provider: "microsoft", id: r.id, driveId: r.driveId, name: item.name || fallbackName };
  }

  toEntry(item) {
    const r = refOf(item);
    const entry = { id: r.id, name: item.name, tag: item.eTag, modified: item.lastModifiedDateTime, size: item.size, folder: r.isFolder };
    if (r.isFolder) entry.driveId = r.driveId;
    return entry;
  }

  async children(folder) {
    const out = [];
    let url = `${GRAPH}/drives/${folder.driveId}/items/${folder.id}/children?${SELECT}&$top=200`;
    while (url) {
      const page = await this.http.json(url);
      out.push(...page.value);
      url = page["@odata.nextLink"];
    }
    return out;
  }

  /** @returns {Promise<{id: string, name: string, tag?: string, modified?: string, size?: number, folder: boolean, driveId?: string}[]>} */
  async list(folder) {
    return (await this.children(folder)).map((i) => this.toEntry(i));
  }

  async read(folder, entry) {
    const meta = await this.http.json(`${GRAPH}/drives/${folder.driveId}/items/${entry.id}?$select=id,@microsoft.graph.downloadUrl`);
    const url = meta["@microsoft.graph.downloadUrl"];
    if (!url) throw new StorageError(ErrorKind.notFound, "No download address for that file");
    return this.http.bytes(url, {}, { auth: false });
  }

  /** Creates or replaces `name` inside `folder` (files up to 4 MB; synced documents are far smaller). */
  async write(folder, name, bytes, _existing) {
    if (bytes.byteLength > MAX_SIMPLE_UPLOAD) throw new StorageError(ErrorKind.invalid, "File is too large for a simple upload");
    const item = await this.http.json(
      `${GRAPH}/drives/${folder.driveId}/items/${folder.id}:/${enc(name)}:/content?@microsoft.graph.conflictBehavior=replace`,
      { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: bytes },
    );
    return this.toEntry(item);
  }

  async remove(folder, entry) {
    await this.http.request(`${GRAPH}/drives/${folder.driveId}/items/${entry.id}`, { method: "DELETE" });
  }

  /** Returns the named subfolder, creating it if it is missing (safe if two devices race). */
  async ensureFolder(parent, name) {
    const existing = (await this.children(parent)).find((i) => refOf(i).isFolder && i.name === name);
    if (existing) return this.folderRef(existing, name);
    try {
      const made = await this.http.json(`${GRAPH}/drives/${parent.driveId}/items/${parent.id}/children`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }),
      });
      return this.folderRef(made, name);
    } catch (e) {
      if (e instanceof StorageError && e.kind === ErrorKind.exists) {
        const again = (await this.children(parent)).find((i) => refOf(i).isFolder && i.name === name);
        if (again) return this.folderRef(again, name);
      }
      throw e;
    }
  }

  /** Writers can write; a viewer is discovered when a write is refused (Graph does not say cheaply), so this reports "unknown". */
  async access() {
    return "unknown";
  }

  // ---- choosing and sharing folders ------------------------------------------------------------------------

  /** Subfolders of a folder, or of the top of the person's OneDrive when `folder` is omitted. For a folder chooser. */
  async browse(folder) {
    const items = folder
      ? await this.children(folder)
      : (await this.http.json(`${GRAPH}/me/drive/root/children?${SELECT}&$top=200`)).value;
    return items.filter((i) => refOf(i).isFolder).map((i) => this.folderRef(i));
  }

  /** Creates a folder at the top of the person's OneDrive, or inside `parent`. */
  async createFolder(name, parent) {
    const url = parent ? `${GRAPH}/drives/${parent.driveId}/items/${parent.id}/children` : `${GRAPH}/me/drive/root/children`;
    const made = await this.http.json(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "rename" }),
    });
    return this.folderRef(made, name);
  }

  /** Turns a OneDrive sharing link into a folder reference (the person must have been invited, or the link must allow them). */
  async resolveLink(link) {
    const token = "u!" + btoa(link).replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
    const item = await this.http.json(`${GRAPH}/shares/${token}/driveItem?$select=id,name,folder,parentReference,remoteItem`);
    const r = refOf(item);
    if (!r.isFolder) throw new StorageError(ErrorKind.invalid, "That link is not a folder");
    return this.folderRef(item);
  }

  /** Invites a person by email as "editor" or "viewer". Returns the sharing link Microsoft created. */
  async invite(folder, email, role = "editor") {
    const res = await this.http.json(`${GRAPH}/drives/${folder.driveId}/items/${folder.id}/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requireSignIn: true, sendInvitation: true, roles: [role === "viewer" ? "read" : "write"], recipients: [{ email }], message: "PBE Focus shared folder" }),
    });
    const first = res.value && res.value[0];
    return { link: first && first.link && first.link.webUrl };
  }

  /** A shareable link; `scope: "anonymous"` means anyone with the link. */
  async createLink(folder, { type = "edit", scope = "anonymous" } = {}) {
    const res = await this.http.json(`${GRAPH}/drives/${folder.driveId}/items/${folder.id}/createLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, scope }),
    });
    return res.link && res.link.webUrl;
  }

  // ---- the settings pointer (which folder the person chose), kept in the app's private folder -----------------

  async readPointer() {
    try {
      return JSON.parse(new TextDecoder().decode(await this.http.bytes(`${GRAPH}/me/drive/special/approot:/${POINTER}:/content`)));
    } catch (e) {
      if (e instanceof StorageError && e.kind === ErrorKind.notFound) return undefined;
      throw e;
    }
  }

  async writePointer(value) {
    await this.http.json(`${GRAPH}/me/drive/special/approot:/${POINTER}:/content`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  }
}
