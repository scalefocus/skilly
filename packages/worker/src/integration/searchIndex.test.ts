// Live-DB integration test for the worker's search-index upkeep (SKILLY_SPEC.md §34.9 / §34.10).
// Gated behind SKILLY_DB_E2E=1; needs a Postgres migrated through 0077 at DATABASE_URL.
//
// Validates: the extraction sweep backfills SKILL.md text from object storage (frontmatter
// stripped) and the skill becomes findable by it over MCP; a missing artifact retries with back-off
// and parks as `failed` after the attempt cap; a version with no stored bundle is `absent`; the
// publish-path fill is write-once; and a search-language switch rebuilds every vector and every
// synonym group's normalized forms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import type { EffectiveAccess } from "@skilly/shared";
import { sweepSearchIndex, reindexSearchLanguage, fillSearchText, SEARCH_EXTRACT_MAX_ATTEMPTS } from "../searchIndex.js";
import { searchSkills } from "../mcp/queries.js";
import type { ArtifactStore } from "../storage/objectStore.js";

const enabled = process.env.SKILLY_DB_E2E === "1";
const NS = "fts-worker";
const admin: EffectiveAccess = { isPlatformAdmin: true, namespaceRoles: new Map() };

test("search index: sweep backfill, retries, absent bundles, write-once fill, language rebuild", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const work = await mkdtemp(join(tmpdir(), "skilly-fts-"));
  const wipe = async () => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local skilly.allow_version_delete = 'on'");
      await c.query(`delete from skills where namespace_id in (select id from namespaces where slug = $1)`, [NS]);
      await c.query("commit");
    } catch (e) {
      await c.query("rollback");
      throw e;
    } finally {
      c.release();
    }
    await pool.query(`delete from search_synonym_groups where 'häuser' = any(terms)`);
    await pool.query(`delete from platform_settings where key = 'search_language'`);
  };
  try {
    await wipe();
    const mem = new Map<string, Buffer>();
    const store: ArtifactStore = {
      async get(k) { const b = mem.get(k); if (!b) throw new Error("missing " + k); return b; },
      async put(k, b) { mem.set(k, b); },
    };
    const src = join(work, "src");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "SKILL.md"), "---\nname: fts-sweep\ndescription: x\n---\n# Sweep\n\nkumquatword body text\n");
    await create({ gzip: true, file: join(work, "b.tgz"), cwd: src }, ["."]);
    mem.set("fts-k1", await readFile(join(work, "b.tgz")));

    const ns = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ($1, 'FTS worker', false)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
      [NS],
    )).rows[0]!.id;
    const skill = async (slug: string) => (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
       values ($1, $2, $2, 'fixture', 'generic', 'hosted', 'org', 'active') returning id`,
      [ns, slug],
    )).rows[0]!.id;
    const version = async (skillId: string, key: string | null) => (await pool.query<{ id: string }>(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key)
       values ($1, '1.0.0', false, 'active', $2) returning id`,
      [skillId, key],
    )).rows[0]!.id;
    const ok = await version(await skill("fts-sweep"), "fts-k1");
    const broken = await version(await skill("fts-broken"), "fts-missing");
    const bare = await version(await skill("fts-bare"), null);
    const row = async (id: string) => (await pool.query<{ status: string; attempts: number; body_text: string | null; last_error: string | null }>(
      `select status, attempts, body_text, last_error from skill_version_search where skill_version_id = $1`,
      [id],
    )).rows[0]!;

    // The migration's trigger gave every new version a pending row.
    assert.equal((await row(ok)).status, "pending");

    await sweepSearchIndex(pool, store, 500);
    const done = await row(ok);
    assert.equal(done.status, "indexed");
    assert.equal(done.body_text, "# Sweep\n\nkumquatword body text\n", "frontmatter stripped, Markdown kept");
    assert.equal((await row(bare)).status, "absent");
    const first = await row(broken);
    assert.equal(first.status, "pending");
    assert.equal(first.attempts, 1);
    assert.match(first.last_error ?? "", /missing fts-missing/);

    // The body reaches search: the skill is now found by a word only its SKILL.md contains.
    const found = await searchSkills(pool, admin, { q: "kumquatword" });
    assert.ok(found.skills.some((s) => s.skillSlug === "fts-sweep"));
    assert.deepEqual(found.skills.find((s) => s.skillSlug === "fts-sweep")!.matchedIn, ["instructions"]);

    // Back-off: a just-failed row is not retried at once …
    await sweepSearchIndex(pool, store, 500);
    assert.equal((await row(broken)).attempts, 1);
    // … and the last allowed attempt parks it as failed.
    await pool.query(
      `update skill_version_search set attempts = $2, updated_at = now() - interval '1 day' where skill_version_id = $1`,
      [broken, SEARCH_EXTRACT_MAX_ATTEMPTS - 1],
    );
    await sweepSearchIndex(pool, store, 500);
    assert.equal((await row(broken)).status, "failed");

    // The publish-path fill is write-once: a second fill never replaces the text.
    await fillSearchText(pool, ok, [{ path: "SKILL.md", bytes: new TextEncoder().encode("# other") }]);
    assert.equal((await row(ok)).body_text, "# Sweep\n\nkumquatword body text\n");

    // A language switch rebuilds every vector and re-normalizes the synonym groups.
    await pool.query(`insert into search_synonym_groups (terms) values (array['häuser', 'gebäude'])`);
    await pool.query(`insert into platform_settings (key, value, updated_at) values ('search_language', '"german"'::jsonb, now())`);
    const rebuilt = await reindexSearchLanguage(pool, 2, 60_000);
    assert.ok(rebuilt >= 3, "every skill built with english is rebuilt, in batches");
    const { rows: stale } = await pool.query(`select 1 from skills where search_lang is distinct from 'german'`);
    assert.equal(stale.length, 0);
    const { rows: syn } = await pool.query<{ normalized: string[]; normalized_lang: string }>(
      `select normalized, normalized_lang from search_synonym_groups where 'häuser' = any(terms)`,
    );
    assert.deepEqual(syn[0], { normalized: ["haus", "gebaud"], normalized_lang: "german" });
    assert.equal(await reindexSearchLanguage(pool, 2, 60_000), 0, "idle once drained");
  } finally {
    await wipe();
    await reindexSearchLanguage(pool).catch(() => {});
    await rm(work, { recursive: true, force: true });
    await pool.end();
  }
});
