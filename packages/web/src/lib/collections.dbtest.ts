// Live-DB integration test for skill collections (SKILLY_SPEC.md §37). Gated behind SKILLY_DB_E2E=1.
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Covers (§37.13): create with a first skill, the 50-collection and 50-skill limits, name_taken
// ignoring case, ineligible skills 422, owner-only edits (403), admin delete audited and owner delete
// not; eviction on archive / last-version yank / visibility narrowing / hard delete, and no re-add on
// restore; a collection read never returns a restricted skill even with an item row forced past
// eviction; the ?collection= and ?collectionsBy= catalog views; the suggest matcher (2-char floor,
// empty + inactive-owner exclusion, top 3, name-hit ranking); the follower fan-out and Mixtape; the
// leaderboard stat's 3-skill threshold; erasure deleting collections and deprovision keeping them.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess } from "@skilly/shared";
import { evictFromCollections } from "@skilly/shared/collections";
import { pool } from "./db";
import {
  addSkillToCollection,
  createCollection,
  deleteCollection,
  getCollection,
  listMyCollections,
  listNonEmptyCollectionsOf,
  removeSkillFromCollection,
  suggestCollections,
  updateCollection,
} from "./collections";
import { searchSkills } from "./catalog";
import { setSkillArchived, setVersionYanked } from "./manage";
import { followUser } from "./follows";
import { getLeaderboard } from "./leaderboard";
import { eraseUser } from "./eraseUser";

const enabled = process.env.SKILLY_DB_E2E === "1";
const P = "colx";
const NS = `${P}-ns`;

const platform: EffectiveAccess = { isPlatformAdmin: true, namespaceRoles: new Map() };
const outsider: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map() };

async function mkUser(tag: string): Promise<string> {
  const oid = `${P}-${tag}`;
  const id = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name, status) values ($1,$2,$3,'active')
     on conflict (entra_object_id) do update set email = excluded.email, display_name = excluded.display_name, status = 'active', erased_at = null
     returning id`,
    [oid, `${oid}@org`, oid],
  )).rows[0]!.id;
  await pool.query(`update users set allow_follows = true, leaderboard_hidden = false where id = $1`, [id]);
  await pool.query(`delete from skill_collections where owner_id = $1`, [id]);
  await pool.query(`delete from user_follows where follower_id = $1 or followee_id = $1`, [id]);
  await pool.query(`delete from user_achievements where user_id = $1`, [id]);
  await pool.query(`delete from notifications where user_id = $1`, [id]);
  return id;
}

let nsId = "";
async function ns(): Promise<string> {
  if (nsId) return nsId;
  nsId = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ($1,'Collections NS', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
    [NS],
  )).rows[0]!.id;
  return nsId;
}

/** An eligible-by-default skill (org, active, one git-published version). */
async function mkSkill(slug: string, opts: { visibility?: "org" | "namespace"; status?: "active" | "archived"; published?: boolean } = {}): Promise<string> {
  const id = (await pool.query<{ id: string }>(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
     values ($1,$2,$2,'d','claude','hosted',$3,$4)
     on conflict (namespace_id, slug) do update set visibility = excluded.visibility, status = excluded.status returning id`,
    [await ns(), `${P}-${slug}`, opts.visibility ?? "org", opts.status ?? "active"],
  )).rows[0]!.id;
  await pool.query(
    `insert into skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, git_published)
     values ($1,'1.0.0',false,'active','k/colx','h',$2)
     on conflict (skill_id, semver) do update set status = 'active', git_published = excluded.git_published`,
    [id, opts.published ?? true],
  );
  return id;
}

const ok = <T>(r: { ok: true; value: T } | { ok: false; status: number; error: string }): T => {
  if (!r.ok) throw new Error(`expected ok, got ${r.status} ${r.error}`);
  return r.value;
};
const err = (r: { ok: boolean; status?: number; error?: string }) => (r.ok ? "ok" : `${r.status} ${r.error}`);
const slugs = (rows: { skillSlug: string }[]) => rows.map((r) => r.skillSlug.replace(`${P}-`, "")).sort();

test("collections: create, limits, names, owner-only edits, membership", { skip: !enabled }, async () => {
  const owner = await mkUser("owner");
  const other = await mkUser("other");
  const a = await mkSkill("a");
  const b = await mkSkill("b");
  const restricted = await mkSkill("restricted", { visibility: "namespace" });
  const archived = await mkSkill("archived", { status: "archived" });
  const unpublished = await mkSkill("unpublished", { published: false });

  assert.equal(err(await createCollection(owner, "   ", a)), "422 a collection name is required");
  assert.equal(err(await createCollection(owner, "x".repeat(61), a)).startsWith("422"), true);
  for (const bad of [restricted, archived, unpublished, "not-a-uuid"]) {
    assert.equal(err(await createCollection(owner, "Bad", bad)).startsWith("422"), true, `ineligible ${bad}`);
  }

  const c = ok(await createCollection(owner, "  Onboarding pack ", a));
  assert.equal(c.name, "Onboarding pack");
  assert.equal(c.skillCount, 1);
  assert.equal(err(await createCollection(owner, "ONBOARDING PACK", b)), "409 name_taken");
  assert.equal(ok(await createCollection(other, "Onboarding pack", a)).name, "Onboarding pack", "names are per owner");

  // Owner-only edits: a non-owner gets 403 (collections are not secret), an unknown id 404.
  assert.equal(err(await addSkillToCollection(other, c.id, b)), "403 only the owner can change this collection");
  assert.equal(err(await updateCollection(other, c.id, { name: "Mine now" })), "403 only the owner can change this collection");
  assert.equal(err(await removeSkillFromCollection(other, c.id, a)), "403 only the owner can change this collection");
  assert.equal(err(await addSkillToCollection(owner, "00000000-0000-4000-8000-000000000000", b)), "404 not found");

  // Membership: idempotent add/remove, ineligible 422.
  ok(await addSkillToCollection(owner, c.id, b));
  ok(await addSkillToCollection(owner, c.id, b));
  assert.equal(err(await addSkillToCollection(owner, c.id, restricted)).startsWith("422"), true);
  assert.equal((await getCollection(c.id))!.skillCount, 2);
  ok(await removeSkillFromCollection(owner, c.id, b));
  ok(await removeSkillFromCollection(owner, c.id, b));
  assert.equal((await getCollection(c.id))!.skillCount, 1);

  // The popup's read: ticks + item counts.
  const mine = await listMyCollections(owner, a);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.contains, true);
  assert.equal((await listMyCollections(owner, b))[0]!.contains, false);

  // Rename + description, and the name_taken rule on rename.
  ok(await createCollection(owner, "Second", a));
  assert.equal(err(await updateCollection(owner, c.id, { name: "second" })), "409 name_taken");
  assert.equal(err(await updateCollection(owner, c.id, { description: "d".repeat(501) })).startsWith("422"), true);
  assert.deepEqual(ok(await updateCollection(owner, c.id, { name: "Starter kit", description: "  For new joiners " })), { name: "Starter kit", description: "For new joiners" });
  assert.deepEqual(ok(await updateCollection(owner, c.id, { description: "" })), { name: "Starter kit", description: null });

  // 50 collections per owner: the 51st is refused.
  await pool.query(
    `insert into skill_collections (owner_id, name) select $1, 'bulk ' || g from generate_series(1, 48) g`,
    [owner],
  );
  assert.equal((await listMyCollections(owner)).length, 50);
  assert.equal(err(await createCollection(owner, "Fifty-first", a)), "409 collection_limit");

  // 50 skills per collection: the 51st is refused, an existing member stays idempotent.
  const many: string[] = [];
  for (let i = 0; i < 50; i++) many.push(await mkSkill(`bulk-${i}`));
  const full = (await pool.query<{ id: string }>(
    `insert into skill_collections (owner_id, name) values ($1, 'Full one') returning id`, [other],
  )).rows[0]!.id;
  await pool.query(`insert into skill_collection_items (collection_id, skill_id) select $1, unnest($2::uuid[])`, [full, many]);
  assert.equal(err(await addSkillToCollection(other, full, a)), "409 collection_full");
  ok(await addSkillToCollection(other, full, many[0]!));
});

test("collections: delete — owner unaudited, platform admin audited, others 403", { skip: !enabled }, async () => {
  const owner = await mkUser("del-owner");
  const admin = await mkUser("del-admin");
  const stranger = await mkUser("del-stranger");
  const a = await mkSkill("a");
  const audits = async (id: string) =>
    Number((await pool.query(`select count(*) from audit_log where action = 'collection.deleted' and target_id = $1`, [id])).rows[0].count);

  const mine = ok(await createCollection(owner, "Mine", a));
  assert.equal(err(await deleteCollection(outsider, stranger, mine.id)), "403 only the owner or a platform admin can delete this collection");
  ok(await deleteCollection(outsider, owner, mine.id));
  assert.equal(await getCollection(mine.id), null);
  assert.equal(await audits(mine.id), 0, "an owner's own delete is not audited");

  const theirs = ok(await createCollection(owner, "Theirs", a));
  ok(await deleteCollection(platform, admin, theirs.id));
  assert.equal(await audits(theirs.id), 1, "an admin deleting someone else's collection is audited");
  const row = (await pool.query<{ before: { ownerId: string; name: string } }>(
    `select before from audit_log where action = 'collection.deleted' and target_id = $1`, [theirs.id],
  )).rows[0]!;
  assert.equal(row.before.ownerId, owner);
  assert.equal(row.before.name, "Theirs");
  assert.equal(err(await deleteCollection(platform, admin, theirs.id)), "404 not found");
});

test("collections: eviction on archive, last-version yank, narrowing and hard delete — never re-added (§37.4)", { skip: !enabled }, async () => {
  const owner = await mkUser("evict");
  const arch = await mkSkill("ev-arch");
  const yank = await mkSkill("ev-yank");
  const narrow = await mkSkill("ev-narrow");
  const gone = await mkSkill("ev-gone");
  const keep = await mkSkill("ev-keep");
  const c = ok(await createCollection(owner, "Evictions", keep));
  for (const s of [arch, yank, narrow, gone]) ok(await addSkillToCollection(owner, c.id, s));
  const items = async () =>
    (await pool.query<{ skill_id: string }>(`select skill_id from skill_collection_items where collection_id = $1`, [c.id])).rows.map((r) => r.skill_id);

  const nsSlug = NS;
  assert.deepEqual(await setSkillArchived(pool, { access: platform, actorUserId: owner, namespaceSlug: nsSlug, skillSlug: `${P}-ev-arch`, archived: true }), { ok: true });
  assert.equal((await items()).includes(arch), false, "archived → evicted");
  await setSkillArchived(pool, { access: platform, actorUserId: owner, namespaceSlug: nsSlug, skillSlug: `${P}-ev-arch`, archived: false });
  assert.equal((await items()).includes(arch), false, "restoring never re-adds");

  await setVersionYanked(pool, { access: platform, actorUserId: owner, namespaceSlug: nsSlug, skillSlug: `${P}-ev-yank`, semver: "1.0.0", yanked: true });
  assert.equal((await items()).includes(yank), false, "last installable version yanked → evicted");
  await setVersionYanked(pool, { access: platform, actorUserId: owner, namespaceSlug: nsSlug, skillSlug: `${P}-ev-yank`, semver: "1.0.0", yanked: false });
  assert.equal((await items()).includes(yank), false, "restoring the version never re-adds");

  // No route narrows visibility today; any future one runs the shared statement.
  await pool.query(`update skills set visibility = 'namespace' where id = $1`, [narrow]);
  await evictFromCollections(pool, narrow);
  assert.equal((await items()).includes(narrow), false, "narrowed → evicted");
  await evictFromCollections(pool, keep);
  assert.equal((await items()).includes(keep), true, "the statement is a no-op for an eligible skill");

  // A permanent skill delete (the §7 routine's carve-out lets the version cascade through).
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local skilly.allow_version_delete = 'on'");
    await client.query(`delete from skills where id = $1`, [gone]);
    await client.query("commit");
  } finally {
    client.release();
  }
  assert.equal((await items()).includes(gone), false, "hard delete cascades");
  await pool.query(`update skills set visibility = 'org' where id = $1`, [narrow]);
});

test("collections: a forced restricted item never surfaces; catalog views and chips (§37.4 / §37.5)", { skip: !enabled }, async () => {
  const owner = await mkUser("view");
  const a = await mkSkill("view-a");
  const b = await mkSkill("view-b");
  const restricted = await mkSkill("view-restricted", { visibility: "namespace" });
  const c1 = ok(await createCollection(owner, "View one", a));
  const c2 = ok(await createCollection(owner, "View two", b));
  ok(await createCollection(owner, "View empty", b));
  ok(await removeSkillFromCollection(owner, (await listMyCollections(owner)).find((c) => c.name === "View empty")!.id, b));
  // Force a restricted item past the eligibility gate, as a missed eviction would.
  await pool.query(`insert into skill_collection_items (collection_id, skill_id) values ($1, $2)`, [c1.id, restricted]);

  const member: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map([[await ns(), "namespace_member"]]) };
  for (const viewer of [outsider, member, platform]) {
    assert.deepEqual(slugs(await searchSkills(viewer, { collectionId: c1.id })), ["view-a"], "never the restricted item, for anyone");
  }
  assert.equal((await getCollection(c1.id))!.skillCount, 1, "the eligible count ignores it too");
  assert.deepEqual(slugs(await searchSkills(outsider, { collectionsByUserId: owner })), ["view-a", "view-b"]);
  const chips = await listNonEmptyCollectionsOf(owner);
  assert.deepEqual(chips.map((c) => c.name).sort(), ["View one", "View two"], "empty collections get no chip");
  assert.ok(chips.find((c) => c.id === c2.id));
});

test("collections: suggest — floor, ranking, top 3, empty and inactive owners excluded (§37.6)", { skip: !enabled }, async () => {
  const ada = await mkUser("sug-ada");
  const leaver = await mkUser("sug-leaver");
  await pool.query(`update users set display_name = 'Zebracurator Ada' where id = $1`, [ada]);
  const a = await mkSkill("sug-a");
  const b = await mkSkill("sug-b");
  ok(await createCollection(ada, "Zebrapack basics", a));
  const big = ok(await createCollection(ada, "Other zebrapack", a));
  ok(await addSkillToCollection(ada, big.id, b));
  const described = ok(await createCollection(ada, "Plain", a));
  ok(await updateCollection(ada, described.id, { description: "all about zebrapack" }));
  const empty = ok(await createCollection(ada, "Zebrapack empty", a));
  ok(await removeSkillFromCollection(ada, empty.id, a));
  ok(await createCollection(leaver, "Zebrapack leaver", a));
  await pool.query(`update users set status = 'inactive' where id = $1`, [leaver]);

  assert.deepEqual(await suggestCollections("z"), [], "below the 2-char floor");
  const hits = await suggestCollections("zebrapack");
  assert.equal(hits.length, 3, "top 3");
  assert.deepEqual(hits.map((h) => h.name), ["Other zebrapack", "Zebrapack basics", "Plain"], "name hits first (bigger first), then description hits");
  assert.ok(!hits.some((h) => h.name === "Zebrapack empty" || h.name === "Zebrapack leaver"));
  const byOwner = await suggestCollections("zebracurator");
  assert.ok(byOwner.length > 0 && byOwner.every((h) => h.owner.id === ada), "owner-name match");
  // A deprovisioned owner's collection still opens from a link.
  const leaverColl = (await pool.query<{ id: string }>(`select id from skill_collections where owner_id = $1`, [leaver])).rows[0]!.id;
  assert.equal((await getCollection(leaverColl))!.owner.active, false);
  await pool.query(`update users set status = 'active' where id = $1`, [leaver]);
});

test("collections: follower fan-out, Mixtape, leaderboard threshold, erasure (§37.8 / §37.10)", { skip: !enabled }, async () => {
  const curator = await mkUser("lb-curator");
  const fan = await mkUser("lb-fan");
  const admin = await mkUser("lb-admin");
  assert.deepEqual(await followUser(fan, curator), { ok: true, following: true });
  const s1 = await mkSkill("lb-1");
  const s2 = await mkSkill("lb-2");
  const s3 = await mkSkill("lb-3");

  const c = ok(await createCollection(curator, "Curated", s1));
  const rows = (await pool.query<{ payload: Record<string, unknown> }>(
    `select payload from notifications where user_id = $1 and type = 'follow.collection_created'`, [fan],
  )).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.payload.collectionId, c.id);
  assert.equal(rows[0]!.payload.collectionName, "Curated");
  assert.equal(rows[0]!.payload.actorId, curator);
  const held = (await pool.query(`select 1 from user_achievements where user_id = $1 and key = 'first_collection'`, [curator])).rowCount;
  assert.equal(held, 1, "Mixtape");
  // Adding and renaming notify nobody.
  ok(await addSkillToCollection(curator, c.id, s2));
  ok(await updateCollection(curator, c.id, { name: "Curated 2" }));
  assert.equal((await pool.query(`select 1 from notifications where user_id = $1 and type = 'follow.collection_created'`, [fan])).rowCount, 1);

  const stat = async () => (await getLeaderboard("all", "curated", { bypassCache: true })).find((e) => e.userId === curator)?.collections ?? 0;
  assert.equal(await stat(), 0, "two skills is under the threshold");
  ok(await addSkillToCollection(curator, c.id, s3));
  assert.equal(await stat(), 1, "three eligible skills qualify");
  assert.equal((await getLeaderboard("30d", "curated", { bypassCache: true })).find((e) => e.userId === curator)?.collections, 1);

  // Deprovision keeps collections; erasure deletes them.
  await pool.query(`update users set status = 'inactive' where id = $1`, [curator]);
  assert.ok(await getCollection(c.id));
  await pool.query(`update users set status = 'active' where id = $1`, [curator]);
  const res = await eraseUser(admin, curator, null);
  assert.equal(res.ok, true);
  assert.equal(await getCollection(c.id), null, "erasure deletes the person's collections");
});
