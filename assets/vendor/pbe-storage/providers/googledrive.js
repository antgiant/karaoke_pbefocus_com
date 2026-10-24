// Google Drive (scopes drive.file + drive.appdata). Verified in the Phase 0 tests: this is SINGLE-USER storage. With drive.file an
// app sees only the files its own account created or picked one by one, so shared multi-writer folders do not work on Google.
// What does work: a person's own data on all of their devices, and read-only distribution through "anyone with the link" plus an
// API key (see GooglePublicReader). See docs/unified-storage-plan.md, sections 3.9 and 3.10.

import { ErrorKind, StorageError } from "../errors.js";
import { Http, describeJsonError } from "./http.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,size,version,md5Checksum,modifiedTime";
const POINTER = "pbe-pointer.json";

const quote = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
/** Drive's `version` also moves for changes nobody made (indexing, thumbnails), so the checksum is the better tag when there is one. */
const tagOf = (f) => f.md5Checksum ?? f.version;
const toEntry = (f) => ({ id: f.id, name: f.name, tag: tagOf(f), modified: f.modifiedTime, size: f.size === undefined ? undefined : Number(f.size), folder: f.mimeType === FOLDER });

function multipart(meta, bytes) {
  const boundary = "pbe" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  const head = new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
  return { boundary, body: new Blob([head, bytes, tail]) };
}

export class GoogleDriveProvider {
  /** @param {{ getToken: (force?: boolean) => Promise<string>, fetch?: typeof fetch, sleep?: (ms: number) => Promise<void> }} opts */
  constructor({ getToken, fetch: fetchFn, sleep, maxRetries }) {
    this.kind = "google";
    this.label = "Google Drive";
    this.http = new Http({ getToken, fetch: fetchFn, sleep, maxRetries, describe: describeJsonError });
  }

  folderRef(f) {
    return { provider: "google", id: f.id, name: f.name };
  }

  async query(q, { appData = false, fields = FIELDS } = {}) {
    const out = [];
    let pageToken;
    do {
      const p = new URLSearchParams({ q, fields: `nextPageToken,files(${fields})`, pageSize: "1000", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
      if (appData) p.set("spaces", "appDataFolder");
      if (pageToken) p.set("pageToken", pageToken);
      const page = await this.http.json(`${API}/files?${p}`);
      out.push(...(page.files || []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  async list(folder) {
    return (await this.query(`'${quote(folder.id)}' in parents and trashed = false`)).map(toEntry);
  }

  async read(_folder, entry) {
    return this.http.bytes(`${API}/files/${encodeURIComponent(entry.id)}?alt=media&supportsAllDrives=true`);
  }

  async write(folder, name, bytes, existing) {
    if (existing) {
      const f = await this.http.json(`${UPLOAD}/files/${encodeURIComponent(existing.id)}?uploadType=media&supportsAllDrives=true&fields=${FIELDS}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/octet-stream" },
        body: bytes,
      });
      return toEntry(f);
    }
    const { boundary, body } = multipart({ name, parents: [folder.id] }, bytes);
    const f = await this.http.json(`${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=${FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return toEntry(f);
  }

  async remove(_folder, entry) {
    await this.http.request(`${API}/files/${encodeURIComponent(entry.id)}?supportsAllDrives=true`, { method: "DELETE" });
  }

  async ensureFolder(parent, name) {
    const found = await this.query(`'${quote(parent.id)}' in parents and mimeType = '${FOLDER}' and name = '${quote(name)}' and trashed = false`);
    if (found.length) return this.folderRef(found[0]);
    return this.createFolder(name, parent);
  }

  /** Creates a folder at the top of My Drive, or inside `parent`. */
  async createFolder(name, parent) {
    const f = await this.http.json(`${API}/files?supportsAllDrives=true&fields=${FIELDS}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, mimeType: FOLDER, ...(parent ? { parents: [parent.id] } : {}) }),
    });
    return this.folderRef(f);
  }

  /** "owner", "editor" or "viewer" for this account on a folder. */
  async access(folder) {
    const f = await this.http.json(`${API}/files/${encodeURIComponent(folder.id)}?fields=ownedByMe,capabilities(canEdit,canAddChildren)&supportsAllDrives=true`);
    if (f.ownedByMe) return "owner";
    return f.capabilities && f.capabilities.canAddChildren ? "editor" : "viewer";
  }

  /** Shares a folder this app created. Changing sharing later fails once others have written into it (appNotAuthorizedToChild). */
  async share(folder, email, role = "editor") {
    return this.http.json(`${API}/files/${encodeURIComponent(folder.id)}/permissions?sendNotificationEmail=true&supportsAllDrives=true&fields=id,role,emailAddress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "user", role: role === "viewer" ? "reader" : "writer", emailAddress: email }),
    });
  }

  /** Makes a folder readable by anyone with the link (for read-only distribution through GooglePublicReader). */
  async shareWithLink(folder) {
    await this.http.json(`${API}/files/${encodeURIComponent(folder.id)}/permissions?supportsAllDrives=true&fields=id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "anyone", role: "reader" }),
    });
    return `https://drive.google.com/drive/folders/${folder.id}`;
  }

  // ---- the settings pointer (which folder the person chose), kept in the app's hidden data area ----------------

  async readPointer() {
    const [file] = await this.query(`name = '${POINTER}'`, { appData: true, fields: "id,name" });
    if (!file) return undefined;
    return JSON.parse(new TextDecoder().decode(await this.http.bytes(`${API}/files/${encodeURIComponent(file.id)}?alt=media`)));
  }

  async writePointer(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const [file] = await this.query(`name = '${POINTER}'`, { appData: true, fields: "id,name" });
    if (file) {
      await this.http.json(`${UPLOAD}/files/${encodeURIComponent(file.id)}?uploadType=media&fields=id`, { method: "PATCH", headers: { "Content-Type": "application/octet-stream" }, body: bytes });
      return;
    }
    const { boundary, body } = multipart({ name: POINTER, parents: ["appDataFolder"] }, bytes);
    await this.http.json(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
  }
}

/**
 * Read-only access to a folder shared as "anyone with the link", using a public API key and no sign-in at all (the same approach
 * Karaoke's song library already uses). Anyone who has the link can read, so only use it for data meant to be distributed.
 */
export class GooglePublicReader {
  /** @param {{ apiKey: string, fetch?: typeof fetch, sleep?: (ms: number) => Promise<void> }} opts */
  constructor({ apiKey, fetch: fetchFn, sleep, maxRetries }) {
    this.kind = "google-public";
    this.label = "Google Drive link";
    this.apiKey = apiKey;
    this.http = new Http({ getToken: async () => "", fetch: fetchFn, sleep, maxRetries, describe: describeJsonError });
  }

  async list(folder) {
    const out = [];
    let pageToken;
    do {
      const p = new URLSearchParams({ key: this.apiKey, q: `'${quote(folder.id)}' in parents and trashed = false`, fields: `nextPageToken,files(${FIELDS})`, pageSize: "1000", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
      if (pageToken) p.set("pageToken", pageToken);
      const page = await this.http.json(`${API}/files?${p}`, {}, { auth: false });
      out.push(...(page.files || []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out.map(toEntry);
  }

  async read(_folder, entry) {
    return this.http.bytes(`${API}/files/${encodeURIComponent(entry.id)}?alt=media&supportsAllDrives=true&key=${encodeURIComponent(this.apiKey)}`, {}, { auth: false });
  }

  async access() {
    return "viewer";
  }

  async write() {
    throw new StorageError(ErrorKind.forbidden, "A shared link is read-only");
  }
}
