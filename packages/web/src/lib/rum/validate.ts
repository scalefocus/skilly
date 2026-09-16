// The RUM trust boundary (SKILLY_SPEC.md §32.5) plus the scrub/fingerprint helpers the browser
// collector and the server share (§32.2). Pure and isomorphic: no DB, no React, no Node-only APIs
// (`crypto.subtle` exists in both the browser and Node ≥ 20), so it is unit-testable as-is.
//
// Validation is ALL-OR-NOTHING: one invalid sample rejects the whole batch. Fixed enums, bounded
// numbers, templated routes only; the client sends no timestamps (created_at is server-stamped).
import { isKnownApiRoute, isKnownPageRoute } from "./routes";

export const RUM_KINDS = ["page_view", "vital", "nav", "api", "error"] as const;
export type RumKind = (typeof RUM_KINDS)[number];

export const RUM_VITALS = ["lcp", "inp", "cls", "ttfb"] as const;
export type RumVital = (typeof RUM_VITALS)[number];

export const RUM_MAX_BATCH = 50;
export const RUM_MAX_BODY_BYTES = 32 * 1024;
/** Upper bound for every duration (ms): nav, api, and the ms-valued vitals. */
export const RUM_MAX_DURATION_MS = 60_000;
/** Upper bound for CLS (unitless). */
export const RUM_MAX_CLS = 10;
export const RUM_MAX_MESSAGE = 500;
export const RUM_MAX_FRAME = 300;
/** Per-user ingest rate limit: batches per minute (the normal cadence is ~6). */
export const RUM_RATE_LIMIT_PER_MINUTE = 60;

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

export interface RumErrorInfo {
  type: string;
  message: string;
  frame: string;
}

/** One sample as the client sends it. */
export interface RumSampleIn {
  kind: RumKind;
  route: string;
  name?: string;
  value?: number;
  ok?: boolean | null;
  sessionId: string;
  error?: RumErrorInfo;
}

/** One validated sample, normalised for insertion. */
export interface RumSample {
  kind: RumKind;
  route: string;
  name: string | null;
  value: number | null;
  ok: boolean | null;
  sessionId: string;
  error: RumErrorInfo | null;
}

export type ParseResult = { ok: true; samples: RumSample[] } | { ok: false; reason: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finiteNonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Parse + validate a `POST /api/rum` body. Never throws. */
export function parseRumBatch(body: unknown): ParseResult {
  if (!isObj(body) || !Array.isArray(body.samples)) return { ok: false, reason: "samples[] required" };
  if (body.samples.length === 0) return { ok: false, reason: "empty batch" };
  if (body.samples.length > RUM_MAX_BATCH) return { ok: false, reason: `more than ${RUM_MAX_BATCH} samples` };
  const out: RumSample[] = [];
  for (let i = 0; i < body.samples.length; i++) {
    const r = validateSample(body.samples[i]);
    if (!r.ok) return { ok: false, reason: `sample ${i}: ${r.reason}` };
    out.push(r.sample);
  }
  return { ok: true, samples: out };
}

function validateSample(raw: unknown): { ok: true; sample: RumSample } | { ok: false; reason: string } {
  if (!isObj(raw)) return { ok: false, reason: "not an object" };
  const kind = raw.kind;
  if (typeof kind !== "string" || !(RUM_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: "unknown kind" };
  const route = raw.route;
  if (typeof route !== "string" || !isKnownPageRoute(route)) return { ok: false, reason: "unknown route" };
  const sessionId = raw.sessionId;
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return { ok: false, reason: "bad sessionId" };

  const k = kind as RumKind;
  const name = raw.name;
  const value = raw.value;
  const okField = raw.ok;
  const base = { kind: k, route, sessionId, ok: null as boolean | null, error: null as RumErrorInfo | null };

  switch (k) {
    case "page_view": {
      if (name !== undefined || value !== undefined) return { ok: false, reason: "page_view carries no name/value" };
      return { ok: true, sample: { ...base, name: null, value: null } };
    }
    case "vital": {
      if (typeof name !== "string" || !(RUM_VITALS as readonly string[]).includes(name)) return { ok: false, reason: "unknown vital" };
      if (!finiteNonNeg(value)) return { ok: false, reason: "vital value must be a finite number ≥ 0" };
      const cap = name === "cls" ? RUM_MAX_CLS : RUM_MAX_DURATION_MS;
      if (value > cap) return { ok: false, reason: `vital ${name} above ${cap}` };
      return { ok: true, sample: { ...base, name, value } };
    }
    case "nav": {
      if (name !== undefined) return { ok: false, reason: "nav carries no name" };
      if (!finiteNonNeg(value) || value > RUM_MAX_DURATION_MS) return { ok: false, reason: "nav value out of range" };
      return { ok: true, sample: { ...base, name: null, value } };
    }
    case "api": {
      if (typeof name !== "string" || !isKnownApiRoute(name)) return { ok: false, reason: "unknown api route" };
      if (!finiteNonNeg(value) || value > RUM_MAX_DURATION_MS) return { ok: false, reason: "api value out of range" };
      if (okField !== undefined && okField !== null && typeof okField !== "boolean") return { ok: false, reason: "ok must be boolean or null" };
      return { ok: true, sample: { ...base, name, value, ok: okField ?? null } };
    }
    case "error": {
      if (typeof name !== "string" || !FINGERPRINT_RE.test(name)) return { ok: false, reason: "error needs a 64-hex fingerprint" };
      if (value !== undefined) return { ok: false, reason: "error carries no value" };
      const e = raw.error;
      if (!isObj(e) || typeof e.type !== "string" || typeof e.message !== "string" || typeof e.frame !== "string") {
        return { ok: false, reason: "error needs { type, message, frame }" };
      }
      const type = e.type.trim().slice(0, 80) || "Error";
      // Re-scrub server-side (defence in depth) — the client already did, so this is idempotent.
      const message = scrubMessage(e.message).slice(0, RUM_MAX_MESSAGE);
      const frame = sanitizeFrame(e.frame);
      return { ok: true, sample: { ...base, name, value: null, error: { type, message, frame } } };
    }
  }
}

// ---- scrubbing + fingerprinting (§32.2) ---------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** ≥ 20 hex chars — hashes, ids, hex-encoded secrets. */
const HEX_RE = /(?<![0-9A-Za-z])[0-9a-fA-F]{20,}(?![0-9A-Za-z])/g;
/** ≥ 24 base64url-ish chars containing at least one digit — bearer tokens, JWT segments, keys.
 *  The digit requirement keeps ordinary long words ("internationalization") intact. */
const B64_RE = /(?<![0-9A-Za-z+/=_-])(?=[A-Za-z0-9+/=_-]*\d)[A-Za-z0-9+/=_-]{24,}(?![0-9A-Za-z+/=_-])/g;

/** Replace anything that looks like an email address or a token-like string with `[redacted]`. */
export function scrubMessage(input: string): string {
  return input.replace(EMAIL_RE, "[redacted]").replace(HEX_RE, "[redacted]").replace(B64_RE, "[redacted]").replace(/\s+/g, " ").trim();
}

/** Reduce a stack frame / error location to `path:line:col` with the origin, query and hash gone. */
export function sanitizeFrame(raw: string): string {
  let s = raw.trim();
  // "at fn (https://host/path:1:2)" → keep the parenthesised location; "https://host/path:1:2" → as is.
  const paren = s.match(/\(([^()]*)\)\s*$/);
  if (paren?.[1]) s = paren[1];
  s = s.replace(/^\s*at\s+/, "");
  s = s.replace(/^[a-z]+:\/\/[^/]+/i, ""); // strip scheme://host[:port]
  s = s.replace(/[?#][^:]*(?=(:\d+){0,2}$)/, ""); // strip query/hash but keep trailing :line:col
  return s.slice(0, RUM_MAX_FRAME);
}

/** Collapse the parts of a message that vary per occurrence so one bug yields one fingerprint. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '""') // quoted values
    .replace(/\d+/g, "#") // numbers (ids, counts, positions)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, RUM_MAX_MESSAGE);
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The client-error fingerprint: sha256 over type + normalised message + top frame (no route). */
export async function fingerprintFor(type: string, message: string, frame: string): Promise<string> {
  return sha256Hex(`${type}\n${normalizeMessage(message)}\n${frame}`);
}
