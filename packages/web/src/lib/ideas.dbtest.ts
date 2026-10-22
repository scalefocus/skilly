// Live-DB integration test for feature ideas (SKILLY_SPEC.md §60). Gated by SKILLY_DB_E2E=1.
// Verifies: submission bounds and both caps (withdrawn rows still count, Retry-After on the daily one),
// the coalesced `idea.submitted` row for platform admins, own-idea edit / withdraw (404 / 409),
// publish (stale version → 409, the proposer's auto-vote, Bright Idea, the notification, the audit
// row), reject, admin edit, close (votes deleted, outcome notified) and Planned → Shipped (Made It
// Real), the votes (idempotent, audience-gated teasers, 404 off a published idea), the merged list
// (ordering, attribution and its opt-out, inert keys), an inactive author, the admin list, and GDPR
// erasure (published ideas stay unattributed, everything else and every vote goes).
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
  voteTeaser,
  withdrawOwnIdea,
  type IdeaViewer,
} from "./ideas";
import { eraseUser } from "./eraseUser";
import { UPCOMING, upcomingFor } from "../app/whats-new/upcoming";

const enabled = process.env.SKILLY_DB_E2E === "1";

const TEXT = (n: number) => `Feature idea number ${n}: let me export my installed skills as a CSV file.`;

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
  await q(`delete from upcoming_votes where user_id = any($1::uuid[])`, [mine]);
  await q(`delete from notifications where user_id = any($1::uuid[]) and type like 'idea.%'`, [mine]);
  await q(`delete from user_achievements where user_id = any($1::uuid[]) and key in ('idea_published', 'idea_shipped')`, [mine]);
  await q(`update users set idea_attribution_hidden = false, idea_notifications = true where id = any($1::uuid[])`, [mine]);

  const viewer = (userId: string, isPlatformAdmin = false): IdeaViewer => ({ userId, isPlatformAdmin, administersNamespace: false });
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
  assert.deepEqual(await submitIdea(author, "too short"), { ok: false, status: 422, error: "description must be at least 20 characters" });
  const s1 = await submitIdea(author, `  ${TEXT(1)}  `);
  assert.ok(s1.ok);
  const id1 = s1.ok ? s1.idea.id : "";
  assert.equal(s1.ok && s1.idea.description, TEXT(1), "trimmed");
  const s2 = await submitIdea(author, TEXT(2));
  const s3 = await submitIdea(author, TEXT(3));
  assert.ok(s2.ok && s3.ok);
  const id2 = s2.ok ? s2.idea.id : "";
  const id3 = s3.ok ? s3.idea.id : "";
  const adminRows = await notes(admin, "idea.submitted");
  assert.equal(adminRows.length, 1, "one coalesced row per admin");
  assert.equal(adminRows[0]!.count, 3);
  assert.equal((await notes(author, "idea.submitted")).length, 0, "the author is not an admin");
  assert.equal(await pendingIdeaCount(), pendingBefore + 3);

  const capped = await submitIdea(author, TEXT(4));
  assert.equal(!capped.ok && capped.status === 429 && capped.reason, "pending_limit");

  // Withdrawn rows leave the pending cap but still count toward the daily one.
  assert.deepEqual(await withdrawOwnIdea(author, id3), { ok: true });
  const s4 = await submitIdea(author, TEXT(4));
  assert.ok(s4.ok);
  assert.deepEqual(await withdrawOwnIdea(author, s4.ok ? s4.idea.id : ""), { ok: true });
  const s5 = await submitIdea(author, TEXT(5));
  assert.ok(s5.ok);
  assert.deepEqual(await withdrawOwnIdea(author, s5.ok ? s5.idea.id : ""), { ok: true });
  const daily = await submitIdea(author, TEXT(6));
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

  // ── The merged list, votes, attribution ───────────────────────────────────────────────────────
  const plain = viewer(voter);
  const cs = await getComingSoon(plain);
  const teaserCount = upcomingFor(UPCOMING, plain).length;
  assert.equal(cs.items.filter((i) => i.kind === "teaser").length, teaserCount);
  const mineIdea = cs.items.find((i) => i.kind === "idea" && i.id === id1);
  assert.ok(mineIdea && mineIdea.kind === "idea");
  assert.equal(mineIdea.votes, 1);
  assert.equal(mineIdea.voted, false);
  assert.equal(mineIdea.suggestedBy?.id, author);
  for (let i = 1; i < cs.items.length; i++) assert.ok(cs.items[i - 1]!.votes >= cs.items[i]!.votes, "most votes first");
  assert.deepEqual(cs.limits, { pending: 0, pendingMax: 3, today: 0, dailyMax: 5 });

  assert.deepEqual(await voteIdea(voter, id1, true), { ok: true, votes: 2, voted: true });
  assert.deepEqual(await voteIdea(voter, id1, true), { ok: true, votes: 2, voted: true }, "idempotent");
  assert.deepEqual(await voteIdea(voter, id1, false), { ok: true, votes: 1, voted: false });
  assert.deepEqual(await voteIdea(voter, id1, true), { ok: true, votes: 2, voted: true });

  const everyone = UPCOMING.find((e) => e.audience === "everyone")!;
  const adminsOnly = UPCOMING.find((e) => e.audience !== "everyone");
  assert.equal((await voteTeaser(plain, everyone.key, true)).ok, true);
  assert.deepEqual(await voteTeaser(plain, "no-such-teaser", true), { ok: false, status: 404 });
  if (adminsOnly) {
    assert.deepEqual(await voteTeaser(plain, adminsOnly.key, true), { ok: false, status: 404 }, "an admin-only teaser is invisible");
    assert.equal((await voteTeaser(viewer(admin, true), adminsOnly.key, true)).ok, true);
    await voteTeaser(viewer(admin, true), adminsOnly.key, false);
  }
  const afterVote = await getComingSoon(plain);
  const t = afterVote.items.find((i) => i.kind === "teaser" && i.key === everyone.key);
  assert.equal(t?.voted, true);
  // A key that left the list never surfaces (§60.12).
  await q(`insert into upcoming_votes (upcoming_key, user_id) values ('shipped-long-ago', $1) on conflict do nothing`, [voter]);
  assert.equal((await getComingSoon(plain)).items.some((i) => i.kind === "teaser" && i.key === "shipped-long-ago"), false);

  await q(`update users set idea_attribution_hidden = true where id = $1`, [author]);
  const hidden = (await getComingSoon(plain)).items.find((i) => i.kind === "idea" && i.id === id1);
  assert.equal(hidden?.kind === "idea" && hidden.suggestedBy, null, "the opt-out applies live");
  await q(`update users set idea_attribution_hidden = false where id = $1`, [author]);

  const authorView = await getComingSoon(viewer(author));
  assert.deepEqual(authorView.mine.map((m) => m.status).sort(), ["published", "rejected"], "withdrawn ideas are hidden");

  // ── Admin edit, close as Planned, then Shipped ────────────────────────────────────────────────
  assert.deepEqual(await editPublishedIdea(admin, id1, { title: "Export installed skills" }), { ok: true });
  assert.deepEqual((await audit("idea.updated", id1))?.after, { title: "Export installed skills", description: TEXT(1) });
  assert.deepEqual(await editPublishedIdea(admin, id2, { title: "Nope" }), { ok: false, status: 409, error: "only a published idea can be edited" });

  assert.equal((await closeIdea(admin, id1, { outcome: "done", note: null })).ok, false, "unknown outcome → 422");
  assert.deepEqual(await closeIdea(admin, id1, { outcome: "planned", note: "Next quarter." }), { ok: true });
  assert.equal((await q(`select 1 from feature_idea_votes where idea_id = $1`, [id1])).rowCount, 0, "closing deletes the votes");
  assert.deepEqual((await audit("idea.closed", id1))?.after, { outcome: "planned", note: "Next quarter.", votes: 2 });
  assert.deepEqual(await notes(author, "idea.closed"), [{ ideaId: id1, title: "Export installed skills", outcome: "planned", adminNote: "Next quarter." }]);
  assert.deepEqual(await voteIdea(voter, id1, true), { ok: false, status: 404 });
  assert.equal(await hasBadge(author, "idea_shipped"), false);

  assert.deepEqual(await markIdeaShipped(admin, id1), { ok: true });
  assert.equal(await hasBadge(author, "idea_shipped"), true, "Made It Real");
  assert.deepEqual(await notes(author, "idea.shipped"), [{ ideaId: id1, title: "Export installed skills" }]);
  assert.deepEqual(await markIdeaShipped(admin, id1), { ok: false, status: 409, error: "only an idea closed as Planned can be marked shipped" });

  // ── An inactive author: published, voted, but no notification and no badge ───────────────────
  const a2 = await submitIdea(author2, TEXT(8));
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
  const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => submitIdea(racer, TEXT(20 + i))));
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
  const e1 = await submitIdea(erasee, TEXT(9));
  const e2 = await submitIdea(erasee, TEXT(10));
  assert.ok(e1.ok && e2.ok);
  const idE1 = e1.ok ? e1.idea.id : "";
  const idE2 = e2.ok ? e2.idea.id : "";
  assert.deepEqual(await publishIdea(admin, idE1, { title: "Erasure survivor", description: TEXT(9), expectedUpdatedAt: await version(idE1) }), { ok: true });
  await voteTeaser(viewer(erasee), everyone.key, true);
  await q(`update users set idea_attribution_hidden = true where id = $1`, [erasee]);
  const erased = await eraseUser(admin, erasee, null);
  assert.equal(erased.ok, true);
  assert.equal((await q(`select 1 from feature_ideas where id = $1`, [idE2])).rowCount, 0, "the pending idea is deleted");
  assert.equal((await q(`select 1 from feature_ideas where id = $1`, [idE1])).rowCount, 1, "the published idea stays");
  assert.equal((await q(`select 1 from feature_idea_votes where user_id = $1`, [erasee])).rowCount, 0);
  assert.equal((await q(`select 1 from upcoming_votes where user_id = $1`, [erasee])).rowCount, 0);
  assert.equal((await q<{ h: boolean }>(`select idea_attribution_hidden as h from users where id = $1`, [erasee])).rows[0]!.h, false, "reset by the scrub");
  const survivor = (await getComingSoon(plain)).items.find((i) => i.kind === "idea" && i.id === idE1);
  assert.equal(survivor?.kind === "idea" && survivor.suggestedBy, null, "shown unattributed");
  // Leave no published survivor behind for other suites.
  await closeIdea(admin, idE1, { outcome: "wont_do", note: null });
});
