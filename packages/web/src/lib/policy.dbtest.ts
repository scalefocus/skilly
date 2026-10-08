// Live-DB integration tests for policy rules (SKILLY_SPEC.md §47.14): rule CRUD + authority +
// revisions + audit; the accept gate over the §46 run's per-rule results (no verdict / violation /
// override with and without a reason / platform authority / dismissal written); critical §46
// findings alone still need no override; direct-publish routing; dismissal; the shadow filter; the
// rule-change reconcile; the migration's checks. Gated by SKILLY_DB_E2E=1. These paths commit, so
// every test cleans up the rows it created.
//
// Platform rules apply to EVERY namespace, and node --test runs files in parallel — so platform
// rules are only ever created inside a transaction that rolls back (never visible to other files).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  createPolicyRule,
  createPrereviewRun,
  linkPrereviewRun,
  loadPolicyRule,
  policyReconcile,
  proposalPolicyPayload,
  recordPrereviewSuccess,
  type EffectiveAccess,
  type PolicyOutcome,
  type PolicySubject,
  type PrereviewSeverity,
} from "@skilly/shared";
import { createProposal, directPublish, evaluateProposalPolicyGate, performProposalAction, type RevisionPayload } from "./proposals";
import { changeRuleState, createRule, deleteRule, dismissPolicyFlag, listRulesForViewer, skillPolicyDetail, skillPolicySummary, updateRule } from "./policy";
import type { ArtifactStore } from "./objectStore";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";
after(async () => { if (enabled) await pool.end(); });

const store: ArtifactStore = {
  get: async () => { throw new Error("unexpected get"); },
  put: async () => { throw new Error("unexpected put"); },
  delete: async () => {},
  list: async () => [],
};

async function deleteSkillRows(skillId: string): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local skilly.allow_version_delete = 'on'");
    await c.query(`delete from skills where id = $1`, [skillId]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

interface World {
  ns: string; nsSlug: string; otherNs: string;
  member: string; admin: string; otherAdmin: string;
  memberAccess: EffectiveAccess; adminAccess: EffectiveAccess; otherAdminAccess: EffectiveAccess; platformAccess: EffectiveAccess;
  runs: string[];
  cleanup: () => Promise<void>;
}

async function world(key: string): Promise<World> {
  const nsSlug = `${key}-ns`;
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ($1, $1, false)
     on conflict (slug) do update set require_review = false returning id`, [nsSlug],
  )).rows[0]!.id;
  const otherNs = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ($1, $1, true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`, [`${key}-other`],
  )).rows[0]!.id;
  // Fixed actors (upserted, never deleted): they author append-only audit rows.
  const mk = async (who: string) => (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ($1, $2, $1)
     on conflict (entra_object_id) do update set email = excluded.email returning id`, [`${key}-${who}`, `${key}-${who}@org`],
  )).rows[0]!.id;
  const member = await mk("member");
  const admin = await mk("admin");
  const otherAdmin = await mk("otheradmin");
  const skillIds = async () => (await pool.query<{ id: string }>(`select id from skills where namespace_id = $1`, [ns])).rows.map((r) => r.id);
  const runs: string[] = [];
  return {
    ns, nsSlug, otherNs, member, admin, otherAdmin, runs,
    memberAccess: { isPlatformAdmin: false, namespaceRoles: new Map([[ns, "namespace_member"]]) },
    adminAccess: { isPlatformAdmin: false, namespaceRoles: new Map([[ns, "namespace_admin"]]) },
    otherAdminAccess: { isPlatformAdmin: false, namespaceRoles: new Map([[otherNs, "namespace_admin"]]) },
    platformAccess: { isPlatformAdmin: true, namespaceRoles: new Map() },
    cleanup: async () => {
      await pool.query(`delete from notifications where user_id = any($1::uuid[])`, [[member, admin, otherAdmin]]);
      await pool.query(`delete from proposals where target_namespace_id = $1`, [ns]);
      await pool.query(`delete from pending_mirrors where skill_id in (select id from skills where namespace_id = $1)`, [ns]).catch(() => {});
      for (const id of await skillIds()) await deleteSkillRows(id);
      await pool.query(`delete from ai_prereviews where id = any($1::uuid[])`, [runs]);
      await pool.query(`delete from scan_reports where subject_id like $1`, [`uploads/${key}/%`]);
      await pool.query(`delete from policy_rules where namespace_id = $1`, [ns]);
    },
  };
}

function hostedPayload(key: string, slug: string, artifact = slug): RevisionPayload {
  return {
    metadata: { skillSlug: slug, title: slug, description: "d", toolHarness: "claude-code", visibility: "org", categories: [], usageExamples: null },
    artifactObjectKey: `uploads/${key}/${artifact}.bundle`,
    artifactSha256: `sha-${artifact}`,
  };
}

async function cleanReport(key: string): Promise<void> {
  await pool.query(
    `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status) values ('artifact', $1, 'test', '[]'::jsonb, 'info', 'scanned')`,
    [key],
  );
}

/**
 * Stand in for the worker: a done §46 run for the subject with these per-rule outcomes (rules at
 * their current revision) and, optionally, a §46 finding of the given severity.
 */
async function judge(w: World, subject: PolicySubject, outcomes: Record<string, PolicyOutcome>, opts: { aiSeverity?: PrereviewSeverity } = {}): Promise<string> {
  const runId = await createPrereviewRun(pool, { source: { kind: "artifact", objectKey: `uploads/x/${Date.now()}` }, contentSha256: null, trigger: "submit" });
  w.runs.push(runId);
  await linkPrereviewRun(pool, runId, subject, false);
  const results = [];
  for (const [ruleId, outcome] of Object.entries(outcomes)) {
    const rule = (await loadPolicyRule(pool, ruleId))!;
    results.push({
      ruleId,
      revisionId: rule.revisionId,
      ruleState: (rule.state === "enforced" ? "enforced" : "shadow") as "enforced" | "shadow",
      outcome,
      explanation: `judged ${outcome}`,
      evidence: outcome === "violates" ? [{ path: "scripts/run.sh", line: 3, excerpt: "curl https://api.example.com" }] : [],
      evidenceRejected: false,
    });
  }
  const findings = opts.aiSeverity
    ? [{ fingerprint: "f1", category: "unsafe_shell" as const, severity: opts.aiSeverity, path: "scripts/run.sh", line: 3, excerpt: "curl x | sh", rationale: "r", suggestion: "s" }]
    : [];
  await recordPrereviewSuccess(pool, runId, {
    result: { summary: "", findings, discarded: 0 },
    coverage: [],
    model: "stub-model",
    contentSha256: "digest",
    maxSeverity: opts.aiSeverity ?? null,
    policy: { fingerprint: null, results },
  });
  return runId;
}

async function nsRule(w: World, title: string, state: "shadow" | "enforced" = "enforced"): Promise<string> {
  const r = await createRule(w.adminAccess, w.admin, { scope: "namespace", namespaceSlug: w.nsSlug, title, body: `${title} — the rule body.`, context: "Approved adapters: acme-http.", state });
  assert.ok(r.ok, JSON.stringify(r));
  return (r as { id: string }).id;
}

test("rules: authority, default Shadow, revisions, title uniqueness, state changes, delete vs cited — all audited (§47.3)", { skip: !enabled }, async () => {
  const w = await world("polcrud");
  try {
    const denied = await createRule(w.memberAccess, w.member, { scope: "namespace", namespaceSlug: w.nsSlug, title: "x", body: "y" });
    assert.deepEqual([denied.ok, (denied as { status: number }).status], [false, 403]);
    assert.equal((await createRule(w.otherAdminAccess, w.otherAdmin, { scope: "namespace", namespaceSlug: w.nsSlug, title: "x", body: "y" }) as { status: number }).status, 403);
    assert.equal((await createRule(w.adminAccess, w.admin, { scope: "platform", title: "x", body: "y" }) as { status: number }).status, 403, "a namespace admin can't write platform rules");

    const created = await createRule(w.adminAccess, w.admin, { scope: "namespace", namespaceSlug: w.nsSlug, title: "No external APIs", body: "No direct calls." });
    assert.ok(created.ok);
    const id = (created as { id: string }).id;
    const rule = (await loadPolicyRule(pool, id))!;
    assert.equal(rule.state, "shadow", "new rules start in Shadow");
    assert.equal(rule.revisionNo, 1);
    assert.equal((await pool.query(`select 1 from audit_log where action = 'policy.rule_created' and target_id = $1`, [id])).rowCount, 1);

    assert.equal((await createRule(w.adminAccess, w.admin, { scope: "namespace", namespaceSlug: w.nsSlug, title: "  no EXTERNAL apis ", body: "b" }) as { code?: string }).code, "title_taken");

    assert.deepEqual(await updateRule(w.adminAccess, w.admin, id, { body: "No direct calls." }), { ok: true, revisionNo: 1, changed: false });
    assert.deepEqual(await updateRule(w.adminAccess, w.admin, id, { body: "No direct calls — use acme-http." }), { ok: true, revisionNo: 2, changed: true });
    const audit = (await pool.query<{ before: { body: string }; after: { revisionNo: number } }>(
      `select before, after from audit_log where action = 'policy.rule_updated' and target_id = $1`, [id],
    )).rows[0]!;
    assert.equal(audit.before.body, "No direct calls.");
    assert.equal(audit.after.revisionNo, 2);
    assert.equal((await updateRule(w.memberAccess, w.member, id, { body: "z" }) as { status: number }).status, 403);

    assert.ok((await changeRuleState(w.adminAccess, w.admin, id, "enforced")).ok);
    assert.equal((await loadPolicyRule(pool, id))!.state, "enforced");
    assert.equal((await pool.query(`select 1 from audit_log where action = 'policy.rule_state_changed' and target_id = $1`, [id])).rowCount, 1);
    assert.equal((await changeRuleState(w.adminAccess, w.admin, id, "bogus") as { status: number }).status, 422);

    // Readers: a member sees enforced rules only; the admin's `all` view adds shadow/disabled + state.
    const shadowId = await nsRule(w, "English only", "shadow");
    const asMember = (await listRulesForViewer(w.memberAccess, w.nsSlug, true)) as { listing: { namespace: { title: string }[] } };
    assert.deepEqual(asMember.listing.namespace.map((r) => r.title), ["No external APIs"]);
    const asAdmin = (await listRulesForViewer(w.adminAccess, w.nsSlug, true)) as { listing: { namespace: { title: string; state: string; cited: boolean }[] } };
    assert.deepEqual(asAdmin.listing.namespace.map((r) => [r.title, r.state]).sort(), [["English only", "shadow"], ["No external APIs", "enforced"]]);

    // Delete: an uncited rule goes; a cited one is 409 `cited`.
    assert.ok((await deleteRule(w.adminAccess, w.admin, shadowId)).ok);
    const { id: proposalId } = await createProposal(pool, { submittedByUserId: w.member, targetNamespaceId: w.ns, proposedSemver: "1.0.0", payload: hostedPayload("polcrud", "cited") });
    await judge(w, { kind: "proposal", proposalId, revision: 1 }, { [id]: "complies" });
    const cited = await deleteRule(w.adminAccess, w.admin, id);
    assert.deepEqual([cited.ok, (cited as { code?: string }).code], [false, "cited"]);
  } finally {
    await w.cleanup();
  }
});

test("accept gate: no verdict trips; a violation trips; the override needs a reason, audits and records the exception (§47.7)", { skip: !enabled }, async () => {
  const w = await world("polgate");
  try {
    const ruleId = await nsRule(w, "No external APIs");
    const payload = hostedPayload("polgate", "gated");
    await cleanReport(payload.artifactObjectKey!);
    const { id: proposalId } = await createProposal(pool, { submittedByUserId: w.member, targetNamespaceId: w.ns, proposedSemver: "1.0.0", payload });
    assert.equal((await performProposalAction(pool, { proposalId, action: "start_review", actorUserId: w.admin, access: w.adminAccess }, store)).ok, true);

    const noVerdict = await performProposalAction(pool, { proposalId, action: "accept", actorUserId: w.admin, access: w.adminAccess, expectedRevisionNo: 1 }, store);
    assert.equal((noVerdict as { status: number }).status, 409);
    const trips = (noVerdict as { policy: { tripped: { reason: string; canOverride: boolean }[] } }).policy.tripped;
    assert.equal(trips.length, 1);
    assert.ok(["off", "unavailable", "pending", "skipped"].includes(trips[0]!.reason), trips[0]!.reason);
    assert.equal(trips[0]!.canOverride, true);

    await judge(w, { kind: "proposal", proposalId, revision: 1 }, { [ruleId]: "violates" });
    const detail = await proposalPolicyPayload(pool, { id: proposalId, namespaceId: w.ns }, { includeShadow: false, aiOn: true });
    assert.equal(detail.status, "done");
    assert.deepEqual(detail.results.map((r) => [r.title, r.outcome, r.evidence[0]?.path]), [["No external APIs", "violates", "scripts/run.sh"]]);

    const blocked = await performProposalAction(pool, { proposalId, action: "accept", actorUserId: w.admin, access: w.adminAccess, expectedRevisionNo: 1 }, store);
    assert.equal((blocked as { status: number }).status, 409);
    assert.equal((blocked as { policy: { tripped: { reason: string }[] } }).policy.tripped[0]!.reason, "violates");
    const noReason = await performProposalAction(pool, { proposalId, action: "accept", actorUserId: w.admin, access: w.adminAccess, expectedRevisionNo: 1, override: true, overrideReason: "  " }, store);
    assert.equal((noReason as { status: number }).status, 422, "a policy override needs a reason");

    const ok = await performProposalAction(pool, { proposalId, action: "accept", actorUserId: w.admin, access: w.adminAccess, expectedRevisionNo: 1, override: true, overrideReason: "approved exception" }, store);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const audit = (await pool.query<{ after: { reason: string; rules: { title: string; reason: string }[] } }>(
      `select after from audit_log where action = 'proposal.policy_override' and target_id = $1`, [proposalId],
    )).rows[0]!;
    assert.equal(audit.after.reason, "approved exception");
    assert.deepEqual(audit.after.rules.map((r) => [r.title, r.reason]), [["No external APIs", "violates"]]);

    const skill = (await pool.query<{ id: string }>(`select id from skills where namespace_id = $1 and slug = 'gated'`, [w.ns])).rows[0]!;
    const dism = (await pool.query<{ kind: string; source: string; reason: string }>(
      `select kind, source, reason from policy_flag_dismissals where skill_id = $1 and semver = '1.0.0'`, [skill.id],
    )).rows;
    assert.deepEqual(dism, [{ kind: "accepted_exception", source: "override", reason: "approved exception" }]);
    // The worker links the accepted revision's run to the version (§46.3); with the exception the
    // version reads "noted".
    const versionId = (await pool.query<{ id: string }>(`select id from skill_versions where skill_id = $1 and semver = '1.0.0'`, [skill.id])).rows[0]!.id;
    const run = (await pool.query<{ run_id: string }>(`select run_id from ai_prereview_links where proposal_id = $1 order by id desc limit 1`, [proposalId])).rows[0]!.run_id;
    await linkPrereviewRun(pool, run, { kind: "version", versionId }, true);
    assert.deepEqual(await skillPolicySummary({ id: skill.id, namespaceId: w.ns }), { semver: "1.0.0", status: "noted", violatedTitles: ["No external APIs"] });
  } finally {
    await w.cleanup();
  }
});

test("§46 findings stay advisory: a critical AI finding with no enforced violation needs no override (§47.13)", { skip: !enabled }, async () => {
  const w = await world("poladv");
  try {
    const ruleId = await nsRule(w, "No external APIs");
    const payload = hostedPayload("poladv", "advisory");
    await cleanReport(payload.artifactObjectKey!);
    const { id: proposalId } = await createProposal(pool, { submittedByUserId: w.member, targetNamespaceId: w.ns, proposedSemver: "1.0.0", payload });
    await performProposalAction(pool, { proposalId, action: "start_review", actorUserId: w.admin, access: w.adminAccess }, store);
    await judge(w, { kind: "proposal", proposalId, revision: 1 }, { [ruleId]: "complies" }, { aiSeverity: "critical" });
    const ok = await performProposalAction(pool, { proposalId, action: "accept", actorUserId: w.admin, access: w.adminAccess, expectedRevisionNo: 1 }, store);
    assert.equal(ok.ok, true, JSON.stringify(ok));
  } finally {
    await w.cleanup();
  }
});

test("a rule moved to Shadow stops gating; shadow results are hidden from the proposer (§47.4, §47.7)", { skip: !enabled }, async () => {
  const w = await world("polshadow");
  try {
    const ruleId = await nsRule(w, "No external APIs");
    const { id: proposalId } = await createProposal(pool, { submittedByUserId: w.member, targetNamespaceId: w.ns, proposedSemver: "1.0.0", payload: hostedPayload("polshadow", "shadowed") });
    await judge(w, { kind: "proposal", proposalId, revision: 1 }, { [ruleId]: "violates" });
    assert.ok((await changeRuleState(w.adminAccess, w.admin, ruleId, "shadow")).ok);
    const proposer = await proposalPolicyPayload(pool, { id: proposalId, namespaceId: w.ns }, { includeShadow: false, aiOn: true });
    assert.equal(proposer.status, "none", "the proposer sees no shadow rule");
    const reviewer = await proposalPolicyPayload(pool, { id: proposalId, namespaceId: w.ns }, { includeShadow: true, aiOn: true });
    assert.deepEqual(reviewer.results.map((r) => [r.state, r.outcome]), [["shadow", "violates"]]);
    assert.deepEqual(reviewer.trips, []);
    assert.deepEqual((await evaluateProposalPolicyGate(pool, { id: proposalId, namespaceId: w.ns }, w.adminAccess)).trips, []);
  } finally {
    await w.cleanup();
  }
});

test("platform rules: only a platform admin can override one (rolled-back transaction, §47.1 #11)", { skip: !enabled }, async () => {
  const w = await world("polplat");
  const c = await pool.connect();
  try {
    const { id: proposalId } = await createProposal(pool, { submittedByUserId: w.member, targetNamespaceId: w.ns, proposedSemver: "1.0.0", payload: hostedPayload("polplat", "plat") });
    await c.query("begin");
    await createPolicyRule(c, { namespaceId: null, state: "enforced", title: "polplat org rule", body: "b", context: null, authorId: w.admin });
    const asNsAdmin = await evaluateProposalPolicyGate(c, { id: proposalId, namespaceId: w.ns }, w.adminAccess);
    const platformTrip = asNsAdmin.trips.find((t) => t.title === "polplat org rule")!;
    assert.equal(platformTrip.scope, "platform");
    assert.equal(platformTrip.canOverride, false);
    const asPlatform = await evaluateProposalPolicyGate(c, { id: proposalId, namespaceId: w.ns }, w.platformAccess);
    assert.equal(asPlatform.trips.find((t) => t.title === "polplat org rule")!.canOverride, true);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
    await w.cleanup();
  }
});

test("direct publish: a member is routed (reason policy) only by an ENFORCED rule; a namespace admin goes straight through (§47.7)", { skip: !enabled }, async () => {
  const w = await world("polpub");
  try {
    const ruleId = await nsRule(w, "No external APIs", "shadow");
    const p0 = hostedPayload("polpub", "shadow-pub");
    await cleanReport(p0.artifactObjectKey!);
    const r0 = await directPublish(pool, { access: w.memberAccess, actorUserId: w.member, namespaceSlug: w.nsSlug, semver: "1.0.0", payload: p0 });
    assert.ok(r0.ok && !("routed" in r0), "a shadow rule never routes");

    assert.ok((await changeRuleState(w.adminAccess, w.admin, ruleId, "enforced")).ok);
    const p1 = hostedPayload("polpub", "member-pub");
    await cleanReport(p1.artifactObjectKey!);
    const r1 = await directPublish(pool, { access: w.memberAccess, actorUserId: w.member, namespaceSlug: w.nsSlug, semver: "1.0.0", payload: p1 });
    assert.ok(r1.ok && "routed" in r1);
    assert.equal((r1 as { routedReason: string }).routedReason, "policy");
    const proposalId = (r1 as { proposalId: string }).proposalId;
    assert.equal((await pool.query<{ routed_reason: string }>(`select routed_reason from proposals where id = $1`, [proposalId])).rows[0]!.routed_reason, "policy");
    const audit = (await pool.query<{ after: { reason: string; rules: string[] } }>(`select after from audit_log where action = 'proposal.routed_to_review' and target_id = $1`, [proposalId])).rows[0]!;
    assert.deepEqual([audit.after.reason, audit.after.rules], ["policy", ["No external APIs"]]);

    const p2 = hostedPayload("polpub", "admin-pub");
    await cleanReport(p2.artifactObjectKey!);
    const r2 = await directPublish(pool, { access: w.adminAccess, actorUserId: w.admin, namespaceSlug: w.nsSlug, semver: "1.0.0", payload: p2 });
    assert.ok(r2.ok && !("routed" in r2), "a namespace admin publishes straight through");
    const skillId = (r2 as { skillId: string }).skillId;
    assert.deepEqual(await skillPolicySummary({ id: skillId, namespaceId: w.ns }), { semver: "1.0.0", status: "pending", violatedTitles: [] }, "judged after the fact");
  } finally {
    await w.cleanup();
  }
});

test("dismissal: authority, flagged → noted, 409 once dismissed; the owner card shows it (§47.8)", { skip: !enabled }, async () => {
  const w = await world("poldismiss");
  try {
    const ruleId = await nsRule(w, "No external APIs");
    const payload = hostedPayload("poldismiss", "dis");
    await cleanReport(payload.artifactObjectKey!);
    const pub = await directPublish(pool, { access: w.adminAccess, actorUserId: w.admin, namespaceSlug: w.nsSlug, semver: "1.0.0", payload });
    const skill = { id: (pub as { skillId: string }).skillId, namespaceId: w.ns, slug: "dis" };
    const versionId = (await pool.query<{ id: string }>(`select id from skill_versions where skill_id = $1`, [skill.id])).rows[0]!.id;
    await judge(w, { kind: "version", versionId }, { [ruleId]: "violates" });
    assert.equal((await skillPolicySummary(skill))?.status, "flagged");

    const body = { semver: "1.0.0", ruleId, kind: "false_positive", reason: "the adapter wraps it" };
    assert.equal((await dismissPolicyFlag(w.memberAccess, w.member, skill, body) as { status: number }).status, 403);
    assert.equal((await dismissPolicyFlag(w.adminAccess, w.admin, skill, { ...body, reason: " " }) as { status: number }).status, 422);
    assert.ok((await dismissPolicyFlag(w.adminAccess, w.admin, skill, body)).ok);
    assert.equal((await skillPolicySummary(skill))?.status, "noted");
    assert.equal((await dismissPolicyFlag(w.adminAccess, w.admin, skill, body) as { status: number }).status, 409);
    assert.equal((await pool.query(`select 1 from audit_log where action = 'skill.policy_flag_dismissed' and target_id = $1`, [`${skill.id}@1.0.0`])).rowCount, 1);
    const card = (await skillPolicyDetail(w.adminAccess, skill, null))!;
    assert.equal(card.status, "noted");
    assert.equal(card.results[0]!.dismissal?.kind, "false_positive");
    assert.equal(card.results[0]!.canDismiss, false);
  } finally {
    await w.cleanup();
  }
});

test("reconcile: a rule edit re-checks the open proposal and the latest version; a Shadow rule spares the proposal (§47.6)", { skip: !enabled }, async () => {
  const w = await world("polrecon");
  try {
    const ruleId = await nsRule(w, "No external APIs");
    const { id: proposalId } = await createProposal(pool, { submittedByUserId: w.member, targetNamespaceId: w.ns, proposedSemver: "1.0.0", payload: hostedPayload("polrecon", "rp") });
    await judge(w, { kind: "proposal", proposalId, revision: 1 }, { [ruleId]: "complies" });
    const payload = hostedPayload("polrecon", "rv");
    await cleanReport(payload.artifactObjectKey!);
    const pub = await directPublish(pool, { access: w.adminAccess, actorUserId: w.admin, namespaceSlug: w.nsSlug, semver: "1.0.0", payload });
    const versionId = (await pool.query<{ id: string }>(`select id from skill_versions where skill_id = $1`, [(pub as { skillId: string }).skillId])).rows[0]!.id;
    await judge(w, { kind: "version", versionId }, { [ruleId]: "complies" });

    const calls: string[] = [];
    const record = async (s: PolicySubject) => { calls.push(s.kind === "proposal" ? `p:${s.proposalId}` : `v:${s.versionId}`); };
    // Covered at the current wording: nothing to do (other namespaces' subjects may appear — filter).
    const mine = () => calls.filter((c) => c === `p:${proposalId}` || c === `v:${versionId}`);
    await policyReconcile(pool, record);
    assert.deepEqual(mine(), []);

    // A new SHADOW rule: the version is re-checked (the preview), the proposal is not.
    await nsRule(w, "English only", "shadow");
    calls.length = 0;
    await policyReconcile(pool, record);
    assert.deepEqual(mine(), [`v:${versionId}`]);

    // Editing the enforced rule: both are stale.
    assert.ok((await updateRule(w.adminAccess, w.admin, ruleId, { body: "Stricter wording." })).ok);
    calls.length = 0;
    await policyReconcile(pool, record);
    assert.deepEqual(mine().sort(), [`p:${proposalId}`, `v:${versionId}`].sort());
    const gate = await evaluateProposalPolicyGate(pool, { id: proposalId, namespaceId: w.ns }, w.adminAccess);
    assert.equal(gate.trips[0]!.reason, "stale");
  } finally {
    await w.cleanup();
  }
});

test("migration 0091: routed_reason accepts policy, the run trigger accepts policy, the scope shape check holds", { skip: !enabled }, async () => {
  await assert.rejects(pool.query(`insert into policy_rules (scope, namespace_id) values ('namespace', null)`), /policy_rules_scope_shape/);
  const c = await pool.connect();
  try {
    await c.query("begin");
    const ns = (await c.query<{ id: string }>(`insert into namespaces (slug, display_name) values ('polmig-ns', 'x') returning id`)).rows[0]!.id;
    await assert.rejects(c.query(`insert into policy_rules (scope, namespace_id) values ('platform', $1)`, [ns]), /policy_rules_scope_shape/);
  } finally {
    await c.query("rollback");
    c.release();
  }
  const def = async (name: string) => (await pool.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1`, [name])).rows[0]!.def;
  assert.match(await def("proposals_routed_reason_check"), /policy/);
  assert.match(await def("ai_prereviews_trigger_check"), /policy/);
});
