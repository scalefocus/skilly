// Signed skill versions in the browser (SKILLY_SPEC.md §73.7, §73.8): the pure half of the Verify
// files dialog, the /verify page and the version badges. No React and no DOM, so every rule here is
// unit-tested (verifyFiles.test.ts); the components only read files and render what this decides.
//
// Privacy (§73.7): a folder is read and hashed HERE, in the browser. Nothing in this module sends a
// file or a hash anywhere — the callers send only a folder's `computedHash` to /api/verify/lookup and,
// when the user chooses to report, paths + statuses + hashes (`reportBody`).
//
// Client components import @skilly/shared through subpath exports only (the root barrel pulls
// node-only modules and breaks `next build`).
import {
  checkEnvelopeSignature,
  decodeEnvelope,
  describeLocalFiles,
  describeVariant,
  isSha256Hex,
  verifyAgainstStatement,
  MAX_VERIFY_FILES,
  type AttestationKind,
  type DecodedEnvelope,
  type FileStatus,
  type FileVerdict,
  type LocalFile,
  type PublicSigningKey,
  type SignatureStatus,
  type StatementVariant,
  type Verdict,
  type VerifyCandidate,
} from "@skilly/shared/attestation";
import { isInstallerExcludedPath, skillsLockComputedHash } from "@skilly/shared/external-tool";
import { compareSemver } from "@skilly/shared/semver";
import { fmtSize } from "./uploadError";

// ---------------------------------------------------------------------------
// Wire shapes (the routes under /api/skills/:ns/:slug/versions/:semver/statement, /api/verify/lookup
// and /.well-known/skilly-signing-keys.json)
// ---------------------------------------------------------------------------

export type KeyStatus = "active" | "retired" | "revoked";

export interface StatementEntry {
  variant: StatementVariant | null;
  kind: AttestationKind;
  keyId: string;
  keyStatus: KeyStatus;
  signedAt: string;
  computedHash: string;
  envelope: unknown;
  /** The signature result skilly computed — used when this browser can't verify Ed25519. */
  serverSignature: SignatureStatus;
}

export interface StatementResponse {
  registry: string;
  semver: string;
  status: string;
  /** The version's own statement first, then one per variant, newest first. */
  statements: StatementEntry[];
  otherVersions: { semver: string; status: string; computedHash: string }[];
}

export interface SigningKeysDocument {
  registry: string;
  keys: {
    keyId: string;
    algorithm: string;
    publicKeyPem: string;
    fingerprint: string;
    createdAt: string;
    retiredAt: string | null;
    revokedAt: string | null;
  }[];
}

export interface HashMatch {
  namespaceSlug: string;
  skillSlug: string;
  title: string;
  semver: string;
  variant: StatementVariant | null;
  status: string;
}

/** The per-version signature summary the skill detail API sends (`SkillVersionView.signature`). */
export interface VersionSignature {
  kind: AttestationKind;
  keyId: string;
  keyStatus: KeyStatus;
  computedHash: string;
  signedAt: string;
  variants: number;
}

/** A file the user picked, read into memory. `path` is relative to the skill folder. */
export interface PickedFile {
  path: string;
  bytes: Uint8Array;
}

// ---------------------------------------------------------------------------
// Picking a folder
// ---------------------------------------------------------------------------

/** `\` → `/`, and no leading `/` or `./` (a dropped entry's fullPath starts with `/`). */
export function normalizePickedPath(p: string): string {
  let s = p.split("\\").join("/");
  while (s.startsWith("./")) s = s.slice(2);
  while (s.startsWith("/")) s = s.slice(1);
  return s;
}

/**
 * Strip the picked folder's own name from every path. `<input webkitdirectory>` reports
 * `my-skill/SKILL.md` and a dropped folder `/my-skill/SKILL.md`; the statement says `SKILL.md`. Only
 * when EVERY path sits inside the same top folder — loose files dropped together keep their paths.
 */
export function stripTopFolder<T extends { path: string }>(files: readonly T[]): { files: T[]; top: string | null } {
  const norm = files.map((f) => ({ ...f, path: normalizePickedPath(f.path) }));
  if (norm.length === 0) return { files: norm, top: null };
  const first = norm[0]!.path.split("/")[0]!;
  const shared = norm.every((f) => {
    const i = f.path.indexOf("/");
    return i > 0 && f.path.slice(0, i) === first;
  });
  if (!shared) return { files: norm, top: null };
  return { files: norm.map((f) => ({ ...f, path: f.path.slice(first.length + 1) })), top: first };
}

export interface FolderLimits {
  /** The platform bundle cap (§6) — a larger folder is refused before anything is read. */
  maxBytes: number;
  maxFiles?: number;
}

export type PreparedFolder<T> =
  | { ok: true; files: T[]; top: string | null; skipped: number; totalBytes: number; hasSkillMd: boolean }
  | { ok: false; error: string };

/**
 * Turn a picked or dropped file list into the set the verifier hashes: the top folder stripped, the
 * installer's exclusions (metadata.json, .git, __pycache__, __pypackages__) left out and counted, and
 * the size and file-count caps applied BEFORE any byte is read (§73.7).
 */
export function prepareFolder<T extends { path: string; size: number }>(items: readonly T[], limits: FolderLimits): PreparedFolder<T> {
  if (items.length === 0) return { ok: false, error: "This folder is empty." };
  const { files: stripped, top } = stripTopFolder(items);
  const kept = stripped.filter((f) => f.path && !isInstallerExcludedPath(f.path));
  const skipped = stripped.length - kept.length;
  if (kept.length === 0) return { ok: false, error: "There's nothing to check: every file in this folder is one the installer never copies." };
  const maxFiles = limits.maxFiles ?? MAX_VERIFY_FILES;
  if (kept.length > maxFiles) {
    return { ok: false, error: `This folder has ${kept.length.toLocaleString("en")} files, more than ${maxFiles.toLocaleString("en")}, so it wasn't checked. Pick the skill's own folder.` };
  }
  const totalBytes = kept.reduce((n, f) => n + f.size, 0);
  if (totalBytes > limits.maxBytes) {
    return { ok: false, error: `This folder is ${fmtSize(totalBytes)}, bigger than the allowed size of ${fmtSize(limits.maxBytes)}, so it wasn't checked.` };
  }
  return { ok: true, files: kept, top, skipped, totalBytes, hasSkillMd: kept.some((f) => f.path === "SKILL.md") };
}

/** A bundle file the detail page's Download serves verbatim (§10): .zip, .tar.gz / .tgz, .skill. */
export function isBundleName(name: string): boolean {
  return /\.(zip|tgz|tar\.gz|skill)$/i.test(name);
}

/** Hash a picked folder the verifier's way (raw + LF digests) plus its installer `computedHash`. */
export async function hashFolder(files: readonly PickedFile[]): Promise<{ local: LocalFile[]; computedHash: string }> {
  const [local, computedHash] = await Promise.all([describeLocalFiles(files), skillsLockComputedHash(files)]);
  return { local, computedHash };
}

// ---------------------------------------------------------------------------
// Statements and signatures
// ---------------------------------------------------------------------------

export interface CheckedStatement {
  entry: StatementEntry;
  /** Null when the envelope isn't a skilly statement (then the signature is `invalid`). */
  decoded: DecodedEnvelope | null;
  signature: SignatureStatus;
}

/** Where the signature was checked: here with WebCrypto Ed25519, or by skilly (no Ed25519 here). */
export type SignatureCheckedBy = "browser" | "server";

export function signingKeysFrom(doc: SigningKeysDocument): PublicSigningKey[] {
  return doc.keys.map((k) => ({ keyId: k.keyId, publicKeyPem: k.publicKeyPem, revokedAt: k.revokedAt }));
}

/**
 * Decode every statement and decide its signature: with the public keys in the browser when `keys`
 * is given (the registry the statement names must be this instance's), else skilly's own result.
 */
export async function checkStatements(resp: StatementResponse, keys: SigningKeysDocument | null): Promise<CheckedStatement[]> {
  const pub = keys ? signingKeysFrom(keys) : null;
  const out: CheckedStatement[] = [];
  for (const entry of resp.statements) {
    const decoded = decodeEnvelope(entry.envelope);
    let signature: SignatureStatus;
    if (!decoded) signature = "invalid";
    else if (pub && keys) signature = await checkEnvelopeSignature(decoded, pub, keys.registry);
    else signature = entry.serverSignature;
    out.push({ entry, decoded, signature });
  }
  return out;
}

/** The version's own statement (variant null), or the first one when somehow none is. */
export function baseStatement(checked: readonly CheckedStatement[]): CheckedStatement | null {
  return checked.find((c) => !c.entry.variant) ?? checked[0] ?? null;
}

/** Verifier candidates (§73.5): the version's own statement first, then its variants in the server's order. */
export function buildCandidates(checked: readonly CheckedStatement[]): VerifyCandidate[] {
  const base = baseStatement(checked);
  const ordered = base ? [base, ...checked.filter((c) => c !== base)] : [];
  return ordered.map((c) => ({
    variant: c.entry.variant ?? c.decoded?.statement.predicate.variant ?? null,
    files: c.decoded?.statement.predicate.files ?? [],
    signature: c.signature,
  }));
}

const safeCompare = (a: string, b: string): number => {
  try {
    return compareSemver(a, b);
  } catch {
    return a < b ? -1 : a > b ? 1 : 0;
  }
};

/**
 * Another version of the same skill whose signed `computedHash` equals the folder's (§73.7
 * `match_other_version`). The highest such version when several share the files.
 */
export function otherVersionMatch(
  computedHash: string,
  otherVersions: StatementResponse["otherVersions"],
  semver: string,
): { semver: string; status: string } | null {
  const h = computedHash.toLowerCase();
  const hits = otherVersions.filter((o) => o.semver !== semver && o.computedHash.toLowerCase() === h);
  hits.sort((a, b) => safeCompare(b.semver, a.semver));
  const top = hits[0];
  return top ? { semver: top.semver, status: top.status } : null;
}

export interface VerificationOutcome {
  verdict: Verdict;
  computedHash: string;
  /** The statement the verdict compares with: the one matched, else the version's own. */
  statement: CheckedStatement | null;
  /** Set for `match_other_version`. */
  otherVersion: { semver: string; status: string } | null;
}

/** The whole §73.7 decision for one folder against one version, with the shared verdict function. */
export function decideVerification(local: readonly LocalFile[], computedHash: string, resp: StatementResponse, checked: readonly CheckedStatement[]): VerificationOutcome {
  const candidates = buildCandidates(checked);
  let verdict = verifyAgainstStatement(local, candidates);
  let otherVersion: VerificationOutcome["otherVersion"] = null;
  if (verdict.overall !== "match") {
    otherVersion = otherVersionMatch(computedHash, resp.otherVersions, resp.semver);
    if (otherVersion) verdict = verifyAgainstStatement(local, candidates, { otherVersionSemver: otherVersion.semver });
  }
  const statement =
    verdict.overall === "match" && verdict.variant
      ? checked.find((c) => c.entry.variant?.inputsSha256 === verdict.variant!.inputsSha256) ?? baseStatement(checked)
      : baseStatement(checked);
  return { verdict, computedHash, statement, otherVersion };
}

// ---------------------------------------------------------------------------
// Words (follow SKILLY_SPEC.md §73.7 / §73.8 wording)
// ---------------------------------------------------------------------------

export type Tone = "ok" | "warn" | "danger" | "muted";

/** The verdict headline: "Unchanged: v1.2.0 with skilly's deprecation notice", … */
export function verdictHeadline(outcome: Pick<VerificationOutcome, "verdict">, semver: string): { text: string; tone: Tone } {
  const v = outcome.verdict;
  if (v.overall === "match") {
    const variant = describeVariant(v.variant);
    return { text: `Unchanged: v${semver}${variant ? ` ${variant}` : ""}`, tone: "ok" };
  }
  if (v.overall === "match_other_version") return { text: `These files are v${v.otherVersion}, not v${semver}.`, tone: "warn" };
  return { text: `Changed: these files don't match v${semver}.`, tone: "danger" };
}

/** "3 files · 2 unchanged · 1 modified" (zero counts left out). */
export function countsLine(counts: Record<FileStatus, number>): string {
  const total = counts.unchanged + counts.line_endings + counts.modified + counts.missing;
  const parts = [`${total} signed ${total === 1 ? "file" : "files"}`];
  const order: [FileStatus, string][] = [
    ["unchanged", "unchanged"],
    ["line_endings", "line endings only"],
    ["modified", "modified"],
    ["missing", "missing"],
    ["extra", "extra"],
  ];
  for (const [k, label] of order) if (counts[k] > 0) parts.push(`${counts[k]} ${label}`);
  return parts.join(" · ");
}

export const FILE_STATUS_LABEL: Record<FileStatus, string> = {
  unchanged: "Unchanged",
  line_endings: "Line endings only",
  modified: "Modified",
  missing: "Missing",
  extra: "Extra",
};

export const FILE_STATUS_TONE: Record<FileStatus, Tone> = {
  unchanged: "ok",
  line_endings: "ok",
  modified: "danger",
  missing: "danger",
  extra: "warn",
};

/** The per-file note in the table, if any. */
export function fileNote(f: FileVerdict): string | null {
  if (f.status === "extra" && f.osMetadata) return "Probably harmless (OS metadata)";
  if (f.status === "line_endings") return "Only CRLF line endings differ (git core.autocrlf does this)";
  if (f.modeChanged) return "File mode differs";
  return null;
}

/** The signature line beside the verdict (§73.7). */
export function signatureLine(sig: SignatureStatus, checkedBy: SignatureCheckedBy): { text: string; tone: Tone } {
  if (sig === "valid") {
    return { text: checkedBy === "browser" ? "Signature valid (checked in your browser)" : "Signature valid · Signature checked by skilly", tone: "ok" };
  }
  if (sig === "revoked_key") {
    return { text: `Signed by a revoked key: re-signing${checkedBy === "server" ? " · Signature checked by skilly" : ""}`, tone: "warn" };
  }
  return {
    text: `Signature invalid: a bad signature, an unknown key or another registry. Don't rely on this result.${checkedBy === "server" ? " · Signature checked by skilly" : ""}`,
    tone: "danger",
  };
}

/**
 * The version's status, shown beside the verdict and never folded into it (§73.7). Null for an
 * active version.
 */
export function statusNote(status: string, semver: string, matched: boolean): string | null {
  if (status === "yanked") return matched ? `Files are unchanged from v${semver}, but this version was yanked.` : `v${semver} was yanked.`;
  if (status === "quarantined") {
    return matched
      ? `Files are unchanged from v${semver}, but this version was quarantined after a critical scan finding.`
      : `v${semver} was quarantined after a critical scan finding.`;
  }
  return null;
}

/** "Signed as ‹old-ns›/‹slug› (moved since)" — the statement names the owner when it was signed (§73.3). */
export function movedNote(statement: CheckedStatement | null, ns: string, slug: string): string | null {
  const skill = statement?.decoded?.statement.predicate.skill;
  if (!skill) return null;
  if (skill.namespace === ns && skill.slug === slug) return null;
  return `Signed as ${skill.namespace}/${skill.slug} (moved since)`;
}

/** The note for a backfill or re-sign statement; `date` is already formatted for the viewer. */
export function kindNote(kind: AttestationKind, date: string): string | null {
  if (kind === "backfill") return `Signed on ${date} from the files skilly held then. This version was published before signing existed.`;
  if (kind === "resign") return `Re-signed on ${date} after a signing key was revoked.`;
  return null;
}

/** The version badge on the skill page (§73.8); `date` formats a UTC ISO for the viewer. */
export function signatureBadge(sig: VersionSignature | null, date: (iso: string) => string): { label: string; tone: Tone; title: string } {
  if (!sig) return { label: "Signature pending", tone: "muted", title: "This version has no signed statement yet." };
  if (sig.keyStatus === "revoked") {
    return { label: "Signed by a revoked key: re-signing", tone: "warn", title: "The key that signed this version was revoked. skilly re-signs it with the active key." };
  }
  if (sig.kind === "backfill") return { label: "Signed (backfill)", tone: "ok", title: kindNote("backfill", date(sig.signedAt))! };
  return { label: "Signed", tone: "ok", title: `Signed on ${date(sig.signedAt)} · key ${sig.keyId}` };
}

// ---------------------------------------------------------------------------
// Downloads, bundles, reports
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

export function statementUrl(ns: string, slug: string, semver: string): string {
  return `/api/skills/${enc(ns)}/${enc(slug)}/versions/${enc(semver)}/statement`;
}

/** The "Download signed statement" link — the version's own, or one variant's (§73.8). */
export function statementDownloadUrl(ns: string, slug: string, semver: string, variant?: StatementVariant | null): string {
  const base = `${statementUrl(ns, slug, semver)}?download=1`;
  return variant ? `${base}&variant=${variant.inputsSha256.slice(0, 8)}` : base;
}

/** The file name the download carries: `<slug>-<semver>.intoto.json` / `….variant-<8 hex>.intoto.json`. */
export function statementFileName(slug: string, semver: string, variant?: StatementVariant | null): string {
  return variant ? `${slug}-${semver}.variant-${variant.inputsSha256.slice(0, 8)}.intoto.json` : `${slug}-${semver}.intoto.json`;
}

/** A variant's name for lists: its rewrites in words. */
export function variantName(variant: StatementVariant): string {
  const d = describeVariant(variant);
  return d ? d.charAt(0).toUpperCase() + d.slice(1) : "Variant";
}

export type BundleResult = "match" | "mismatch" | "no_hash";

/** Compare a dropped bundle's sha256 with the version statement's `artifactSha256` (§73.7). */
export function bundleVerdict(sha256: string, base: CheckedStatement | null): BundleResult {
  const want = base?.decoded?.statement.predicate.artifactSha256 ?? null;
  if (!want || !isSha256Hex(want)) return "no_hash";
  return want.toLowerCase() === sha256.toLowerCase() ? "match" : "mismatch";
}

export function bundleMessage(result: BundleResult, semver: string): { text: string; tone: Tone } {
  if (result === "match") return { text: `Unchanged: this is the v${semver} bundle skilly signed.`, tone: "ok" };
  if (result === "no_hash") {
    return { text: `No bundle hash was recorded for v${semver}, so a bundle can't be checked. Extract it and verify the folder instead.`, tone: "warn" };
  }
  return {
    text: `This file isn't the v${semver} bundle skilly signed. A re-packed archive never matches (a pointer skill's .skill download is re-packed too): extract it and verify the folder instead.`,
    tone: "danger",
  };
}

export const MAX_REPORT_NOTE = 2000;

/** The mismatch report body (§73.11): paths, statuses and hashes only — never file contents. */
export function reportBody(verdict: Verdict, note: string): { files: { path: string; status: FileStatus; sha256?: string }[]; note?: string; verdict: "changed" | "match_other_version" } {
  const files = verdict.files.map((f) => (f.sha256 ? { path: f.path, status: f.status, sha256: f.sha256 } : { path: f.path, status: f.status }));
  const trimmed = note.trim().slice(0, MAX_REPORT_NOTE);
  return { files, ...(trimmed ? { note: trimmed } : {}), verdict: verdict.overall === "match_other_version" ? "match_other_version" : "changed" };
}

/** The version an install's Verify files opens at: the pinned semver, else what it was last served (§73.8). */
export function installVerifySemver(i: { pinnedSemver: string | null; lastServedSemver: string | null; latestSemver?: string | null }): string | null {
  return i.pinnedSemver ?? i.lastServedSemver ?? i.latestSemver ?? null;
}

// ---------------------------------------------------------------------------
// skills-lock.json (the /verify lock tab)
// ---------------------------------------------------------------------------

export interface LockEntry {
  /** The lock's own name for the skill. */
  name: string;
  /** The entry's lock-v2 `computedHash`, or null (lock v1, or an entry without one). */
  computedHash: string | null;
}

export type ParsedLock = { ok: true; lockVersion: number | null; entries: LockEntry[] } | { ok: false; error: string };

/** The message for an entry without a hash (§73.7). */
export const NO_LOCK_HASH = "No hash in this lock: run `npx skills install` with a current `skills` release";

/**
 * Parse a `skills-lock.json` in the browser (§73.7). Only the name and the `computedHash` of each
 * entry are kept — a lock's `sourceUrl` can carry an install token, and nothing else of it is ever
 * sent. `skills` may be a name → entry map or an array of entries with a `name`. A lock version
 * below 2 has no installer hash, so its entries carry none.
 */
export function parseSkillsLock(text: string): ParsedLock {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "This isn't valid JSON. Paste the whole skills-lock.json." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "This doesn't look like a skills-lock.json." };
  const obj = raw as Record<string, unknown>;
  const v = typeof obj.version === "number" ? obj.version : typeof obj.lockVersion === "number" ? obj.lockVersion : null;
  const hashOf = (e: unknown): string | null => {
    if (v !== null && v < 2) return null;
    const h = e && typeof e === "object" ? (e as Record<string, unknown>).computedHash : undefined;
    return isSha256Hex(h) ? h.toLowerCase() : null;
  };
  const skills = obj.skills;
  let entries: LockEntry[];
  if (Array.isArray(skills)) {
    entries = skills.map((e, i) => {
      const r = e && typeof e === "object" ? (e as Record<string, unknown>) : {};
      const name = typeof r.name === "string" ? r.name : typeof r.skill === "string" ? r.skill : `entry ${i + 1}`;
      return { name, computedHash: hashOf(e) };
    });
  } else if (skills && typeof skills === "object") {
    entries = Object.entries(skills as Record<string, unknown>).map(([name, e]) => ({ name, computedHash: hashOf(e) }));
  } else {
    return { ok: false, error: "This doesn't look like a skills-lock.json: it has no skills." };
  }
  if (entries.length === 0) return { ok: false, error: "This lock lists no skills." };
  return { ok: true, lockVersion: v, entries };
}

/** The distinct hashes a lock sends to the lookup API, in first-seen order. */
export function lockHashes(entries: readonly LockEntry[]): string[] {
  return [...new Set(entries.map((e) => e.computedHash).filter((h): h is string => !!h))];
}

/** Split into lookup calls of at most `size` hashes (the API takes 200). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** A lookup match as one line: `ns/slug@semver`, plus the variant's rewrites. */
export function matchLabel(m: HashMatch): string {
  const v = describeVariant(m.variant);
  return `${m.namespaceSlug}/${m.skillSlug}@${m.semver}${v ? ` (${v})` : ""}`;
}

// ---------------------------------------------------------------------------
// The offline recipe (§73.7)
// ---------------------------------------------------------------------------

/** The §73.7 openssl recipe with this instance's registry and the active key filled in. */
export function offlineRecipe(registry: string, keyId: string | null): string {
  // Trailing slashes dropped with a linear scan (a `/\/+$/` regex is polynomial on long runs).
  let end = registry.length;
  while (end > 0 && registry.charCodeAt(end - 1) === 47 /* / */) end--;
  const reg = registry.slice(0, end);
  return [
    keyId
      ? `KEYID=${keyId}   # the active key; or: KEYID=$(jq -r '.signatures[0].keyid' statement.json)`
      : `KEYID=$(jq -r '.signatures[0].keyid' statement.json)`,
    "# 1. The public key. Compare its fingerprint with the one on /verify, and check revokedAt is null.",
    `curl -s ${reg}/.well-known/skilly-signing-keys.json \\`,
    `  | jq -r --arg k "$KEYID" '.keys[] | select(.keyId == $k) | .publicKeyPem' > skilly.pem`,
    "# 2. The signature.",
    "jq -r .payload statement.json | base64 -d > payload.json",
    "jq -r '.signatures[0].sig' statement.json | base64 -d > sig.bin",
    "T=application/vnd.in-toto+json",
    `{ printf 'DSSEv1 %d %s %d ' "\${#T}" "$T" "$(wc -c < payload.json)"; cat payload.json; } > pae.bin`,
    "openssl pkeyutl -verify -pubin -inkey skilly.pem -rawin -in pae.bin -sigfile sig.bin",
    "# 3. The files, then the file count (an extra file is a change).",
    `jq -r '.predicate.files[] | select(.installed) | "\\(.sha256)  \\(.path)"' payload.json > "$PWD/SHA256SUMS"`,
    `(cd path/to/skill && sha256sum -c "$OLDPWD/SHA256SUMS")`,
    "jq '[.predicate.files[] | select(.installed)] | length' payload.json",
    "(cd path/to/skill && find . -type f ! -name metadata.json ! -path '*/.git/*' \\",
    "  ! -path '*/__pycache__/*' ! -path '*/__pypackages__/*' | wc -l)",
  ].join("\n");
}
