// Live-DB integration tests for skill quality on the web side (SKILLY_SPEC.md §41.13). Gated by
// SKILLY_DB_E2E=1. Validates: the publish-time write (row + skill columns, AI off → settled and
// notified once), `refreshSkillQuality` following `latest` across a yank, the detail payload, the
// catalog sort / minQuality facet / default-ranking tiebreak under the visibility predicate (a
// restricted skill never shifts an outsider's order or appears in their facet), re-assess
// (403 for a non-admin, superseding report, audit), the catalog-wide rescore audit, and the
// proposal-side rules-only computation.
import { test, after } from "node:test";
import { withAiIntegrationLock } from "./aiTestLock";
import assert from "node:assert/strict";
import AdmZip from "adm-zip";
import { QUALITY_RULESET_VERSION, qualityScanner, scoreQuality, type EffectiveAccess, type ScanFinding } from "@skilly/shared";
import { writeQualityForVersion, refreshSkillQualityColumns, skillQualityDetail, skillVersionQualities, reassessQuality, requestCatalogRescore, proposalQuality } from "./quality";
import { searchCatalog, findSkill } from "./catalog";
import { pool } from "./db";
import type { ArtifactStore } from "./objectStore";

const enabled = process.env.SKILLY_DB_E2E === "1";
after(async () => { if (enabled) await pool.end(); });

const GOOD = `---
name: SLUG
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
const BAD = "---\nname: SLUG\ndescription: Helps.\n---\nmake sure to do things properly\n";

function bundle(slug: string, md: string, extra: Record<string, string> = {}): { files: { path: string; bytes: Uint8Array }[]; zip: Buffer } {
  const text = md.replace(/SLUG/g, slug);
  const z = new AdmZip();
  z.addFile("SKILL.md", Buffer.from(text));
  for (const [p, c] of Object.entries(extra)) z.addFile(p, Buffer.from(c));
  const files = [{ path: "SKILL.md", bytes: new TextEncoder().encode(text) }, ...Object.entries(extra).map(([p, c]) => ({ path: p, bytes: new TextEncoder().encode(c) }))];
  return { files, zip: z.toBuffer() };
}

async function deleteSkillRows(ids: string[]): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local skilly.allow_version_delete = 'on'");
    await c.query(`delete from skills where id = any($1::uuid[])`, [ids]);
    await c.query("commit");
  } finally {
    c.release();
  }
}

test("quality: publish write, latest tracking, detail, catalog sort/facet, re-assess, rescore", { skip: !enabled }, () => withAiIntegrationLock(async () => {
  const tag = `qweb${Date.now().toString(36)}`;
  const skillIds: string[] = [];
  const userIds: string[] = [];
  const savedAi = (await pool.query(`select * from ai_integration where id = 1`)).rows[0] ?? null;
  await pool.query(`delete from ai_integration`); // AI off throughout
  const mem = new Map<string, Buffer>();
  const store: ArtifactStore = {
    get: async (k) => { const b = mem.get(k); if (!b) throw new Error("missing " + k); return b; },
    put: async (k, b) => { mem.set(k, b); },
    delete: async () => {},
    list: async () => [],
  };
  try {
    const nsId = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ($1, $1, true) on conflict (slug) do update set display_name = excluded.display_name returning id`,
      [`${tag}-ns`],
    )).rows[0]!.id;
    const restrictedNsId = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ($1, $1, true) on conflict (slug) do update set display_name = excluded.display_name returning id`,
      [`${tag}-rns`],
    )).rows[0]!.id;
    // A fixed, upserted actor: audit rows reference it and audit_log is append-only, so it is never deleted.
    const maintainer = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name, quality_notifications) values ('qweb-dbtest-actor', 'qweb-dbtest-actor@org', 'QWeb actor', true)
       on conflict (entra_object_id) do update set quality_notifications = true returning id`,
    )).rows[0]!.id;
    await pool.query(`delete from notifications where user_id = $1 and type = 'skill.quality_low'`, [maintainer]);
    const admin: EffectiveAccess = { isPlatformAdmin: true, namespaceRoles: new Map(), userId: maintainer } as EffectiveAccess;
    const outsider: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map(), userId: maintainer } as EffectiveAccess;

    const mkSkill = async (slug: string, ns: string, visibility: "org" | "namespace", versions: { semver: string; md: string; extra?: Record<string, string>; installs?: number }[]) => {
      const id = (await pool.query<{ id: string }>(
        `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status, install_count)
         values ($1, $2, $2, 'd', 'claude-code', 'hosted', $3, 'active', $4) returning id`,
        [ns, slug, visibility, versions[0]?.installs ?? 0],
      )).rows[0]!.id;
      skillIds.push(id);
      await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1, $2)`, [id, maintainer]);
      const out: { versionId: string; artifactKey: string; findings: ScanFinding[] }[] = [];
      for (const v of versions) {
        const b = bundle(slug, v.md, v.extra);
        const artifactKey = `${tag}/${slug}-${v.semver}.skill`;
        mem.set(artifactKey, b.zip);
        const findings = qualityScanner.scan(b.files) as ScanFinding[];
        await pool.query(
          `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status) values ('artifact', $1, 'pipeline', $2::jsonb, 'info', 'scanned')`,
          [artifactKey, JSON.stringify(findings)],
        );
        const versionId = (await pool.query<{ id: string }>(
          `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
           values ($1, $2, false, 'active', $3, 'sha', $4, true) returning id`,
          [id, v.semver, artifactKey, maintainer],
        )).rows[0]!.id;
        await writeQualityForVersion(pool, { versionId, skillId: id, artifactKey });
        out.push({ versionId, artifactKey, findings });
      }
      return { id, versions: out };
    };

    // ── publish-time write ──
    const good = await mkSkill(`${tag}-good`, nsId, "org", [{ semver: "1.0.0", md: GOOD, extra: { "scripts/run.py": "import json\n" }, installs: 1 }]);
    const bad = await mkSkill(`${tag}-bad`, nsId, "org", [{ semver: "1.0.0", md: BAD, extra: { "README.md": "x" }, installs: 100 }]);
    // mid: a README (error, −20) and no Examples section (warn, −6) → 74 → 4 stars.
    const mid = await mkSkill(`${tag}-mid`, nsId, "org", [{ semver: "1.0.0", md: GOOD.replace("## Examples\n\nUser says: \"review this contract\"\n", ""), extra: { "scripts/run.py": "import json\n", "README.md": "x" }, installs: 100 }]);
    const restricted = await mkSkill(`${tag}-secret`, restrictedNsId, "namespace", [{ semver: "1.0.0", md: GOOD, extra: { "scripts/run.py": "import json\n" }, installs: 1000 }]);

    const cols = async (id: string) => (await pool.query<{ quality_score: number | null; quality_mode: string | null }>(`select quality_score, quality_mode from skills where id = $1`, [id])).rows[0]!;
    assert.deepEqual(await cols(good.id), { quality_score: 100, quality_mode: "rules" });
    const badScore = scoreQuality(bad.versions[0]!.findings);
    assert.ok(badScore < 40, `bad scores ${badScore}`);
    assert.deepEqual(await cols(bad.id), { quality_score: badScore, quality_mode: "rules" });
    const midScore = scoreQuality(mid.versions[0]!.findings);
    assert.ok(midScore > 40 && midScore < 100, `mid scores ${midScore}`);

    // AI off → settled at write time → one notification for the low skill, none for the others.
    const notes = async () => (await pool.query<{ payload: { skillSlug: string; findings: unknown[] } }>(
      `select payload from notifications where type = 'skill.quality_low' and user_id = $1`, [maintainer],
    )).rows;
    const n = await notes();
    assert.deepEqual(n.map((x) => x.payload.skillSlug), [`${tag}-bad`]);
    assert.ok(n[0]!.payload.findings.length > 0);

    // ── detail + per-version summaries ──
    const detail = await skillQualityDetail(admin, { id: bad.id, namespaceId: nsId }, "1.0.0");
    assert.equal(detail?.finalScore, badScore);
    assert.equal(detail?.mode, "rules");
    assert.equal(detail?.aiStatus, "off");
    assert.equal(detail?.canReassess, true);
    assert.ok(detail!.findings.some((f) => f.rule === "FS-003" && f.level === "error"));
    assert.equal(detail?.verdict, null);
    assert.equal((await skillQualityDetail(outsider, { id: bad.id, namespaceId: nsId }, "1.0.0"))?.canReassess, false);
    assert.equal((await skillVersionQualities(good.id)).get("1.0.0")?.stars, 5);

    // ── latest tracking: a second, worse version becomes latest; yanking it restores the first ──
    const b2 = bundle(`${tag}-good`, BAD);
    const k2 = `${tag}/good-2.0.0.skill`;
    mem.set(k2, b2.zip);
    const f2 = qualityScanner.scan(b2.files) as ScanFinding[];
    await pool.query(`insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status) values ('artifact', $1, 'pipeline', $2::jsonb, 'info', 'scanned')`, [k2, JSON.stringify(f2)]);
    const v2 = (await pool.query<{ id: string }>(
      `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
       values ($1, '2.0.0', false, 'active', $2, 'sha', $3, true) returning id`,
      [good.id, k2, maintainer],
    )).rows[0]!.id;
    await writeQualityForVersion(pool, { versionId: v2, skillId: good.id, artifactKey: k2 });
    assert.equal((await cols(good.id)).quality_score, scoreQuality(f2), "latest moved to 2.0.0");
    await pool.query(`update skill_versions set status = 'yanked' where id = $1`, [v2]);
    await refreshSkillQualityColumns(good.id);
    assert.equal((await cols(good.id)).quality_score, 100, "yank → latest is 1.0.0 again");
    await pool.query(`update skill_versions set status = 'active' where id = $1`, [v2]);
    await refreshSkillQualityColumns(good.id);
    assert.equal((await cols(good.id)).quality_score, scoreQuality(f2));
    await pool.query(`update skill_versions set status = 'yanked' where id = $1`, [v2]);
    await refreshSkillQualityColumns(good.id);

    // ── catalog: sort, facet, tiebreak, visibility ──
    const mine = (r: { skills: { skillSlug: string }[] }) => r.skills.map((s) => s.skillSlug).filter((s) => s.startsWith(tag));
    const byQuality = await searchCatalog(admin, { sort: "quality", namespaceSlug: `${tag}-ns`, limit: 100 });
    assert.deepEqual(mine(byQuality), [`${tag}-good`, `${tag}-mid`, `${tag}-bad`]);
    assert.equal(byQuality.skills.find((s) => s.skillSlug === `${tag}-good`)?.quality?.stars, 5);
    const min4 = await searchCatalog(admin, { minQuality: 4, namespaceSlug: `${tag}-ns`, limit: 100 });
    assert.ok(mine(min4).includes(`${tag}-good`) && !mine(min4).includes(`${tag}-bad`));
    const min45 = await searchCatalog(admin, { minQuality: 4.5, namespaceSlug: `${tag}-ns`, limit: 100 });
    assert.deepEqual(mine(min45), [`${tag}-good`]);
    // Default ranking: bad and mid tie on installs (100) and have no ratings → quality breaks the tie.
    const def = await searchCatalog(admin, { namespaceSlug: `${tag}-ns`, limit: 100 });
    const order = mine(def);
    assert.ok(order.indexOf(`${tag}-mid`) < order.indexOf(`${tag}-bad`), `quality tiebreak: ${order.join(",")}`);
    // Invariant #3: the restricted skill never appears for an outsider — not in the sort, not in the facet.
    const outsiderSorted = await searchCatalog(outsider, { sort: "quality", limit: 100 });
    assert.ok(!outsiderSorted.skills.some((s) => s.skillSlug === `${tag}-secret`));
    const outsiderMin = await searchCatalog(outsider, { minQuality: 3, limit: 100 });
    assert.ok(!outsiderMin.skills.some((s) => s.skillSlug === `${tag}-secret`));
    assert.ok((await searchCatalog(admin, { minQuality: 3, limit: 100 })).skills.some((s) => s.skillSlug === `${tag}-secret`));
    const row = await findSkill(`${tag}-ns`, `${tag}-good`);
    assert.equal(row?.qualityScore, 100);

    // ── re-assess: 403 for a non-admin; superseding report + fresh row + audit for an admin ──
    const denied = await reassessQuality(outsider, maintainer, { id: bad.id, namespaceId: nsId, slug: `${tag}-bad` }, "1.0.0", { store });
    assert.equal(denied.ok, false);
    assert.equal((denied as { status: number }).status, 403);
    const since = new Date();
    const ok = await reassessQuality(admin, maintainer, { id: bad.id, namespaceId: nsId, slug: `${tag}-bad` }, "1.0.0", { store });
    assert.equal(ok.ok, true);
    assert.equal((ok as { detail: { finalScore: number } }).detail.finalScore, badScore);
    assert.equal((await pool.query(`select 1 from scan_reports where subject_id = $1`, [bad.versions[0]!.artifactKey])).rowCount, 2, "superseding report");
    assert.equal((await pool.query(`select 1 from audit_log where action = 'skill.quality_reassess_requested' and target_id = $1 and created_at >= $2`, [`${bad.id}@1.0.0`, since])).rowCount, 1);
    assert.equal((await notes()).length, 2, "a re-assessment that settles low notifies again");

    // ── catalog-wide rescore ──
    const queued = await requestCatalogRescore(maintainer);
    assert.ok(queued >= 4);
    assert.equal((await pool.query(`select 1 from audit_log where action = 'job.quality_rescore_requested' and created_at >= $1`, [since])).rowCount, 1);

    // ── proposal-side rules-only computation ──
    const pq = proposalQuality(bad.versions[0]!.findings);
    assert.equal(pq?.rulesScore, badScore);
    assert.equal(proposalQuality([{ scanner: "secret-scan", severity: "info", rule: "x", message: "" }]), null, "no quality marker → null");
    assert.equal(QUALITY_RULESET_VERSION, detail?.ruleset);
  } finally {
    await pool.query(`delete from notifications where user_id = any($1::uuid[]) or (type = 'skill.quality_low' and payload->>'skillSlug' like $2)`, [userIds, `${tag}-%`]);
    await pool.query(`delete from scan_reports where subject_id like $1`, [`${tag}/%`]);
    await deleteSkillRows(skillIds);
    await pool.query(`delete from users where id = any($1::uuid[])`, [userIds]);
    if (savedAi) {
      const cols = Object.keys(savedAi);
      await pool.query(`insert into ai_integration (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) on conflict (id) do nothing`, cols.map((k) => savedAi[k]));
    }
  }
}));
