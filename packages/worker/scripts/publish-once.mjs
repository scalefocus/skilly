// One-shot publish sweep for CI/dev stacks that don't run the worker daemon.
//
// The SQL seed (db/seed.dev.sql) deliberately creates HOSTED versions with git_published=false,
// and seed-bundles.mjs only uploads the bytes — it is the WORKER that synthesizes the serving git
// repo/tags and flips the flag. A stack without the worker therefore leaves every hosted skill on
// the detail page's "Publishing this skill…" placeholder, so the Install panel never renders and
// every e2e spec that drives it fails. This runs exactly the same sweep the daemon runs, once, and
// exits — no leader lock, no SCIM listener, no intervals. SKILLY_SPEC.md §6/§9, roadmap item 18.
//
// Runs against the BUILT worker (pnpm -r build first), with the same DATABASE_URL / S3_* env as
// seed-bundles.mjs, e.g.:
//   cd packages/worker && DATABASE_URL=... S3_ENDPOINT=... S3_ACCESS_KEY=... S3_SECRET_KEY=... \
//     S3_BUCKET=skilly-artifacts node scripts/publish-once.mjs
import { Pool } from "pg";
import { publishPendingVersions } from "../dist/git/publish.js";
import { s3ArtifactStore } from "../dist/storage/objectStore.js";
import { defaultRepoRoot } from "../dist/git/repoStore.js";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const deps = { store: s3ArtifactStore(), repoRoot: defaultRepoRoot() };

const published = await publishPendingVersions(pool, deps);
console.log(`publish sweep: ${published} version(s) published into ${deps.repoRoot}`);

// Report what is still unpublished so a CI log shows the gap rather than a later, stranger failure.
const { rows } = await pool.query(
  `select n.slug as ns, s.slug, v.semver
     from skill_versions v
     join skills s     on s.id = v.skill_id
     join namespaces n on n.id = s.namespace_id
    where v.status = 'active' and not v.git_published
    order by 1, 2, 3`,
);
if (rows.length) {
  console.warn(`still unpublished (${rows.length}): ${rows.map((r) => `${r.ns}/${r.slug}@${r.semver}`).join(", ")}`);
}

await pool.end();
// Fail loudly: a stack that silently skipped provisioning produces a confusing suite-wide failure.
process.exit(rows.length ? 1 : 0);
