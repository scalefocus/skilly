// The platform signing key (SKILLY_SPEC.md §73.9): load it, register it, sign with it.
//
// SKILLY_SIGNING_KEY (or SKILLY_SIGNING_KEY_FILE) holds an Ed25519 PKCS#8 private key — PEM (real or
// `\n`-escaped newlines, so it fits one .env line) or bare base64 DER. Only the worker holds it; web
// verifies with the public key from `signing_keys`. In production a missing or unparsable key stops
// the worker from starting. Outside production a dev key is generated once and kept under the git
// repo root (`_skilly/dev-signing-key.pem` — `_`-prefixed, so never a servable repo path).
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as nodeSign, type KeyObject } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import { fingerprintFromSpki, keyIdFromSpki, paeBytes, DSSE_PAYLOAD_TYPE } from "@skilly/shared";

export interface SigningKeyMaterial {
  privateKey: KeyObject;
  publicKeyPem: string;
  spkiDer: Uint8Array;
  keyId: string;
  fingerprint: string;
}

export type KeySource = "env" | "file" | "dev";

/** Parse a configured private key. Throws with a message naming the problem (never the key). */
export function parsePrivateKey(raw: string): KeyObject {
  const text = raw.trim().replace(/\\n/g, "\n");
  let key: KeyObject;
  try {
    key = text.includes("-----BEGIN")
      ? createPrivateKey({ key: text, format: "pem" })
      : createPrivateKey({ key: Buffer.from(text, "base64"), format: "der", type: "pkcs8" });
  } catch {
    throw new Error("SKILLY_SIGNING_KEY is not a readable PKCS#8 private key (PEM or base64 DER)");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`SKILLY_SIGNING_KEY must be an Ed25519 key (got ${key.asymmetricKeyType ?? "unknown"})`);
  }
  return key;
}

export async function materialFor(privateKey: KeyObject): Promise<SigningKeyMaterial> {
  const pub = createPublicKey(privateKey);
  const spkiDer = new Uint8Array(pub.export({ type: "spki", format: "der" }));
  return {
    privateKey,
    publicKeyPem: pub.export({ type: "spki", format: "pem" }).toString(),
    spkiDer,
    keyId: await keyIdFromSpki(spkiDer),
    fingerprint: await fingerprintFromSpki(spkiDer),
  };
}

/** The dev key's location under a repo root. */
export function devKeyPath(repoRoot: string): string {
  return join(repoRoot, "_skilly", "dev-signing-key.pem");
}

/**
 * Load the signing key from the environment. Production without a key throws (the worker refuses to
 * start, §73.9); elsewhere a dev key is created on first use and reused after.
 */
export async function loadSigningKey(opts: { env?: NodeJS.ProcessEnv; repoRoot: string }): Promise<{ material: SigningKeyMaterial; source: KeySource }> {
  const env = opts.env ?? process.env;
  const file = env.SKILLY_SIGNING_KEY_FILE?.trim();
  if (file) return { material: await materialFor(parsePrivateKey(await readFile(file, "utf8"))), source: "file" };
  const inline = env.SKILLY_SIGNING_KEY?.trim();
  if (inline) return { material: await materialFor(parsePrivateKey(inline)), source: "env" };
  if (env.NODE_ENV === "production") {
    throw new Error("missing required env: SKILLY_SIGNING_KEY (generate one: openssl genpkey -algorithm ed25519)");
  }
  const path = devKeyPath(opts.repoRoot);
  let pem: string | null = null;
  try {
    pem = await readFile(path, "utf8");
  } catch {
    /* first use */
  }
  if (!pem) {
    const { privateKey } = generateKeyPairSync("ed25519");
    pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await mkdir(join(opts.repoRoot, "_skilly"), { recursive: true });
    await writeFile(path, pem, { mode: 0o600 });
    console.warn(JSON.stringify({ level: "warn", msg: "no SKILLY_SIGNING_KEY: generated a dev signing key (never do this in production)", path }));
  }
  return { material: await materialFor(parsePrivateKey(pem)), source: "dev" };
}

export type KeyRegistration = "registered" | "reactivated" | "active" | "revoked";

/**
 * Make the configured key the active one (§73.9): a new key is inserted and the previously active
 * key retired; a retired key becomes active again; a revoked key is never used. Audited. One
 * transaction under an advisory lock, so two workers never both "register".
 */
export async function registerSigningKey(pool: Pool, m: SigningKeyMaterial, opts: { retired?: boolean } = {}): Promise<KeyRegistration> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(855400)");
    const { rows } = await client.query<{ retired_at: Date | null; revoked_at: Date | null }>(
      `select retired_at, revoked_at from signing_keys where key_id = $1`,
      [m.keyId],
    );
    const row = rows[0];
    if (row?.revoked_at) {
      await client.query("rollback");
      return "revoked";
    }
    if (row && !row.retired_at) {
      await client.query("commit");
      return "active";
    }
    if (opts.retired) {
      // Test signers register retired so they never displace the platform's active key.
      if (!row) {
        await client.query(
          `insert into signing_keys (key_id, public_key_pem, fingerprint, retired_at) values ($1, $2, $3, now())`,
          [m.keyId, m.publicKeyPem, m.fingerprint],
        );
      }
      await client.query("commit");
      return row ? "active" : "registered";
    }
    const { rows: prev } = await client.query<{ key_id: string }>(
      `update signing_keys set retired_at = now() where retired_at is null and revoked_at is null and key_id <> $1 returning key_id`,
      [m.keyId],
    );
    if (row) {
      await client.query(`update signing_keys set retired_at = null where key_id = $1`, [m.keyId]);
    } else {
      await client.query(`insert into signing_keys (key_id, public_key_pem, fingerprint) values ($1, $2, $3)`, [m.keyId, m.publicKeyPem, m.fingerprint]);
    }
    await client.query(
      `insert into audit_log (actor_user_id, action, target_type, target_id, after, source)
       values (null, $1, 'signing_key', $2, $3::jsonb, 'worker')`,
      [row ? "signing.key_reactivated" : "signing.key_registered", m.keyId, JSON.stringify({ keyId: m.keyId, fingerprint: m.fingerprint, retired: prev[0]?.key_id ?? null })],
    );
    await client.query("commit");
    return row ? "reactivated" : "registered";
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Signs DSSE payloads with the platform key and knows whether that key may still be used. */
export interface Signer {
  readonly keyId: string;
  /** Ed25519 signature over PAE(payloadType, payload). */
  signPayload(payload: Uint8Array): Uint8Array;
  /** False once the key is revoked (cached ~30 s): sign nothing then (§73.9, fail closed). */
  usable(): Promise<boolean>;
}

export function signerFor(pool: Pool, m: SigningKeyMaterial): Signer {
  let cache: { at: number; ok: boolean } | null = null;
  let warned = false;
  return {
    keyId: m.keyId,
    signPayload(payload) {
      return new Uint8Array(nodeSign(null, Buffer.from(paeBytes(DSSE_PAYLOAD_TYPE, payload)), m.privateKey));
    },
    async usable() {
      if (cache && Date.now() - cache.at < 30_000) return cache.ok;
      const { rows } = await pool.query<{ revoked_at: Date | null }>(`select revoked_at from signing_keys where key_id = $1`, [m.keyId]);
      const ok = !!rows[0] && !rows[0].revoked_at;
      cache = { at: Date.now(), ok };
      if (!ok && !warned) {
        warned = true;
        await recordRevokedKey(pool, m.keyId, !rows[0]);
      }
      return ok;
    },
  };
}

/** Once per worker run: the configured key is revoked (or unregistered), so nothing is signed. */
async function recordRevokedKey(pool: Pool, keyId: string, unregistered: boolean): Promise<void> {
  const message = unregistered
    ? `signing key ${keyId} is not registered — nothing is signed until the worker registers it`
    : `signing key ${keyId} is revoked — configure a new SKILLY_SIGNING_KEY; publishing is paused`;
  console.error(JSON.stringify({ level: "error", msg: message }));
  await pool
    .query(
      `insert into system_event (status, method, route, path, user_id, error_code, message, source)
       values (500, 'JOB', 'worker:signing', '/signing', null, 'signing_key_revoked', $1, 'worker')`,
      [message.slice(0, 300)],
    )
    .catch(() => {});
}

/** A throwaway signer for tests: a fresh key, registered RETIRED so the active key is untouched. */
export async function testSigner(pool: Pool): Promise<Signer & { material: SigningKeyMaterial }> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const material = await materialFor(privateKey);
  await registerSigningKey(pool, material, { retired: true });
  return Object.assign(signerFor(pool, material), { material });
}
