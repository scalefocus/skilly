// Build a downloadable archive of a skill version for the detail page (SKILLY_SPEC.md §6, §10).
// A governed, visibility-checked extension of the readme byte-path. We serve the ORIGINAL uploaded
// bundle VERBATIM (no re-pack) so a `.skill` downloads as `.skill`, a `.zip` as `.zip`, a `.tar.gz`
// as `.tar.gz`. The extension comes from the version's recorded original filename
// (`artifact_filename`); for pre-0040 versions and Pointer mirrors (no upload) we sniff the bytes
// (zip → .zip/.skill, gzip → .tar.gz) and finally fall back to the skill's harness. Visibility MUST
// be checked by the caller before invoking this.
import AdmZip from "adm-zip";
import { resolveLatest, detectArchive, downloadExtFromFilename, fallbackDownloadExt, downloadContentType } from "@skilly/shared";
import { pool } from "./db";
import { s3ArtifactStore } from "./objectStore";
import { extractBundle } from "./bundle";

export interface SkillDownload {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/** Requested download format mismatches the stored artifact (e.g. `tar.gz` of a zip bundle) —
 *  the route maps this to a 400, distinct from the 404 "no artifact" case. */
export class DownloadFormatError extends Error {}

export type DownloadFormat = "skill" | "tar.gz";

/**
 * Build the download for a skill's version (or its latest stable). Returns null when there's
 * no downloadable artifact — no published bytes, or the requested version is yanked/missing
 * (yanked = withdrawn from serving, so it isn't downloadable either).
 */
export async function buildSkillDownload(skillId: string, skillSlug: string, semver?: string, format?: DownloadFormat): Promise<SkillDownload | null> {
  const skill = (await pool.query<{ tool_harness: string; type: "hosted" | "pointer" }>(
    `select tool_harness, type from skills where id = $1`,
    [skillId],
  )).rows[0];
  if (!skill) return null;

  // Only ACTIVE (non-yanked) versions are downloadable, mirroring what is installable.
  const { rows } = await pool.query<{ semver: string; artifact_object_key: string | null; artifact_filename: string | null; external_ref: string | null }>(
    `select semver, artifact_object_key, artifact_filename, external_ref from skill_versions
      where skill_id = $1 and status = 'active' and artifact_object_key is not null`,
    [skillId],
  );
  if (rows.length === 0) return null;
  const target = semver ?? resolveLatest(rows.map((r) => r.semver));
  const row = rows.find((r) => r.semver === target);
  if (!row?.artifact_object_key) return null;

  let stored: Buffer;
  try {
    stored = await s3ArtifactStore().get(row.artifact_object_key);
  } catch {
    return null;
  }

  // Resolve the extension: recorded original filename first; then magic-byte sniff (zip vs gzip);
  // then the harness/type fallback. The bytes are served verbatim — no decompression here (they
  // were size-capped + scanned at ingest), so there's no decompression-bomb surface on our side.
  const isPointer = skill.type === "pointer" || !!row.external_ref;
  const sniffed = detectArchive(stored);
  const ext =
    downloadExtFromFilename(row.artifact_filename) ??
    (sniffed === "zip"
      ? skill.tool_harness === "claude-code"
        ? "skill"
        : "zip"
      : sniffed === "gzip"
        ? "tar.gz"
        : fallbackDownloadExt({ isPointer, toolHarness: skill.tool_harness }));

  // Explicit format request (§6 "Pointer download format choice"): `tar.gz` streams the stored
  // tarball verbatim; `skill` serves zip-backed bytes verbatim under the .skill name (a .skill IS
  // a zip) or re-packs a gzip tarball into a zip. Re-packing goes through extractBundle, so the
  // upload-ingest decompression-bomb guards (size/entry caps, symlink refusal, wrapper/junk
  // stripping) apply to this one decompress-on-our-side path.
  if (format === "tar.gz") {
    if (sniffed !== "gzip") throw new DownloadFormatError("this version's bundle is not a tarball — download it as .skill instead");
    return { filename: `${skillSlug}-${row.semver}.tar.gz`, contentType: downloadContentType("tar.gz"), bytes: stored };
  }
  if (format === "skill") {
    if (sniffed !== "gzip") {
      return { filename: `${skillSlug}-${row.semver}.skill`, contentType: downloadContentType("skill"), bytes: stored };
    }
    let entries;
    try {
      entries = await extractBundle(stored, row.artifact_filename ?? undefined);
    } catch (e) {
      throw new DownloadFormatError(`could not re-pack this bundle as .skill (${e instanceof Error ? e.message : String(e)}) — download it as .tar.gz instead`);
    }
    const zip = new AdmZip();
    for (const f of entries) zip.addFile(f.path, Buffer.isBuffer(f.bytes) ? f.bytes : Buffer.from(f.bytes));
    return { filename: `${skillSlug}-${row.semver}.skill`, contentType: downloadContentType("skill"), bytes: zip.toBuffer() };
  }

  return {
    filename: `${skillSlug}-${row.semver}.${ext}`,
    contentType: downloadContentType(ext),
    bytes: stored,
  };
}
