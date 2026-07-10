// Dev-only seed-bundle uploader. The SQL seed (db/seed.dev.sql) creates HOSTED skill versions
// that reference artifact keys (k-<slug>-<semver>) which have no bytes in object storage — so
// the git server can't serve them ("repository not provisioned"). This script generates a
// minimal valid SKILL.md bundle for each such version and uploads it to S3/MinIO. It does NOT
// touch the DB (skill_versions is immutable / append-only): once the bytes exist, the worker
// synthesizes the repo automatically — via publishPendingVersions (git_published=false) or the
// self-healing reprovisionMissingRepos (git_published=true but repo missing).
//
// Idempotent: versions whose artifact object already exists are skipped.
//
// Run it with the same DATABASE_URL / S3_* env as the worker, from the worker package so its
// deps (pg, @aws-sdk/client-s3, tar) resolve, e.g.:
//   cd packages/worker && DATABASE_URL=... S3_ENDPOINT=... S3_ACCESS_KEY=... S3_SECRET_KEY=... \
//     S3_BUCKET=skilly-artifacts node scripts/seed-bundles.mjs
import { Pool } from "pg";
import { S3Client, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { create } from "tar";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const bucket = process.env.S3_BUCKET ?? "skilly-artifacts";
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION ?? "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY ?? "", secretAccessKey: process.env.S3_SECRET_KEY ?? "" },
});

async function objectExists(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

const { rows } = await pool.query(
  `select sv.id, sv.semver, sv.artifact_object_key, s.slug, s.description, n.slug as ns
     from skill_versions sv
     join skills s on s.id = sv.skill_id
     join namespaces n on n.id = s.namespace_id
    where sv.status = 'active' and sv.external_ref is null and sv.artifact_object_key is not null`,
);

let made = 0;
for (const r of rows) {
  if (await objectExists(r.artifact_object_key)) continue;

  const tmp = await mkdtemp(join(tmpdir(), "seedbundle-"));
  try {
    // frontmatter name MUST equal the skill slug (shared validateBundle). One-line description.
    const desc = String(r.description ?? "Seed skill").replace(/\s+/g, " ").trim() || "Seed skill";
    const md = `---\nname: ${r.slug}\ndescription: ${desc}\n---\n\n# ${r.slug}\n\nLocal-dev seed bundle (placeholder content).\n`;
    await writeFile(join(tmp, "SKILL.md"), md, "utf8");
    const out = join(tmp, "bundle.tgz");
    await create({ gzip: true, file: out, cwd: tmp }, ["SKILL.md"]);
    const buf = await readFile(out);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: r.artifact_object_key, Body: buf, ContentType: "application/gzip" }));
    made++;
    console.log(`seeded bundle for ${r.ns}/${r.slug}@${r.semver} -> ${r.artifact_object_key}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

console.log(`done: ${made} bundle(s) uploaded, ${rows.length - made} already present`);
await pool.end();
