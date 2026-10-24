// Google's file and folder Picker. With drive.file this is how a person hands an app something it did not create.
// Browser only; the Google script is loaded on first use. `google` and `gapi` can be injected for tests.

function loadScript(src, doc) {
  return new Promise((resolve, reject) => {
    const s = Object.assign(doc.createElement("script"), { src, async: true });
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    doc.head.append(s);
  });
}

let ready;
/** Loads Google's Picker once and returns `google.picker`. */
export function loadPicker({ document: doc = globalThis.document, window: win = globalThis.window } = {}) {
  if (win && win.google && win.google.picker) return Promise.resolve(win.google.picker);
  return (ready ??= loadScript("https://apis.google.com/js/api.js", doc)
    .then(() => new Promise((resolve, reject) => win.gapi.load("picker", { callback: resolve, onerror: () => reject(new Error("The Google Picker failed to load")) })))
    .then(() => win.google.picker)
    .catch((e) => { ready = undefined; throw e; }));
}

function show(picker, { token, apiKey, appId, title, views, multi }) {
  return new Promise((resolve) => {
    const b = new picker.PickerBuilder();
    for (const v of views) b.addView(v);
    if (multi) b.enableFeature(picker.Feature.MULTISELECT_ENABLED);
    b.setOAuthToken(token).setDeveloperKey(apiKey).setAppId(appId).setTitle(title).setCallback((data) => {
      if (data.action === picker.Action.PICKED && data.docs) resolve(data.docs.map((d) => ({ id: d.id, name: d.name })));
      else if (data.action === picker.Action.CANCEL) resolve(null);
    });
    b.build().setVisible(true);
  });
}

/** Opens the folder picker. Resolves with `{ provider: "google", id, name }`, or null if the person closed it. Must run from a click. */
export async function pickFolder({ token, apiKey, appId, title = "Choose a folder", picker } = {}) {
  const p = picker || (await loadPicker());
  const mime = "application/vnd.google-apps.folder";
  const mine = new p.DocsView(p.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes(mime);
  const shared = new p.DocsView(p.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setOwnedByMe(false).setMimeTypes(mime);
  const picked = await show(p, { token, apiKey, appId, title, views: [mine, shared], multi: false });
  return picked && picked[0] ? { provider: "google", id: picked[0].id, name: picked[0].name } : null;
}

/** Opens a file picker, optionally starting inside a folder and allowing several files. Resolves with `[{ id, name }]` or null. */
export async function pickFiles({ token, apiKey, appId, title = "Choose files", parent, multi = false, mimeTypes, picker } = {}) {
  const p = picker || (await loadPicker());
  const view = new p.DocsView(p.ViewId.DOCS).setIncludeFolders(false);
  if (parent) view.setParent(parent);
  if (mimeTypes) view.setMimeTypes(mimeTypes);
  return show(p, { token, apiKey, appId, title, views: [view], multi });
}
