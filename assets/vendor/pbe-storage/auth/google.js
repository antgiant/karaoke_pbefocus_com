// Google sign-in with Google Identity Services (the token popup flow). Google gives a browser app only ~1 hour access tokens and
// no refresh token, so the token is renewed quietly (prompt "none") using the remembered account hint while the person's Google
// session lasts; otherwise the app shows a "Reconnect" button.

import { ErrorKind, StorageError } from "../errors.js";

export const DEFAULT_SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata";
const SESSION_KEY = "pbe.google.session";

function loadGis(doc) {
  return new Promise((resolve, reject) => {
    const s = Object.assign(doc.createElement("script"), { src: "https://accounts.google.com/gsi/client", async: true });
    s.onload = resolve;
    s.onerror = () => reject(new StorageError(ErrorKind.network, "Could not load Google sign-in"));
    doc.head.append(s);
  });
}

/**
 * @param {{ clientId: string, scope?: string, google?: object, fetch?: typeof fetch, storage?: Storage, now?: () => number,
 *   document?: Document }} opts  `google` is `window.google` (injected in tests; loaded on demand otherwise).
 */
export function createGoogleAuth({ clientId, scope = DEFAULT_SCOPE, google, fetch: fetchFn = globalThis.fetch?.bind(globalThis), storage = globalThis.sessionStorage, now = Date.now, document: doc = globalThis.document }) {
  let session; // { token, expiresAt, account }
  let hint;

  const load = async () => {
    if (google) return google;
    if (globalThis.google?.accounts?.oauth2) return globalThis.google;
    await loadGis(doc);
    return globalThis.google;
  };
  const fresh = (s) => Boolean(s) && s.expiresAt - now() > 60_000;
  const save = () => {
    try {
      if (session) storage.setItem(SESSION_KEY, JSON.stringify(session));
      else storage.removeItem(SESSION_KEY);
    } catch { /* storage blocked: the session lasts until the page reloads */ }
  };

  const requestToken = async (prompt, loginHint) => {
    const g = await load();
    return new Promise((resolve, reject) => {
      const tokenClient = g.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope,
        callback: (r) => (r.access_token ? resolve(r) : reject(new StorageError(ErrorKind.auth, r.error_description || r.error || "Google sign-in failed"))),
        error_callback: (e) => reject(new StorageError(ErrorKind.auth, (e && (e.message || e.type)) || "Google sign-in was cancelled")),
      });
      tokenClient.requestAccessToken({ prompt, ...(loginHint ? { hint: loginHint } : {}) });
    });
  };

  const accountFor = async (token) => {
    const res = await fetchFn("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)", { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new StorageError(ErrorKind.auth, `Google did not say who signed in (${res.status})`);
    const user = (await res.json()).user || {};
    const email = user.emailAddress || user.displayName || "Google account";
    return { id: email, name: email };
  };

  const acquire = async (prompt, loginHint) => {
    const r = await requestToken(prompt, loginHint);
    session = { token: r.access_token, expiresAt: now() + (r.expires_in || 3600) * 1000, account: await accountFor(r.access_token) };
    hint = session.account.name;
    save();
    return session.account;
  };

  return {
    /** Resumes this tab's session if its token is still good. */
    async restore() {
      try {
        const saved = JSON.parse(storage.getItem(SESSION_KEY) || "null");
        if (fresh(saved)) { session = saved; hint = saved.account.name; return saved.account; }
      } catch { /* ignore */ }
      return session && fresh(session) ? session.account : undefined;
    },

    async getToken(force = false) {
      if (!force && fresh(session)) return session.token;
      if (!hint) throw new StorageError(ErrorKind.auth, "Google sign-in has expired");
      try {
        await acquire("none", hint);
      } catch (cause) {
        throw new StorageError(ErrorKind.auth, "Google sign-in has expired", { cause });
      }
      return session.token;
    },

    /** Must run from a click: opens Google's sign-in window. */
    async signIn(loginHint) {
      await acquire(loginHint || hint ? "" : "select_account", loginHint || hint);
    },

    async autoSignIn(loginHint) {
      return acquire("none", loginHint);
    },

    canAutoSignIn: (loginHint) => Boolean(loginHint),

    /** Revokes this browser's token and forgets it. Does not sign the person out of Google. */
    async signOut() {
      const token = session && session.token;
      session = undefined;
      hint = undefined;
      save();
      if (token) {
        try {
          const g = await load();
          await new Promise((resolve) => g.accounts.oauth2.revoke(token, resolve));
        } catch { /* revoking is best effort */ }
      }
    },

    async forget() {
      session = undefined;
      hint = undefined;
      save();
    },
  };
}
