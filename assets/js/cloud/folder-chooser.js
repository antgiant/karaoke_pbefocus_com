// Lets the person choose (or create) the folder their PBE data lives in. Nothing is ever created in their cloud account without this
// choice (docs/unified-storage-plan.md, section 3.5). OneDrive: a small folder browser built on the provider. Google: the Google Picker,
// or one tap to create a folder.

import { pickFolder } from "../../vendor/pbe-storage/providers/google-picker.js";
import { DEFAULT_FOLDER_NAME } from "./config.js";

function el(doc, tag, props = {}, ...children) {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined));
  return node;
}

/**
 * @param {{ document: Document, container: HTMLElement, google?: { getToken: () => Promise<string>, apiKey: string, appId: string },
 *   ask?: (message: string, fallback: string) => string | null, pick?: typeof pickFolder }} deps
 * @returns {(provider: string, instance: object) => Promise<object | null>} resolves with a folder reference, or null if they cancel
 */
export function createFolderChooser({ document: doc, container, google, ask = (m, d) => globalThis.prompt(m, d), pick = pickFolder }) {
  const previous = () => Array.from(container.childNodes);

  return function chooseFolder(provider, instance) {
    const saved = previous();
    return new Promise((resolve) => {
      container.dataset.chooser = "1"; // tells the storage panel not to redraw over this while the person is choosing
      const done = (value) => {
        delete container.dataset.chooser;
        container.replaceChildren(...saved);
        resolve(value);
      };
      if (provider === "google") renderGoogle(done, instance);
      else renderOneDrive(done, instance);
    });
  };

  function show(...nodes) {
    container.replaceChildren(...nodes);
  }

  function renderGoogle(done, instance) {
    const status = el(doc, "p", { class: "storage-error", role: "alert", hidden: "" });
    const fail = (e) => { status.textContent = e && e.message ? e.message : String(e); status.hidden = false; };
    show(
      el(doc, "h2", { id: "storageDialogTitle" }, "Choose a folder for your PBE data"),
      el(doc, "p", {}, "Your Karaoke data goes in a “karaoke” folder inside the folder you choose. Other PBE apps use the same folder."),
      el(doc, "div", { class: "storage-actions" },
        el(doc, "button", { type: "button", class: "btn", id: "folderCreateBtn", onclick: async () => {
          try { done(await instance.createFolder(DEFAULT_FOLDER_NAME)); } catch (e) { fail(e); }
        } }, `Create “${DEFAULT_FOLDER_NAME}” for me`),
        el(doc, "button", { type: "button", class: "btn secondary", id: "folderPickBtn", onclick: async () => {
          try {
            const token = await google.getToken();
            const folder = await pick({ token, apiKey: google.apiKey, appId: google.appId, title: "Choose a folder for your PBE data" });
            if (folder) done(folder);
          } catch (e) { fail(e); }
        } }, "Pick a folder in Google Drive"),
        el(doc, "button", { type: "button", class: "btn secondary", id: "folderCancelBtn", onclick: () => done(null) }, "Cancel"),
      ),
      status,
    );
  }

  function renderOneDrive(done, instance) {
    const stack = []; // folder references from the top of OneDrive down to where the person is now
    const render = async () => {
      const here = stack[stack.length - 1];
      const status = el(doc, "p", { class: "storage-error", role: "alert", hidden: "" });
      const list = el(doc, "ul", { class: "folder-list" }, el(doc, "li", {}, "Loading…"));
      const fail = (e) => { status.textContent = e && e.message ? e.message : String(e); status.hidden = false; };
      const crumbs = ["My OneDrive", ...stack.map((f) => f.name)].join(" / ");
      show(
        el(doc, "h2", { id: "storageDialogTitle" }, "Choose a folder for your PBE data"),
        el(doc, "p", {}, "Your Karaoke data goes in a “karaoke” folder inside the folder you choose. Other PBE apps use the same folder."),
        el(doc, "p", { class: "folder-crumbs" }, crumbs),
        list,
        el(doc, "div", { class: "storage-actions" },
          stack.length ? el(doc, "button", { type: "button", class: "btn secondary", id: "folderUpBtn", onclick: () => { stack.pop(); render(); } }, "Back") : null,
          el(doc, "button", { type: "button", class: "btn", id: "folderUseBtn", ...(here ? {} : { disabled: "" }), onclick: () => done(here) }, "Use this folder"),
          el(doc, "button", { type: "button", class: "btn secondary", id: "folderNewBtn", onclick: async () => {
            const name = ask("Name the new folder:", DEFAULT_FOLDER_NAME);
            if (!name || !name.trim()) return;
            try { stack.push(await instance.createFolder(name.trim(), here)); render(); } catch (e) { fail(e); }
          } }, "New folder…"),
          el(doc, "button", { type: "button", class: "btn secondary", id: "folderCancelBtn", onclick: () => done(null) }, "Cancel"),
        ),
        status,
      );
      try {
        const folders = await instance.browse(here);
        list.replaceChildren(...(folders.length
          ? folders.map((f) => el(doc, "li", {}, el(doc, "button", { type: "button", class: "btn secondary tiny folder-open", onclick: () => { stack.push(f); render(); } }, `📁 ${f.name}`)))
          : [el(doc, "li", {}, "No folders here yet. Create one with “New folder…”.")]));
      } catch (e) { list.replaceChildren(); fail(e); }
    };
    render();
  }
}
