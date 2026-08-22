// Minimal in-memory Cache Storage + fetch stand-in shared by tests
// exercising assets/js/offline/*.js -- Node has no `caches` global (Cache
// Storage is browser/service-worker only), so this installs a small
// working stand-in onto globalThis for the duration of one test file. Pair
// with tests/helpers/dom.mjs's installDom() for localStorage/window.location,
// which the offline modules also depend on.

class FakeCache {
  constructor() {
    this.store = new Map(); // url string -> Response
  }
  async match(request) {
    const url = typeof request === "string" ? request : request.url;
    const response = this.store.get(url);
    return response ? response.clone() : undefined;
  }
  async put(request, response) {
    const url = typeof request === "string" ? request : request.url;
    this.store.set(url, response);
  }
  async delete(request) {
    const url = typeof request === "string" ? request : request.url;
    return this.store.delete(url);
  }
}

class FakeCacheStorage {
  constructor() {
    this.named = new Map();
  }
  async open(name) {
    if (!this.named.has(name)) this.named.set(name, new FakeCache());
    return this.named.get(name);
  }
  async delete(name) {
    return this.named.delete(name);
  }
}

let previousCaches, previousFetch, previousCreateObjectURL;
let objectUrlCounter = 0;

export function installFakeCaches({ fetchImpl } = {}) {
  previousCaches = globalThis.caches;
  previousFetch = globalThis.fetch;
  previousCreateObjectURL = globalThis.URL.createObjectURL;
  globalThis.caches = new FakeCacheStorage();
  globalThis.fetch = fetchImpl ?? (() => Promise.resolve(makeResponse(1024)));
  globalThis.URL.createObjectURL = () => `blob:test-${objectUrlCounter++}`;
}

export function uninstallFakeCaches() {
  globalThis.caches = previousCaches;
  globalThis.fetch = previousFetch;
  globalThis.URL.createObjectURL = previousCreateObjectURL;
}

/** A Response whose body is exactly `bytes` bytes long, with a matching content-length header. */
export function makeResponse(bytes, { ok = true, status = 200 } = {}) {
  return new Response(new Uint8Array(bytes), { status, headers: ok ? { "content-length": String(bytes) } : {} });
}

/** A fetch stub keyed by URL: `{ [url]: bytes }` for a successful response of that size, or `{ [url]: "error" }` for an HTTP 500. Any URL not listed defaults to a 1KB success response. */
export function makeFetch(sizesByUrl) {
  return async (request) => {
    const url = typeof request === "string" ? request : request.url;
    const spec = sizesByUrl[url];
    if (spec === "error") return makeResponse(0, { ok: false, status: 500 });
    return makeResponse(spec ?? 1024);
  };
}
