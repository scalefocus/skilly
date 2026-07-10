// At-rest encryption for the §12 email service-account tokens: AES-256-GCM keyed by the
// env EMAIL_TOKEN_ENC_KEY (32 bytes, base64). SERVER-ONLY (node:crypto) — exported via the
// "@skilly/shared/email" subpath, never from the client-reachable main index.
// Plaintext tokens never touch the database, logs, or audit payloads. SKILLY_SPEC.md §12/§22.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const EMAIL_TOKEN_ENC_KEY_ENV = "EMAIL_TOKEN_ENC_KEY";

/** Parse + validate the base64 key. Returns null when unset/invalid (channel stays off). */
export function parseEmailTokenKey(keyB64: string | undefined): Buffer | null {
  if (!keyB64) return null;
  try {
    const key = Buffer.from(keyB64, "base64");
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}

/** Encrypt a token → "v1:<iv b64>:<tag b64>:<ciphertext b64>". */
export function encryptToken(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

/** Decrypt a stored token. Throws on tamper, wrong key, or a malformed value. */
export function decryptToken(enc: string, key: Buffer): string {
  const parts = enc.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("malformed encrypted token");
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64!, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64!, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64!, "base64")), decipher.final()]).toString("utf8");
}
