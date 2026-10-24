// The "Storage" button and dialog: where the person's data lives, which accounts are connected, and how to change that.
// Plain DOM, driven entirely by cloud.snapshot() (cloud.js); every action goes through the cloud object, never to a provider directly.

const PROVIDER_LABEL = { microsoft: "OneDrive", google: "Google Drive" };

export const TEXT = {
  localSummary: "Your playlists, practice history and settings are saved on this device only. You can also back them up to your own cloud storage, which keeps them in step on all your devices.",
  googleWarning: "Google Drive works for your own data on all your devices. Because of limits Google puts on apps, it can't be used for shared folders where several people add data. You can still join shared folders on OneDrive by also connecting a Microsoft account.",
  needsFolder: "You're signed in. Choose a folder to finish setting up.",
};

const el = (doc, tag, props = {}, ...children) => {
  const node = doc.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  node.append(...children.flat().filter((c) => c !== null && c !== undefined));
  return node;
};

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function ago(then, now = Date.now()) {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Short text for the header button. */
export function buttonLabel(snapshot) {
  if (snapshot.primary === "local") return "Storage: this device";
  const name = PROVIDER_LABEL[snapshot.primary] ?? snapshot.primary;
  if (snapshot.error || snapshot.sync.status === "error") return `Storage: ${name} ⚠`;
  if (snapshot.sync.status === "syncing") return `Storage: ${name} ⟳`;
  return `Storage: ${name}`;
}

/**
 * @param {{ document: Document, button: HTMLElement, dialog: HTMLDialogElement, body: HTMLElement, cloud: object, now?: () => number }} deps
 * @returns {{ render: () => void, open: () => void }}
 */
export function mountStoragePanel({ document: doc, button, dialog, body, cloud, now = Date.now }) {
  let view = "main"; // "main" | "googleWarning"
  let busy = false;
  let message = "";

  const refreshButton = () => {
    const snap = cloud.snapshot();
    button.textContent = buttonLabel(snap);
    button.setAttribute("aria-label", `${buttonLabel(snap)}. Open storage settings.`);
  };

  async function run(action) {
    if (busy) return;
    busy = true;
    message = "";
    render();
    try { await action(); } catch (e) { message = e && e.message ? e.message : String(e); }
    busy = false;
    view = "main";
    render();
  }

  function btn(label, onclick, { secondary = true, id } = {}) {
    return el(doc, "button", { type: "button", class: secondary ? "btn secondary" : "btn", ...(id ? { id } : {}), ...(busy ? { disabled: "" } : {}), onclick }, label);
  }

  /** Connect (if needed) then make `provider` the person's own storage. */
  const backUpTo = (provider) => run(async () => {
    const snap = cloud.snapshot();
    const connection = snap.connections.find((c) => c.provider === provider);
    if (!connection || !connection.connected) await cloud.connect(provider);
    await cloud.useForMyData(provider);
  });

  function renderMain(snap) {
    const nodes = [el(doc, "h2", {}, "Where your data lives")];
    if (snap.primary === "local") {
      nodes.push(el(doc, "p", { class: "storage-summary" }, TEXT.localSummary));
      nodes.push(el(doc, "div", { class: "storage-actions" },
        btn("Back up to OneDrive", () => backUpTo("microsoft"), { secondary: false, id: "storageOneDriveBtn" }),
        btn("Back up to Google Drive", () => { view = "googleWarning"; render(); }, { id: "storageGoogleBtn" }),
      ));
    } else {
      const name = PROVIDER_LABEL[snap.primary];
      const last = snap.sync.lastSyncedAt ? `Last synced ${ago(snap.sync.lastSyncedAt, now())}.` : "Not synced yet.";
      if (snap.needsFolder) {
        nodes.push(el(doc, "p", { class: "storage-summary" }, TEXT.needsFolder));
        nodes.push(el(doc, "div", { class: "storage-actions" }, btn("Choose a folder", () => run(() => cloud.useForMyData(snap.primary)), { secondary: false, id: "storageChooseBtn" })));
      } else {
        nodes.push(el(doc, "p", { class: "storage-summary" }, `Your data is saved on this device and backed up to ${name}, in the folder “${snap.folderName ?? "(unnamed)"}”. ${last}`));
        if (snap.primary === "google") nodes.push(el(doc, "p", { class: "fallback-note" }, TEXT.googleWarning));
        nodes.push(el(doc, "div", { class: "storage-actions" },
          btn("Sync now", () => run(() => cloud.syncNow()), { secondary: false, id: "storageSyncBtn" }),
          btn("Change folder", () => run(() => cloud.changeFolder()), { id: "storageFolderBtn" }),
          btn("Use this device only", () => run(async () => cloud.useLocalOnly()), { id: "storageLocalBtn" }),
        ));
      }
    }

    const shown = snap.connections.filter((c) => c.connected || c.needsReconnect);
    if (shown.length) {
      nodes.push(el(doc, "h3", {}, "Connected accounts"));
      nodes.push(el(doc, "ul", { class: "storage-connections" }, shown.map((c) => el(doc, "li", {},
        `${c.label}${c.account ? ` — ${c.account.name}` : ""}${c.primary ? " (your storage)" : ""}${c.needsReconnect ? " — needs reconnecting" : ""} `,
        c.needsReconnect ? btn("Reconnect", () => run(() => cloud.connect(c.provider)), { id: `reconnect-${c.provider}` }) : null,
        btn("Disconnect", () => run(() => cloud.disconnect(c.provider)), { id: `disconnect-${c.provider}` }),
      ))));
    }

    const problem = message || (snap.error && snap.error.message) || "";
    nodes.push(el(doc, "p", { class: "storage-error", role: "alert", ...(problem ? {} : { hidden: "" }) }, problem ? `Something went wrong: ${problem}` : ""));
    nodes.push(el(doc, "div", { class: "storage-actions" },
      shown.length ? btn("Sign out of everything", () => run(() => cloud.signOutAll()), { id: "storageSignOutAllBtn" }) : null,
      btn("Close", () => dialog.close(), { secondary: false, id: "storageCloseBtn" }),
    ));
    return nodes;
  }

  function renderGoogleWarning() {
    return [
      el(doc, "h2", {}, "Before you use Google Drive"),
      el(doc, "p", { class: "storage-summary" }, TEXT.googleWarning),
      el(doc, "div", { class: "storage-actions" },
        btn("Continue with Google Drive", () => backUpTo("google"), { secondary: false, id: "storageGoogleContinueBtn" }),
        btn("Use OneDrive instead", () => backUpTo("microsoft"), { id: "storageUseOneDriveBtn" }),
        btn("Cancel", () => { view = "main"; render(); }, { id: "storageGoogleCancelBtn" }),
      ),
    ];
  }

  function render() {
    refreshButton();
    // While the folder chooser owns the dialog body it replaces our content; re-rendering would throw it away.
    if (body.dataset.chooser === "1") return;
    const snap = cloud.snapshot();
    const nodes = view === "googleWarning" ? renderGoogleWarning() : renderMain(snap);
    nodes[0].id = "storageDialogTitle"; // the dialog's aria-labelledby
    body.replaceChildren(...nodes);
  }

  button.addEventListener("click", () => { view = "main"; message = ""; render(); dialog.showModal?.() ?? dialog.setAttribute("open", ""); });
  render();
  return { render, open: () => button.click() };
}
