// Live-DB integration test for feature ideas (SKILLY_SPEC.md §60). Gated by SKILLY_DB_E2E=1.
// Verifies: migration 0101 (the nine seeded items, `upcoming_votes` gone), submission bounds and both
// caps (withdrawn rows still count, Retry-After on the daily one), the coalesced `idea.submitted` row
// for platform admins, own-idea edit / withdraw (404 / 409), publish (stale version → 409, the
// proposer's auto-vote, Bright Idea, the notification, the audit row), reject, admin edit (a seeded
// item too), close (Planned refused, votes deleted, outcome notified, nobody to tell on a seeded item)
// and a pre-v2.41.0 Planned → Shipped (Made It Real), the votes (idempotent, 404 off a published
// idea), the list (ordering, attribution and its opt-out, `canSuggest`), the switch (only platform
// admins may suggest while it is off; everything else carries on), an inactive author, the admin
// list, the admin delete (every status, votes and the idea's own notifications go, nobody is told,
// badges stay, the audit snapshot, the caps freed), GDPR erasure (published ideas stay
// unattributed, everything else and every vote goes), and the v2.45.0 "Upvoted by" voters (the
// strip, hidden voters, the full list and its cap, the vote answer, the opt-out, the ETag).
import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "./db";
import {
  closeIdea,
  deleteIdea,
  editOwnIdea,
  editPublishedIdea,
  getComingSoon,
  getIdeaVoters,
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
import { getFeatureIdeasEnabled, setFeatureIdeasEnabled, setUserIdeaVotesHidden } from "./settings";
import { conditionalJson } from "./etag";

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
  const deletee = await mkUser("ideas-deletee");
  const mine = [author, author2, voter, erasee, racer, deletee, admin];

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
  await q(`update users set idea_attribution_hidden = false, idea_notifications = true, idea_votes_hidden = false where id = any($1::uuid[])`, [mine]);

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
  // The vote counts alone; the "Upvoted by" strip in the answer has its own test below.
  const tally = (r: Awaited<ReturnType<typeof voteIdea>>) => (r.ok ? { ok: r.ok, votes: r.votes, voted: r.voted } : r);
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

  assert.deepEqual(tally(await voteIdea(voter, id1, true)), { ok: true, votes: 2, voted: true });
  assert.deepEqual(tally(await voteIdea(voter, id1, true)), { ok: true, votes: 2, voted: true }, "idempotent");
  assert.deepEqual(tally(await voteIdea(voter, id1, false)), { ok: true, votes: 1, voted: false });
  assert.deepEqual(tally(await voteIdea(voter, id1, true)), { ok: true, votes: 2, voted: true });
  if (seeded[0]) {
    const before = seeded[0].votes;
    assert.deepEqual(tally(await voteIdea(voter, seeded[0].id, true)), { ok: true, votes: before + 1, voted: true }, "a seeded item takes votes");
    assert.equal((await getComingSoon(plain)).items.find((i) => i.id === seeded[0]!.id)?.voted, true);
    assert.deepEqual(tally(await voteIdea(voter, seeded[0].id, false)), { ok: true, votes: before, voted: false });
  }
  assert.deepEqual(tally(await voteIdea(voter, "00000000-0000-4000-8000-000000000000", true)), { ok: false, status: 404 });

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
  assert.deepEqual(tally(await voteIdea(voter, id1, true)), { ok: false, status: 404 });
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

  // ── Delete: any status the admin page shows, for good and quietly ─────────────────────────────
  const submitAs = async (userId: string, n: number) => {
    const r = await submitIdea(viewer(userId), TEXT(n));
    assert.ok(r.ok);
    return r.ok ? r.idea.id : "";
  };
  const noteCount = async (userId: string) => (await q<{ n: number }>(`select count(*)::int as n from notifications where user_id = $1`, [userId])).rows[0]!.n;
  const dPending = await submitAs(deletee, 40);
  const dPublished = await submitAs(deletee, 41);
  const dKept = await submitAs(deletee, 42);
  assert.equal((await submitIdea(viewer(deletee), TEXT(43))).ok, false, "the pending cap is full");

  // A pending idea must match the version the admin saw; a reason over 500 is refused.
  const staleD = await version(dPending);
  await q(`update feature_ideas set updated_at = updated_at + interval '1 second' where id = $1`, [dPending]);
  const conflictD = { ok: false, status: 409, error: "this idea changed since you opened it" };
  assert.deepEqual(await deleteIdea(admin, dPending, { reason: null, expectedUpdatedAt: staleD }), conflictD);
  assert.deepEqual(await deleteIdea(admin, dPending, { reason: null, expectedUpdatedAt: undefined }), conflictD, "a pending idea needs a version");
  const tooLong = await deleteIdea(admin, dPending, { reason: "x".repeat(501), expectedUpdatedAt: await version(dPending) });
  assert.equal(!tooLong.ok && tooLong.status, 422);

  const pendingNow = await pendingIdeaCount();
  assert.deepEqual(await deleteIdea(admin, dPending, { reason: " Spam. ", expectedUpdatedAt: await version(dPending) }), { ok: true });
  assert.equal((await q(`select 1 from feature_ideas where id = $1`, [dPending])).rowCount, 0, "the row is gone");
  assert.equal(await pendingIdeaCount(), pendingNow - 1);
  const pendingAudit = await audit("idea.deleted", dPending);
  assert.equal(pendingAudit?.before?.status, "pending");
  assert.equal(pendingAudit?.before?.description, TEXT(40));
  assert.equal(pendingAudit?.before?.authorId, deletee);
  assert.deepEqual(pendingAudit?.after, { reason: "Spam.", votes: 0 });
  const freed = await submitAs(deletee, 43);
  assert.equal((await getComingSoon(viewer(deletee))).limits.today, 3, "a deleted idea leaves both caps");

  // A published idea: its votes cascade, only its own notifications go, the badge stays, nobody is told.
  assert.deepEqual(await publishIdea(admin, dPublished, { title: "Doomed item", description: TEXT(41), expectedUpdatedAt: await version(dPublished) }), { ok: true });
  assert.deepEqual(await publishIdea(admin, dKept, { title: "Kept item", description: TEXT(42), expectedUpdatedAt: await version(dKept) }), { ok: true });
  assert.equal((await voteIdea(voter, dPublished, true)).ok, true);
  const submittedBefore = await notes(admin, "idea.submitted");
  const deleteeNotes = await noteCount(deletee);
  assert.deepEqual(await deleteIdea(admin, dPublished, { reason: null, expectedUpdatedAt: undefined }), { ok: true }, "no version needed once published");
  assert.equal((await q(`select 1 from feature_idea_votes where idea_id = $1`, [dPublished])).rowCount, 0, "the votes cascade");
  assert.deepEqual(await notes(deletee, "idea.published"), [{ ideaId: dKept, title: "Kept item" }], "only the deleted idea's notification goes");
  assert.equal(await noteCount(deletee), deleteeNotes - 1, "no notification about the delete");
  assert.deepEqual(await notes(admin, "idea.submitted"), submittedBefore, "idea.submitted rows untouched");
  assert.equal(await hasBadge(deletee, "idea_published"), true, "Bright Idea stays");
  const publishedAudit = await audit("idea.deleted", dPublished);
  assert.equal(publishedAudit?.before?.title, "Doomed item");
  assert.deepEqual(publishedAudit?.after, { reason: null, votes: 2 });
  assert.equal((await getComingSoon(plain)).items.some((i) => i.id === dPublished), false, "off Coming soon");
  assert.equal((await getComingSoon(viewer(deletee))).mine.some((m) => m.id === dPublished), false, "off Your ideas");

  // Closed and rejected ideas take their notifications with them.
  assert.deepEqual(await closeIdea(admin, dKept, { outcome: "wont_do", note: null }), { ok: true });
  assert.deepEqual(await deleteIdea(admin, dKept, { reason: null, expectedUpdatedAt: undefined }), { ok: true }, "a closed idea");
  assert.deepEqual(await notes(deletee, "idea.published"), []);
  assert.deepEqual(await notes(deletee, "idea.closed"), []);
  assert.deepEqual(await rejectIdea(admin, freed, { reason: null, expectedUpdatedAt: await version(freed) }), { ok: true });
  assert.deepEqual(await deleteIdea(admin, freed, { reason: null, expectedUpdatedAt: undefined }), { ok: true }, "a rejected idea");
  assert.deepEqual(await notes(deletee, "idea.rejected"), []);
  assert.equal((await audit("idea.deleted", freed))?.before?.status, "rejected");

  // An item with no proposer; two admins at once: one deletes, the other gets 404.
  const orphanD = await one(
    `insert into feature_ideas (status, title, description, submitted_description, decided_at, published_at)
     values ('published', 'Orphan to delete', $1, $1, now(), now()) returning id`,
    [TEXT(44)],
  );
  const both = await Promise.all([
    deleteIdea(admin, orphanD, { reason: null, expectedUpdatedAt: undefined }),
    deleteIdea(admin, orphanD, { reason: null, expectedUpdatedAt: undefined }),
  ]);
  assert.deepEqual(both.map((r) => (r.ok ? 204 : r.status)).sort(), [204, 404]);
  assert.equal((await audit("idea.deleted", orphanD))?.before?.authorId, null);
  const gone = { ok: false, status: 404, error: "not found" };
  assert.deepEqual(await deleteIdea(admin, id3, { reason: null, expectedUpdatedAt: undefined }), gone, "a withdrawn idea");
  assert.deepEqual(await deleteIdea(admin, "00000000-0000-4000-8000-000000000000", { reason: null, expectedUpdatedAt: undefined }), gone);

  // ── Erasure ───────────────────────────────────────────────────────────────────────────────────
  const e1 = await submitIdea(viewer(erasee), TEXT(9));
  const e2 = await submitIdea(viewer(erasee), TEXT(10));
  assert.ok(e1.ok && e2.ok);
  const idE1 = e1.ok ? e1.idea.id : "";
  const idE2 = e2.ok ? e2.idea.id : "";
  assert.deepEqual(await publishIdea(admin, idE1, { title: "Erasure survivor", description: TEXT(9), expectedUpdatedAt: await version(idE1) }), { ok: true });
  if (seeded[0]) assert.equal((await voteIdea(erasee, seeded[0].id, true)).ok, true);
  await q(`update users set idea_attribution_hidden = true, idea_votes_hidden = true where id = $1`, [erasee]);
  const erased = await eraseUser(admin, erasee, null);
  assert.equal(erased.ok, true);
  assert.equal((await q(`select 1 from feature_ideas where id = $1`, [idE2])).rowCount, 0, "the pending idea is deleted");
  assert.equal((await q(`select 1 from feature_ideas where id = $1`, [idE1])).rowCount, 1, "the published idea stays");
  assert.equal((await q(`select 1 from feature_idea_votes where user_id = $1`, [erasee])).rowCount, 0, "every vote they cast goes");
  assert.equal((await q<{ h: boolean }>(`select idea_attribution_hidden as h from users where id = $1`, [erasee])).rows[0]!.h, false, "reset by the scrub");
  assert.equal((await q<{ h: boolean }>(`select idea_votes_hidden as h from users where id = $1`, [erasee])).rows[0]!.h, false, "the upvoter opt-out is reset too");
  const survivor = (await getComingSoon(plain)).items.find((i) => i.id === idE1);
  assert.equal(survivor?.suggestedBy, null, "shown unattributed");
  // Leave no published survivor behind for other suites.
  await closeIdea(admin, idE1, { outcome: "wont_do", note: null });
});

test("Upvoted by (v2.45.0): the strip, hidden voters, the full list, the vote answer, the ETag", { skip: !enabled }, async () => {
  const q = <T extends object = Record<string, unknown>>(sql: string, params: unknown[] = []) => pool.query<T>(sql, params);
  const one = async (sql: string, params: unknown[] = []) => (await q<{ id: string }>(sql, params)).rows[0]!.id;
  const mkUser = (oid: string) =>
    one(
      `insert into users (entra_object_id, email, display_name, status) values ($1, $1 || '@org', $1, 'active')
       on conflict (entra_object_id) do update set status = 'active', erased_at = null, idea_votes_hidden = false returning id`,
      [oid],
    );
  // Fixed actors (audit_log FK — never deleted, see the dbtest memory note).
  const admin = await mkUser("ideas-platform-admin");
  const proposer = await mkUser("voters-proposer");
  const a = await mkUser("voters-a");
  const b = await mkUser("voters-b");
  const c = await mkUser("voters-c");
  const d = await mkUser("voters-d");
  const e = await mkUser("voters-e");
  const f = await mkUser("voters-f");
  const hider = await mkUser("voters-hider");
  const leaver = await mkUser("voters-leaver");
  const everyone = [proposer, a, b, c, d, e, f, hider, leaver];
  await q(`delete from feature_ideas where author_id = $1`, [proposer]);
  await q(`delete from feature_idea_votes where user_id = any($1::uuid[])`, [everyone]);

  const viewer = (userId: string, isPlatformAdmin = false): IdeaViewer => ({ userId, isPlatformAdmin });
  const version = async (id: string) => (await q<{ v: string }>(`select updated_at::text as v from feature_ideas where id = $1`, [id])).rows[0]!.v;
  const s = await submitIdea(viewer(proposer), TEXT(60));
  assert.ok(s.ok);
  const id = s.ok ? s.idea.id : "";
  assert.deepEqual(await getIdeaVoters(a, id), { ok: false, status: 404 }, "a pending idea has no list");
  assert.deepEqual(await publishIdea(admin, id, { title: "Voters item", description: TEXT(60), expectedUpdatedAt: await version(id) }), { ok: true });
  try {
    // Votes a minute apart, oldest first: the proposer's auto-vote, then a … f, the hider, the leaver.
    for (const u of [a, b, c, d, e, f, hider, leaver]) assert.equal((await voteIdea(u, id, true)).ok, true);
    for (const [i, u] of [proposer, a, b, c, d, e, f, hider, leaver].entries()) {
      await q(`update feature_idea_votes set created_at = now() - make_interval(mins => $3) where idea_id = $1 and user_id = $2`, [id, u, 100 - i]);
    }
    await q(`update users set idea_votes_hidden = true where id = $1`, [hider]);
    await q(`update users set status = 'inactive' where id = $1`, [leaver]);
    const strip = async (v: IdeaViewer) => (await getComingSoon(v)).items.find((i) => i.id === id)!;

    // Everyone else: newest first, five at most, the hider absent (for a platform admin too), the leaver listed.
    for (const v of [viewer(a), viewer(admin, true)]) {
      const it = await strip(v);
      assert.equal(it.votes, 9);
      assert.deepEqual(it.voters.map((x) => x.id), [leaver, f, e, d, c]);
      assert.equal(it.votersTotal, 8, "every voter but the hider");
      assert.ok(it.voters.every((x) => !x.onlyYou));
    }
    // The hider sees themself, at their vote's place and marked only you.
    const own = await getComingSoon(viewer(hider));
    assert.equal(own.votesHidden, true);
    const ownItem = own.items.find((i) => i.id === id)!;
    assert.deepEqual(ownItem.voters.map((x) => x.id), [leaver, hider, f, e, d]);
    assert.equal(ownItem.voters[1]!.onlyYou, true);
    assert.equal(ownItem.votersTotal, 9);
    assert.equal((await getComingSoon(viewer(a))).votesHidden, false);

    // The full list: strip order, the proposer's auto-vote included, the hidden ones only counted.
    const list = await getIdeaVoters(a, id);
    assert.ok(list.ok);
    assert.deepEqual(list.ok && list.voters.map((x) => x.id), [leaver, f, e, d, c, b, a, proposer]);
    assert.equal(list.ok && list.votersTotal, 8);
    assert.equal(list.ok && list.hiddenCount, 1);
    const hiderList = await getIdeaVoters(hider, id);
    assert.equal(hiderList.ok && hiderList.hiddenCount, 0, "the viewer is listed to themself");

    // The vote answer carries the caller's view of the strip, their own bubble first.
    await q(`delete from feature_idea_votes where idea_id = $1 and user_id = $2`, [id, a]);
    const back = await voteIdea(a, id, true);
    assert.ok(back.ok);
    assert.deepEqual(back.ok && back.voters.map((x) => x.id), [a, leaver, f, e, d]);
    assert.equal(back.ok && back.votersTotal, 8);
    const gone = await voteIdea(a, id, false);
    assert.equal(gone.ok && gone.votersTotal, 7);
    assert.equal(gone.ok && gone.voters.some((x) => x.id === a), false);

    // The opt-out applies live to earlier votes, both ways.
    await setUserIdeaVotesHidden(f, true);
    assert.equal((await strip(viewer(b))).voters.some((x) => x.id === f), false);
    await setUserIdeaVotesHidden(f, false);
    assert.equal((await strip(viewer(b))).voters[1]!.id, f);

    // The ETag: the same for an unchanged list, another after someone else's vote, 304 when it matches.
    const req = (tag?: string) => new Request("http://skilly.test/api/coming-soon", tag ? { headers: { "if-none-match": tag } } : {});
    const tag1 = conditionalJson(req(), await getComingSoon(viewer(b))).headers.get("etag")!;
    assert.equal(conditionalJson(req(), await getComingSoon(viewer(b))).headers.get("etag"), tag1);
    const unchanged = conditionalJson(req(tag1), await getComingSoon(viewer(b)));
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), "");
    assert.equal((await voteIdea(a, id, true)).ok, true);
    const changed = conditionalJson(req(tag1), await getComingSoon(viewer(b)));
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), tag1);

    // The list stops at 100, newest first.
    const bulk = (
      await q<{ id: string }>(
        `insert into users (entra_object_id, email, display_name, status)
         select 'voters-bulk-' || lpad(n::text, 3, '0'), 'voters-bulk-' || n || '@org', 'Bulk ' || n, 'active' from generate_series(1, 101) n
         on conflict (entra_object_id) do update set status = 'active', idea_votes_hidden = false returning id`,
      )
    ).rows.map((r) => r.id);
    await q(
      `insert into feature_idea_votes (idea_id, user_id, created_at)
       select $1, u, now() + make_interval(secs => i::int) from unnest($2::uuid[]) with ordinality as t(u, i)`,
      [id, bulk],
    );
    const big = await getIdeaVoters(a, id);
    assert.ok(big.ok);
    assert.equal(big.ok && big.voters.length, 100);
    assert.equal(big.ok && big.votersTotal, 109);
    assert.equal(big.ok && big.voters[0]!.id, bulk[bulk.length - 1], "the newest vote first");

    assert.deepEqual(await getIdeaVoters(a, "00000000-0000-4000-8000-000000000000"), { ok: false, status: 404 });
  } finally {
    await q(`update users set status = 'active', idea_votes_hidden = false where id = any($1::uuid[])`, [everyone]);
    // Leave nothing published for other suites; closing deletes the votes.
    assert.deepEqual(await closeIdea(admin, id, { outcome: "wont_do", note: null }), { ok: true });
  }
  assert.deepEqual(await getIdeaVoters(a, id), { ok: false, status: 404 }, "a closed idea has no list");
});
