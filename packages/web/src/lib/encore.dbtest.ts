// Live-DB integration tests for the Encore badge (SKILLY_SPEC.md §31.11): `first_version_proposal`,
// the first time a user puts forward a new version of an EXISTING skill. Gated by SKILLY_DB_E2E=1.
//
// Covers every door and every non-door: a web new-version proposal awards it (a new-skill one does
// not); revise and review acceptance never award it; a global re-promotion does not count; a direct
// publish of a new version awards it (a new skill does not); a content-risk-routed direct publish
// awards it through createProposal(); and migration 0085's history backfill (both sources, the
// earlier timestamp, re-promotions and accepted proposals excluded from the direct-publish source,
// erased users skipped, no notifications, the Hero stamp for a user it completes).
//
// These paths commit (createProposal / directPublish / performProposalAction own their
// transactions), so every test cleans up the rows it created — audit_log rows stay (invariant #5).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ACHIEVEMENT_KEYS } from "@skilly/shared/achievements";
import { CONTENT_RULESET_VERSION, maxSeverity, type EffectiveAccess, type ScanFinding } from "@skilly/shared";
import { createProposal, directPublish, performProposalAction, type RevisionPayload } from "./proposals";
import { awardAchievement } from "./achievements";
import type { ArtifactStore } from "./objectStore";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";
after(async () => { if (enabled) await pool.end(); });

const ENCORE = "first_version_proposal";
const platformAdmin: EffectiveAccess = { isPlatformAdmin: true, namespaceRoles: new Map() };
const noAccess: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map() };

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
  ns: string;
  nsSlug: string;
  /** Fresh users by role name — no badges, no notifications, not erased. */
  user: (who: string) => Promise<string>;
  memberAccess: EffectiveAccess;
  cleanup: () => Promise<void>;
}

async function world(key: string, requireReview: boolean): Promise<World> {
  const nsSlug = `${key}-ns`;
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ($1, $1, $2)
     on conflict (slug) do update set require_review = excluded.require_review returning id`, [nsSlug, requireReview],
  )).rows[0]!.id;
  const users: string[] = [];
  const user = async (who: string) => {
    const id = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name, status) values ($1, $2, $1, 'active')
       on conflict (entra_object_id) do update set email = excluded.email, status = 'active', erased_at = null returning id`,
      [`${key}-${who}`, `${key}-${who}@org`],
    )).rows[0]!.id;
    await pool.query(`update users set hero_at = null, achievements_hidden = false, time_zone = null where id = $1`, [id]);
    await pool.query(`delete from user_achievements where user_id = $1`, [id]);
    await pool.query(`delete from notifications where user_id = $1`, [id]);
    users.push(id);
    return id;
  };
  return {
    ns, nsSlug, user,
    memberAccess: { isPlatformAdmin: false, namespaceRoles: new Map([[ns, "namespace_member"]]) },
    cleanup: async () => {
      await pool.query(`delete from notifications where user_id = any($1::uuid[])`, [users]);
      await pool.query(`delete from user_achievements where user_id = any($1::uuid[])`, [users]);
      await pool.query(`update users set erased_at = null, hero_at = null where id = any($1::uuid[])`, [users]);
      await pool.query(`delete from proposals where target_namespace_id = $1`, [ns]);
      const skills = (await pool.query<{ id: string }>(`select id from skills where namespace_id = $1`, [ns])).rows;
      for (const s of skills) await deleteSkillRows(s.id);
      await pool.query(`delete from scan_reports where subject_id like $1`, [`uploads/${key}/%`]);
    },
  };
}

function hosted(key: string, slug: string, file: string, whatChanged?: string): RevisionPayload {
  return {
    metadata: {
      skillSlug: slug, title: slug, description: "d", toolHarness: "claude-code", visibility: "org",
      categories: [], usageExamples: null, ...(whatChanged ? { whatChanged } : {}),
    },
    artifactObjectKey: `uploads/${key}/${file}.bundle`,
    artifactSha256: `sha-${file}`,
  };
}

const held = async (userId: string, key = ENCORE) =>
  (await pool.query(`select 1 from user_achievements where user_id = $1 and key = $2`, [userId, key])).rowCount === 1;
const encoreNotifs = async (userId: string) =>
  Number((await pool.query<{ n: string }>(
    `select count(*)::text as n from notifications where user_id = $1 and type = 'achievement.earned' and payload->>'key' = $2`,
    [userId, ENCORE],
  )).rows[0]!.n);
const skillIdOf = async (ns: string, slug: string) =>
  (await pool.query<{ id: string }>(`select id from skills where namespace_id = $1 and slug = $2`, [ns, slug])).rows[0]!.id;
const versionIdOf = async (skillId: string, semver: string) =>
  (await pool.query<{ id: string }>(`select id from skill_versions where skill_id = $1 and semver = $2`, [skillId, semver])).rows[0]!.id;

test("Encore: web proposals — new version awards once; new skill, revise, acceptance and re-promotion do not (§31.11)", { skip: !enabled }, async () => {
  const w = await world("enc-prop", true);
  try {
    const proposer = await w.user("proposer");
    const promoter = await w.user("promoter");

    // A brand-new skill: Homegrown, but no Encore.
    const { id: firstId } = await createProposal(pool, {
      submittedByUserId: proposer, targetNamespaceId: w.ns, proposedSemver: "1.0.0",
      payload: hosted("enc-prop", "enc-skill", "v1"),
    });
    assert.equal(await held(proposer), false, "a new-skill proposal is not a new version");
    assert.equal(await held(proposer, "first_hosted_proposal"), true);
    await performProposalAction(pool, { proposalId: firstId, action: "start_review", actorUserId: promoter, access: platformAdmin }, store);
    const acc1 = await performProposalAction(pool, { proposalId: firstId, action: "accept", actorUserId: promoter, access: platformAdmin, expectedRevisionNo: 1 }, store);
    assert.equal(acc1.ok, true, JSON.stringify(acc1));
    const skillId = await skillIdOf(w.ns, "enc-skill");

    // A new version of it: Encore, with exactly one notification.
    const { id: nvId } = await createProposal(pool, {
      submittedByUserId: proposer, targetNamespaceId: w.ns, targetSkillId: skillId, proposedSemver: "1.1.0",
      payload: hosted("enc-prop", "enc-skill", "v2", "Better."),
    });
    assert.equal(await held(proposer), true, "a new-version proposal earns Encore");
    assert.equal(await encoreNotifs(proposer), 1);

    // Remove the row so the next two steps prove they do not award it themselves.
    await pool.query(`delete from user_achievements where user_id = $1 and key = $2`, [proposer, ENCORE]);
    const revised = await performProposalAction(pool, {
      proposalId: nvId, action: "revise", actorUserId: proposer, access: noAccess,
      newPayload: hosted("enc-prop", "enc-skill", "v2", "Better still."),
    }, store);
    assert.equal(revised.ok, true, JSON.stringify(revised));
    assert.equal(await held(proposer), false, "revise never awards Encore");

    await performProposalAction(pool, { proposalId: nvId, action: "start_review", actorUserId: promoter, access: platformAdmin }, store);
    const acc2 = await performProposalAction(pool, { proposalId: nvId, action: "accept", actorUserId: promoter, access: platformAdmin, expectedRevisionNo: 2 }, store);
    assert.equal(acc2.ok, true, JSON.stringify(acc2));
    assert.equal(await held(proposer), false, "acceptance never awards Encore (it was earned at submission)");
    assert.equal(await held(proposer, "first_new_version"), true, "Sequel still lands on publish");

    // A global (re-)promotion targets an existing skill but copies a version: no Encore.
    const promoted = { ...hosted("enc-prop", "enc-skill", "v2"), promotedFromSkillVersionId: await versionIdOf(skillId, "1.1.0") };
    await createProposal(pool, {
      submittedByUserId: promoter, targetNamespaceId: w.ns, targetSkillId: skillId, proposedSemver: "1.2.0", payload: promoted,
    });
    assert.equal(await held(promoter), false, "a re-promotion is not a new-version proposal");
  } finally {
    await w.cleanup();
  }
});

test("Encore: direct publish — a new version awards it, a new skill does not, a routed publish awards via createProposal (§31.11)", { skip: !enabled }, async () => {
  const w = await world("enc-direct", false);
  try {
    const member = await w.user("member");
    const routed = await w.user("routed");

    const first = await directPublish(pool, { access: w.memberAccess, actorUserId: member, namespaceSlug: w.nsSlug, semver: "1.0.0", payload: hosted("enc-direct", "enc-d", "v1") });
    assert.ok(first.ok && !("routed" in first), JSON.stringify(first));
    assert.equal(await held(member), false, "a new skill is not a new version");

    const second = await directPublish(pool, { access: w.memberAccess, actorUserId: member, namespaceSlug: w.nsSlug, semver: "1.0.1", payload: hosted("enc-direct", "enc-d", "v2", "Fixes.") });
    assert.ok(second.ok && !("routed" in second), JSON.stringify(second));
    assert.equal(await held(member), true, "a direct publish of a new version earns Encore");
    assert.equal(await held(member, "first_new_version"), true, "and Sequel, in the same publish");
    assert.equal(await encoreNotifs(member), 1);

    // A member's flagged publish is routed to review (§37.4) — still a submission of a new version.
    const flagged = hosted("enc-direct", "enc-d", "v3", "Risky.");
    const findings: ScanFinding[] = [
      { scanner: "content-risk", severity: "info", rule: "cr-scanned", message: "", ruleset: CONTENT_RULESET_VERSION },
      { scanner: "content-risk", severity: "high", rule: "cr-hidden-unicode", message: "hidden character", path: "SKILL.md", line: 1, excerpt: "x", ruleset: CONTENT_RULESET_VERSION },
    ];
    await pool.query(
      `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status) values ('artifact', $1, 'test', $2::jsonb, $3, 'scanned')`,
      [flagged.artifactObjectKey, JSON.stringify(findings), maxSeverity(findings) ?? "info"],
    );
    const r = await directPublish(pool, { access: w.memberAccess, actorUserId: routed, namespaceSlug: w.nsSlug, semver: "1.0.2", payload: flagged });
    assert.ok(r.ok && "routed" in r, JSON.stringify(r));
    assert.equal(await held(routed), true, "a routed new-version publish earns Encore at submission");
  } finally {
    await w.cleanup();
  }
});

test("Encore: migration 0085 backfills from both sources, earliest wins, exclusions hold, Hero stamped (§31.11)", { skip: !enabled }, async () => {
  const w = await world("enc-bf", false);
  try {
    const owner = await w.user("owner"); // only ever published the first version
    const direct = await w.user("direct"); // a historical direct publish of a new version
    const proposer = await w.user("proposer"); // an old new-version proposal, and a later direct publish
    const promoter = await w.user("promoter"); // only a re-promotion, accepted
    const erased = await w.user("erased"); // a direct publish, then erased

    const pub = async (who: string, semver: string, file: string) => {
      const r = await directPublish(pool, { access: w.memberAccess, actorUserId: who, namespaceSlug: w.nsSlug, semver, payload: hosted("enc-bf", "enc-bf", file, semver === "1.0.0" ? undefined : "Changes.") });
      assert.ok(r.ok && !("routed" in r), JSON.stringify(r));
    };
    await pub(owner, "1.0.0", "a");
    const skillId = await skillIdOf(w.ns, "enc-bf");
    await pub(direct, "1.0.1", "b");
    await pub(erased, "1.0.2", "c");

    const { id: oldProposal } = await createProposal(pool, {
      submittedByUserId: proposer, targetNamespaceId: w.ns, targetSkillId: skillId, proposedSemver: "1.0.3",
      payload: hosted("enc-bf", "enc-bf", "d", "Old idea."),
    });
    await pool.query(`update proposals set created_at = '2024-03-01T10:00:00Z' where id = $1`, [oldProposal]);
    await pub(proposer, "1.0.4", "e");

    const { id: promo } = await createProposal(pool, {
      submittedByUserId: promoter, targetNamespaceId: w.ns, targetSkillId: skillId, proposedSemver: "1.0.5",
      payload: { ...hosted("enc-bf", "enc-bf", "f"), promotedFromSkillVersionId: await versionIdOf(skillId, "1.0.1") },
    });
    await performProposalAction(pool, { proposalId: promo, action: "start_review", actorUserId: owner, access: platformAdmin }, store);
    const accepted = await performProposalAction(pool, { proposalId: promo, action: "accept", actorUserId: owner, access: platformAdmin, expectedRevisionNo: 1 }, store);
    assert.equal(accepted.ok, true, JSON.stringify(accepted));

    // `direct` holds every other badge since 2024, so Encore is the one that completes the set.
    for (const key of ACHIEVEMENT_KEYS.filter((k) => k !== ENCORE)) {
      await awardAchievement(pool, direct, key, { at: new Date("2024-11-20T09:00:00Z"), backfill: true, noHabits: true });
    }

    // Wipe what the runtime awarded, so the migration's own statements are what this exercises.
    const everyone = [owner, direct, proposer, promoter, erased];
    await pool.query(`delete from user_achievements where key = $1 and user_id = any($2::uuid[])`, [ENCORE, everyone]);
    await pool.query(`delete from notifications where user_id = any($1::uuid[])`, [everyone]);
    await pool.query(`update users set hero_at = null where id = any($1::uuid[])`, [everyone]);
    await pool.query(`update users set erased_at = now() where id = $1`, [erased]);

    const sql = await readFile(fileURLToPath(new URL("../../../../db/migrations/0085_encore_badge.sql", import.meta.url)), "utf8");
    await pool.query(sql);

    const earnedAt = async (u: string) =>
      (await pool.query<{ earned_at: Date }>(`select earned_at from user_achievements where user_id = $1 and key = $2`, [u, ENCORE])).rows[0]?.earned_at ?? null;
    const v101 = (await pool.query<{ created_at: Date }>(`select created_at from skill_versions where skill_id = $1 and semver = '1.0.1'`, [skillId])).rows[0]!.created_at;

    assert.equal((await earnedAt(direct))?.toISOString(), v101.toISOString(), "direct source: the new version's own timestamp");
    assert.equal((await earnedAt(proposer))?.toISOString(), "2024-03-01T10:00:00.000Z", "the earlier of the two sources wins");
    assert.equal(await earnedAt(owner), null, "a first version is not a new version");
    assert.equal(await earnedAt(promoter), null, "a re-promotion counts in neither source");
    assert.equal(await earnedAt(erased), null, "erased users are skipped");
    assert.equal(await encoreNotifs(direct) + await encoreNotifs(proposer), 0, "the backfill never notifies");

    const heroAt = (await pool.query<{ hero_at: Date | null }>(`select hero_at from users where id = $1`, [direct])).rows[0]!.hero_at;
    const lastEarned = (await pool.query<{ m: Date }>(`select max(earned_at) as m from user_achievements where user_id = $1`, [direct])).rows[0]!.m;
    assert.equal(heroAt?.toISOString(), lastEarned.toISOString(), "completing the set stamps Hero at the last badge's time");

    // Idempotent: a re-run changes nothing.
    await pool.query(sql);
    assert.equal((await earnedAt(proposer))?.toISOString(), "2024-03-01T10:00:00.000Z");
  } finally {
    await w.cleanup();
  }
});
