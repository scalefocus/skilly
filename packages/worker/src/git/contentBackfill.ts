// One-off backfill of skill_versions.content_sha256 (SKILLY_SPEC.md §8). Pre-existing versions
// (created before the column landed) have a null digest, so duplicate detection can't match them.
// This drains them in small batches: fetch each stored artifact from S3, extract its files, and
// compute the same packaging-independent content digest the upload/mirror paths now compute.
// Idempotent and self-limiting — once every version has a digest it does nothing. Artifacts that
// can't be read/extracted are skipped (logged) and retried on the next pass; for a maintenance
// backfill the cost of re-attempting a handful of bad rows is negligible.
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { extract } from "tar";
import AdmZip from "adm-zip";
import { detectArchive, isJunkEntry, contentDigest, type BundleEntry } from "@skilly/shared";
import type { Pool } from "pg";
import type { ArtifactStore } from "../storage/objectStore.js";

const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 5000;

async function walk(dir: string, base: string, out: BundleEntry[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) await walk(abs, base, out);
    else if (entry.isFile()) {
      const rel = relative(base, abs).split(sep).join("/");
      if (!isJunkEntry(rel)) out.push({ path: rel, bytes: await readFile(abs) });
    }
  }
}

async function extractTarGz(targz: Buffer): Promise<BundleEntry[]> {
  const dir = await mkdtemp(join(tmpdir(), "skilly-backfill-"));
  try {
    const archive = join(dir, "bundle.tgz");
    await writeFile(archive, targz);
    const dest = join(dir, "out");
    await mkdir(dest, { recursive: true });
    let total = 0;
    let count = 0;
    let exceeded = false;
    await extract({
      file: archive,
      cwd: dest,
      strip: 0,
      filter: (_p, entry) => {
        const e = entry as unknown as { type?: string; size?: number };
        if (e.type && e.type !== "File" && e.type !== "Directory") return false;
        if (e.type === "Directory") return true;
        count += 1;
        total += e.size ?? 0;
        if (count > MAX_ENTRIES || total > MAX_TOTAL_BYTES) { exceeded = true; return false; }
        return true;
      },
    });
    if (exceeded) throw new Error("bundle exceeds size/entry limits");
    const files: BundleEntry[] = [];
    await walk(dest, dest, files);
    return files;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function extractZip(buf: Buffer): BundleEntry[] {
  const zip = new AdmZip(buf);
  const out: BundleEntry[] = [];
  let total = 0;
  let count = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    count += 1;
    if (count > MAX_ENTRIES) throw new Error("bundle exceeds size/entry limits");
    const data = e.getData();
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error("bundle exceeds size/entry limits");
    const path = e.entryName.split("\\").join("/");
    if (!isJunkEntry(path)) out.push({ path, bytes: data });
  }
  return out;
}

async function extractAny(buf: Buffer): Promise<BundleEntry[]> {
  const kind = detectArchive(buf);
  if (kind === "gzip") return extractTarGz(buf);
  if (kind === "zip") return extractZip(buf);
  throw new Error("unsupported archive");
}

/** Backfill up to `limit` versions per call. Returns how many were updated. */
export async function backfillContentDigests(pool: Pool, store: ArtifactStore, limit = 200): Promise<number> {
  const { rows } = await pool.query<{ id: string; artifact_object_key: string }>(
    `select id, artifact_object_key from skill_versions
      where content_sha256 is null and artifact_object_key is not null
      order by created_at asc limit $1`,
    [limit],
  );
  let updated = 0;
  for (const r of rows) {
    try {
      const buf = await store.get(r.artifact_object_key);
      const digest = contentDigest(await extractAny(buf));
      await pool.query(`update skill_versions set content_sha256 = $2 where id = $1`, [r.id, digest]);
      updated += 1;
    } catch (err) {
      console.error(JSON.stringify({ level: "warn", msg: "content backfill skipped a version", versionId: r.id, err: String(err) }));
    }
  }
  return updated;
}
