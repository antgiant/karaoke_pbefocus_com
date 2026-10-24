import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installDom, uninstallDom } from "./helpers/dom.mjs";

before(() => installDom());
after(() => uninstallDom());
beforeEach(() => { localStorage.clear(); window.sessionStorage.clear(); delete window.msal; });

const { initCloud, isAuthPopup, onPbeDomain } = await import("../assets/js/cloud/setup.js");

class FakePublicClientApplication {
  constructor(config) { FakePublicClientApplication.config = config; this.accounts = []; }
  async initialize() {}
  async handleRedirectPromise() { return null; }
  getAllAccounts() { return this.accounts; }
  setActiveAccount() {}
  async acquireTokenSilent() { throw new Error("none"); }
  async loginPopup() { const account = { homeAccountId: "h", username: "me@outlook.com" }; this.accounts = [account]; return { account, accessToken: "t" }; }
  async clearCache() { this.accounts = []; }
}

test("onPbeDomain recognises pbefocus.com and its subdomains only", () => {
  assert.equal(onPbeDomain("pbefocus.com"), true);
  assert.equal(onPbeDomain("karaoke.pbefocus.com"), true);
  assert.equal(onPbeDomain("evilpbefocus.com"), false);
  assert.equal(onPbeDomain("pbefocus.com.evil.example"), false);
  assert.equal(onPbeDomain("localhost"), false);
});

test("isAuthPopup spots MSAL's own sign-in window", () => {
  assert.equal(isAuthPopup({ opener: {}, name: "msal.123" }), true);
  assert.equal(isAuthPopup({ opener: null, name: "msal.123" }), false);
  assert.equal(isAuthPopup({ opener: {}, name: "" }), false);
});

test("initCloud starts local-only, with both providers available when the Microsoft library is loaded", async () => {
  window.msal = { PublicClientApplication: FakePublicClientApplication };
  const started = await initCloud({ window, document });
  assert.ok(started);
  const snap = started.cloud.snapshot();
  assert.equal(snap.primary, "local");
  assert.deepEqual(snap.connections.map((c) => c.provider).sort(), ["google", "microsoft"]);
  assert.equal(FakePublicClientApplication.config.auth.clientId, "86d550b4-029b-4b45-abf0-c8a56aa5bffe");
  assert.equal(FakePublicClientApplication.config.cache.cacheLocation, "localStorage");
  started.cloud.controller.stop();
});

test("without the Microsoft library, Google is still offered and nothing throws", async () => {
  const started = await initCloud({ window, document });
  assert.deepEqual(started.cloud.snapshot().connections.map((c) => c.provider), ["google"]);
  started.cloud.controller.stop();
});

test("connecting Microsoft through the real wiring signs in and records it in the shared cookie", async () => {
  window.msal = { PublicClientApplication: FakePublicClientApplication };
  const started = await initCloud({ window, document });
  const account = await started.cloud.connect("microsoft");
  assert.equal(account.name, "me@outlook.com");
  assert.match(document.cookie, /pbe_account=/);
  assert.equal(started.cloud.snapshot().connections.find((c) => c.provider === "microsoft").connected, true);
  started.cloud.controller.stop();
});

test("inside MSAL's sign-in popup nothing starts", async () => {
  const popup = { ...window, opener: {}, name: "msal.9", location: window.location };
  assert.equal(await initCloud({ window: popup, document }), null);
});
