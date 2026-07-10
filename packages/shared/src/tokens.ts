// Token hashing — shared between the web app (minting) and the worker (validation) so
// both agree on the stored representation. Raw tokens are never stored; only the hash.
// SKILLY_SPEC.md §9, §3 (tokens.hashed_token).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Constant-time string equality for secrets (bearer tokens, etc.). Length-safe. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** SHA-256 hex of a raw token. Deterministic; used to look up `tokens.hashed_token`. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Generate a random, URL-safe token (default 32 bytes -> 43 base64url chars). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
