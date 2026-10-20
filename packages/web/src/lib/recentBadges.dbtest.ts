// Live-DB integration tests for the five §31.12 badges (SKILLY_SPEC.md §31.12) — Hype Squad, Word
// of Mouth, Glow Up and Robot Sidekick on the web side (Fresh Coat lives in the worker's
// integration suite), the "not available here" list on the achievements read model, the AI display
// name in the notification copy, and migration 0099's history backfill. Gated by SKILLY_DB_E2E=1.
//
// Robot Sidekick's two runtime doors are covered where their AI stubs already live
// (aiDraft.dbtest.ts, qualityDraft.dbtest.ts); here it is awarded directly to test the copy.
//
// Users are FIXED (upserted by entra_object_id, never deleted): the share mint writes audit_log rows,
// which reference their actor and can never be removed (invariant #5).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ACHIEVEMENT_KEYS, type AchievementFlags } from "@skilly/shared/achievements";
import { DEFAULT_HYPE_SETTINGS } from "@skilly/shared/hype";
import type { EffectiveAccess } from "@skilly/shared";
import { pool } from "./db";
import { awardAchievement, getAchievements } from "./achievements";
import { placeHype } from "./hype";
import { mintShareLink } from "./shareLinks";
import { createProposal, directPublish, type RevisionPayload } from "./proposals";
import { appendAudit } from "./audit";

const enabled = process.env.SKILLY_DB_E2E === "1";
after(async () => { if (enabled) await pool.end(); });

const q = <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
const one = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;

async function user(oid: string): Promise<string> {
  const id = await one(
    `insert into users (entra_object_id, email, display_name, status) values ($1, $1 || '@org', $1, 'active')
     on conflict (entra_object_id) do update set status = 'active', erased_at = null returning id`,
    [oid],
  );
  await q(`update users set hero_at = null, achievements_hidden = false, time_zone = null where id = $1`, [id]);
  await q(`delete from user_achievements where user_id = $1`, [id]);
  await q(`delete from notifications where user_id = $1`, [id]);
  return id;
}

async function namespace(slug: string, requireReview: boolean): Promise<string> {
  return one(
    `insert into namespaces (slug, display_name, require_review) values ($1, $1, $2)
     on conflict (slug) do update set require_review = excluded.require_review returning id`,
    [slug, requireReview],
  );
}

/** Drop every skill and proposal of a namespace (versions are immutable without the session flag). */
async function wipeNamespace(ns: string): Promise<void> {
  await q(`delete from proposals where target_namespace_id = $1`, [ns]);
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local skilly.allow_version_delete = 'on'");
    await c.query(`delete from skill_share_links where skill_id in (select id from skills where namespace_id = $1)`, [ns]);
    await c.query(`delete from skills where namespace_id = $1`, [ns]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

const held = async (userId: string, key: string) =>
  (await q(`select 1 from user_achievements where user_id = $1 and key = $2`, [userId, key])).rowCount === 1;
const earnedAt = async (userId: string, key: string) =>
  (await q<{ earned_at: Date }>(`select earned_at from user_achievements where user_id = $1 and key = $2`, [userId, key])).rows[0]?.earned_at ?? null;
const notifs = async (userId: string, key: string) =>
  Number((await q<{ n: string }>(
    `select count(*)::text as n from notifications where user_id = $1 and type = 'achievement.earned' and payload->>'key' = $2`,
    [userId, key],
  )).rows[0]!.n);

/** An org skill that is hype-eligible: young, small, with an installable version. */
async function hypeableSkill(ns: string, slug: string, by: string): Promise<string> {
  const id = await one(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
     values ($1,$2,$2,'d','claude','hosted','org','active') returning id`,
    [ns, slug],
  );
  await q(
    `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, created_by, git_published)
     values ($1,'1.0.0',false,'active',$3,'h',$2,true)`,
    [id, by, `k/rb/${id}`],
  );
  return id;
}

function hosted(slug: string, file: string, meta: Partial<RevisionPayload["metadata"]> = {}): RevisionPayload {
  return {
    metadata: { skillSlug: slug, title: slug, description: "d", toolHarness: "claude-code", visibility: "org", categories: [], usageExamples: null, ...meta },
    artifactObjectKey: `uploads/rb/${file}.bundle`,
    artifactSha256: `sha-${file}`,
  };
}

/** §49.2: the fail-closed gate needs a complete verdict — stand in for the upload path's artifact report. */
async function scanned(p: RevisionPayload): Promise<RevisionPayload> {
  await q(
    `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status) values ('artifact', $1, 'test', '[]'::jsonb, 'info', 'scanned')`,
    [p.artifactObjectKey],
  );
  return p;
}

async function iconRow(sha: string, createdBy: string): Promise<void> {
  await q(`insert into skill_icons (sha256, bytes, created_by) values ($1, '\\x00'::bytea, $2) on conflict (sha256) do nothing`, [sha, createdBy]);
}

test("Hype Squad: an accepted hype awards it once; refusals award nothing (§31.12.3)", { skip: !enabled }, async () => {
  const ns = await namespace("rb-hype-ns", true);
  await wipeNamespace(ns);
  const maker = await user("rb-hype-maker");
  const fan = await user("rb-hype-fan");
  try {
    const a = await hypeableSkill(ns, "rb-hype-a", maker);
    const b = await hypeableSkill(ns, "rb-hype-b", maker);
    await q(`insert into skill_maintainers (skill_id, user_id) values ($1,$2) on conflict do nothing`, [a, maker]);

    const self = await placeHype(maker, a, DEFAULT_HYPE_SETTINGS);
    assert.equal(self.ok, false, "a maintainer cannot hype their own skill");
    assert.equal(await held(maker, "first_hype"), false, "a refusal awards nothing");

    const first = await placeHype(fan, a, DEFAULT_HYPE_SETTINGS);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(await held(fan, "first_hype"), true);
    const again = await placeHype(fan, a, DEFAULT_HYPE_SETTINGS);
    assert.equal(again.ok, false, "already hyped");
    const second = await placeHype(fan, b, DEFAULT_HYPE_SETTINGS);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(await notifs(fan, "first_hype"), 1, "earned once, one notification");
  } finally {
    await q(`delete from skill_hypes where skill_id in (select id from skills where namespace_id = $1)`, [ns]);
    await wipeNamespace(ns);
  }
});

test("Word of Mouth: a share-link mint awards it once (§31.12.3)", { skip: !enabled }, async () => {
  const ns = await namespace("rb-share-ns", true);
  await wipeNamespace(ns);
  const sharer = await user("rb-sharer");
  try {
    const skill = await hypeableSkill(ns, "rb-share", sharer);
    await mintShareLink(sharer, { id: skill, namespaceId: ns });
    assert.equal(await held(sharer, "first_share"), true);
    await mintShareLink(sharer, { id: skill, namespaceId: ns });
    assert.equal(await notifs(sharer, "first_share"), 1);
  } finally {
    await wipeNamespace(ns);
  }
});

test("Glow Up: a chosen icon on submission counts; keeping, echoing, removing and promotion do not (§31.12.3)", { skip: !enabled }, async () => {
  const ns = await namespace("rb-icon-ns", true);
  const direct = await namespace("rb-icon-direct", false);
  await wipeNamespace(ns);
  await wipeNamespace(direct);
  const plain = await user("rb-icon-plain");
  const emoji = await user("rb-icon-emoji");
  const image = await user("rb-icon-image");
  const keeper = await user("rb-icon-keeper");
  const changer = await user("rb-icon-changer");
  const promoter = await user("rb-icon-promoter");
  const publisher = await user("rb-icon-publisher");
  const echoer = await user("rb-icon-echoer");
  const member: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map([[direct, "namespace_member"]]) };
  try {
    // New skills: no icon → nothing; an emoji or an uploaded image → Glow Up.
    await createProposal(pool, { submittedByUserId: plain, targetNamespaceId: ns, proposedSemver: "1.0.0", payload: await scanned(hosted("rb-i-plain", "plain")) });
    assert.equal(await held(plain, "first_icon"), false, "no icon, no badge");
    await createProposal(pool, { submittedByUserId: emoji, targetNamespaceId: ns, proposedSemver: "1.0.0", payload: await scanned(hosted("rb-i-emoji", "emoji", { iconEmoji: "🦊" })) });
    assert.equal(await held(emoji, "first_icon"), true, "a picked emoji counts");
    const sha = "a1".repeat(32);
    await iconRow(sha, image);
    await createProposal(pool, { submittedByUserId: image, targetNamespaceId: ns, proposedSemver: "1.0.0", payload: await scanned(hosted("rb-i-image", "image", { iconSha256: sha, iconSource: "upload" })) });
    assert.equal(await held(image, "first_icon"), true, "an uploaded image counts");
    assert.equal(await notifs(image, "first_icon"), 1);

    // A published skill with an emoji icon, to propose new versions of.
    const pub = await directPublish(pool, { access: member, actorUserId: publisher, namespaceSlug: "rb-icon-direct", semver: "1.0.0", payload: await scanned(hosted("rb-i-live", "live1", { iconEmoji: "🦊" })) });
    assert.ok(pub.ok && !("routed" in pub), JSON.stringify(pub));
    assert.equal(await held(publisher, "first_icon"), true, "a direct publish with a chosen icon counts");
    const skillId = (await q<{ id: string }>(`select id from skills where namespace_id = $1 and slug = 'rb-i-live'`, [direct])).rows[0]!.id;

    // Keep (fields omitted), echo (the same emoji), remove (explicit nulls): no badge.
    await createProposal(pool, { submittedByUserId: keeper, targetNamespaceId: direct, targetSkillId: skillId, proposedSemver: "1.1.0", payload: await scanned(hosted("rb-i-live", "keep", { whatChanged: "Keep." })) });
    await createProposal(pool, { submittedByUserId: keeper, targetNamespaceId: direct, targetSkillId: skillId, proposedSemver: "1.1.1", payload: await scanned(hosted("rb-i-live", "echo", { whatChanged: "Echo.", iconEmoji: "🦊" })) });
    await createProposal(pool, { submittedByUserId: keeper, targetNamespaceId: direct, targetSkillId: skillId, proposedSemver: "1.1.2", payload: await scanned(hosted("rb-i-live", "remove", { whatChanged: "Remove.", iconEmoji: null, iconSha256: null })) });
    assert.equal(await held(keeper, "first_icon"), false, "keeping, echoing or removing the icon is not choosing one");

    // A different emoji on a new version counts.
    await createProposal(pool, { submittedByUserId: changer, targetNamespaceId: direct, targetSkillId: skillId, proposedSemver: "1.2.0", payload: await scanned(hosted("rb-i-live", "change", { whatChanged: "New look.", iconEmoji: "🐙" })) });
    assert.equal(await held(changer, "first_icon"), true, "a new icon on a new version counts");

    // A global re-promotion copies the icon — not a choice.
    const v1 = (await q<{ id: string }>(`select id from skill_versions where skill_id = $1 and semver = '1.0.0'`, [skillId])).rows[0]!.id;
    await createProposal(pool, {
      submittedByUserId: promoter, targetNamespaceId: ns, proposedSemver: "1.0.0",
      payload: { ...(await scanned(hosted("rb-i-promoted", "promo", { iconEmoji: "🐙" }))), promotedFromSkillVersionId: v1 },
    });
    assert.equal(await held(promoter, "first_icon"), false, "a promotion copies the icon");

    // A direct publish of a new version that echoes the current icon: no badge.
    const echoPub = await directPublish(pool, { access: member, actorUserId: echoer, namespaceSlug: "rb-icon-direct", semver: "1.0.1", payload: await scanned(hosted("rb-i-live", "live2", { whatChanged: "Same face.", iconEmoji: "🦊" })) });
    assert.ok(echoPub.ok && !("routed" in echoPub), JSON.stringify(echoPub));
    assert.equal(await held(echoer, "first_icon"), false, "echoing the current icon on a direct publish is not a choice");
  } finally {
    await wipeNamespace(ns);
    await wipeNamespace(direct);
    await q(`delete from scan_reports where subject_id like 'uploads/rb/%'`);
  }
});

test("unavailable: only the owner's locked switch-gated keys, never another viewer's (§31.12.4)", { skip: !enabled }, async () => {
  const owner = await user("rb-unavail-owner");
  const other = await user("rb-unavail-other");
  const flags: AchievementFlags = { hypeEnabled: false, aiAvailable: false, mcpEnabled: true, marketplaceReachable: true };
  await awardAchievement(pool, owner, "first_hype", { backfill: true, noHabits: true });
  const self = await getAchievements(owner, owner, pool, flags);
  // Catalog order: Robot Sidekick and Hype Train (Contribute) before Talent Scout (Explore).
  assert.deepEqual(self?.unavailable, ["first_ai_draft", "hype_train", "talent_scout"], "earned Hype Squad is never listed");
  const seen = await getAchievements(owner, other, pool, flags);
  assert.deepEqual(seen?.unavailable, [], "another viewer never gets the owner's switch state");
  const noFlags = await getAchievements(owner, owner);
  assert.deepEqual(noFlags?.unavailable, []);
});

test("Robot Sidekick: the notification names the AI by its display name (§31.12.5)", { skip: !enabled }, async () => {
  const u = await user("rb-ai-copy");
  const saved = (await q<{ value: unknown }>(`select value from platform_settings where key = 'ai_display_name'`)).rows[0]?.value;
  try {
    await q(
      `insert into platform_settings (key, value, updated_at) values ('ai_display_name', '"Aria"'::jsonb, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
    );
    await awardAchievement(pool, u, "first_ai_draft", { noHabits: true });
    const payload = (await q<{ payload: { blurb: string } }>(
      `select payload from notifications where user_id = $1 and type = 'achievement.earned' and payload->>'key' = 'first_ai_draft'`, [u],
    )).rows[0]!.payload;
    assert.equal(payload.blurb, "You let Aria write the first draft.");
  } finally {
    if (saved === undefined) await q(`delete from platform_settings where key = 'ai_display_name'`);
    else await q(`update platform_settings set value = $1::jsonb where key = 'ai_display_name'`, [JSON.stringify(saved)]);
  }
});

test("migration 0099: seeds hype, share, icon and AI history; skips erased users and Fresh Coat; stamps Hero (§31.12.7)", { skip: !enabled }, async () => {
  const ns = await namespace("rb-bf-ns", true);
  await wipeNamespace(ns);
  const hyper = await user("rb-bf-hyper");
  const sharer = await user("rb-bf-sharer");
  const iconNew = await user("rb-bf-icon-new");
  const iconVersion = await user("rb-bf-icon-version");
  const drafter = await user("rb-bf-drafter");
  const improver = await user("rb-bf-improver");
  const erased = await user("rb-bf-erased");
  const hero = await user("rb-bf-hero");
  const everyone = [hyper, sharer, iconNew, iconVersion, drafter, improver, erased, hero];
  try {
    const skill = await hypeableSkill(ns, "rb-bf-skill", sharer);
    // Hypes: two for `hyper` (the earlier wins), one for the erased user, one for the Hero.
    for (const [who, at] of [[hyper, "2025-02-01T10:00:00Z"], [hyper, "2025-03-01T10:00:00Z"], [erased, "2025-02-02T10:00:00Z"], [hero, "2025-04-01T10:00:00Z"]] as const) {
      await q(`insert into skill_hypes (skill_id, user_id, points, created_at) values ($1, $2, 1, $3)`, [skill, who, at]);
    }
    // A share mint (audit rows cannot be backdated — compare with the row's own timestamp).
    await mintShareLink(sharer, { id: skill, namespaceId: ns });
    const shareAt = (await q<{ at: Date }>(
      `select min(created_at) as at from audit_log where actor_user_id = $1 and action = 'skill.share_link_created'`, [sharer],
    )).rows[0]!.at;
    // Icons: a new-skill proposal with an emoji; a new-version proposal with the submitter's own image.
    const { id: p1 } = await createProposal(pool, { submittedByUserId: iconNew, targetNamespaceId: ns, proposedSemver: "1.0.0", payload: await scanned(hosted("rb-bf-new", "bf1", { iconEmoji: "🦊" })) });
    await q(`update proposals set created_at = '2025-05-01T10:00:00Z' where id = $1`, [p1]);
    const sha = "b2".repeat(32);
    await iconRow(sha, iconVersion);
    const { id: p2 } = await createProposal(pool, {
      submittedByUserId: iconVersion, targetNamespaceId: ns, targetSkillId: skill, proposedSemver: "1.1.0",
      payload: await scanned(hosted("rb-bf-skill", "bf2", { whatChanged: "Icon.", iconSha256: sha, iconSource: "upload" })),
    });
    await q(`update proposals set created_at = '2025-05-02T10:00:00Z' where id = $1`, [p2]);
    // AI: an ok and an earlier failed propose-form draft; a §44 run that modified a file.
    await q(
      `insert into ai_usage (created_at, feature, user_id, provider, model, latency_ms, ok) values
         ('2025-06-01T10:00:00Z', 'skill_draft', $1, 'anthropic', 'm', 1, false),
         ('2025-06-02T10:00:00Z', 'skill_draft', $1, 'anthropic', 'm', 1, true)`,
      [drafter],
    );
    await appendAudit(pool, {
      actorUserId: improver, action: "skill.ai_draft_generated", targetType: "skill", targetId: skill, namespaceId: ns,
      after: { skill: "rb-bf-skill", baseSemver: "1.0.0", model: "m", outcome: "complete", calls: 1, files: { queued: 1, modified: 1, deleted: 0, unchanged: 0, failed: 0, skipped: 0 } },
    });
    const improveAt = (await q<{ at: Date }>(
      `select max(created_at) as at from audit_log where actor_user_id = $1 and action = 'skill.ai_draft_generated'`, [improver],
    )).rows[0]!.at;
    // `hero` holds every other key already; Hype Squad is the one the migration completes.
    for (const key of ACHIEVEMENT_KEYS.filter((k) => k !== "first_hype")) {
      await awardAchievement(pool, hero, key, { at: new Date("2025-01-01T00:00:00Z"), backfill: true, noHabits: true });
    }

    // Wipe what the runtime awarded so the migration's own statements are what this exercises.
    // (`hero` keeps its pre-seeded set — it holds none of these from history but Hype Squad.)
    const seeded = ["first_hype", "first_share", "first_icon", "first_ai_draft"];
    await q(`delete from user_achievements where key = any($1::text[]) and user_id = any($2::uuid[])`, [seeded, everyone.filter((u) => u !== hero)]);
    await q(`delete from notifications where user_id = any($1::uuid[])`, [everyone]);
    await q(`update users set hero_at = null where id = any($1::uuid[])`, [everyone]);
    await q(`update users set erased_at = now() where id = $1`, [erased]);

    const sql = await readFile(fileURLToPath(new URL("../../../../db/migrations/0099_recent_feature_badges.sql", import.meta.url)), "utf8");
    await q(sql);
    await q(sql); // idempotent

    assert.equal((await earnedAt(hyper, "first_hype"))?.toISOString(), "2025-02-01T10:00:00.000Z", "the earliest hype");
    assert.equal((await earnedAt(sharer, "first_share"))?.getTime(), new Date(shareAt).getTime());
    assert.equal((await earnedAt(iconNew, "first_icon"))?.toISOString(), "2025-05-01T10:00:00.000Z");
    assert.equal((await earnedAt(iconVersion, "first_icon"))?.toISOString(), "2025-05-02T10:00:00.000Z");
    assert.equal((await earnedAt(drafter, "first_ai_draft"))?.toISOString(), "2025-06-02T10:00:00.000Z", "a failed call does not count");
    assert.equal((await earnedAt(improver, "first_ai_draft"))?.getTime(), new Date(improveAt).getTime());
    assert.equal(await held(erased, "first_hype"), false, "erased users are skipped");
    assert.equal(await held(hyper, "first_update"), false, "Fresh Coat is never seeded");
    const notes = Number((await q<{ n: string }>(`select count(*)::text as n from notifications where user_id = any($1::uuid[])`, [everyone])).rows[0]!.n);
    assert.equal(notes, 0, "a backfill notifies nobody");
    const stamp = (await q<{ hero_at: Date | null }>(`select hero_at from users where id = $1`, [hero])).rows[0]!.hero_at;
    assert.equal(stamp?.toISOString(), "2025-04-01T10:00:00.000Z", "Hero stamped at the completing badge's date");
  } finally {
    await q(`update users set erased_at = null where id = $1`, [erased]);
    await q(`delete from skill_hypes where user_id = any($1::uuid[])`, [everyone]);
    await q(`delete from ai_usage where user_id = any($1::uuid[])`, [everyone]);
    await q(`delete from user_achievements where user_id = any($1::uuid[])`, [everyone]);
    await q(`update users set hero_at = null where id = any($1::uuid[])`, [everyone]);
    await wipeNamespace(ns);
    await q(`delete from scan_reports where subject_id like 'uploads/rb/%'`);
  }
});
