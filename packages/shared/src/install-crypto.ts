// The recoverable copy of an install token (SKILLY_SPEC.md §23 "Show install URL", §22). At mint
// time the raw token is AES-256-GCM-encrypted under the env INSTALL_TOKEN_ENC_KEY (same `v1:` format
// and code as the §12 email / §40 AI tokens — key separation from both) and stored in
// tokens.token_enc, so the owner can re-show the install command later. The gateway never decrypts:
// hashed_token stays the only validation path. Without the key, nothing is stored and nothing is
// revealable. Both mint paths seal: the web install endpoint and the worker's MCP install_skill.
// SERVER-ONLY (node:crypto) — import via "@skilly/shared/install-crypto", never from the
// client-reachable main index. Never log the plaintext.
import { decryptToken, encryptToken, parseEmailTokenKey } from "./email-crypto.js";

export const INSTALL_TOKEN_ENC_KEY_ENV = "INSTALL_TOKEN_ENC_KEY";

let warnedInvalidKey = false;

/** The parsed 32-byte key, or null when unset/invalid (the feature is then off). Read per call so
 *  a test or a restarted process picks up the current env. A key that is SET but doesn't decode to
 *  32 bytes is warned about once per process — otherwise a typo silently turns the feature off. */
export function installTokenKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env[INSTALL_TOKEN_ENC_KEY_ENV];
  const key = parseEmailTokenKey(raw);
  if (!key && raw && !warnedInvalidKey) {
    warnedInvalidKey = true;
    console.warn(JSON.stringify({ level: "warn", msg: `${INSTALL_TOKEN_ENC_KEY_ENV} is set but is not 32 bytes of base64 — install commands won't be recoverable (Show install URL is off)` }));
  }
  return key;
}

/** Encrypt a freshly minted raw token for storage; null when no key is configured. */
export function sealInstallToken(raw: string, key: Buffer | null = installTokenKey()): string | null {
  return key ? encryptToken(raw, key) : null;
}

/** Decrypt a stored copy; null when there is no copy, no key, or the copy can't be opened under the
 *  current key (rotated/replaced key, tampered value) — the caller maps that to "generate a new one". */
export function openInstallToken(enc: string | null, key: Buffer | null = installTokenKey()): string | null {
  if (!enc || !key) return null;
  try {
    return decryptToken(enc, key);
  } catch {
    return null;
  }
}
