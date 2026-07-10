// Read a skill version's SKILL.md for in-app rendering. Both hosted and (mirrored) pointer
// versions carry an immutable artifact in object storage, so we extract the bundle and pull
// out SKILL.md. The returned text is rendered as Markdown by a safe client component — it is
// NOT trusted HTML. SKILLY_SPEC.md §6, §10.
import { pool } from "./db";
import { resolveLatest, bundleContentCap } from "@skilly/shared";
import { s3ArtifactStore } from "./objectStore";
import { extractBundle } from "./bundle";
import { getMaxBundleBytes } from "./settings";
import { createTtlCache } from "./ttlCache";

const MAX_BYTES = 256 * 1024; // never ship a megabyte of markdown to the browser

// The artifact for a given version is immutable, so the extracted SKILL.md never changes for a
// given object key. Cache it (keyed by that key) to avoid re-downloading + re-extracting a bundle
// on every detail-page view. Long TTL since the only thing that changes it is GC of dead versions.
const readmeCache = createTtlCache<SkillReadme | null>(Number(process.env.README_CACHE_TTL_MS ?? 600_000));

export interface SkillReadme {
  semver: string;
  content: string;
}

/**
 * Fetch the SKILL.md for a skill's given version (or its latest stable version). Returns null
 * if there is no published artifact yet (e.g. a pointer still pending mirror) or no SKILL.md.
 * Visibility MUST be checked by the caller before invoking this.
 */
export async function readSkillReadme(skillId: string, semver?: string): Promise<SkillReadme | null> {
  const { rows } = await pool.query<{ semver: string; artifact_object_key: string | null }>(
    `select semver, artifact_object_key from skill_versions
      where skill_id = $1 and status = 'active' and artifact_object_key is not null`,
    [skillId],
  );
  if (rows.length === 0) return null;

  const target = semver ?? resolveLatest(rows.map((r) => r.semver));
  const row = rows.find((r) => r.semver === target);
  if (!row?.artifact_object_key) return null;
  const key = row.artifact_object_key;
  const ver = row.semver;

  return readmeCache.get(key, async () => {
    let bytes: Buffer;
    try {
      bytes = await s3ArtifactStore().get(key);
    } catch {
      return null;
    }
    const entries = await extractBundle(bytes, undefined, bundleContentCap(await getMaxBundleBytes()));
    const md = entries.find((e) => /^skill\.md$/i.test(e.path)) ?? entries.find((e) => /(^|\/)skill\.md$/i.test(e.path));
    if (!md) return null;

    const text = Buffer.from(md.bytes).toString("utf8").slice(0, MAX_BYTES);
    return { semver: ver, content: text };
  });
}
