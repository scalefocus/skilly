// Weak ETags for polled JSON (SKILLY_SPEC.md §60.3, §60.11): the live Coming soon list re-fetches
// every 15 s, and an unchanged list answers 304 with no body. The tag is a hash of the exact body
// the caller would get, so it is per-caller by construction (votes, "only you", limits all differ).
import { createHash } from "node:crypto";

/** `W/"<sha1, base64url>"` of the body. */
export function weakEtag(body: string): string {
  return `W/"${createHash("sha1").update(body).digest("base64url")}"`;
}

/**
 * Does `If-None-Match` name this tag? Weak comparison (RFC 9110 §13.1.2): `W/` is ignored on both
 * sides, the header may list several tags, and `*` matches anything.
 */
export function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (!header) return false;
  const opaque = (t: string) => t.trim().replace(/^W\//, "");
  const want = opaque(etag);
  return header.split(",").some((t) => t.trim() === "*" || opaque(t) === want);
}

/**
 * The JSON answer for a polled route: 200 with the body and its tag, or 304 with only the tag when
 * the caller already holds it. The `/api` default `Cache-Control: no-store` (next.config.mjs) stays,
 * so no cache ever keeps the body: the page holds the last tag and sends `If-None-Match` itself.
 */
export function conditionalJson(req: Request, value: unknown): Response {
  const body = JSON.stringify(value);
  const etag = weakEtag(body);
  if (ifNoneMatchHits(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers: { etag } });
  return new Response(body, { status: 200, headers: { etag, "content-type": "application/json" } });
}
