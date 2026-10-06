// Live-DB integration test for the quality sweep (SKILLY_SPEC.md §41.6, §41.9, §41.13).
// Gated behind SKILLY_DB_E2E=1; requires a migrated Postgres at DATABASE_URL.
//
// Validates: phase 1 backfills a report lacking the qa-scanned marker with a superseding report
// that keeps other findings, writes the row and the skill columns, skips yanked versions and
// archived skills, and is a no-op on rerun; with AI off a low score notifies maintainers (minus
// opt-outs) once, with every finding in the payload; phase 2 takes at most 3 rows per pass, only
// latest/recent versions, blends the verdict, counts a failed attempt, and settles the low-score
// notification only once the AI part is done; a refused call leaves rows pending.
import { test } from "node:test";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import { QUALITY_RULESET_VERSION, type ScanFinding } from "@skilly/shared";
import { encryptAiToken } from "@skilly/shared/ai";
import { sweepQualityRules, sweepQualityAi, resetQualitySweepFailures } from "../scan/quality.js";
import type { ArtifactStore } from "../storage/objectStore.js";

const enabled = process.env.SKILLY_DB_E2E === "1";
const KEY = Buffer.alloc(32, 7);

function zip(files: Record<string, string>): Buffer {
  const z = new AdmZip();
  for (const [p, c] of Object.entries(files)) z.addFile(p, Buffer.from(c));
  return z.toBuffer();
}

const GOOD = `---
name: good
description: Processes PDF legal documents for contract review. Use this when the user says "review this contract". Do not use for spreadsheets.
license: MIT
compatibility: Python 3
metadata:
  version: 1.0.0
  author: QA
---
# Good

## Instructions

1. Run \`python scripts/run.py\`
   Returns JSON.

## Examples

User says: "review this contract"

## Troubleshooting

If it fails, retry.
`;
const BAD = "---\nname: bad\ndescription: Helps.\n---\nmake sure to do things properly\n";

function verdictResponse(score: number) {
  const dim = { score, remark: "r" };
  const body = { clarity: dim, triggers: dim, domain: dim, workflow: dim, composability: dim, summary: "s", suggestions: ["fix it"] };
  return { content: [{ type: "text", text: JSON.stringify(body) }], model: "stub-model", usage: { input_tokens: 1, output_tokens: 1 } };
}

test("quality sweep: rules backfill, low-score notification, AI batch and blend", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  resetQualitySweepFailures();
  const tag = `qsweep${Date.now().toString(36)}`;
  const key = (k: string) => `${tag}/${k}`;
  const mem = new Map<string, Buffer>([
    [key("good"), zip({ "SKILL.md": GOOD, "scripts/run.py": "import json\n" })],
    [key("bad"), zip({ "SKILL.md": BAD, "README.md": "x" })],
    [key("yanked"), zip({ "SKILL.md": BAD })],
    [key("archived"), zip({ "SKILL.md": BAD })],
    [key("old"), zip({ "SKILL.md": GOOD, "scripts/run.py": "import json\n" })],
  ]);
  const store: ArtifactStore = {
    async get(k) { const b = mem.get(k); if (!b) throw new Error("missing " + k); return b; },
    async put(k, b) { mem.set(k, b); },
  };
  const skillIds: string[] = [];
  const userIds: string[] = [];
  let parked: { skill_version_id: string; ai_status: string }[] = [];
  const savedAi = (await pool.query(`select * from ai_integration where id = 1`)).rows[0] ?? null;
  try {
    await pool.query(`delete from ai_integration`); // AI off for phase 1
    const nsId = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ('qsweep-ns', 'qsweep-ns', true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
    )).rows[0]!.id;
    const mkUser = async (who: string, notify: boolean) => {
      const id = (await pool.query<{ id: string }>(
        `insert into users (entra_object_id, email, display_name, quality_notifications) values ($1, $2, $1, $3) returning id`,
        [`${tag}-${who}`, `${tag}-${who}@org`, notify],
      )).rows[0]!.id;
      userIds.push(id);
      return id;
    };
    const keen = await mkUser("keen", true);
    const quiet = await mkUser("quiet", false);
    const mkSkill = async (slug: string, status: "active" | "archived", versions: { semver: string; status: "active" | "yanked"; artifact: string; ageDays?: number }[]) => {
      const id = (await pool.query<{ id: string }>(
        `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
         values ($1, $2, $2, 'd', 'claude-code', 'hosted', 'org', $3) returning id`,
        [nsId, slug, status],
      )).rows[0]!.id;
      skillIds.push(id);
      for (const v of versions) {
        await pool.query(
          `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published, created_at)
           values ($1, $2, false, $3, $4, 'sha', $5, true, now() - ($6 || ' days')::interval)`,
          [id, v.semver, v.status, v.artifact, keen, String(v.ageDays ?? 0)],
        );
      }
      for (const u of [keen, quiet]) await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1, $2)`, [id, u]);
      return id;
    };
    const goodSkill = await mkSkill(`${tag}-good`, "active", [{ semver: "1.0.0", status: "active", artifact: key("good") }]);
    const badSkill = await mkSkill(`${tag}-bad`, "active", [{ semver: "1.0.0", status: "active", artifact: key("bad") }]);
    await mkSkill(`${tag}-yanked`, "active", [{ semver: "1.0.0", status: "yanked", artifact: key("yanked") }]);
    await mkSkill(`${tag}-archived`, "archived", [{ semver: "1.0.0", status: "active", artifact: key("archived") }]);
    // Two versions: an old non-latest one (never AI-judged) and the latest.
    const twoSkill = await mkSkill(`${tag}-two`, "active", [
      { semver: "1.0.0", status: "active", artifact: key("old"), ageDays: 30 },
      { semver: "2.0.0", status: "active", artifact: key("good") },
    ]);

    // The bad artifact's pre-§41 report: a secret finding that must survive the supersede.
    const secret: ScanFinding = { scanner: "secret-scan", severity: "medium", rule: "generic-secret", message: "m", path: "SKILL.md" };
    await pool.query(
      `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status) values ('artifact', $1, 'pipeline', $2::jsonb, 'medium', 'scanned')`,
      [key("bad"), JSON.stringify([secret])],
    );

    // ── Phase 1 ──
    let passes = 0;
    while ((await sweepQualityRules(pool, store, 500)) > 0 && passes < 20) passes++;

    const latestReport = async (k: string) => (await pool.query<{ findings: ScanFinding[]; severity: string; scanner: string }>(
      `select findings, severity, scanner from scan_reports where subject_type = 'artifact' and subject_id = $1 order by created_at desc limit 1`, [k],
    )).rows[0];
    const bad = await latestReport(key("bad"));
    assert.equal(bad?.scanner, "quality-rescan");
    assert.equal(bad?.severity, "medium", "quality findings never raise the severity");
    assert.ok(bad!.findings.some((x) => x.scanner === "secret-scan"), "non-quality findings carried forward");
    assert.ok(bad!.findings.some((x) => x.rule === "FS-003" && x.severity === "info" && x.level === "error"));
    assert.ok(bad!.findings.some((x) => x.rule === "qa-scanned" && x.ruleset === QUALITY_RULESET_VERSION));
    assert.equal((await pool.query(`select 1 from scan_reports where subject_id = $1`, [key("bad")])).rowCount, 2, "superseded, never mutated");
    assert.equal(await latestReport(key("yanked")), undefined, "yanked versions are skipped");
    assert.equal(await latestReport(key("archived")), undefined, "archived skills are skipped");

    const row = async (skillId: string, semver: string) => (await pool.query<{ rules_score: number; final_score: number; mode: string; ai_status: string; ai_score: number | null; low_notified_at: string | null }>(
      `select q.rules_score, q.final_score, q.mode, q.ai_status, q.ai_score, q.low_notified_at
         from skill_version_quality q join skill_versions sv on sv.id = q.skill_version_id where q.skill_id = $1 and sv.semver = $2`, [skillId, semver],
    )).rows[0];
    const skillCols = async (skillId: string) => (await pool.query<{ quality_score: number | null; quality_mode: string | null }>(`select quality_score, quality_mode from skills where id = $1`, [skillId])).rows[0]!;

    const g = await row(goodSkill, "1.0.0");
    assert.equal(g!.rules_score, 100);
    assert.equal(g!.ai_status, "off", "AI unavailable at scoring time");
    assert.equal(g!.mode, "rules");
    assert.deepEqual(await skillCols(goodSkill), { quality_score: 100, quality_mode: "rules" });
    const b = await row(badSkill, "1.0.0");
    assert.ok(b!.rules_score < 40, `bad scores ${b!.rules_score}`);
    assert.ok(b!.low_notified_at, "settled low with AI off → notified");
    assert.deepEqual(await skillCols(twoSkill), { quality_score: 100, quality_mode: "rules" }, "the skill columns follow the latest stable version");

    const notes = async () => (await pool.query<{ user_id: string; payload: { semver: string; score: number; findings: { rule: string }[] } }>(
      `select user_id, payload from notifications where type = 'skill.quality_low' and user_id = any($1::uuid[])`, [userIds],
    )).rows;
    const n1 = await notes();
    assert.deepEqual(n1.map((n) => n.user_id), [keen], "the opted-out maintainer gets no row at all");
    assert.ok(n1[0]!.payload.findings.some((f) => f.rule === "FS-003"), "every finding rides in the payload");
    assert.equal(n1[0]!.payload.score, b!.rules_score);

    // A rerun finds nothing to do and fires nothing new.
    assert.equal(await sweepQualityRules(pool, store, 500), 0);
    assert.equal((await notes()).length, 1, "once per assessment");

    // ── Phase 2: AI off → nothing; AI on → batch of 3, latest/recent only, blend, failure counted ──
    const env = { key: KEY, source: "worker" as const };
    assert.equal(await sweepQualityAi(pool, store, 3, { env }), 0, "AI not configured → no attempts");

    await pool.query(
      `insert into ai_integration (id, enabled, provider, base_url, model, token_enc, token_last4, last_test_at, last_test_ok)
       values (1, true, 'anthropic', 'https://api.anthropic.com', 'stub-model', $1, 'tok1', now(), true)`,
      [encryptAiToken("stubtok1", KEY)],
    );
    // AI became available: rows written while it was off are queued again.
    await pool.query(`update skill_version_quality set ai_status = 'pending' where ai_status = 'off' and skill_id = any($1::uuid[])`, [skillIds]);
    // A shared DB may hold other due rows (older fixtures): park them so this test's batch is deterministic.
    parked = (await pool.query<{ skill_version_id: string; ai_status: string }>(
      `select skill_version_id, ai_status from skill_version_quality where ai_status in ('pending', 'off') and not (skill_id = any($1::uuid[]))`,
      [skillIds],
    )).rows;
    await pool.query(`update skill_version_quality set ai_status = 'failed' where skill_version_id = any($1::uuid[])`, [parked.map((r) => r.skill_version_id)]);

    let badCalls = 0;
    const budgets: number[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const prompt = JSON.parse(String(init?.body ?? "{}")) as { messages: { content: string }[]; max_tokens?: number };
      budgets.push(prompt.max_tokens ?? -1);
      // The bad skill gets a failing answer on its first attempt (the call and its one retry);
      // everything else a verdict of 50.
      if (/name: bad/.test(prompt.messages[0]?.content ?? "") && badCalls++ < 2) return new Response("boom", { status: 500 });
      return new Response(JSON.stringify(verdictResponse(50)), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const aiEnv = { ...env, fetchImpl, sleep: async () => {} };

    const first = await sweepQualityAi(pool, store, 3, { env: aiEnv });
    assert.equal(first, 3, "at most 3 per pass");
    assert.ok(budgets.length > 0 && budgets.every((b) => b === 8192), "the scoring call asks for the 8192-token budget (§41.5)");
    const second = await sweepQualityAi(pool, store, 3, { env: aiEnv });
    assert.ok(second <= 3);
    // The old, non-latest version of the two-version skill is never judged.
    assert.equal((await row(twoSkill, "1.0.0"))!.ai_status, "pending", "non-latest, not recent → left alone");
    const two = await row(twoSkill, "2.0.0");
    assert.equal(two!.ai_status, "done");
    assert.equal(two!.ai_score, 50);
    assert.equal(two!.final_score, 80, "0.6 × 100 + 0.4 × 50");
    assert.equal(two!.mode, "rules+ai");
    assert.deepEqual(await skillCols(twoSkill), { quality_score: 80, quality_mode: "rules+ai" });
    const badAfter = await row(badSkill, "1.0.0");
    assert.equal(badAfter!.ai_status, "pending", "a failed attempt waits for its retry");
    const attempts = (await pool.query<{ ai_attempts: number; ai_next_attempt_at: string | null }>(
      `select ai_attempts, ai_next_attempt_at from skill_version_quality where skill_id = $1`, [badSkill],
    )).rows[0]!;
    assert.equal(attempts.ai_attempts, 1);
    assert.ok(attempts.ai_next_attempt_at, "retry scheduled");
    assert.equal((await pool.query(`select 1 from ai_usage where feature = 'skill_quality' and created_at > now() - interval '1 minute'`)).rowCount! >= 3, true);
    assert.equal((await notes()).length, 1, "the low notification was already settled rules-only; no second one");

    // Disable → refused before the network, rows stay pending, no attempt counted.
    await pool.query(`update ai_integration set enabled = false where id = 1`);
    await pool.query(`update skill_version_quality set ai_next_attempt_at = null where skill_id = $1`, [badSkill]);
    assert.equal(await sweepQualityAi(pool, store, 3, { env: aiEnv }), 0);
    assert.equal((await row(badSkill, "1.0.0"))!.ai_status, "pending");
  } finally {
    for (const r of parked) await pool.query(`update skill_version_quality set ai_status = $2 where skill_version_id = $1`, [r.skill_version_id, r.ai_status]);
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
    await pool.query(`delete from ai_integration`);
    if (savedAi) {
      const cols = Object.keys(savedAi);
      await pool.query(`insert into ai_integration (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((k) => savedAi[k]));
    }
    await pool.end();
  }
});
