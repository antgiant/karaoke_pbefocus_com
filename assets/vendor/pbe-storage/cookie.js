// The cross-app sign-in hint (docs/unified-storage-plan.md, sections 3.2 and 3.10).
//
// One first-party cookie on `.pbefocus.com` tells every PBE app which providers this browser is connected to, so signing in or
// out in one app is picked up by the others. It is a HINT: it holds provider names, account emails and folder pointers, never a
// password or an access token.

export const COOKIE_NAME = "pbe_account";
export const COOKIE_VERSION = 2;
export const PROVIDERS = Object.freeze(["google", "microsoft"]);
const PRIMARIES = new Set(["local", ...PROVIDERS]);

/** @typedef {{ provider: string, id: string, driveId?: string, name?: string }} FolderRef */
/** @typedef {{ provider: string, hint: string, folder?: FolderRef, at: number }} AccountHint */
/** @typedef {{ v: number, primary: string, accounts: AccountHint[], out: Record<string, number> }} CookieState */

/** @returns {CookieState} */
export function emptyState() {
  return { v: COOKIE_VERSION, primary: "local", accounts: [], out: {} };
}

// ---- encoding ---------------------------------------------------------------------------------------------------

function toBase64Url(text) {
  let bin = "";
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const isFiniteNumber = (n) => typeof n === "number" && Number.isFinite(n);

function cleanFolder(folder) {
  if (!folder || typeof folder !== "object" || typeof folder.id !== "string" || typeof folder.provider !== "string") return undefined;
  const out = { provider: folder.provider, id: folder.id };
  if (typeof folder.driveId === "string") out.driveId = folder.driveId;
  if (typeof folder.name === "string") out.name = folder.name;
  return out;
}

/**
 * Coerces anything (including attacker- or bug-supplied data) into a valid state. Unknown providers, wrong types and duplicates are
 * dropped; the newest entry per provider wins.
 * @returns {CookieState}
 */
export function normalize(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== "object") return state;
  if (PRIMARIES.has(raw.primary)) state.primary = raw.primary;
  const best = new Map();
  for (const a of Array.isArray(raw.accounts) ? raw.accounts : []) {
    if (!a || !PROVIDERS.includes(a.provider) || typeof a.hint !== "string" || !isFiniteNumber(a.at)) continue;
    const prev = best.get(a.provider);
    if (prev && prev.at >= a.at) continue;
    const entry = { provider: a.provider, hint: a.hint.slice(0, 320), at: a.at };
    const folder = cleanFolder(a.folder);
    if (folder) entry.folder = folder;
    best.set(a.provider, entry);
  }
  state.accounts = PROVIDERS.filter((p) => best.has(p)).map((p) => best.get(p));
  if (raw.out && typeof raw.out === "object") {
    for (const p of PROVIDERS) if (isFiniteNumber(raw.out[p])) state.out[p] = raw.out[p];
  }
  if (state.primary !== "local" && !state.accounts.some((a) => a.provider === state.primary)) state.primary = "local";
  return state;
}

/** @param {CookieState} state */
export function serialize(state) {
  return toBase64Url(JSON.stringify(normalize(state)));
}

/** Tolerant: anything unreadable yields an empty state. @returns {CookieState} */
export function parse(text) {
  if (typeof text !== "string" || !text) return emptyState();
  try {
    return normalize(JSON.parse(fromBase64Url(text)));
  } catch {
    return emptyState();
  }
}

// ---- state transitions (pure; each returns a new state) -----------------------------------------------------------

/** Records that `provider` is connected as `hint`. A reconnect clears that provider's sign-out marker. */
export function connect(state, { provider, hint, folder }, now) {
  const next = structuredClone(normalize(state));
  next.accounts = next.accounts.filter((a) => a.provider !== provider);
  const entry = { provider, hint, at: now };
  const f = cleanFolder(folder);
  if (f) entry.folder = f;
  next.accounts.push(entry);
  delete next.out[provider];
  return normalize(next);
}

/** Signs one provider out everywhere: drops its account and leaves a marker with the time. */
export function disconnect(state, provider, now) {
  const next = structuredClone(normalize(state));
  next.accounts = next.accounts.filter((a) => a.provider !== provider);
  next.out[provider] = now;
  if (next.primary === provider) next.primary = "local";
  return normalize(next);
}

export function signOutAll(state, now) {
  let next = normalize(state);
  for (const p of PROVIDERS) next = disconnect(next, p, now);
  return next;
}

export function setPrimary(state, provider) {
  const next = structuredClone(normalize(state));
  if (provider === "local" || next.accounts.some((a) => a.provider === provider)) next.primary = provider;
  return next;
}

/** Remembers which folder the person chose for a provider (no-op if not connected). */
export function setFolder(state, provider, folder) {
  const next = structuredClone(normalize(state));
  const entry = next.accounts.find((a) => a.provider === provider);
  if (!entry) return next;
  const f = cleanFolder(folder);
  if (f) entry.folder = f;
  else delete entry.folder;
  return next;
}

/**
 * Decides what this app must do to agree with the cookie.
 * @param {CookieState} state
 * @param {Record<string, { connectedAt: number, hint?: string }>} sessions what this app currently has, by provider
 * @returns {{ type: "signIn" | "signOut" | "adopt", provider: string, hint?: string }[]}
 *  - signIn: the cookie names the provider but this app has no session (another app connected it).
 *  - signOut: this app has a session that is older than the provider's sign-out marker (another app signed out).
 *  - adopt: this app has a session the cookie knows nothing about (cookie expired or cleared); write it back.
 */
export function reconcile(state, sessions) {
  const s = normalize(state);
  const actions = [];
  for (const provider of PROVIDERS) {
    const account = s.accounts.find((a) => a.provider === provider);
    const session = sessions[provider];
    const out = s.out[provider];
    if (session) {
      if (out !== undefined && out > session.connectedAt && (!account || account.at < out)) actions.push({ type: "signOut", provider });
      else if (!account) actions.push({ type: "adopt", provider, hint: session.hint });
    } else if (account) {
      actions.push({ type: "signIn", provider, hint: account.hint });
    }
  }
  return actions;
}

// ---- reading and writing the browser cookie -------------------------------------------------------------------

/** Pulls one cookie's value out of a `document.cookie` string. */
export function readCookieValue(cookieHeader, name = COOKIE_NAME) {
  for (const part of String(cookieHeader || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

export class CookieStore {
  /**
   * @param {{ document: { cookie: string }, domain?: string, secure?: boolean, maxAgeSeconds?: number, now?: () => number }} opts
   *  `domain` is `.pbefocus.com` in production; leave it out on localhost (a Domain attribute would be rejected there).
   */
  constructor({ document, domain, secure = true, maxAgeSeconds = 365 * 24 * 3600, now = Date.now }) {
    this.document = document;
    this.domain = domain;
    this.secure = secure;
    this.maxAgeSeconds = maxAgeSeconds;
    this.now = now;
  }

  /** @returns {CookieState} */
  read() {
    return parse(readCookieValue(this.document.cookie));
  }

  /** @param {CookieState} state */
  write(state) {
    const parts = [`${COOKIE_NAME}=${serialize(state)}`, "Path=/", `Max-Age=${this.maxAgeSeconds}`, "SameSite=Lax"];
    if (this.domain) parts.push(`Domain=${this.domain}`);
    if (this.secure) parts.push("Secure");
    this.document.cookie = parts.join("; ");
  }

  /** Reads, applies `fn(state, now)`, writes back and returns the new state. */
  update(fn) {
    const next = fn(this.read(), this.now());
    this.write(next);
    return next;
  }
}
