// Bundle upload (hosted skills). The proposer uploads a tar.gz BEFORE creating a proposal.
// We extract, BLOCKING-validate, ADVISORY-scan (writing an artifact-keyed scan report so
// reviewers see findings pre-accept), store the bundle, and return the key + sha + scan
// summary for the subsequent POST /api/proposals. SKILLY_SPEC.md §6, §8, §9.
import { randomUUID, createHash } from "node:crypto";
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { resolveUserAccess } from "../../../lib/access";
import { pool } from "../../../lib/db";
import { s3ArtifactStore } from "../../../lib/objectStore";
import { extractBundle } from "../../../lib/bundle";
import { enforceRateLimit } from "../../../lib/ratelimit";
import { findDuplicateSkill } from "../../../lib/duplicate";
import { getDuplicateEnforcement, getMaxBundleBytes } from "../../../lib/settings";
import { withSystemLog } from "../../../lib/apiLog";
import { validateBundle, runScanners, PURE_SCANNERS, maxSeverity, contentDigest, bundleContentCap } from "@skilly/shared";

export const dynamic = "force-dynamic";

/** Human-readable size for the configured limit ("100 KB" / "50 MB" / "1 GB"). */
function fmtSize(bytes: number): string {
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;
  if (bytes >= GB) return `${Math.round(bytes / GB)} GB`;
  return bytes >= MB ? `${Math.round(bytes / MB)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export const POST = withSystemLog("/api/uploads", async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  const limited = enforceRateLimit("uploads", access.userId, 20);
  if (limited) return limited;

  // The admin-configured maximum bundle size (§6) is the user-facing limit. Route Handlers have
  // NO default body limit (next.config bodySizeLimit only covers Server Actions), so cap
  // explicitly — first by Content-Length (before buffering), then by the parsed blob size.
  const maxBytes = await getMaxBundleBytes();
  const tooLarge = `the bundle is bigger than the allowed size of ${fmtSize(maxBytes)}`;

  // Reject oversized bodies before reading/parsing them into memory.
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) {
    return Response.json({ error: tooLarge }, { status: 413 });
  }

  const form = await req.formData();
  const file = form.get("bundle");
  const skillSlug = String(form.get("skillSlug") ?? "");
  if (!(file instanceof Blob) || !skillSlug) {
    return Response.json({ error: "multipart 'bundle' (.tar.gz, .zip, or .skill) and 'skillSlug' required" }, { status: 400 });
  }
  if (file.size > maxBytes) {
    return Response.json({ error: tooLarge }, { status: 413 });
  }

  const bundleBytes = Buffer.from(await file.arrayBuffer());
  // Pass the original filename so a `.skill`/`.zip` export whose magic bytes don't sniff cleanly
  // still extracts as a zip instead of being rejected as an unsupported archive. §6.
  const filename = file instanceof File ? file.name : undefined;
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
});
