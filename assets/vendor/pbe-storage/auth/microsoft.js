// Microsoft sign-in with MSAL.js (the redirect flow StepUp uses, with a popup option for pages that must not navigate away).
// Microsoft keeps a browser app's refresh token for about a day, so the person is quietly signed in again from their Microsoft
// session using the remembered account hint; only if that fails does the app show a "Reconnect" button.

import { ErrorKind, StorageError } from "../errors.js";

export const DEFAULT_SCOPES = ["Files.ReadWrite.All", "User.Read"];

/**
 * @param {{ msal: object, clientId: string, redirectUri: string, scopes?: string[], authority?: string, mode?: "redirect" | "popup" }} opts
 *  `msal` is the vendored library's global (`window.msal`).
 * @returns the StorageAuth object the ConnectionRegistry expects, plus `getToken`.
 */
export function createMicrosoftAuth({ msal, clientId, redirectUri, scopes = DEFAULT_SCOPES, authority = "https://login.microsoftonline.com/common", mode = "redirect" }) {
  let pca;
  let account = null;
  let ready;

  const client = async () => {
    if (!msal) throw new StorageError(ErrorKind.auth, "The Microsoft sign-in library did not load");
    if (!pca) {
      pca = new msal.PublicClientApplication({ auth: { clientId, authority, redirectUri }, cache: { cacheLocation: "localStorage" } });
      ready = pca.initialize();
    }
    await ready;
    return pca;
  };

  const describe = (acc) => ({ id: acc.homeAccountId, name: acc.username });
  const adopt = (acc) => {
    account = acc || null;
    if (acc) pca.setActiveAccount(acc);
    return acc ? describe(acc) : undefined;
  };

  return {
    /** Finishes a redirect that just happened and resumes a remembered session. */
    async restore() {
      const app = await client();
      const result = await app.handleRedirectPromise();
      return adopt((result && result.account) || app.getAllAccounts()[0]);
    },

    async getToken() {
      const app = await client();
      if (!account) throw new StorageError(ErrorKind.auth, "Not signed in to Microsoft");
      try {
        return (await app.acquireTokenSilent({ scopes, account })).accessToken;
      } catch (cause) {
        throw new StorageError(ErrorKind.auth, "Microsoft sign-in needs to be renewed", { cause });
      }
    },

    async signIn(hint) {
      const app = await client();
      const request = hint ? { scopes, loginHint: hint } : { scopes, prompt: "select_account" };
      if (mode === "popup") {
        const result = await app.loginPopup(request);
        adopt(result.account);
        return;
      }
      await app.loginRedirect(request);
      await new Promise(() => {}); // the page is navigating away
    },

    /** Quietly signs in again as the remembered account. In redirect mode this may navigate away and come back signed in. */
    async autoSignIn(hint) {
      const app = await client();
      try {
        const result = await app.ssoSilent({ scopes, loginHint: hint });
        return adopt(result.account);
      } catch (cause) {
        if (mode !== "redirect" || !hint) throw cause;
      }
      await app.loginRedirect({ scopes, loginHint: hint });
      return new Promise(() => {});
    },

    canAutoSignIn: (hint) => Boolean(hint),

    /** Leaves PBE apps but not Microsoft itself: clears this browser's tokens without logging the person out of their Microsoft account. */
    async signOut() {
      const app = await client();
      if (account) await app.clearCache({ account });
      account = null;
    },

    async forget() {
      return this.signOut();
    },
  };
}
