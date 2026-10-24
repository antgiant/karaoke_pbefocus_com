// Browser bootstrap for cloud storage: builds the connection registry from the page's real cookie, storage and sign-in libraries and
// hands back the `cloud` object (cloud.js). Never throws into the app: if anything here fails, Karaoke simply stays local-only.

import { ConnectionRegistry } from "../../vendor/pbe-storage/registry.js";
import { CookieStore } from "../../vendor/pbe-storage/cookie.js";
import { getDeviceId } from "../../vendor/pbe-storage/envelope.js";
import { attachBrowserHooks } from "../../vendor/pbe-storage/sync/controller.js";
import { createMicrosoftAuth } from "../../vendor/pbe-storage/auth/microsoft.js";
import { createGoogleAuth } from "../../vendor/pbe-storage/auth/google.js";
import { OneDriveProvider } from "../../vendor/pbe-storage/providers/onedrive.js";
import { GoogleDriveProvider } from "../../vendor/pbe-storage/providers/googledrive.js";
import { loadState, saveState } from "../storage.js";
import { STATE_SAVED_EVENT } from "../constants.js";
import { createCloud } from "./cloud.js";
import { GOOGLE_CLIENT_ID, MICROSOFT_CLIENT_ID } from "./config.js";
import { getPca, msalAvailable } from "./msal.js";

/** MSAL's sign-in popup loads this same page; it must not start its own sync while it finishes the sign-in. */
export function isAuthPopup(win) {
  return Boolean(win.opener) && String(win.name || "").startsWith("msal");
}

/** True on pbefocus.com and its subdomains, where the shared sign-in cookie can be set for every PBE app. */
export function onPbeDomain(hostname) {
  return hostname === "pbefocus.com" || hostname.endsWith(".pbefocus.com");
}

/**
 * @param {{ window?: Window, document?: Document, onChange?: () => void }} [opts]
 * @returns {Promise<null | { cloud: object, googleAuth: object, setFolderChooser: (fn: Function) => void }>}
 */
export async function initCloud({ window: win = globalThis.window, document: doc = globalThis.document, onChange = () => {} } = {}) {
  if (!win || isAuthPopup(win)) return null;
  const loc = win.location;
  const cookie = new CookieStore({ document: doc, domain: onPbeDomain(loc.hostname) ? ".pbefocus.com" : undefined, secure: loc.protocol === "https:" });

  const providers = {};
  if (msalAvailable()) {
    const auth = createMicrosoftAuth({ pca: getPca(), clientId: MICROSOFT_CLIENT_ID, redirectUri: loc.origin + loc.pathname, mode: "popup", autoRedirect: false });
    providers.microsoft = { label: "OneDrive", auth, createProvider: (a) => new OneDriveProvider({ getToken: () => a.getToken() }) };
  }
  const googleAuth = createGoogleAuth({ clientId: GOOGLE_CLIENT_ID, storage: win.sessionStorage });
  providers.google = { label: "Google Drive", auth: googleAuth, createProvider: (a) => new GoogleDriveProvider({ getToken: (force) => a.getToken(force) }) };

  let folderChooser = async () => null;
  const registry = new ConnectionRegistry({ cookie, providers, store: win.localStorage, sessionStore: win.sessionStorage });
  const cloud = createCloud({
    registry,
    loadState,
    saveState,
    storage: win.localStorage,
    deviceId: getDeviceId(win.localStorage),
    chooseFolder: (provider, instance) => folderChooser(provider, instance),
    onChange,
  });

  win.addEventListener(STATE_SAVED_EVENT, () => cloud.noteChange());
  attachBrowserHooks(cloud.controller, { window: win, document: doc });
  const recheck = () => { if (doc.visibilityState === "visible") void cloud.reconcile().catch(() => {}); };
  win.addEventListener("focus", recheck);
  doc.addEventListener("visibilitychange", recheck);

  await registry.init();
  cloud.start();
  return { cloud, googleAuth, setFolderChooser: (fn) => { folderChooser = fn; } };
}
