/** Failure kinds every provider maps its errors onto, so callers never parse provider-specific messages. */
export const ErrorKind = Object.freeze({
  auth: "auth",
  notFound: "notFound",
  forbidden: "forbidden",
  exists: "exists",
  rateLimit: "rateLimit",
  network: "network",
  invalid: "invalid",
  unknown: "unknown",
});

export class StorageError extends Error {
  /**
   * @param {string} kind one of ErrorKind
   * @param {string} message
   * @param {{ status?: number, cause?: unknown }} [extra]
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = "StorageError";
    this.kind = kind;
    this.status = extra.status;
    if (extra.cause !== undefined) this.cause = extra.cause;
  }
}

/** Maps an HTTP status to an ErrorKind. */
export function kindForStatus(status) {
  if (status === 401) return ErrorKind.auth;
  if (status === 403) return ErrorKind.forbidden;
  if (status === 404) return ErrorKind.notFound;
  if (status === 409 || status === 412) return ErrorKind.exists;
  if (status === 429) return ErrorKind.rateLimit;
  if (status === 400 || status === 422) return ErrorKind.invalid;
  return ErrorKind.unknown;
}
