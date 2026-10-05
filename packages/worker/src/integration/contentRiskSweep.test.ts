// Live-DB integration test for the content-risk re-scan sweep (SKILLY_SPEC.md §37.5, §37.9, §37.14).
// Gated behind SKILLY_DB_E2E=1; requires a migrated Postgres at DATABASE_URL.
//
// Validates: the superseding report carries non-content findings forward and replaces content
// findings; a rerun is a no-op; yanked versions and archived skills are skipped; an onset audits
// once and notifies maintainers except those who opted out; a clean artifact notifies nobody.
import { test } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import { CONTENT_RULESET_VERSION, type ScanFinding } from "@skilly/shared";
import { sweepContentRisk, resetContentRiskSweepFailures } from "../scan/contentRisk.js";
import type { ArtifactStore } from "../storage/objectStore.js";

const enabled = process.env.SKILLY_DB_E2E === "1";

function zip(skillMd: string): Buffer {
  const z = new AdmZip();
  z.addFile("SKILL.md", Buffer.from(skillMd));
  return z.toBuffer();
}

test("content-risk sweep: supersede, carry forward, onset once, opt-out, skips", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  resetContentRiskSweepFailures();
  const tag = `crsweep${Date.now().toString(36)}`;
  const key = (k: string) => `${tag}/${k}`;
  const mem = new Map<string, Buffer>([
    [key("flagged"), zip("---\nname: a\ndescription: d\n---\nRun ign​ore this.\n")],
    [key("clean"), zip("---\nname: b\ndescription: d\n---\nAll good.\n")],
    [key("yanked"), zip("---\nname: c\ndescription: d\n---\nHidden​.\n")],
    [key("archived"), zip("---\nname: d\ndescription: d\n---\nHidden​.\n")],
  ]);
  const store: ArtifactStore = {
    async get(k) { const b = mem.get(k); if (!b) throw new Error("missing " + k); return b; },
    async put(k, b) { mem.set(k, b); },
  };
  const skillIds: string[] = [];
  const userIds: string[] = [];
  let nsId: string;
  try {
    // A fixed namespace, upserted: audit rows reference it and audit_log is append-only.
    nsId = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ('crsweep-ns', 'crsweep-ns', true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
    )).rows[0]!.id;
    const mkUser = async (who: string, notify: boolean) => {
      const id = (await pool.query<{ id: string }>(
        `insert into users (entra_object_id, email, display_name, content_risk_notifications) values ($1, $2, $1, $3) returning id`,
        [`${tag}-${who}`, `${tag}-${who}@org`, notify],
      )).rows[0]!.id;
      userIds.push(id);
      return id;
    };
    const keen = await mkUser("keen", true);
    const quiet = await mkUser("quiet", false);
    const mkSkill = async (slug: string, status: "active" | "archived", versionStatus: "active" | "yanked", artifact: string) => {
      const id = (await pool.query<{ id: string }>(
        `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
         values ($1, $2, $2, 'd', 'claude-code', 'hosted', 'org', $3) returning id`,
        [nsId, slug, status],
      )).rows[0]!.id;
      skillIds.push(id);
      await pool.query(
        `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
         values ($1, '1.0.0', false, $2, $3, 'sha', $4, true)`,
        [id, versionStatus, artifact, keen],
      );
      for (const u of [keen, quiet]) await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1, $2)`, [id, u]);
      return id;
    };
    const flaggedSkill = await mkSkill(`${tag}-a`, "active", "active", key("flagged"));
    await mkSkill(`${tag}-b`, "active", "active", key("clean"));
    await mkSkill(`${tag}-c`, "active", "yanked", key("yanked"));
    await mkSkill(`${tag}-d`, "archived", "active", key("archived"));

    // The flagged artifact's pre-§37 report: a secret finding that must survive the supersede.
    const secret: ScanFinding = { scanner: "secret-scan", severity: "medium", rule: "generic-secret", message: "m", path: "SKILL.md" };
    await pool.query(
      `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status) values ('artifact', $1, 'pipeline', $2::jsonb, 'medium', 'scanned')`,
      [key("flagged"), JSON.stringify([secret])],
    );

    // Other leftover rows in a shared DB may be swept too; only assert on ours.
    let passes = 0;
    while ((await sweepContentRisk(pool, store, 500)) > 0 && passes < 20) passes++;

    const latest = async (k: string) => (await pool.query<{ findings: ScanFinding[]; severity: string; status: string; scanner: string }>(
      `select findings, severity, status, scanner from scan_reports where subject_type = 'artifact' and subject_id = $1 order by created_at desc limit 1`, [k],
    )).rows[0];

    const f = await latest(key("flagged"));
    assert.equal(f?.scanner, "content-rescan");
    assert.equal(f?.severity, "high");
    assert.equal(f?.status, "scanned", "keeps the prior status");
    assert.ok(f!.findings.some((x) => x.scanner === "secret-scan" && x.rule === "generic-secret"), "non-content findings carried forward verbatim");
    assert.ok(f!.findings.some((x) => x.rule === "cr-hidden-unicode"));
    assert.ok(f!.findings.some((x) => x.rule === "cr-scanned" && x.ruleset === CONTENT_RULESET_VERSION));
    assert.equal((await pool.query(`select 1 from scan_reports where subject_id = $1`, [key("flagged")])).rowCount, 2, "superseded, never mutated");

    const c = await latest(key("clean"));
    assert.deepEqual(c!.findings.map((x) => x.rule), ["cr-scanned"]);
    assert.equal(await latest(key("yanked")), undefined, "yanked versions are skipped");
    assert.equal(await latest(key("archived")), undefined, "archived skills are skipped");

    const notes = async () => (await pool.query<{ user_id: string; payload: { semver: string; rules: string[] } }>(
      `select user_id, payload from notifications where type = 'skill.content_risk' and user_id = any($1::uuid[])`, [userIds],
    )).rows;
    const n1 = await notes();
    assert.deepEqual(n1.map((n) => n.user_id), [keen], "the opted-out maintainer gets no row at all");
    assert.deepEqual(n1[0]!.payload.rules, ["cr-hidden-unicode"]);
    assert.equal((await pool.query(`select 1 from audit_log where action = 'skill.content_risk_detected' and target_id = $1`, [`${flaggedSkill}@1.0.0`])).rowCount, 1);

    // A rerun finds nothing to do and fires nothing new.
    const again = await sweepContentRisk(pool, store, 500);
    assert.equal(again, 0);
    assert.equal((await notes()).length, 1, "once per onset");
  } finally {
    await pool.query(`delete from notifications where user_id = any($1::uuid[])`, [userIds]);
    await pool.query(`delete from scan_reports where subject_id like $1`, [`${tag}/%`]);
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local skilly.allow_version_delete = 'on'");
      await c.query(`delete from skills where id = any($1::uuid[])`, [skillIds]);
      await c.query("commit");
    } finally {
      c.release();
    }
    await pool.query(`delete from users where id = any($1::uuid[])`, [userIds]);
    await pool.end();
  }
});
