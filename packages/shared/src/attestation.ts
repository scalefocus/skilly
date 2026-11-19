// Signed skill versions (SKILLY_SPEC.md §73): the in-toto Statement v1 skilly signs for every
// served file set, its DSSE envelope, signature checking and the shared verdict function.
//
// Client-safe: WebCrypto (`globalThis.crypto.subtle`) only, so the browser Verify dialog, the web
// API and the worker (REST + MCP) all run the SAME code. Signing itself needs the private key and
// lives in the worker (packages/worker/src/signing); everything a verifier needs is here.
import {
  SKILLS_LOCK_VERSION,
  isInstallerExcludedPath,
  normalizeLockLineEndings,
  sha256Hex,
  skillsLockComputedHash,
  sortByPathBytes,
} from "./external-tool.js";

export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";
export const SKILL_VERSION_PREDICATE_TYPE = "https://github.com/scalefocus/skilly/attestation/skill-version/v1";

export type FileMode = "100644" | "100755";
/** Who made the statement: the publish sweep, the backfill sweep, or a re-sign after a revocation. */
export type AttestationKind = "publish" | "backfill" | "resign";
/** The skilly-made rewrites a served file set can carry (§73.5). */
export type VariantRewrite = "deprecation" | "marketplace_hoist";
export const VARIANT_REWRITES: readonly VariantRewrite[] = ["deprecation", "marketplace_hoist"];

export interface StatementFile {
  path: string;
  size: number;
  mode: FileMode;
  /** sha256 of the raw bytes. */
  sha256: string;
  /** sha256 after the installer's lock-v2 line-ending rule (equal to `sha256` when nothing changes). */
  lfSha256: string;
  /** false for a path the installer never copies (§73.4). */
  installed: boolean;
}

export interface StatementVariant {
  /** Sorted rewrite names. */
  rewrites: VariantRewrite[];
  inputsSha256: string;
}

export type StatementSource =
  | { type: "hosted" }
  | { type: "pointer"; origin: string; ref: string; subdir: string | null; commit: string | null };

export interface SkillVersionPredicate {
  registry: string;
  skill: { id: string; namespace: string; slug: string };
  version: { id: string; semver: string };
  variant: StatementVariant | null;
  kind: AttestationKind;
  hashRecordedAtPublish: boolean;
  source: StatementSource;
  artifactSha256: string | null;
  tagCommit: string | null;
  skillsLock: { lockVersion: number; computedHash: string };
  files: StatementFile[];
  signedAt: string;
}

export interface InTotoStatement {
  _type: string;
  subject: { name: string; digest: { sha256: string } }[];
  predicateType: string;
  predicate: SkillVersionPredicate;
}

export interface DsseEnvelope {
  payloadType: string;
  payload: string;
  signatures: { keyid: string; sig: string }[];
}

const utf8 = new TextEncoder();
const utf8Decode = new TextDecoder("utf-8", { fatal: true });
const HEX64 = /^[0-9a-f]{64}$/;

/** WebCrypto wants an ArrayBuffer-backed view; every array built here is one. */
function buf(b: Uint8Array): Uint8Array<ArrayBuffer> {
  return b as Uint8Array<ArrayBuffer>;
}

// ---------------------------------------------------------------------------
// base64 / PEM (no Buffer: this module runs in the browser too)
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * DER bytes of a PEM block (the first one), or null when the text is not PEM. Parsed with indexOf,
 * not a regex: the input can be caller-supplied, and a lazy multi-line pattern backtracks
 * polynomially on crafted `-----BEGIN` repetitions.
 */
export function pemToDer(pem: string): Uint8Array | null {
  const begin = pem.indexOf("-----BEGIN ");
  if (begin < 0) return null;
  const headerEnd = pem.indexOf("-----", begin + "-----BEGIN ".length);
  if (headerEnd < 0) return null;
  const bodyStart = headerEnd + "-----".length;
  const end = pem.indexOf("-----END ", bodyStart);
  if (end < 0 || end === bodyStart) return null;
  try {
    return base64ToBytes(pem.slice(bodyStart, end));
  } catch {
    return null;
  }
}

export function derToPem(der: Uint8Array, label = "PUBLIC KEY"): string {
  const b64 = bytesToBase64(der).replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** keyId = the first 16 hex characters of sha256(DER SPKI) (§73.9). */
export async function keyIdFromSpki(spkiDer: Uint8Array): Promise<string> {
  return (await sha256Hex(spkiDer)).slice(0, 16);
}

/** The full 64-hex fingerprint of a public key (sha256 of its DER SPKI). */
export async function fingerprintFromSpki(spkiDer: Uint8Array): Promise<string> {
  return sha256Hex(spkiDer);
}

/** A fingerprint in groups of four, for display (§73.9). */
export function formatFingerprint(fp: string): string {
  return (fp.match(/.{1,4}/g) ?? []).join(" ");
}

// ---------------------------------------------------------------------------
// Building a statement
// ---------------------------------------------------------------------------

export interface SourceFile {
  path: string;
  bytes: Uint8Array;
  mode?: FileMode;
}

/** The per-file table of a served file set, sorted by the UTF-8 bytes of the path. */
export async function describeFiles(files: readonly SourceFile[]): Promise<StatementFile[]> {
  const out: StatementFile[] = [];
  for (const f of sortByPathBytes(files)) {
    const sha256 = await sha256Hex(f.bytes);
    const lf = normalizeLockLineEndings(f.bytes);
    out.push({
      path: f.path,
      size: f.bytes.length,
      mode: f.mode ?? "100644",
      sha256,
      lfSha256: lf === f.bytes ? sha256 : await sha256Hex(lf),
      installed: !isInstallerExcludedPath(f.path),
    });
  }
  return out;
}

export interface DeprecationInputs {
  successor: string | null;
  note: string | null;
  successorUrl: string | null;
}

/**
 * A variant's identity (§73.5): sha256 over the sorted rewrite names and the inputs each rewrite
 * reads. `deprecation` reads the successor, the note and the successor URL; `marketplace_hoist`
 * reads nothing beyond the version's own files.
 */
export async function variantFor(rewrites: readonly VariantRewrite[], deprecation: DeprecationInputs | null): Promise<StatementVariant> {
  const sorted = [...new Set(rewrites)].sort();
  const dep = sorted.includes("deprecation") && deprecation
    ? { successor: deprecation.successor ?? null, note: deprecation.note ?? null, successorUrl: deprecation.successorUrl ?? null }
    : null;
  const inputsSha256 = await sha256Hex(utf8.encode(JSON.stringify({ rewrites: sorted, deprecation: dep })));
  return { rewrites: sorted as VariantRewrite[], inputsSha256 };
}

export interface BuildStatementInput {
  registry: string;
  skill: { id: string; namespace: string; slug: string };
  version: { id: string; semver: string };
  variant: StatementVariant | null;
  kind: AttestationKind;
  hashRecordedAtPublish: boolean;
  source: StatementSource;
  artifactSha256: string | null;
  tagCommit: string | null;
  signedAt: string;
  files: readonly SourceFile[];
}

export interface BuiltStatement {
  statement: InTotoStatement;
  /** The exact bytes to sign and to store (never re-serialized). */
  payload: Uint8Array;
  computedHash: string;
}

/** Build the in-toto statement for a served file set, with its fixed key order (§73.3). */
export async function buildSkillVersionStatement(input: BuildStatementInput): Promise<BuiltStatement> {
  const files = await describeFiles(input.files);
  const computedHash = await skillsLockComputedHash(input.files);
  const statement: InTotoStatement = {
    _type: STATEMENT_TYPE,
    subject: files.map((f) => ({ name: f.path, digest: { sha256: f.sha256 } })),
    predicateType: SKILL_VERSION_PREDICATE_TYPE,
    predicate: {
      registry: input.registry,
      skill: { id: input.skill.id, namespace: input.skill.namespace, slug: input.skill.slug },
      version: { id: input.version.id, semver: input.version.semver },
      variant: input.variant ? { rewrites: [...input.variant.rewrites], inputsSha256: input.variant.inputsSha256 } : null,
      kind: input.kind,
      hashRecordedAtPublish: input.hashRecordedAtPublish,
      source: input.source,
      artifactSha256: input.variant ? null : input.artifactSha256,
      tagCommit: input.tagCommit,
      skillsLock: { lockVersion: SKILLS_LOCK_VERSION, computedHash },
      files,
      signedAt: input.signedAt,
    },
  };
  return { statement, payload: utf8.encode(JSON.stringify(statement)), computedHash };
}

/** DSSE v1 pre-authentication encoding: "DSSEv1" SP len(type) SP type SP len(body) SP body. */
export function paeBytes(payloadType: string, payload: Uint8Array): Uint8Array {
  const type = utf8.encode(payloadType);
  const head = utf8.encode(`DSSEv1 ${type.length} ${payloadType} ${payload.length} `);
  const out = new Uint8Array(head.length + payload.length);
  out.set(head, 0);
  out.set(payload, head.length);
  return out;
}

export function envelopeFromSignature(payload: Uint8Array, keyId: string, signature: Uint8Array): DsseEnvelope {
  return { payloadType: DSSE_PAYLOAD_TYPE, payload: bytesToBase64(payload), signatures: [{ keyid: keyId, sig: bytesToBase64(signature) }] };
}

export interface DecodedEnvelope {
  envelope: DsseEnvelope;
  payload: Uint8Array;
  statement: InTotoStatement;
}

/** Parse and shape-check an envelope. Null for anything that is not a skilly statement. */
export function decodeEnvelope(raw: unknown): DecodedEnvelope | null {
  if (!raw || typeof raw !== "object") return null;
  const env = raw as Partial<DsseEnvelope>;
  if (env.payloadType !== DSSE_PAYLOAD_TYPE || typeof env.payload !== "string" || !Array.isArray(env.signatures)) return null;
  const sigs = env.signatures.filter((s): s is { keyid: string; sig: string } => !!s && typeof s.keyid === "string" && typeof s.sig === "string");
  if (sigs.length === 0) return null;
  let payload: Uint8Array;
  let statement: InTotoStatement;
  try {
    payload = base64ToBytes(env.payload);
    statement = JSON.parse(utf8Decode.decode(payload)) as InTotoStatement;
  } catch {
    return null;
  }
  if (!isStatementShape(statement)) return null;
  return { envelope: { payloadType: env.payloadType, payload: env.payload, signatures: sigs }, payload, statement };
}

function isStatementShape(s: unknown): s is InTotoStatement {
  if (!s || typeof s !== "object") return false;
  const st = s as InTotoStatement;
  if (st._type !== STATEMENT_TYPE || st.predicateType !== SKILL_VERSION_PREDICATE_TYPE) return false;
  const p = st.predicate;
  if (!p || typeof p !== "object" || typeof p.registry !== "string" || !Array.isArray(p.files)) return false;
  if (!p.skill || typeof p.skill.id !== "string" || !p.version || typeof p.version.semver !== "string") return false;
  if (!p.skillsLock || typeof p.skillsLock.computedHash !== "string") return false;
  return p.files.every(
    (f) => !!f && typeof f.path === "string" && typeof f.sha256 === "string" && HEX64.test(f.sha256) && typeof f.lfSha256 === "string" && typeof f.installed === "boolean",
  );
}

// ---------------------------------------------------------------------------
// Signature checking
// ---------------------------------------------------------------------------

export type SignatureStatus = "valid" | "revoked_key" | "invalid";

export interface PublicSigningKey {
  keyId: string;
  publicKeyPem: string;
  revokedAt: string | null;
}

/** Whether this runtime's WebCrypto can verify Ed25519 (older browsers cannot). */
export async function ed25519Supported(): Promise<boolean> {
  try {
    const pair = (await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as { publicKey?: unknown };
    return !!pair.publicKey;
  } catch {
    return false;
  }
}

/** Ed25519 verify of raw bytes against a PEM SPKI public key. False on any error. */
export async function verifyEd25519(publicKeyPem: string, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const der = pemToDer(publicKeyPem);
  if (!der) return false;
  try {
    const key = await globalThis.crypto.subtle.importKey("spki", buf(der), { name: "Ed25519" }, false, ["verify"]);
    return await globalThis.crypto.subtle.verify({ name: "Ed25519" }, key, buf(signature), buf(message));
  } catch {
    return false;
  }
}

/**
 * The §73.7 signature verdict for one envelope: `invalid` for an unknown key, a bad signature or
 * another registry; `revoked_key` for a good signature by a revoked key; else `valid`.
 */
export async function checkEnvelopeSignature(decoded: DecodedEnvelope, keys: readonly PublicSigningKey[], registry: string): Promise<SignatureStatus> {
  if (normalizeRegistry(decoded.statement.predicate.registry) !== normalizeRegistry(registry)) return "invalid";
  const pae = paeBytes(decoded.envelope.payloadType, decoded.payload);
  for (const s of decoded.envelope.signatures) {
    const key = keys.find((k) => k.keyId === s.keyid);
    if (!key) continue;
    let sig: Uint8Array;
    try {
      sig = base64ToBytes(s.sig);
    } catch {
      continue;
    }
    if (await verifyEd25519(key.publicKeyPem, pae, sig)) return key.revokedAt ? "revoked_key" : "valid";
  }
  return "invalid";
}

/** Drop trailing `/`s with a linear scan (a `/\/+$/` regex is polynomial on long slash runs). */
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* / */) end--;
  return s.slice(0, end);
}

function normalizeRegistry(u: string): string {
  return stripTrailingSlashes(u.trim()).toLowerCase();
}

/**
 * The `registry` a statement names (§73.3): SKILLY_REGISTRY_URL, else the same fallbacks the rest of
 * the app uses for its base URL. Web and worker MUST resolve it identically, or every signature
 * reads as "another registry". Trailing slashes stripped.
 */
export function resolveSigningRegistry(env: Record<string, string | undefined>): string {
  for (const raw of [env.SKILLY_REGISTRY_URL, env.PUBLIC_BASE_URL, env.NEXTAUTH_URL]) {
    const v = raw?.trim();
    if (v) return stripTrailingSlashes(v);
  }
  return "http://localhost:3000";
}

// ---------------------------------------------------------------------------
// Verdicts (§73.7)
// ---------------------------------------------------------------------------

export type FileStatus = "unchanged" | "line_endings" | "modified" | "missing" | "extra";

export interface LocalFile {
  path: string;
  sha256: string;
  lfSha256?: string;
  mode?: FileMode;
}

export interface FileVerdict {
  path: string;
  status: FileStatus;
  /** An extra file that is OS metadata (.DS_Store, Thumbs.db, desktop.ini) — still a change. */
  osMetadata?: boolean;
  /** The caller supplied a mode and it differs from the signed one. */
  modeChanged?: boolean;
  /** The local file's sha256, when there is one (extra / modified / unchanged). */
  sha256?: string;
}

export const OS_METADATA_FILES: ReadonlySet<string> = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function baseName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/** Hash a folder's files the way a verifier does: raw + line-ending-normalized, exclusions skipped. */
export async function describeLocalFiles(files: readonly { path: string; bytes: Uint8Array }[]): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  for (const f of files) {
    const path = f.path.split("\\").join("/");
    if (isInstallerExcludedPath(path)) continue;
    const sha256 = await sha256Hex(f.bytes);
    const lf = normalizeLockLineEndings(f.bytes);
    out.push({ path, sha256, lfSha256: lf === f.bytes ? sha256 : await sha256Hex(lf) });
  }
  return out;
}

/** Compare a checked file set with a statement's installed files. */
export function compareFiles(local: readonly LocalFile[], signed: readonly StatementFile[]): { files: FileVerdict[]; matches: boolean } {
  const want = new Map(signed.filter((f) => f.installed).map((f) => [f.path, f]));
  const have = new Map<string, LocalFile>();
  for (const f of local) {
    const path = f.path.split("\\").join("/");
    if (!isInstallerExcludedPath(path)) have.set(path, { ...f, path });
  }
  const files: FileVerdict[] = [];
  for (const [path, s] of want) {
    const l = have.get(path);
    if (!l) {
      files.push({ path, status: "missing" });
      continue;
    }
    const modeChanged = l.mode !== undefined && l.mode !== s.mode;
    let status: FileStatus;
    if (l.sha256.toLowerCase() === s.sha256) status = "unchanged";
    else if (l.lfSha256 !== undefined && l.lfSha256.toLowerCase() === s.lfSha256) status = "line_endings";
    else status = "modified";
    if (modeChanged) status = "modified";
    const v: FileVerdict = { path, status, sha256: l.sha256.toLowerCase() };
    if (modeChanged) v.modeChanged = true;
    files.push(v);
  }
  for (const [path, l] of have) {
    if (want.has(path)) continue;
    const v: FileVerdict = { path, status: "extra", sha256: l.sha256.toLowerCase() };
    if (OS_METADATA_FILES.has(baseName(path))) v.osMetadata = true;
    files.push(v);
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, matches: files.every((f) => f.status === "unchanged" || f.status === "line_endings") };
}

export interface VerifyCandidate {
  variant: StatementVariant | null;
  files: readonly StatementFile[];
  signature: SignatureStatus;
}

export type OverallVerdict = "match" | "match_other_version" | "changed";

export interface Verdict {
  overall: OverallVerdict;
  /** The signature status of the statement the files were compared with. */
  signature: SignatureStatus;
  /** The variant the files matched (null = the version itself, or no match). */
  variant: StatementVariant | null;
  files: FileVerdict[];
  /** Set for `match_other_version`. */
  otherVersion: string | null;
  counts: Record<FileStatus, number>;
}

/**
 * The one verdict function (§73.7). Candidates are the version's statement first, then its
 * variants newest first; the first whose files match wins. With no match, the files are reported
 * against the version's own statement and the overall is `changed` — or `match_other_version`
 * when the caller found (by computedHash, visibility-filtered) another version with these files.
 */
export function verifyAgainstStatement(
  local: readonly LocalFile[],
  candidates: readonly VerifyCandidate[],
  opts: { otherVersionSemver?: string | null } = {},
): Verdict {
  for (const c of candidates) {
    const cmp = compareFiles(local, c.files);
    if (cmp.matches) return finish("match", c.signature, c.variant, cmp.files, null);
  }
  const base = candidates[0];
  const cmp = base ? compareFiles(local, base.files) : { files: local.map((l) => ({ path: l.path, status: "extra" as const, sha256: l.sha256 })), matches: false };
  const other = opts.otherVersionSemver ?? null;
  return finish(other ? "match_other_version" : "changed", base?.signature ?? "invalid", null, cmp.files, other);
}

function finish(overall: OverallVerdict, signature: SignatureStatus, variant: StatementVariant | null, files: FileVerdict[], otherVersion: string | null): Verdict {
  const counts: Record<FileStatus, number> = { unchanged: 0, line_endings: 0, modified: 0, missing: 0, extra: 0 };
  for (const f of files) counts[f.status]++;
  return { overall, signature, variant, files, otherVersion, counts };
}

/** A short human label for a variant's rewrites, for verdict lines and download names. */
export function describeVariant(v: StatementVariant | null): string {
  if (!v || v.rewrites.length === 0) return "";
  const parts: string[] = [];
  if (v.rewrites.includes("deprecation")) parts.push("with skilly's deprecation notice");
  if (v.rewrites.includes("marketplace_hoist")) parts.push("as delivered in a plugin marketplace");
  return parts.join(", ");
}

/**
 * `skill.signature_mismatch` (§73.11): the one sentence the inbox and the email both show, and the
 * CTA into Administration → Signing. Null for any other type.
 */
export function signatureMismatchNotificationContent(type: string, payload: Record<string, unknown>): { sentence: string; detail: string | null; ctaLabel: string; path: string } | null {
  if (type !== "skill.signature_mismatch") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const who = str(payload.reporterName) || "A user";
  return {
    sentence: `${who} reported that their copy of ${str(payload.namespaceSlug)}/${str(payload.skillSlug)} v${str(payload.semver)} doesn't match its signed statement: ${num(payload.modified)} modified, ${num(payload.missing)} missing, ${num(payload.extra)} extra.`,
    detail: str(payload.note) || null,
    ctaLabel: "Open Signing",
    path: "/admin/signing",
  };
}

/** The most files a REST/MCP verify call may send (§73.10). */
export const MAX_VERIFY_FILES = 5000;

/**
 * Validate a caller's `files` / `local` list for REST and MCP verify: `{ path, sha256, lfSha256?,
 * mode? }`, at most {@link MAX_VERIFY_FILES}. Returns the normalized list or an error message.
 */
export function parseLocalFiles(raw: unknown): LocalFile[] | string {
  if (!Array.isArray(raw)) return "files must be an array of { path, sha256, lfSha256?, mode? }";
  if (raw.length > MAX_VERIFY_FILES) return `at most ${MAX_VERIFY_FILES} files`;
  const out: LocalFile[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") return "each file must be an object";
    const { path, sha256, lfSha256, mode } = item as Record<string, unknown>;
    if (typeof path !== "string" || path.length === 0 || path.length > 1024) return "each file needs a path (1–1024 characters)";
    const norm = path.split("\\").join("/").replace(/^\.?\//, "");
    if (seen.has(norm)) return `duplicate path: ${norm.slice(0, 200)}`;
    seen.add(norm);
    if (!isSha256Hex(sha256)) return `sha256 must be 64 hex characters (${norm.slice(0, 200)})`;
    if (lfSha256 !== undefined && !isSha256Hex(lfSha256)) return `lfSha256 must be 64 hex characters (${norm.slice(0, 200)})`;
    if (mode !== undefined && mode !== "100644" && mode !== "100755") return `mode must be "100644" or "100755" (${norm.slice(0, 200)})`;
    const f: LocalFile = { path: norm, sha256: sha256.toLowerCase() };
    if (typeof lfSha256 === "string") f.lfSha256 = lfSha256.toLowerCase();
    if (mode === "100644" || mode === "100755") f.mode = mode;
    out.push(f);
  }
  return out;
}

/** True when a string is a lowercase or uppercase 64-hex sha256. */
export function isSha256Hex(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-fA-F]{64}$/.test(s);
}
