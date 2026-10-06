// Live-DB integration test for the §42 `skill.shared_new_version` fan-out on publish. Gated behind
// SKILLY_DB_E2E=1; requires a migrated Postgres at DATABASE_URL.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://... node --test dist/integration/sharedNewVersion.test.js
//
// A restricted skill owned by namespace A and shared with B publishes a version. B's admins hear
// `skill.shared_new_version` — except one who already got `skill.new_version` as a watcher (dedupe)
// and the publisher themself; A's admins get only their usual `skill.new_version`; an admin of a
// namespace the skill is NOT shared with hears nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import { publishPendingVersions } from "../git/publish.js";
import type { ArtifactStore } from "../storage/objectStore.js";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("§42: a shared skill's new version notifies the grantee namespace's admins, deduped", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const work = await mkdtemp(join(tmpdir(), "skilly-shared-"));
  const K = `snv${Date.now().toString(36)}`;
  try {
    const mem = new Map<string, Buffer>();
    const store: ArtifactStore = {
      async get(k) { const b = mem.get(k); if (!b) throw new Error("missing " + k); return b; },
      async put(k, b) { mem.set(k, b); },
    };
    const slug = `${K}-sk`;
    const src = join(work, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), `---\nname: ${slug}\ndescription: shared\n---\n# shared\n`);
    const tgz = join(work, "b.tgz");
    await create({ gzip: true, file: tgz, cwd: src }, ["."]);
    mem.set(`${K}-key`, await readFile(tgz));

    const mkNs = async (s: string) => (await pool.query<{ id: string }>(`insert into namespaces (slug, display_name, require_review) values ($1, $1, true) returning id`, [s])).rows[0]!.id;
    const A = await mkNs(`${K}-a`);
    const B = await mkNs(`${K}-b`);
    const C = await mkNs(`${K}-c`);
    const mkAdmin = async (key: string, ns: string) => {
      const u = (await pool.query<{ id: string }>(`insert into users (entra_object_id, email, display_name) values ($1, $2, $1) returning id`, [key, `${key}@org`])).rows[0]!.id;
      const g = (await pool.query<{ id: string }>(`insert into groups (entra_object_id, display_name) values ($1, $1) returning id`, [`${key}-g`])).rows[0]!.id;
      await pool.query(`insert into role_mappings (group_id, namespace_id, role) values ($1, $2, 'namespace_admin')`, [g, ns]);
      await pool.query(`insert into group_memberships (group_id, user_id) values ($1, $2)`, [g, u]);
      return u;
    };
    const aAdmin = await mkAdmin(`${K}-aadm`, A);
    const bAdmin = await mkAdmin(`${K}-badm`, B);
    const bWatcher = await mkAdmin(`${K}-bwat`, B);
    const bPublisher = await mkAdmin(`${K}-bpub`, B);
    const cAdmin = await mkAdmin(`${K}-cadm`, C);

    const skill = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
       values ($1, $2, 'Shared', 'shared skill', 'generic', 'hosted', 'namespace') returning id`,
      [A, slug],
    )).rows[0]!.id;
    await pool.query(`insert into skill_namespace_grants (skill_id, namespace_id) values ($1, $2)`, [skill, B]);
    await pool.query(`insert into skill_watches (skill_id, user_id) values ($1, $2)`, [skill, bWatcher]);
    await pool.query(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
       values ($1, '1.0.0', false, 'active', $2, 'x', $3, false)`,
      [skill, `${K}-key`, bPublisher],
    );

    await publishPendingVersions(pool, { store, repoRoot: join(work, "repos") });
    assert.ok((await pool.query(`select 1 from skill_versions where skill_id = $1 and git_published`, [skill])).rowCount, "version published");

    const rows = (await pool.query<{ user_id: string; type: string }>(
      `select user_id, type from notifications where payload->>'skillSlug' = $1 order by type, user_id`,
      [slug],
    )).rows;
    const typesFor = (u: string) => rows.filter((r) => r.user_id === u).map((r) => r.type).sort();
    assert.deepEqual(typesFor(bAdmin), ["skill.shared_new_version"], "grantee admin hears about the shared skill's version");
    assert.deepEqual(typesFor(bWatcher), ["skill.new_version"], "a watcher's new_version wins — no duplicate shared ping");
    assert.deepEqual(typesFor(bPublisher), [], "the publisher is not pinged about their own version");
    assert.deepEqual(typesFor(aAdmin), ["skill.new_version"], "owner admins keep their usual maintainer notification only");
    assert.deepEqual(typesFor(cAdmin), [], "a namespace the skill isn't shared with hears nothing");
  } finally {
    await pool.end();
    await rm(work, { recursive: true, force: true });
  }
});
