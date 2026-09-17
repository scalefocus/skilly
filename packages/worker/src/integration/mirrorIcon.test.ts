// Live-DB integration test for bundle-borne icon extraction during Pointer mirroring (§33.2/§33.6).
// Gated by SKILLY_DB_E2E=1. A root-level icon.png in the upstream repo is detected, normalized,
// stored, and written onto the skill row — overriding whatever accept-time sync (the proposer's
// upload/emoji fallback) already set, per the "bundle beats upload" precedence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { synthesizeVersion } from "../git/synth.js";
import { mirrorPointerVersion } from "../git/mirror.js";
import type { ArtifactStore } from "../storage/objectStore.js";

const enc = (s: string) => new TextEncoder().encode(s);
const enabled = process.env.SKILLY_DB_E2E === "1";
process.env.SKILLY_MIRROR_ALLOW_INSECURE = "1";

test("mirrorPointerVersion: a root icon.png overrides the accept-time fallback icon", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const work = await mkdtemp(join(tmpdir(), "skilly-icon-e2e-"));
  try {
    const mem = new Map<string, Buffer>();
    const store: ArtifactStore = {
      async get(k) { const b = mem.get(k); if (!b) throw new Error("missing " + k); return b; },
      async put(k, b) { mem.set(k, b); },
    };

    const png = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 4, g: 5, b: 6 } } }).png().toBuffer();
    const externalRepo = join(work, "external.git");
    await synthesizeVersion({
      bareRepoPath: externalRepo,
      semver: "1.0.0",
      isLatestStable: true,
      files: [
        { path: "SKILL.md", bytes: enc("---\nname: iconed\ndescription: has an icon\n---\n# iconed\n") },
        { path: "icon.png", bytes: png },
      ],
    });

    const ns = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ('icon-mirror-ns','Icon Mirror', false)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
    )).rows[0]!.id;
    const user = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ('icon-mirror-oid','icon-mirror@org','E2E')
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
    )).rows[0]!.id;
    const skill = (await pool.query<{ id: string }>(
      // Idempotent across re-runs: a stale row from a prior aborted run resets to the same
      // known starting state (icon_emoji/icon_source), not just title.
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, icon_emoji, icon_source)
       values ($1,'iconed','Iconed','has an icon','claude-code','pointer','org','🚀','upload')
       on conflict (namespace_id, slug) do update set title = excluded.title, icon_sha256 = null, icon_emoji = '🚀', icon_source = 'upload'
       returning id`,
      [ns],
    )).rows[0]!.id;
    // Sanity: the accept-time fallback (proposer's emoji) is in place before mirroring.
    assert.equal((await pool.query(`select icon_emoji from skills where id = $1`, [skill])).rows[0].icon_emoji, "🚀");

    await mirrorPointerVersion(pool, store, {
      skillId: skill, skillSlug: "iconed", semver: "1.0.0",
      externalUrl: externalRepo, ref: "v1.0.0", createdBy: user, isPrerelease: false,
    });

    const row = (await pool.query<{ icon_sha256: string | null; icon_emoji: string | null; icon_source: string | null }>(
      `select icon_sha256, icon_emoji, icon_source from skills where id = $1`,
      [skill],
    )).rows[0]!;
    assert.ok(row.icon_sha256, "the bundle's icon.png overrode the fallback");
    assert.equal(row.icon_emoji, null, "the emoji fallback is cleared once a bundle image wins");
    assert.equal(row.icon_source, "bundle");

    const stored = await pool.query(`select octet_length(bytes) as n from skill_icons where sha256 = $1`, [row.icon_sha256]);
    assert.ok(Number(stored.rows[0].n) > 0);
  } finally {
    // §7/invariant #2: skill_versions are immutable — deleting the skill row (which cascades to
    // its versions) needs the same 0022 delete carve-out the shared dbtest cleanup helpers use.
    // A single checked-out client (not pool.query per statement) so BEGIN/SET LOCAL/DELETE/COMMIT
    // share one session.
    const cleanup = await pool.connect();
    try {
      await cleanup.query("begin");
      await cleanup.query("set local skilly.allow_version_delete = 'on'");
      await cleanup.query(`delete from skills where slug = 'iconed'`);
      await cleanup.query(`delete from namespaces where slug = 'icon-mirror-ns'`);
      await cleanup.query("commit");
    } catch {
      await cleanup.query("rollback").catch(() => {});
    } finally {
      cleanup.release();
    }
    await pool.end();
    await rm(work, { recursive: true, force: true });
  }
});
