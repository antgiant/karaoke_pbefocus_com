// The on-disk format of every synced JSON document: a small versioned envelope around the app's own data.

export const FORMAT = "pbe-doc";

export class EnvelopeError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnvelopeError";
  }
}

/** JSON with object keys sorted, so equal data always serializes identically (used to detect "nothing changed"). */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * @param {{ app: string, kind: string, schema: number, deviceId: string, updatedAt: number, data: unknown }} fields
 */
export function makeEnvelope({ app, kind, schema, deviceId, updatedAt, data }) {
  return { format: FORMAT, app, kind, schema, deviceId, updatedAt, data };
}

/** @returns {Uint8Array} */
export function encodeEnvelope(envelope) {
  return new TextEncoder().encode(JSON.stringify(envelope));
}

/** Validates and returns an envelope; throws EnvelopeError for anything else (a stray file in the folder, a corrupt upload). */
export function decodeEnvelope(bytes) {
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new EnvelopeError("Not valid JSON");
  }
  if (!value || typeof value !== "object" || value.format !== FORMAT) throw new EnvelopeError("Not a PBE document");
  for (const key of ["app", "kind", "deviceId"]) if (typeof value[key] !== "string" || !value[key]) throw new EnvelopeError(`Missing ${key}`);
  if (!Number.isInteger(value.schema) || value.schema < 1) throw new EnvelopeError("Missing schema");
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) throw new EnvelopeError("Missing updatedAt");
  if (!("data" in value)) throw new EnvelopeError("Missing data");
  return value;
}

const DEVICE_KEY = "pbe.deviceId";

/** A stable random id for this browser, used in the names of the files it writes. */
export function getDeviceId(storage = globalThis.localStorage, random = () => crypto.getRandomValues(new Uint8Array(6))) {
  try {
    const have = storage && storage.getItem(DEVICE_KEY);
    if (have && /^[a-z0-9]{6,16}$/.test(have)) return have;
  } catch {
    /* storage blocked: fall through to a fresh, unsaved id */
  }
  const id = Array.from(random(), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
  try {
    if (storage) storage.setItem(DEVICE_KEY, id);
  } catch {
    /* ignore */
  }
  return id;
}
