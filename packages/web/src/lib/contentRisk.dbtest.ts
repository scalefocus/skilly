// Live-DB integration tests for the content-risk gate, acknowledgement and status (SKILLY_SPEC.md
// §37.4, §37.6, §37.7, §37.14). Gated by SKILLY_DB_E2E=1. These paths commit (directPublish and
// createProposal own their transactions), so every test cleans up the rows it created.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { CONTENT_RULESET_VERSION, maxSeverity, type EffectiveAccess, type ScanFinding } from "@skilly/shared";
import { createProposal, directPublish, performProposalAction, type RevisionPayload } from "./proposals";
import { acknowledgeContentRisk, skillContentRiskDetail, skillContentRiskSummary } from "./contentRisk";
import type { ArtifactStore } from "./objectStore";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";
after(async () => { if (enabled) await pool.end(); });

const marker: ScanFinding = { scanner: "content-risk", severity: "info", rule: "cr-scanned", message: "", ruleset: CONTENT_RULESET_VERSION };
const hidden: ScanFinding = { scanner: "content-risk", severity: "high", rule: "cr-hidden-unicode", message: "hidden character", path: "SKILL.md", line: 3, excerpt: "Run ⟨U+200B⟩this", ruleset: CONTENT_RULESET_VERSION };
const secret: ScanFinding = { scanner: "secret-scan", severity: "critical", rule: "aws-access-key", message: "aws", path: "x" };

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
  memberAccess: EffectiveAccess; adminAccess: EffectiveAccess; otherAdminAccess: EffectiveAccess;
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
  const mk = async (who: string) => (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ($1, $2, $1)
     on conflict (entra_object_id) do update set email = excluded.email returning id`, [`${key}-${who}`, `${key}-${who}@org`],
  )).rows[0]!.id;
  const member = await mk("member");
  const admin = await mk("admin");
  const otherAdmin = await mk("otheradmin");
  const skillIds = async () => (await pool.query<{ id: string }>(`select id from skills where namespace_id = $1`, [ns])).rows.map((r) => r.id);
  return {
    ns, nsSlug, otherNs, member, admin, otherAdmin,
    memberAccess: { isPlatformAdmin: false, namespaceRoles: new Map([[ns, "namespace_member"]]) },
    adminAccess: { isPlatformAdmin: false, namespaceRoles: new Map([[ns, "namespace_admin"]]) },
    otherAdminAccess: { isPlatformAdmin: false, namespaceRoles: new Map([[otherNs, "namespace_admin"]]) },
    cleanup: async () => {
      await pool.query(`delete from notifications where user_id = any($1::uuid[])`, [[member, admin, otherAdmin]]);
      await pool.query(`delete from proposals where target_namespace_id = $1`, [ns]);
      for (const id of await skillIds()) await deleteSkillRows(id);
      await pool.query(`delete from scan_reports where subject_id like $1`, [`uploads/${key}/%`]);
      await pool.query(`delete from skill_requests where requester_user_id = $1`, [member]);
    },
  };
}

function hostedPayload(key: string, slug: string): RevisionPayload {
  return {
    metadata: { skillSlug: slug, title: slug, description: "d", toolHarness: "claude-code", visibility: "org", categories: [], usageExamples: null },
    artifactObjectKey: `uploads/${key}/${slug}.bundle`,
    artifactSha256: `sha-${slug}`,
  };
}

async function report(subjectType: "artifact" | "proposal", subjectId: string, findings: ScanFinding[]): Promise<void> {
  await pool.query(
    `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status)
     values ($1, $2, 'test', $3::jsonb, $4, 'scanned')`,
    // Like every real writer: the stored severity is the findings' maximum.
    [subjectType, subjectId, JSON.stringify(findings), maxSeverity(findings) ?? "info"],
  );
}

test("direct publish: a member's flagged hosted publish is routed to review, request link carried (§37.4)", { skip: !enabled }, async () => {
  const w = await world("crroute");
  try {
    const payload = hostedPayload("crroute", "cr-routed");
    await report("artifact", payload.artifactObjectKey!, [marker, hidden]);
    const request = (await pool.query<{ id: string }>(
      `insert into skill_requests (requester_user_id, title, description, tool_harness) values ($1,'t','d','generic') returning id`, [w.member],
    )).rows[0]!.id;

    const r = await directPublish(pool, { access: w.memberAccess, actorUserId: w.member, namespaceSlug: w.nsSlug, semver: "1.0.0", payload, originRequestId: request });
    assert.ok(r.ok && "routed" in r, "routed to review");
    const proposalId = (r as { proposalId: string }).proposalId;

    const p = (await pool.query<{ state: string; routed_reason: string; origin_request_id: string }>(
      `select state, routed_reason, origin_request_id from proposals where id = $1`, [proposalId],
    )).rows[0]!;
    assert.deepEqual(p, { state: "proposed", routed_reason: "content_risk", origin_request_id: request });
    assert.equal((await pool.query(`select 1 from skills where namespace_id = $1`, [w.ns])).rowCount, 0, "nothing published");
    const audit = (await pool.query<{ after: { rules: string[] } }>(
      `select after from audit_log where action = 'proposal.routed_to_review' and target_id = $1`, [proposalId],
    )).rows[0];
    assert.deepEqual(audit?.after.rules, ["cr-hidden-unicode"]);
  } finally {
    await w.cleanup();
  }
});

test("direct publish: other scanners' high findings don't route; an unreachable pointer does (§37.4)", { skip: !enabled }, async () => {
  const w = await world("crother");
  try {
    const payload = hostedPayload("crother", "cr-secret-only");
    await report("artifact", payload.artifactObjectKey!, [marker, secret]);
    const r = await directPublish(pool, { access: w.memberAccess, actorUserId: w.member, namespaceSlug: w.nsSlug, semver: "1.0.0", payload });
    assert.ok(r.ok && !("routed" in r), "published as before §37");

    const pointer: RevisionPayload = { ...hostedPayload("crother", "cr-pointer"), artifactObjectKey: undefined, artifactSha256: undefined, pointer: { url: "https://example.com/x.git", ref: "v1" } };
    const r2 = await directPublish(pool, {
      access: w.memberAccess, actorUserId: w.member, namespaceSlug: w.nsSlug, semver: "1.0.0", payload: pointer,
      contentCheck: { findings: [], reportId: null, unreachable: true },
    });
    assert.ok(r2.ok && "routed" in r2, "unreachable routes to review");
  } finally {
    await w.cleanup();
  }
});

test("direct publish: an override holder gets 409, then publishes with an audited override that acknowledges (§37.4, §37.6)", { skip: !enabled }, async () => {
  const w = await world("croverride");
  try {
    const payload = hostedPayload("croverride", "cr-admin");
    await report("artifact", payload.artifactObjectKey!, [marker, hidden]);

    const first = await directPublish(pool, { access: w.adminAccess, actorUserId: w.admin, namespaceSlug: w.nsSlug, semver: "1.0.0", payload });
    assert.equal(first.ok, false);
    assert.equal((first as { status: number }).status, 409);
    assert.equal((first as { requiresOverride?: boolean }).requiresOverride, true);
    assert.deepEqual((first as { findings: ScanFinding[] }).findings.map((f) => f.rule), ["cr-scanned", "cr-hidden-unicode"]);

    const ok = await directPublish(pool, { access: w.adminAccess, actorUserId: w.admin, namespaceSlug: w.nsSlug, semver: "1.0.0", payload, override: true, overrideReason: "teaches defence" });
    assert.ok(ok.ok && "skillId" in ok);
    const skillId = (ok as { skillId: string }).skillId;

    const ack = (await pool.query<{ source: string; note: string; pairs: unknown }>(
      `select source, note, pairs from content_risk_acknowledgements where skill_id = $1 and semver = '1.0.0'`, [skillId],
    )).rows;
    assert.deepEqual(ack, [{ source: "override", note: "teaches defence", pairs: [{ rule: "cr-hidden-unicode", path: "SKILL.md" }] }]);
    assert.equal((await pool.query(`select 1 from audit_log where action = 'skill.publish_scan_override' and target_id = $1`, [skillId])).rowCount, 1);
    assert.deepEqual(await skillContentRiskSummary(skillId), { semver: "1.0.0", status: "noted", ruleset: CONTENT_RULESET_VERSION });
  } finally {
    await w.cleanup();
  }
});

test("acknowledgement: authority, flagged → noted, 409 when not flagged; consumers never get findings (§37.6, §37.11)", { skip: !enabled }, async () => {
  const w = await world("crack");
  try {
    const payload = hostedPayload("crack", "cr-ack");
    await report("artifact", payload.artifactObjectKey!, [marker]);
    const pub = await directPublish(pool, { access: w.adminAccess, actorUserId: w.admin, namespaceSlug: w.nsSlug, semver: "1.0.0", payload });
    assert.ok(pub.ok && "skillId" in pub);
    const skillId = (pub as { skillId: string }).skillId;
    const skill = { id: skillId, namespaceId: w.ns, slug: "cr-ack" };
    assert.equal((await skillContentRiskSummary(skillId))?.status, "passed");

    // The sweep finds something after publish: a superseding report for the same artifact.
    await new Promise((r) => setTimeout(r, 5));
    await report("artifact", payload.artifactObjectKey!, [marker, hidden]);
    const summary = await skillContentRiskSummary(skillId);
    assert.deepEqual(summary, { semver: "1.0.0", status: "flagged", ruleset: CONTENT_RULESET_VERSION });
    assert.equal("findings" in (summary as object), false, "the consumer summary carries no findings");

    // A maintainer who is not an admin can see but not acknowledge.
    await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1, $2) on conflict do nothing`, [skillId, w.member]);
    const asMember = await acknowledgeContentRisk(w.memberAccess, w.member, skill, "1.0.0", null);
    assert.deepEqual(asMember.ok ? null : (asMember as { status: number }).status, 403);
    const detail = await skillContentRiskDetail(w.memberAccess, skill, null);
    assert.equal(detail?.canAcknowledge, false);
    assert.deepEqual(detail?.findings.map((f) => f.rule), ["cr-scanned", "cr-hidden-unicode"]);
    assert.equal(detail?.findings[1]?.excerpt, "Run ⟨U+200B⟩this");

    // An admin of a different namespace cannot either.
    const asOther = await acknowledgeContentRisk(w.otherAdminAccess, w.otherAdmin, skill, "1.0.0", null);
    assert.equal(asOther.ok ? null : (asOther as { status: number }).status, 403);

    // The skill's namespace admin can; the version becomes noted and the action is audited.
    const asAdmin = await acknowledgeContentRisk(w.adminAccess, w.admin, skill, "1.0.0", "reviewed, harmless");
    assert.deepEqual(asAdmin, { ok: true });
    assert.equal((await skillContentRiskSummary(skillId))?.status, "noted");
    assert.equal((await pool.query(`select 1 from audit_log where action = 'skill.content_risk_acknowledged' and target_id = $1`, [`${skillId}@1.0.0`])).rowCount, 1);
    const again = await acknowledgeContentRisk(w.adminAccess, w.admin, skill, "1.0.0", null);
    assert.equal(again.ok ? null : (again as { status: number }).status, 409);

    // A later report with the same pair stays acknowledged; a new pair flags again.
    await new Promise((r) => setTimeout(r, 5));
    await report("artifact", payload.artifactObjectKey!, [marker, hidden, { ...hidden, line: 9 }]);
    assert.equal((await skillContentRiskSummary(skillId))?.status, "noted");
    await new Promise((r) => setTimeout(r, 5));
    await report("artifact", payload.artifactObjectKey!, [marker, hidden, { ...hidden, rule: "cr-credential-exfil" }]);
    assert.equal((await skillContentRiskSummary(skillId))?.status, "flagged");
  } finally {
    await w.cleanup();
  }
});

test("accept gate: a pointer proposal's pre-scan findings now require the audited override (§37.4)", { skip: !enabled }, async () => {
  const w = await world("crpointer");
  try {
    const payload: RevisionPayload = {
      metadata: { skillSlug: "cr-pointer-skill", title: "P", description: "d", toolHarness: "claude-code", visibility: "org", categories: [], usageExamples: null },
      pointer: { url: "https://example.com/p.git", ref: "v1" },
    };
    await pool.query(`update namespaces set require_review = true where id = $1`, [w.ns]);
    const { id: proposalId } = await createProposal(pool, { submittedByUserId: w.member, targetNamespaceId: w.ns, proposedSemver: "1.0.0", payload });
    await report("proposal", proposalId, [marker, hidden]);

    const started = await performProposalAction(pool, { proposalId, action: "start_review", actorUserId: w.admin, access: w.adminAccess }, store);
    assert.equal(started.ok, true);
    const blocked = await performProposalAction(pool, { proposalId, action: "accept", actorUserId: w.admin, access: w.adminAccess, expectedRevisionNo: 1 }, store);
    assert.equal(blocked.ok, false);
    assert.equal((blocked as { requiresOverride?: boolean }).requiresOverride, true);

    const ok = await performProposalAction(pool, { proposalId, action: "accept", actorUserId: w.admin, access: w.adminAccess, expectedRevisionNo: 1, override: true, overrideReason: "ok" }, store);
    assert.equal(ok.ok, true);
    assert.equal((await pool.query(`select 1 from audit_log where action = 'proposal.scan_override' and target_id = $1`, [proposalId])).rowCount, 1);
    const ack = (await pool.query<{ source: string }>(
      `select a.source from content_risk_acknowledgements a join skills s on s.id = a.skill_id where s.slug = 'cr-pointer-skill' and a.semver = '1.0.0'`,
    )).rows;
    assert.deepEqual(ack, [{ source: "override" }], "acknowledged for the version-to-be, before the worker mirrors it");
  } finally {
    await pool.query(`delete from scan_reports where subject_type = 'proposal' and subject_id in (select id::text from proposals where target_namespace_id = $1)`, [w.ns]);
    await pool.query(`delete from pending_mirrors where skill_id in (select id from skills where namespace_id = $1)`, [w.ns]);
    await w.cleanup();
  }
});
