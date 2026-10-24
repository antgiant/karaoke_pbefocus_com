// The set of providers this browser is connected to (docs/unified-storage-plan.md, section 3.10).
//
// A person may be connected to several providers at once; one is "primary" (where their own data lives) and the rest exist to join
// spaces hosted elsewhere. The shared sign-in cookie keeps every PBE app in agreement about which providers are connected.
//
// Each provider supplies an `auth` object (the StorageAuth interface):
//   restore()                 -> { id, name } | undefined   finish a redirect / resume a remembered session, quietly
//   signIn()                  -> Promise<void>             interactive; may navigate away
//   signOut()                 -> Promise<void>             provider-level sign-out (revoke / logout); may navigate away
//   forget()                  -> Promise<void>             drop local tokens only, no network or navigation
//   canAutoSignIn(hint)       -> boolean
//   autoSignIn(hint)          -> Promise<{ id, name } | undefined>   quiet re-sign-in as the remembered account
//   getToken()                -> Promise<string>
// and `createProvider(auth)` returning a StorageProvider.

import { connect, disconnect, reconcile, setFolder, setPrimary, signOutAll, PROVIDERS } from "./cookie.js";

const stampKey = (provider) => `pbe.connectedAt.${provider}`;
const PENDING_KEY = "pbe.pendingConnect";

export class ConnectionRegistry {
  /**
   * @param {{ cookie: import("./cookie.js").CookieStore, providers: Record<string, { label: string, auth: object, createProvider: (auth: object) => object }>,
   *   store?: { getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void },
   *   now?: () => number, onChange?: () => void }} opts
   */
  constructor({ cookie, providers, store, sessionStore, now = Date.now, onChange = () => {} }) {
    this.cookie = cookie;
    /** survives a sign-in redirect within one tab (sessionStorage), so a failed automatic sign-in cannot loop */
    this.sessionStore = sessionStore || memoryStore();
    this.providers = providers;
    this.store = store || memoryStore();
    this.now = now;
    this.onChange = onChange;
    /** provider -> { account, connectedAt, hint } */
    this.sessions = new Map();
    /** providers whose cookie says "connected" but whose quiet sign-in did not work: the UI offers Reconnect */
    this.needsReconnect = new Set();
    this.instances = new Map();
  }

  read(key) {
    try { return this.store.getItem(key); } catch { return null; }
  }
  write(key, value) {
    try { if (value === null) this.store.removeItem(key); else this.store.setItem(key, String(value)); } catch { /* storage blocked */ }
  }

  autoTried(provider) {
    try { return this.sessionStore.getItem(`pbe.autoTried.${provider}`) === "1"; } catch { return true; } // cannot guard against a loop: never start one
  }
  setAutoTried(provider, on) {
    try { if (on) this.sessionStore.setItem(`pbe.autoTried.${provider}`, "1"); else this.sessionStore.removeItem(`pbe.autoTried.${provider}`); } catch { /* ignore */ }
  }

  /** Call once at start-up (and after a sign-in redirect). Restores sessions, then agrees with the cookie. */
  async init() {
    const pending = this.read(PENDING_KEY);
    for (const provider of Object.keys(this.providers)) {
      const account = await this.providers[provider].auth.restore().catch(() => undefined);
      if (!account) continue;
      const fresh = pending === provider;
      let at = Number(this.read(stampKey(provider)));
      if (fresh || !Number.isFinite(at) || at <= 0) { at = this.now(); this.write(stampKey(provider), at); }
      this.sessions.set(provider, { account, connectedAt: at, hint: account.name || account.id });
      this.setAutoTried(provider, false);
      if (fresh) this.cookie.update((s, now) => connect(s, { provider, hint: account.name || account.id }, now));
    }
    if (pending) this.write(PENDING_KEY, null);
    await this.reconcile();
    this.onChange();
  }

  /** Brings this app in line with the cookie. Safe to call often (on focus, on a timer). */
  async reconcile() {
    const sessions = {};
    for (const [provider, s] of this.sessions) sessions[provider] = { connectedAt: s.connectedAt, hint: s.hint };
    const actions = reconcile(this.cookie.read(), sessions);
    let changed = false;
    for (const action of actions) {
      const entry = this.providers[action.provider];
      if (!entry) continue;
      if (action.type === "signOut") {
        await entry.auth.forget();
        this.sessions.delete(action.provider);
        this.needsReconnect.delete(action.provider);
        this.write(stampKey(action.provider), null);
        changed = true;
      } else if (action.type === "adopt") {
        const s = this.sessions.get(action.provider);
        this.cookie.update((state) => connect(state, { provider: action.provider, hint: action.hint || s.account.name }, s.connectedAt));
        changed = true;
      } else if (action.type === "signIn") {
        if (this.autoTried(action.provider)) { this.needsReconnect.add(action.provider); changed = true; continue; }
        this.setAutoTried(action.provider, true); // one automatic attempt, so a failure shows a button instead of looping
        let account;
        try {
          if (entry.auth.canAutoSignIn(action.hint)) account = await entry.auth.autoSignIn(action.hint);
        } catch { /* needs an interactive sign-in */ }
        if (account) {
          const at = this.now();
          this.sessions.set(action.provider, { account, connectedAt: at, hint: action.hint });
          this.write(stampKey(action.provider), at);
          this.needsReconnect.delete(action.provider);
          this.setAutoTried(action.provider, false);
        } else {
          this.needsReconnect.add(action.provider);
        }
        changed = true;
      }
    }
    if (changed) this.onChange();
    return actions;
  }

  /** Interactive connect (must run from a click). For redirect providers the page navigates and init() finishes the job. */
  async connect(provider) {
    const entry = this.providers[provider];
    if (!entry) throw new Error(`Unknown provider ${provider}`);
    this.write(PENDING_KEY, provider);
    this.setAutoTried(provider, false);
    await entry.auth.signIn(this.cookie.read().accounts.find((a) => a.provider === provider)?.hint);
    // Reached only for providers that sign in without navigating (a popup).
    const account = await entry.auth.restore();
    if (!account) { this.write(PENDING_KEY, null); return undefined; }
    const at = this.now();
    this.sessions.set(provider, { account, connectedAt: at, hint: account.name || account.id });
    this.write(stampKey(provider), at);
    this.write(PENDING_KEY, null);
    this.needsReconnect.delete(provider);
    this.cookie.update((s, now) => connect(s, { provider, hint: account.name || account.id }, now));
    this.onChange();
    return account;
  }

  /** Signs out of one provider (here and in every other PBE app). Local data and cloud files stay. */
  async disconnect(provider) {
    const entry = this.providers[provider];
    this.sessions.delete(provider);
    this.needsReconnect.delete(provider);
    this.instances.delete(provider);
    this.write(stampKey(provider), null);
    this.cookie.update((s, now) => disconnect(s, provider, now));
    if (entry) await entry.auth.signOut();
    this.onChange();
  }

  async signOutAll() {
    const names = Object.keys(this.providers);
    for (const p of names) { this.sessions.delete(p); this.instances.delete(p); this.write(stampKey(p), null); }
    this.needsReconnect.clear();
    this.cookie.update((s, now) => signOutAll(s, now));
    for (const p of names) await this.providers[p].auth.signOut().catch(() => undefined);
    this.onChange();
  }

  setPrimary(provider) {
    this.cookie.update((s) => setPrimary(s, provider));
    this.onChange();
  }

  /** Remembers the folder the person chose as the root of their own data on `provider`. */
  setFolder(provider, folder) {
    this.cookie.update((s) => setFolder(s, provider, folder));
    this.onChange();
  }

  primary() {
    return this.cookie.read().primary;
  }

  folderFor(provider) {
    const a = this.cookie.read().accounts.find((x) => x.provider === provider);
    return a && a.folder;
  }

  isConnected(provider) {
    return this.sessions.has(provider);
  }

  /** The StorageProvider for a connected provider (created once, reused). */
  providerFor(provider) {
    if (!this.sessions.has(provider)) throw new Error(`Not connected to ${provider}`);
    let inst = this.instances.get(provider);
    if (!inst) {
      const entry = this.providers[provider];
      inst = entry.createProvider(entry.auth);
      this.instances.set(provider, inst);
    }
    return inst;
  }

  /** What the account widget shows. */
  status() {
    const primary = this.primary();
    return Object.keys(this.providers).map((provider) => {
      const s = this.sessions.get(provider);
      return {
        provider,
        label: this.providers[provider].label,
        connected: Boolean(s),
        needsReconnect: this.needsReconnect.has(provider),
        account: s ? s.account : undefined,
        primary: primary === provider,
      };
    });
  }
}

export function memoryStore() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k) };
}

export { PROVIDERS };
