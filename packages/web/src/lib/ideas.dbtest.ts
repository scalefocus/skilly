// Live-DB integration test for feature ideas (SKILLY_SPEC.md §60). Gated by SKILLY_DB_E2E=1.
// Verifies: migration 0101 (the nine seeded items, `upcoming_votes` gone), submission bounds and both
// caps (withdrawn rows still count, Retry-After on the daily one), the coalesced `idea.submitted` row
// for platform admins, own-idea edit / withdraw (404 / 409), publish (stale version → 409, the
// proposer's auto-vote, Bright Idea, the notification, the audit row), reject, admin edit (a seeded
// item too), close (Planned refused, votes deleted, outcome notified, nobody to tell on a seeded item)
// and a pre-v2.41.0 Planned → Shipped (Made It Real), the votes (idempotent, 404 off a published
// idea), the list (ordering, attribution and its opt-out, `canSuggest`), the switch (only platform
// admins may suggest while it is off; everything else carries on), an inactive author, the admin
// list, and GDPR erasure (published ideas stay unattributed, everything else and every vote goes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "./db";
import {
  closeIdea,
  editOwnIdea,
  editPublishedIdea,
  getComingSoon,
  listAdminIdeas,
  markIdeaShipped,
  pendingIdeaCount,
  publishIdea,
  rejectIdea,
  submitIdea,
  voteIdea,
  withdrawOwnIdea,
  type IdeaViewer,
} from "./ideas";
import { eraseUser } from "./eraseUser";
import { getFeatureIdeasEnabled, setFeatureIdeasEnabled } from "./settings";

const enabled = process.env.SKILLY_DB_E2E === "1";

const TEXT = (n: number) => `Feature idea number ${n}: let me export my installed skills as a CSV file.`;

/** The items migration 0101 seeded from the former code teasers, in their old display order. */
const SEEDED = [
  ["dce851e7-a1c6-434b-b539-34e99f989951", "Skill evals"],
  ["106c3c92-220a-4945-a696-b9b2a56eb068", "Upstream release alerts"],
  ["b83fd07a-da36-4a00-8652-1474b9a37324", "Try a skill before installing"],
  ["a594fd78-3f6f-4cd6-aefe-3adfe2b683fe", "Review assignments and deadlines"],
  ["4b122d21-18f2-4c41-a965-d31483c07cb9", "Search gaps"],
  ["5e3529a7-c04e-40df-9d0e-6e21a5b7bc2d", "Popular in your department"],
  ["9079a8e5-3c78-46e0-8dc4-c290f181fe24", "Customize a skill for your team"],
  ["34de0381-d9de-4400-b41d-800cc34d7ad2", "Import a whole repository"],
  ["c459775f-7224-4d4f-9d57-3c6a2ec8a10e", "Usage insights"],
] as const;

test("migration 0101: the nine former teasers are published items with no proposer; upcoming_votes is gone", { skip: !enabled }, async () => {
  const { rows } = await pool.query<{ id: string; title: string; author_id: string | null; decided_by: string | null; published_at: Date }>(
    `select id, title, author_id, decided_by, published_at from feature_ideas where id = any($1::uuid[])`,
    [SEEDED.map(([id]) => id)],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.equal(rows.length, SEEDED.length);
  for (const [id, title] of SEEDED) {
    const r = byId.get(id)!;
    assert.equal(r.author_id, null, title);
    assert.equal(r.decided_by, null, title);
  }
  // Seeded titles are what the migration wrote unless an admin has edited one since — never on CI.
  if (process.env.CI) assert.deepEqual(SEEDED.map(([id]) => byId.get(id)!.title), SEEDED.map(([, title]) => title));
  // Stamped a second apart, the first item newest, so equal vote counts keep the old order.
  for (let i = 1; i < SEEDED.length; i++) {
    assert.ok(byId.get(SEEDED[i - 1]![0])!.published_at > byId.get(SEEDED[i]![0])!.published_at, SEEDED[i]![1]);
  }
  const gone = await pool.query<{ t: string | null }>(`select to_regclass('upcoming_votes')::text as t`);
  assert.equal(gone.rows[0]!.t, null);
});

test("feature ideas: caps, notifications, review, votes, list, badges, erasure", { skip: !enabled }, async () => {
  const q = <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;
  const mkUser = (oid: string) =>
    one(
      `insert into users (entra_object_id, email, display_name, status) values ($1, $1 || '@org', $1, 'active')
       on conflict (entra_object_id) do update set status = 'active', erased_at = null returning id`,
      [oid],
    );
  // Fixed actors (audit_log FK — never deleted, see the dbtest memory note).
  const admin = await mkUser("ideas-platform-admin");
  const author = await mkUser("ideas-author");
  const author2 = await mkUser("ideas-author-2");
  const voter = await mkUser("ideas-voter");
  const erasee = await mkUser("ideas-erasee");
  const racer = await mkUser("ideas-racer");
  const mine = [author, author2, voter, erasee, racer, admin];

  const grp = await one(
    `insert into groups (entra_object_id, display_name) values ('ideas-padmin-grp','Ideas Platform Admins')
     on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
  );
  await q(`insert into role_mappings (group_id, namespace_id, role) values ($1, null, 'platform_admin') on conflict do nothing`, [grp]);
  await q(`insert into group_memberships (group_id, user_id) values ($1,$2) on conflict do nothing`, [grp, admin]);

  // Clean slate for every run.
  await q(`delete from feature_ideas where author_id = any($1::uuid[])`, [mine]);
  await q(`delete from feature_idea_votes where user_id = any($1::uuid[])`, [mine]);
  await q(`delete from notifications where user_id = any($1::uuid[]) and type like 'idea.%'`, [mine]);
  await q(`delete from user_achievements where user_id = any($1::uuid[]) and key in ('idea_published', 'idea_shipped')`, [mine]);
  await q(`update users set idea_attribution_hidden = false, idea_notifications = true where id = any($1::uuid[])`, [mine]);

  const viewer = (userId: string, isPlatformAdmin = false): IdeaViewer => ({ userId, isPlatformAdmin });
  // The suite expects suggestions on for everyone; the switch section below turns them off and back.
  if (!(await getFeatureIdeasEnabled())) await setFeatureIdeasEnabled(true, admin);
  const version = async (id: string) => (await q<{ v: string }>(`select updated_at::text as v from feature_ideas where id = $1`, [id])).rows[0]!.v;
  const notes = async (userId: string, type: string) =>
    (await q<{ payload: Record<string, unknown> }>(`select payload from notifications where user_id = $1 and type = $2 order by created_at, id`, [userId, type])).rows.map((r) => r.payload);
  const hasBadge = async (userId: string, key: string) =>
    (await q(`select 1 from user_achievements where user_id = $1 and key = $2`, [userId, key])).rowCount === 1;
  const audit = async (action: string, id: string) =>
    (await q<{ before: Record<string, unknown> | null; after: Record<string, unknown> | null }>(
      `select before, after from audit_log where action = $1 and target_type = 'feature_idea' and target_id = $2 order by created_at desc limit 1`,
      [action, id],
    )).rows[0];
  const pendingBefore = await pendingIdeaCount();

  // ── Submission: bounds, the coalesced admin notification, the two caps ────────────────────────
  assert.deepEqual(await submitIdea(viewer(author), "too short"), { ok: false, status: 422, error: "description must be at least 20 characters" });
  const s1 = await submitIdea(viewer(author), `  ${TEXT(1)}  `);
  assert.ok(s1.ok);
  const id1 = s1.ok ? s1.idea.id : "";
  assert.equal(s1.ok && s1.idea.description, TEXT(1), "trimmed");
  const s2 = await submitIdea(viewer(author), TEXT(2));
  const s3 = await submitIdea(viewer(author), TEXT(3));
  assert.ok(s2.ok && s3.ok);
  const id2 = s2.ok ? s2.idea.id : "";
  const id3 = s3.ok ? s3.idea.id : "";
  const adminRows = await notes(admin, "idea.submitted");
  assert.equal(adminRows.length, 1, "one coalesced row per admin");
  assert.equal(adminRows[0]!.count, 3);
  assert.equal((await notes(author, "idea.submitted")).length, 0, "the author is not an admin");
  assert.equal(await pendingIdeaCount(), pendingBefore + 3);

  const capped = await submitIdea(viewer(author), TEXT(4));
  assert.equal(!capped.ok && capped.status === 429 && capped.reason, "pending_limit");

  // Withdrawn rows leave the pending cap but still count toward the daily one.
  assert.deepEqual(await withdrawOwnIdea(author, id3), { ok: true });
  const s4 = await submitIdea(viewer(author), TEXT(4));
  assert.ok(s4.ok);
  assert.deepEqual(await withdrawOwnIdea(author, s4.ok ? s4.idea.id : ""), { ok: true });
  const s5 = await submitIdea(viewer(author), TEXT(5));
  assert.ok(s5.ok);
  assert.deepEqual(await withdrawOwnIdea(author, s5.ok ? s5.idea.id : ""), { ok: true });
  const daily = await submitIdea(viewer(author), TEXT(6));
  assert.equal(!daily.ok && daily.status === 429 && daily.reason, "daily_limit");
  assert.ok(!daily.ok && daily.status === 429 && daily.retryAfterSeconds! > 23 * 3600, "Retry-After counts down from ~24 h");

  // Own-idea edit / withdraw: someone else's → 404; no longer pending → 409.
  assert.equal((await editOwnIdea(voter, id1, TEXT(7))).ok, false);
  assert.deepEqual(await editOwnIdea(voter, id1, TEXT(7)), { ok: false, status: 404, error: "not found" });
  assert.deepEqual(await editOwnIdea(author, id3, TEXT(7)), { ok: false, status: 409, error: "this idea is no longer pending" });
  assert.deepEqual(await editOwnIdea(author, id1, `${TEXT(1)} Edited.`), { ok: true });

  // ── Publish: stale version → 409, then the real thing ─────────────────────────────────────────
  const staleVersion = await version(id1);
  await q(`update feature_ideas set updated_at = updated_at + interval '1 second' where id = $1`, [id1]);
  assert.deepEqual(await publishIdea(admin, id1, { title: "CSV export", description: TEXT(1), expectedUpdatedAt: staleVersion }), {
    ok: false, status: 409, error: "this idea changed since you opened it",
  });
  assert.equal((await publishIdea(admin, id1, { title: "x", description: TEXT(1), expectedUpdatedAt: await version(id1) })).ok, false, "title too short");
  assert.deepEqual(await publishIdea(admin, id1, { title: "  CSV   export ", description: TEXT(1), expectedUpdatedAt: await version(id1) }), { ok: true });
  const row1 = (await q<{ status: string; title: string; description: string; submitted_description: string }>(`select status, title, description, submitted_description from feature_ideas where id = $1`, [id1])).rows[0]!;
  assert.deepEqual(row1, { status: "published", title: "CSV export", description: TEXT(1), submitted_description: `${TEXT(1)} Edited.` });
  assert.equal((await q(`select 1 from feature_idea_votes where idea_id = $1 and user_id = $2`, [id1, author])).rowCount, 1, "the proposer's auto-vote");
  assert.equal(await hasBadge(author, "idea_published"), true, "Bright Idea");
  assert.deepEqual(await notes(author, "idea.published"), [{ ideaId: id1, title: "CSV export" }]);
  assert.deepEqual((await audit("idea.published", id1))?.after, { title: "CSV export", description: TEXT(1) });
  assert.equal((await publishIdea(admin, id1, { title: "Again", description: TEXT(1), expectedUpdatedAt: await version(id1) })).ok, false, "already published → 409");

  // ── Reject ────────────────────────────────────────────────────────────────────────────────────
  assert.deepEqual(await rejectIdea(admin, id2, { reason: " Already possible with the API. ", expectedUpdatedAt: await version(id2) }), { ok: true });
  const rejected = await notes(author, "idea.rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.reason, "Already possible with the API.");
  assert.equal(rejected[0]!.excerpt, TEXT(2));
  assert.equal((await voteIdea(voter, id2, true)).ok, false, "no votes on a rejected idea");

  // ── The list, votes, attribution ──────────────────────────────────────────────────────────────
  const plain = viewer(voter);
  const cs = await getComingSoon(plain);
  assert.equal(cs.canSuggest, true);
  const mineIdea = cs.items.find((i) => i.id === id1);
  assert.ok(mineIdea);
  assert.equal(mineIdea.votes, 1);
  assert.equal(mineIdea.voted, false);
  assert.equal(mineIdea.suggestedBy?.id, author);
  for (let i = 1; i < cs.items.length; i++) assert.ok(cs.items[i - 1]!.votes >= cs.items[i]!.votes, "most votes first");
  assert.deepEqual(cs.limits, { pending: 0, pendingMax: 3, today: 0, dailyMax: 5 });
  // The seeded items still on the list carry no "Suggested by" line.
  const seeded = cs.items.filter((i) => SEEDED.some(([id]) => id === i.id));
  for (const s of seeded) assert.equal(s.suggestedBy, null, s.title);

  assert.deepEqual(await voteIdea(voter, id1, true), { ok: true, votes: 2, voted: true });
  assert.deepEqual(await voteIdea(voter, id1, true), { ok: true, votes: 2, voted: true }, "idempotent");
  assert.deepEqual(await voteIdea(voter, id1, false), { ok: true, votes: 1, voted: false });
  assert.deepEqual(await voteIdea(voter, id1, true), { ok: true, votes: 2, voted: true });
  if (seeded[0]) {
    const before = seeded[0].votes;
    assert.deepEqual(await voteIdea(voter, seeded[0].id, true), { ok: true, votes: before + 1, voted: true }, "a seeded item takes votes");
    assert.equal((await getComingSoon(plain)).items.find((i) => i.id === seeded[0]!.id)?.voted, true);
    assert.deepEqual(await voteIdea(voter, seeded[0].id, false), { ok: true, votes: before, voted: false });
  }
  assert.deepEqual(await voteIdea(voter, "00000000-0000-4000-8000-000000000000", true), { ok: false, status: 404 });

  await q(`update users set idea_attribution_hidden = true where id = $1`, [author]);
  const hidden = (await getComingSoon(plain)).items.find((i) => i.id === id1);
  assert.equal(hidden?.suggestedBy, null, "the opt-out applies live");
  await q(`update users set idea_attribution_hidden = false where id = $1`, [author]);

  const authorView = await getComingSoon(viewer(author));
  assert.deepEqual(authorView.mine.map((m) => m.status).sort(), ["published", "rejected"], "withdrawn ideas are hidden");

  // ── Admin edit; a close never takes Planned; a pre-v2.41.0 Planned idea → Shipped ─────────────
  assert.deepEqual(await editPublishedIdea(admin, id1, { title: "Export installed skills" }), { ok: true });
  assert.deepEqual((await audit("idea.updated", id1))?.after, { title: "Export installed skills", description: TEXT(1) });
  assert.deepEqual(await editPublishedIdea(admin, id2, { title: "Nope" }), { ok: false, status: 409, error: "only a published idea can be edited" });
  if (seeded[0]) {
    // A seeded item is edited like any other (and put back, for the next run).
    const original = seeded[0].title;
    assert.deepEqual(await editPublishedIdea(admin, seeded[0].id, { title: `${original} (edited)` }), { ok: true });
    assert.deepEqual(await editPublishedIdea(admin, seeded[0].id, { title: original }), { ok: true });
  }

  assert.equal((await closeIdea(admin, id1, { outcome: "done", note: null })).ok, false, "unknown outcome → 422");
  assert.deepEqual(await closeIdea(admin, id1, { outcome: "planned", note: null }), {
    ok: false, status: 422, error: "outcome must be shipped, duplicate or wont_do",
  });
  assert.deepEqual(await closeIdea(admin, id1, { outcome: "duplicate", note: "Same as the export request." }), { ok: true });
  assert.equal((await q(`select 1 from feature_idea_votes where idea_id = $1`, [id1])).rowCount, 0, "closing deletes the votes");
  assert.deepEqual((await audit("idea.closed", id1))?.after, { outcome: "duplicate", note: "Same as the export request.", votes: 2 });
  assert.deepEqual(await notes(author, "idea.closed"), [{ ideaId: id1, title: "Export installed skills", outcome: "duplicate", adminNote: "Same as the export request." }]);
  assert.deepEqual(await voteIdea(voter, id1, true), { ok: false, status: 404 });
  assert.equal(await hasBadge(author, "idea_shipped"), false);
  assert.deepEqual(await markIdeaShipped(admin, id1), { ok: false, status: 409, error: "only an idea closed as Planned can be marked shipped" });

  // Ideas closed as Planned before v2.41.0 keep their Mark shipped action.
  await q(`update feature_ideas set outcome = 'planned' where id = $1`, [id1]);
  assert.deepEqual(await markIdeaShipped(admin, id1), { ok: true });
  assert.equal(await hasBadge(author, "idea_shipped"), true, "Made It Real");
  assert.deepEqual(await notes(author, "idea.shipped"), [{ ideaId: id1, title: "Export installed skills" }]);
  assert.deepEqual(await markIdeaShipped(admin, id1), { ok: false, status: 409, error: "only an idea closed as Planned can be marked shipped" });

  // An item with no proposer (like the seeded ones) closes without anyone to tell or reward.
  const orphan = await one(
    `insert into feature_ideas (status, title, description, submitted_description, decided_at, published_at)
     values ('published', 'Orphan item', $1, $1, now(), now()) returning id`,
    [TEXT(30)],
  );
  assert.deepEqual(await closeIdea(admin, orphan, { outcome: "shipped", note: null }), { ok: true });
  assert.equal((await q(`select 1 from notifications where payload->>'ideaId' = $1`, [orphan])).rowCount, 0);
  assert.deepEqual((await audit("idea.closed", orphan))?.after, { outcome: "shipped", note: null, votes: 0 });
  await q(`delete from feature_ideas where id = $1`, [orphan]);

  // ── The switch: off, only platform admins may suggest; nothing else changes ───────────────────
  await setFeatureIdeasEnabled(false, admin);
  try {
    assert.deepEqual(await submitIdea(viewer(author2), TEXT(11)), { ok: false, status: 403, reason: "suggestions_off" });
    const plainOff = await getComingSoon(viewer(author2));
    assert.equal(plainOff.canSuggest, false);
    assert.ok(plainOff.items.length > 0, "the list stays");
    const own = await submitIdea(viewer(admin, true), TEXT(12));
    assert.ok(own.ok, "a platform admin still may");
    const ownId = own.ok ? own.idea.id : "";
    assert.equal((await getComingSoon(viewer(admin, true))).canSuggest, true);
    // Pending ideas can still be edited and withdrawn, and votes carry on.
    assert.deepEqual(await editOwnIdea(admin, ownId, `${TEXT(12)} Edited.`), { ok: true });
    assert.deepEqual(await withdrawOwnIdea(admin, ownId), { ok: true });
    if (seeded[0]) {
      assert.equal((await voteIdea(author2, seeded[0].id, true)).ok, true);
      await voteIdea(author2, seeded[0].id, false);
    }
  } finally {
    await setFeatureIdeasEnabled(true, admin);
  }

  // ── An inactive author: published, voted, but no notification and no badge ───────────────────
  const a2 = await submitIdea(viewer(author2), TEXT(8));
  assert.ok(a2.ok);
  const idA2 = a2.ok ? a2.idea.id : "";
  await q(`update users set status = 'inactive' where id = $1`, [author2]);
  try {
    assert.deepEqual(await publishIdea(admin, idA2, { title: "Inactive author", description: TEXT(8), expectedUpdatedAt: await version(idA2) }), { ok: true });
    assert.equal((await notes(author2, "idea.published")).length, 0);
    assert.equal(await hasBadge(author2, "idea_published"), false);
    assert.deepEqual(await closeIdea(admin, idA2, { outcome: "shipped", note: null }), { ok: true });
    assert.equal(await hasBadge(author2, "idea_shipped"), false);
    assert.equal((await q<{ shipped: boolean }>(`select shipped_at is not null as shipped from feature_ideas where id = $1`, [idA2])).rows[0]!.shipped, true);
  } finally {
    await q(`update users set status = 'active' where id = $1`, [author2]);
  }

  // ── The admin list ────────────────────────────────────────────────────────────────────────────
  const closedTab = await listAdminIdeas("closed");
  const ours = closedTab.ideas.filter((i) => [id1, id2, idA2].includes(i.id));
  assert.equal(ours.length, 3, "rejected and closed ideas share the Closed tab");
  assert.ok(closedTab.counts.closed >= 3);
  assert.equal((await listAdminIdeas("pending")).ideas.some((i) => i.id === id3), false, "withdrawn ideas never show");
  assert.equal(await pendingIdeaCount(), pendingBefore);

  // ── Concurrency ───────────────────────────────────────────────────────────────────────────────
  // Six simultaneous submissions: the advisory lock lets exactly the first three through.
  const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => submitIdea(viewer(racer), TEXT(20 + i))));
  assert.equal(burst.filter((r) => r.ok).length, 3);
  assert.deepEqual(burst.filter((r) => !r.ok).map((r) => !r.ok && r.status === 429 && r.reason), ["pending_limit", "pending_limit", "pending_limit"]);
  const racerIds = burst.flatMap((r) => (r.ok ? [r.idea.id] : []));

  // Two admins publishing the same idea at once: one wins, the other gets 409.
  const v0 = await version(racerIds[0]!);
  const twice = await Promise.all([
    publishIdea(admin, racerIds[0]!, { title: "Race one", description: TEXT(20), expectedUpdatedAt: v0 }),
    publishIdea(admin, racerIds[0]!, { title: "Race two", description: TEXT(20), expectedUpdatedAt: v0 }),
  ]);
  assert.deepEqual(twice.map((r) => r.ok).sort(), [false, true]);
  assert.equal(twice.find((r) => !r.ok)?.ok === false && (twice.find((r) => !r.ok) as { status: number }).status, 409);

  // Votes racing a close: whatever the interleaving, no vote survives on the closed idea.
  const raced = await Promise.all([
    voteIdea(voter, racerIds[0]!, true),
    closeIdea(admin, racerIds[0]!, { outcome: "duplicate", note: null }),
    voteIdea(author2, racerIds[0]!, true),
  ]);
  assert.equal(raced[1].ok, true);
  assert.equal((await q(`select 1 from feature_idea_votes where idea_id = $1`, [racerIds[0]])).rowCount, 0);
  for (const id of racerIds.slice(1)) await withdrawOwnIdea(racer, id);

  // ── Erasure ───────────────────────────────────────────────────────────────────────────────────
  const e1 = await submitIdea(viewer(erasee), TEXT(9));
  const e2 = await submitIdea(viewer(erasee), TEXT(10));
  assert.ok(e1.ok && e2.ok);
  const idE1 = e1.ok ? e1.idea.id : "";
  const idE2 = e2.ok ? e2.idea.id : "";
  assert.deepEqual(await publishIdea(admin, idE1, { title: "Erasure survivor", description: TEXT(9), expectedUpdatedAt: await version(idE1) }), { ok: true });
  if (seeded[0]) assert.equal((await voteIdea(erasee, seeded[0].id, true)).ok, true);
  await q(`update users set idea_attribution_hidden = true where id = $1`, [erasee]);
  const erased = await eraseUser(admin, erasee, null);
  assert.equal(erased.ok, true);
  assert.equal((await q(`select 1 from feature_ideas where id = $1`, [idE2])).rowCount, 0, "the pending idea is deleted");
  assert.equal((await q(`select 1 from feature_ideas where id = $1`, [idE1])).rowCount, 1, "the published idea stays");
  assert.equal((await q(`select 1 from feature_idea_votes where user_id = $1`, [erasee])).rowCount, 0, "every vote they cast goes");
  assert.equal((await q<{ h: boolean }>(`select idea_attribution_hidden as h from users where id = $1`, [erasee])).rows[0]!.h, false, "reset by the scrub");
  const survivor = (await getComingSoon(plain)).items.find((i) => i.id === idE1);
  assert.equal(survivor?.suggestedBy, null, "shown unattributed");
  // Leave no published survivor behind for other suites.
  await closeIdea(admin, idE1, { outcome: "wont_do", note: null });
});
