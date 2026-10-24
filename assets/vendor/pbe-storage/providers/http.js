// Shared HTTP plumbing for the cloud providers: bearer auth, one refresh on 401, retries with backoff for rate limits and 5xx,
// and mapping failures onto StorageError kinds.

import { ErrorKind, StorageError, kindForStatus } from "../errors.js";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export class Http {
  /**
   * @param {{ getToken: (forceRefresh?: boolean) => Promise<string>, fetch?: typeof fetch, sleep?: (ms: number) => Promise<void>,
   *   maxRetries?: number, baseDelayMs?: number, maxDelayMs?: number, describe?: (body: string) => string }} opts
   */
  constructor({ getToken, fetch: fetchFn = globalThis.fetch?.bind(globalThis), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxRetries = 3, baseDelayMs = 500, maxDelayMs = 8000, describe = (b) => b.slice(0, 300) }) {
    this.getToken = getToken;
    this.fetch = fetchFn;
    this.sleep = sleep;
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.describe = describe;
  }

  backoff(attempt, res) {
    const retryAfter = res && Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(this.maxDelayMs, retryAfter * 1000);
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt);
  }

  /** @returns {Promise<Response>} a successful response (non-2xx throws a StorageError) */
  async request(url, init = {}, { auth = true } = {}) {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers(init.headers || {});
      if (auth) headers.set("Authorization", `Bearer ${await this.getToken(refreshed)}`);
      let res;
      try {
        res = await this.fetch(url, { ...init, headers });
      } catch (cause) {
        if (attempt >= this.maxRetries) throw new StorageError(ErrorKind.network, "Network request failed", { cause });
        await this.sleep(this.backoff(attempt));
        continue;
      }
      if (res.ok) return res;
      if (res.status === 401 && auth && !refreshed) { refreshed = true; continue; }
      const body = await res.text().catch(() => "");
      if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
        await this.sleep(this.backoff(attempt, res));
        continue;
      }
      throw new StorageError(kindForStatus(res.status), `${init.method || "GET"} ${String(url).split("?")[0]} failed (${res.status}): ${this.describe(body)}`, { status: res.status });
    }
  }

  async json(url, init, opts) {
    return (await this.request(url, init, opts)).json();
  }

  async bytes(url, init, opts) {
    return new Uint8Array(await (await this.request(url, init, opts)).arrayBuffer());
  }
}

/** Pulls the human message out of a Graph or Drive JSON error body. */
export function describeJsonError(body) {
  try {
    const e = JSON.parse(body).error;
    return [e.message, e.code || (e.errors && e.errors[0] && e.errors[0].reason) || e.status].filter(Boolean).join(" ");
  } catch {
    return body.slice(0, 300);
  }
}
