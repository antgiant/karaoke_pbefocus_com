// The one MSAL client for the whole page. The OneDrive library link (offline/onedrive-library.js) and cloud storage (cloud/setup.js)
// both sign in through it: two MSAL clients sharing one cache confuse each other.

import { MICROSOFT_CLIENT_ID } from "./config.js";

const AUTHORITY = "https://login.microsoftonline.com/common";

let pca; // lazily constructed -- window.msal isn't available until the vendored script has loaded

export function msalAvailable() {
  return typeof window !== "undefined" && Boolean(window.msal);
}

export function getPca() {
  if (!msalAvailable()) {
    throw new Error("OneDrive sign-in isn't available (the Microsoft sign-in library failed to load) -- try reloading the page.");
  }
  if (!pca) {
    pca = new window.msal.PublicClientApplication({
      auth: { clientId: MICROSOFT_CLIENT_ID, authority: AUTHORITY, redirectUri: window.location.origin + window.location.pathname },
      // localStorage, so the sign-in survives closing the tab and is shared with every other tab of this site.
      cache: { cacheLocation: "localStorage" },
    });
  }
  return pca;
}
