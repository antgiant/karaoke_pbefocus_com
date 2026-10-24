// Schedules sync rounds: debounced after local edits, polled while the page is open, with exponential backoff after failures.
// Timers are injectable so the logic is testable without waiting.

export class SyncController {
  /**
   * @param {{ run: () => Promise<void>, debounceMs?: number, pollMs?: number, minBackoffMs?: number, maxBackoffMs?: number,
   *   timers?: { setTimeout: Function, clearTimeout: Function }, now?: () => number, onStatus?: (s: object) => void }} opts
   */
  constructor({ run, debounceMs = 2000, pollMs = 60_000, minBackoffMs = 5000, maxBackoffMs = 300_000, timers, now = Date.now, onStatus = () => {} }) {
    this.run = run;
    this.debounceMs = debounceMs;
    this.pollMs = pollMs;
    this.minBackoffMs = minBackoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.timers = timers || { setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis) };
    this.now = now;
    this.onStatus = onStatus;
    this.timer = undefined;
    this.running = false;
    this.pending = false;
    this.started = false;
    this.current = undefined;
    this.state = { status: "idle", lastSyncedAt: undefined, lastError: undefined, failures: 0 };
  }

  start() {
    this.started = true;
    this.schedule(0);
  }

  stop() {
    this.started = false;
    this.clear();
  }

  clear() {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
  }

  schedule(ms) {
    this.clear();
    if (!this.started) return;
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      void this.runNow();
    }, ms);
  }

  /** Call after a local change: syncs soon, coalescing bursts of edits. */
  request() {
    if (!this.started) return;
    if (this.running) { this.pending = true; return; }
    this.schedule(this.debounceMs);
  }

  setStatus(patch) {
    this.state = { ...this.state, ...patch };
    this.onStatus(this.state);
  }

  /** Runs a round now. If one is already in flight this waits for that one (and asks for another straight after) instead of starting a second. */
  runNow() {
    if (this.running) {
      this.pending = true;
      return this.current;
    }
    this.clear();
    this.running = true;
    this.current = this.execute();
    return this.current;
  }

  async execute() {
    this.setStatus({ status: "syncing" });
    let ok = false;
    try {
      await this.run();
      ok = true;
      this.setStatus({ status: "idle", lastSyncedAt: this.now(), lastError: undefined, failures: 0 });
    } catch (e) {
      const failures = this.state.failures + 1;
      this.setStatus({ status: "error", lastError: e instanceof Error ? e : new Error(String(e)), failures });
    } finally {
      this.running = false;
    }
    if (!this.started) return;
    if (this.pending) { this.pending = false; this.schedule(ok ? 0 : this.backoff()); return; }
    this.schedule(ok ? this.pollMs : this.backoff());
  }

  backoff() {
    return Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** Math.max(0, this.state.failures - 1));
  }
}

/** Hooks a controller up to the page: sync when the tab becomes visible or the network returns. Returns a function that removes the hooks. */
export function attachBrowserHooks(controller, { window: win = globalThis.window, document: doc = globalThis.document } = {}) {
  if (!win || !doc) return () => {};
  const poke = () => { if (controller.started) void controller.runNow(); };
  const onVisible = () => { if (doc.visibilityState === "visible") poke(); };
  win.addEventListener("online", poke);
  win.addEventListener("focus", poke);
  doc.addEventListener("visibilitychange", onVisible);
  return () => {
    win.removeEventListener("online", poke);
    win.removeEventListener("focus", poke);
    doc.removeEventListener("visibilitychange", onVisible);
  };
}
