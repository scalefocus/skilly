// The hosted-bundle ingest pipeline (§6, §8, §9), shared verbatim by the single-shot
// POST /api/uploads and the chunked-upload complete step — extract → BLOCKING validation →
// ADVISORY scan → store the original bytes at an immutable key → artifact-keyed scan report →
// advisory duplicate pre-check. Both entry points return this function's Response as-is, so the
// two upload paths can never drift in behavior or response shape.
import { randomUUID, createHash } from "node:crypto";
import { pool } from "./db";
import { s3ArtifactStore } from "./objectStore";
import { extractBundle } from "./bundle";
import { findDuplicateSkill } from "./duplicate";
import { getDuplicateEnforcement } from "./settings";
import { validateBundle, runScanners, PURE_SCANNERS, maxSeverity, contentDigest, bundleContentCap, type EffectiveAccess } from "@skilly/shared";

/** Human-readable size for the configured limit ("100 KB" / "50 MB" / "1 GB"). */
export function fmtSize(bytes: number): string {
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  if (bytes >= GB) return `${Math.round(bytes / GB)} GB`;
  return bytes >= MB ? `${Math.round(bytes / MB)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Validate + scan + store an uploaded hosted bundle and answer with the upload contract
 * (201 { artifactObjectKey, artifactSha256, contentSha256, artifactFilename, scan, duplicate,
 * duplicateEnforcement }, or the 413/422/503 error shapes). `access` must carry a userId.
 */
export async function processBundleUpload(
  access: EffectiveAccess & { userId: string },
  bundleBytes: Buffer,
  filename: string | undefined,
  skillSlug: string,
  maxBytes: number,
): Promise<Response> {
  if (bundleBytes.length > maxBytes) {
    return Response.json({ error: `the bundle is bigger than the allowed size of ${fmtSize(maxBytes)}` }, { status: 413 });
  }

  // The uploaded FILE is already capped at maxBytes; give extraction/validation the same bound
  // (with a floor so small limits keep generous decompression headroom) so a within-limit bundle
  // is never pre-rejected by the decompression-bomb guard while a bomb still trips. The SAME cap
  // is reused at publish/mirror/download so an accepted bundle is never rejected later. §6.
  const contentCap = bundleContentCap(maxBytes);
  let files;
  try {
    files = await extractBundle(bundleBytes, filename, contentCap);
  } catch (e) {
    return Response.json({ error: `could not read bundle: ${(e as Error).message}` }, { status: 422 });
  }

  // BLOCKING validation.
  const validation = validateBundle(files, { skillSlug, maxBytes: contentCap });
  if (!validation.ok) {
    return Response.json({ error: "invalid bundle", details: validation.errors }, { status: 422 });
  }

  // ADVISORY scan (pre-accept; reviewer-visible).
  const findings = await runScanners(files, PURE_SCANNERS);
  const severity = maxSeverity(findings) ?? "info";

  // Packaging-independent content-set digest (§8): persisted on the version and used to detect a
  // byte-identical upload that already exists in the catalog.
  const contentSha256 = contentDigest(files);

  // Store the original uploaded bundle (verbatim) at an immutable key; record the scan.
  const artifactObjectKey = `uploads/${access.userId}/${randomUUID()}.bundle`;
  try {
    await s3ArtifactStore().put(artifactObjectKey, bundleBytes);
  } catch (e) {
    // Object storage unreachable/misconfigured (e.g. the S3 endpoint host can't be resolved).
    // Surface a clear, actionable message instead of a generic 500; the raw cause goes to stdout
    // (and the System log via the wrapper records this 503). It's a server/infra fault, not the
    // user's bundle.
    console.error(JSON.stringify({ level: "error", msg: "artifact store put failed", key: artifactObjectKey, err: String(e instanceof Error ? e.message : e) }));
    return Response.json(
      { error: "couldn’t store the bundle — object storage is unavailable. Try again shortly; if it persists, contact an administrator." },
      { status: 503 },
    );
  }
  const artifactSha256 = createHash("sha256").update(bundleBytes).digest("hex");
  await pool.query(
    `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status)
     values ('artifact', $1, 'pipeline', $2::jsonb, $3, 'scanned')`,
    [artifactObjectKey, JSON.stringify(findings), severity],
  );

  // Duplicate detection: does this exact content already exist somewhere the proposer can see?
  // We surface the match + the platform enforcement mode so the propose form can block (and offer
  // "propose a new version") or warn. The proposals/publish endpoints re-check authoritatively.
  // ADVISORY — must never break a valid upload: if the check itself errors (e.g. the
  // content_sha256 column hasn't been migrated on this DB yet, §8 migration 0034), we log and
  // return "no duplicate" so the upload still succeeds.
  let duplicate: Awaited<ReturnType<typeof findDuplicateSkill>> = null;
  let duplicateEnforcement: "block" | "warn" = "block";
  try {
    duplicate = await findDuplicateSkill(access, { contentSha256 });
    duplicateEnforcement = await getDuplicateEnforcement();
  } catch (e) {
    console.error(JSON.stringify({ level: "warn", msg: "duplicate pre-check failed (non-fatal)", err: String(e) }));
  }

  return Response.json(
    // `artifactFilename` (the original upload's name) rides along so the proposal/version persists
    // it and the detail-page download can serve the bundle back with its original extension (§6/§10).
    { artifactObjectKey, artifactSha256, contentSha256, artifactFilename: filename ?? null, scan: { severity, findings }, duplicate, duplicateEnforcement },
    { status: 201 },
  );
}
