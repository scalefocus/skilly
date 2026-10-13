// Live-DB integration tests for the skill discussion (SKILLY_SPEC.md §24 "Skill discussion").
// Gated behind SKILLY_DB_E2E=1 (needs a migrated Postgres):
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
//
// Each test seeds under a unique key and rolls its own cleanup at the end (these functions use the
// shared pool, not a per-test transaction, because the fan-out crosses several tables).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess } from "@skilly/shared";
import type { SkillDiscussionSkill } from "./messages";

const enabled = process.env.SKILLY_DB_E2E === "1";

type NsRole = "namespace_admin" | "namespace_member";
const access = (userId: string | null, opts: { admin?: boolean; roles?: [string, NsRole][] } = {}) =>
  ({ userId, isPlatformAdmin: opts.admin ?? false, namespaceRoles: new Map(opts.roles ?? []) }) as unknown as EffectiveAccess & { userId: string | null };

test("skill discussion: post/validate/moderate/notify (§24)", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const m = await import("./messages");
  const K = "disc-test";

  const created: { skills: string[]; users: string[]; groups: string[]; namespaces: string[] } = { skills: [], users: [], groups: [], namespaces: [] };
  const mkUser = async (key: string, name: string, discussionOn = true) => {
    const id = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name, discussion_notifications) values ($1,$2,$3,$4)
       on conflict (entra_object_id) do update set display_name = excluded.display_name, discussion_notifications = excluded.discussion_notifications
       returning id`,
      [`${K}-${key}`, `${K}-${key}@t`, name, discussionOn],
    )).rows[0]!.id;
    created.users.push(id);
    return id;
  };
  const mkSkill = async (nsId: string, slug: string, visibility: "org" | "namespace") => {
    const id = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
       values ($1,$2,$2,'d','generic','hosted',$3) returning id`,
      [nsId, slug, visibility],
    )).rows[0]!.id;
    created.skills.push(id);
    return id;
  };

  try {
    const nsId = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ($1,$1,true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
      [`${K}-ns`],
    )).rows[0]!.id;
    created.namespaces.push(nsId);

    const author = await mkUser("author", "Author");
    const watcher = await mkUser("watcher", "Watcher");
    const optedOut = await mkUser("muted", "Muted", false);
    const maintainer = await mkUser("maint", "Maintainer");
    const stranger = await mkUser("stranger", "Stranger");

    const skillId = await mkSkill(nsId, `${K}-pdf`, "org");
    await pool.query(`insert into skill_versions (skill_id, semver, is_prerelease, status) values ($1,'1.0.0',false,'active'),($1,'1.1.0-beta.1',true,'active'),($1,'0.9.0',false,'yanked')`, [skillId]);
    await pool.query(`insert into skill_watches (user_id, skill_id) values ($1,$2),($3,$2),($4,$2) on conflict do nothing`, [watcher, skillId, optedOut, maintainer]);
    await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1,$2) on conflict do nothing`, [skillId, maintainer]);

    const skill: SkillDiscussionSkill = { id: skillId, namespaceId: nsId, namespaceSlug: `${K}-ns`, skillSlug: `${K}-pdf`, visibility: "org", archived: false, sharedNamespaceIds: [] };

    // ── Validation ──────────────────────────────────────────────────────────
    const empty = await m.postSkillDiscussionMessage(access(author), skill, "   ", "1.0.0");
    assert.equal(empty.ok, false); assert.equal((empty as { status: number }).status, 422);

    const tooLong = await m.postSkillDiscussionMessage(access(author), skill, "x".repeat(501), "1.0.0");
    assert.equal(tooLong.ok, false); assert.equal((tooLong as { status: number }).status, 422);

    const badVer = await m.postSkillDiscussionMessage(access(author), skill, "hi", "9.9.9");
    assert.equal(badVer.ok, false, "unknown version rejected");
    const yankedVer = await m.postSkillDiscussionMessage(access(author), skill, "hi", "0.9.0");
    assert.equal(yankedVer.ok, false, "yanked version rejected");

    // ── Happy path: post stamps the version, creates the thread, NO participant row ───────────
    const posted = await m.postSkillDiscussionMessage(access(author), skill, "**hello** everyone", "1.1.0-beta.1");
    assert.ok(posted.ok, `post failed: ${JSON.stringify(posted)}`);
    const conversationId = (posted as { conversationId: string }).conversationId;
    assert.equal((posted as { message: { contextSemver: string | null } }).message.contextSemver, "1.1.0-beta.1");

    const conv = await pool.query(`select subject_type, subject_id from conversations where id = $1`, [conversationId]);
    assert.equal(conv.rows[0]!.subject_type, "skill");
    assert.equal(conv.rows[0]!.subject_id, skillId);
    const parts = await pool.query(`select count(*)::int as n from conversation_participants where conversation_id = $1`, [conversationId]);
    assert.equal(parts.rows[0]!.n, 0, "skill discussions carry NO participant rows (never in the messages menu)");

    // ── Fan-out: watcher + maintainer notified; author + opted-out are NOT ───────────────────
    const notif = async (uid: string) => (await pool.query<{ n: string }>(`select count(*)::text as n from notifications where user_id = $1 and type = 'skill.discussion' and payload->>'conversationId' = $2`, [uid, conversationId])).rows[0]!.n;
    const unread = async (uid: string) => (await pool.query<{ n: string }>(`select count(*)::text as n from notifications where user_id = $1 and type = 'skill.discussion' and read_at is null and payload->>'conversationId' = $2`, [uid, conversationId])).rows[0]!.n;
    assert.equal(await notif(watcher), "1", "watcher notified");
    assert.equal(await notif(maintainer), "1", "maintainer notified");
    assert.equal(await notif(author), "0", "author never notified of own comment");
    assert.equal(await notif(optedOut), "0", "discussion_notifications=false is filtered at insert (watch does NOT override)");

    // ── Coalescing: a second comment refreshes the SAME row, preserving delivery bookkeeping ──
    const firstRow = await pool.query<{ id: string }>(`select id from notifications where user_id = $1 and type = 'skill.discussion' and read_at is null and payload->>'conversationId' = $2`, [watcher, conversationId]);
    await pool.query(`update notifications set delivered_at = now() where id = $1`, [firstRow.rows[0]!.id]);
    await m.postSkillDiscussionMessage(access(author), skill, "another", "1.0.0");
    const afterRow = await pool.query<{ id: string; delivered_at: string | null }>(`select id, delivered_at from notifications where user_id = $1 and type = 'skill.discussion' and read_at is null and payload->>'conversationId' = $2`, [watcher, conversationId]);
    assert.equal(afterRow.rowCount, 1, "still one coalesced row");
    assert.equal(afterRow.rows[0]!.id, firstRow.rows[0]!.id, "updated in place");
    assert.ok(afterRow.rows[0]!.delivered_at, "delivered_at preserved → no re-email");

    // ── Read model (§24, viewport rule): FETCHING the thread is not the read action any more —
    // the alert clears only via markSkillDiscussionRead (the card's viewport read endpoint).
    const thread = await m.getSkillDiscussion(access(watcher), skill, { offset: 0 });
    assert.equal(thread.count, 2);
    assert.equal(thread.messages.length, 2);
    assert.equal((thread.messages[0] as { body?: string }).body, "another", "newest-first");
    assert.equal(await unread(watcher), "1", "a mere fetch (poll / expanded-by-default load) does NOT clear the alert");
    await m.markSkillDiscussionRead(access(watcher), skill);
    assert.equal(await unread(watcher), "0", "the viewport read action clears the coalesced alert");

    // ── Moderation: maintainer can delete; a plain commenter cannot ──────────────────────────
    const victimId = thread.messages[0]!.id;
    const notAllowed = await m.deleteSkillDiscussionMessage(access(stranger), skill, victimId);
    assert.equal(notAllowed.ok, false); assert.equal((notAllowed as { status: number }).status, 403);

    const del = await m.deleteSkillDiscussionMessage(access(maintainer), skill, victimId);
    assert.ok(del.ok, `maintainer delete failed: ${JSON.stringify(del)}`);
    assert.equal(await m.skillDiscussionCount(skillId), 1, "count decremented after moderator delete");
    const audit = await pool.query<{ after: { messageId: string; authorId: string; body?: string } }>(
      `select after from audit_log where action = 'skill.discussion_message_deleted' and target_id = $1 order by created_at desc limit 1`,
      [skillId],
    );
    assert.equal(audit.rows[0]!.after.messageId, victimId);
    assert.equal(audit.rows[0]!.after.body, undefined, "the comment body is NEVER recorded in the audit payload (§24)");

    // Platform admin can also moderate; ns admin can too (both are effective moderators).
    assert.equal(await m.canModerateSkillDiscussion(access(stranger, { admin: true }), skill), true);
    assert.equal(await m.canModerateSkillDiscussion(access(stranger, { roles: [[nsId, "namespace_admin"]] }), skill), true);
    assert.equal(await m.canModerateSkillDiscussion(access(stranger), skill), false);

    // ── Archived → read-only post ────────────────────────────────────────────────────────────
    const archived = { ...skill, archived: true };
    const archPost = await m.postSkillDiscussionMessage(access(author), archived, "nope", "1.0.0");
    assert.equal(archPost.ok, false); assert.equal((archPost as { status: number }).status, 409);
    assert.equal((await m.getSkillDiscussion(access(author), archived)).canPost, false);
  } finally {
    // Cleanup (children first). notifications/watches/versions/maintainers cascade off skills;
    // conversations are polymorphic (no FK) so delete them explicitly. Deleting a skill cascades
    // into skill_versions, which the immutability guard (migration 0022) blocks unless
    // skilly.allow_version_delete is set — so drive it in a tx like deleteSkill does.
    for (const sid of created.skills) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("set local skilly.allow_version_delete = 'on'");
        await c.query(`delete from conversations where subject_type = 'skill' and subject_id = $1`, [sid]);
        await c.query(`delete from skills where id = $1`, [sid]);
        await c.query("commit");
      } catch { await c.query("rollback").catch(() => {}); } finally { c.release(); }
    }
    for (const uid of created.users) {
      await pool.query(`delete from notifications where user_id = $1`, [uid]).catch(() => {});
      await pool.query(`delete from users where id = $1`, [uid]).catch(() => {});
    }
    for (const nid of created.namespaces) await pool.query(`delete from namespaces where id = $1`, [nid]).catch(() => {});
    await pool.end();
  }
});

test("skill discussion: a watcher who can't see a restricted skill is skipped (invariant #3)", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const m = await import("./messages");
  const K = "disc-vis";
  const userIds: string[] = [];
  let skillId = "";
  let nsId = "";
  try {
    nsId = (await pool.query<{ id: string }>(`insert into namespaces (slug, display_name, require_review) values ($1,$1,true) on conflict (slug) do update set display_name = excluded.display_name returning id`, [`${K}-ns`])).rows[0]!.id;
    const author = (await pool.query<{ id: string }>(`insert into users (entra_object_id,email,display_name) values ($1,$2,'A') on conflict (entra_object_id) do update set email=excluded.email returning id`, [`${K}-author`, `${K}-a@t`])).rows[0]!.id;
    const outsider = (await pool.query<{ id: string }>(`insert into users (entra_object_id,email,display_name) values ($1,$2,'O') on conflict (entra_object_id) do update set email=excluded.email returning id`, [`${K}-out`, `${K}-o@t`])).rows[0]!.id;
    userIds.push(author, outsider);
    skillId = (await pool.query<{ id: string }>(`insert into skills (namespace_id,slug,title,description,tool_harness,type,visibility) values ($1,$2,$2,'d','generic','hosted','namespace') returning id`, [nsId, `${K}-sk`])).rows[0]!.id;
    await pool.query(`insert into skill_versions (skill_id,semver,is_prerelease,status) values ($1,'1.0.0',false,'active')`, [skillId]);
    // The outsider watches the (now namespace-restricted) skill but holds NO role in the namespace.
    await pool.query(`insert into skill_watches (user_id, skill_id) values ($1,$2) on conflict do nothing`, [outsider, skillId]);

    const skill: SkillDiscussionSkill = { id: skillId, namespaceId: nsId, namespaceSlug: `${K}-ns`, skillSlug: `${K}-sk`, visibility: "namespace", archived: false, sharedNamespaceIds: [] };
    const posted = await m.postSkillDiscussionMessage(access(author, { roles: [[nsId, "namespace_member"]] }), skill, "hi", "1.0.0");
    assert.ok(posted.ok);
    const cid = (posted as { conversationId: string }).conversationId;
    const n = (await pool.query<{ n: string }>(`select count(*)::text as n from notifications where user_id = $1 and type = 'skill.discussion' and payload->>'conversationId' = $2`, [outsider, cid])).rows[0]!.n;
    assert.equal(n, "0", "a watcher without access to the restricted skill is not notified");
  } finally {
    if (skillId) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("set local skilly.allow_version_delete = 'on'");
        await c.query(`delete from conversations where subject_type='skill' and subject_id=$1`, [skillId]);
        await c.query(`delete from skills where id=$1`, [skillId]);
        await c.query("commit");
      } catch { await c.query("rollback").catch(() => {}); } finally { c.release(); }
    }
    for (const uid of userIds) { await pool.query(`delete from notifications where user_id=$1`, [uid]).catch(() => {}); await pool.query(`delete from users where id=$1`, [uid]).catch(() => {}); }
    if (nsId) await pool.query(`delete from namespaces where id=$1`, [nsId]).catch(() => {});
    await pool.end();
  }
});

test("skill discussion replies: shape, notifications, tombstones (§24 Replies)", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const m = await import("./messages");
  const K = "disc-reply";
  const userIds: string[] = [];
  const skillIds: string[] = [];
  let nsId = "";
  const mkUser = async (key: string, name: string, discussionOn = true) =>
    (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name, discussion_notifications) values ($1,$2,$3,$4)
       on conflict (entra_object_id) do update set display_name = excluded.display_name, discussion_notifications = excluded.discussion_notifications
       returning id`,
      [`${K}-${key}`, `${K}-${key}@t`, name, discussionOn],
    )).rows[0]!.id;
  const mkSkill = async (slug: string, visibility: "org" | "namespace") => {
    const id = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility) values ($1,$2,$2,'d','generic','hosted',$3) returning id`,
      [nsId, slug, visibility],
    )).rows[0]!.id;
    skillIds.push(id);
    await pool.query(`insert into skill_versions (skill_id, semver, is_prerelease, status) values ($1,'1.0.0',false,'active'),($1,'2.0.0',false,'active')`, [id]);
    return id;
  };
  const rows = async (uid: string, type: string, extra = "") =>
    (await pool.query<{ id: string; payload: Record<string, unknown>; read_at: string | null }>(
      `select id, payload, read_at from notifications where user_id = $1 and type = $2 ${extra} order by created_at`,
      [uid, type],
    )).rows;
  const idOf = (r: unknown) => (r as { message: { id: string } }).message.id;
  const statusOf = (r: unknown) => (r as { status?: number }).status;

  try {
    nsId = (await pool.query<{ id: string }>(`insert into namespaces (slug, display_name, require_review) values ($1,$1,true) on conflict (slug) do update set display_name = excluded.display_name returning id`, [`${K}-ns`])).rows[0]!.id;
    // The moderator writes audit rows, so it is a FIXED user left in place (audit_log is append-only).
    const moderator = await mkUser("moderator", "Moderator");
    const rootAuthor = await mkUser("root", "Root");
    const replierA = await mkUser("a", "Replier A");
    const replierB = await mkUser("b", "Replier B");
    const muted = await mkUser("muted", "Muted", false);
    const watcher = await mkUser("watcher", "Watcher");
    const outsider = await mkUser("outsider", "Outsider");
    userIds.push(rootAuthor, replierA, replierB, muted, watcher, outsider);

    const skillId = await mkSkill(`${K}-pdf`, "org");
    const otherSkillId = await mkSkill(`${K}-other`, "org");
    await pool.query(`insert into skill_watches (user_id, skill_id) values ($1,$2) on conflict do nothing`, [watcher, skillId]);
    await pool.query(`insert into skill_maintainers (skill_id, user_id) values ($1,$2) on conflict do nothing`, [skillId, moderator]);
    const skill: SkillDiscussionSkill = { id: skillId, namespaceId: nsId, namespaceSlug: `${K}-ns`, skillSlug: `${K}-pdf`, visibility: "org", archived: false, sharedNamespaceIds: [] };
    const other: SkillDiscussionSkill = { ...skill, id: otherSkillId, skillSlug: `${K}-other` };
    const post = (uid: string, body: string, semver: string | null, parentId: string | null = null, sk = skill) =>
      m.postSkillDiscussionMessage(access(uid), sk, body, semver, parentId);

    const root = await post(rootAuthor, "root comment", "2.0.0");
    assert.ok(root.ok);
    const rootId = idOf(root);

    // ── Validation: 422 with a version, 404 for a comment from another discussion, archived 409 ──
    assert.equal(statusOf(await post(replierA, "hi", "1.0.0", rootId)), 422, "parentId + contextSemver is rejected");
    assert.equal(statusOf(await post(replierA, "hi", null, rootId, other)), 404, "the parent must be in the same conversation");
    assert.equal(statusOf(await post(replierA, "hi", null, rootId, { ...skill, archived: true })), 409, "an archived skill takes no replies");

    // ── A reply inherits the root's version; a reply to a reply normalises to the root ──
    const a1 = await post(replierA, "first reply", null, rootId);
    assert.ok(a1.ok, JSON.stringify(a1));
    const a1Id = idOf(a1);
    const stored = await pool.query<{ parent_id: string; context_semver: string }>(`select parent_id, context_semver from messages where id = $1`, [a1Id]);
    assert.equal(stored.rows[0]!.parent_id, rootId);
    assert.equal(stored.rows[0]!.context_semver, "2.0.0", "the version pill is inherited");
    const b1 = await post(replierB, "reply to the reply", null, a1Id);
    assert.ok(b1.ok);
    const b1Id = idOf(b1);
    assert.equal((await pool.query(`select parent_id from messages where id = $1`, [b1Id])).rows[0]!.parent_id, rootId, "one level: normalised to the root");

    // ── Notifications: thread people get skill.discussion_reply, coalesced per thread ──
    const rootRows = await rows(rootAuthor, "skill.discussion_reply");
    assert.equal(rootRows.length, 1, "the root's author: one coalesced row for the thread");
    assert.equal(rootRows[0]!.payload.rootId, rootId);
    assert.equal(rootRows[0]!.payload.yourComment, true);
    assert.equal(rootRows[0]!.payload.fromName, "Replier B", "refreshed in place by the latest reply");
    const aRows = await rows(replierA, "skill.discussion_reply");
    assert.equal(aRows.length, 1, "an earlier replier is in the thread");
    assert.equal(aRows[0]!.payload.yourComment, false);
    assert.equal((await rows(replierB, "skill.discussion_reply")).length, 0, "never notified of your own reply");
    // Precedence: thread people get no skill.discussion for a reply; a watcher still does.
    assert.equal((await rows(replierA, "skill.discussion")).length, 0, "a reply row outranks skill.discussion");
    assert.equal((await rows(watcher, "skill.discussion")).length, 1, "watchers still hear about replies");
    // Opt-out: a muted thread member gets nothing.
    const mutedRootId = idOf(await post(muted, "muted root", null));
    await post(replierA, "answer to muted", null, mutedRootId);
    assert.equal((await rows(muted, "skill.discussion_reply")).length, 0, "discussion_notifications=false silences replies too");

    // ── GET: replies nested oldest-first; per-reader unread threads; count ──
    const t = await m.getSkillDiscussion(access(rootAuthor), skill);
    const thread = t.messages.find((x) => x.id === rootId)!;
    assert.deepEqual(thread.replies.map((r) => r.id), [a1Id, b1Id], "replies oldest-first");
    assert.equal(thread.replyCount, 2);
    assert.ok(t.unreadThreads.includes(rootId), "the viewer's unread reply thread is listed");
    assert.equal(t.count, 5, "every live message counts, replies included");
    assert.ok(!t.messages.some((x) => x.id === a1Id), "replies are not top-level entries");

    // ── Per-thread read clears only that thread ──
    await post(rootAuthor, "root author answers the muted thread", null, mutedRootId); // replierA is in that thread
    assert.equal((await rows(replierA, "skill.discussion_reply", "and read_at is null")).length, 2, "replierA: unread rows in two threads");
    await m.markSkillDiscussionThreadsRead(access(replierA), skill, [rootId]);
    const left = await rows(replierA, "skill.discussion_reply", "and read_at is null");
    assert.equal(left.length, 1, "seeing one thread does not clear another's");
    assert.equal(left[0]!.payload.rootId, mutedRootId);

    // ── Visibility: a thread member who can't see a restricted skill is skipped ──
    const restrictedId = await mkSkill(`${K}-secret`, "namespace");
    const restricted: SkillDiscussionSkill = { ...skill, id: restrictedId, skillSlug: `${K}-secret`, visibility: "namespace" };
    const asMember = (uid: string) => access(uid, { roles: [[nsId, "namespace_member"]] });
    const rRoot = await m.postSkillDiscussionMessage(asMember(rootAuthor), restricted, "restricted root", null);
    assert.ok(rRoot.ok);
    // The outsider authored an earlier reply (e.g. before losing access): seed it directly.
    await pool.query(`insert into messages (conversation_id, author_id, body, parent_id) values ($1,$2,'old reply',$3)`, [(rRoot as { conversationId: string }).conversationId, outsider, idOf(rRoot)]);
    await m.postSkillDiscussionMessage(asMember(replierA), restricted, "new reply", null, idOf(rRoot));
    assert.equal((await rows(outsider, "skill.discussion_reply")).length, 0, "a thread member who can't see the skill is skipped (invariant #3)");

    // ── Tombstones ──
    const mod = access(moderator);
    assert.deepEqual(await m.deleteSkillDiscussionMessage(mod, skill, b1Id), { ok: true, outcome: "deleted", tombstoneRemoved: false }, "a reply under a live root: hard delete");
    assert.deepEqual(await m.deleteSkillDiscussionMessage(mod, skill, rootId), { ok: true, outcome: "tombstoned", tombstoneRemoved: false }, "a root with replies: tombstone");
    const tomb = await pool.query<{ body: string; removed_at: string | null }>(`select body, removed_at from messages where id = $1`, [rootId]);
    assert.equal(tomb.rows[0]!.body, "", "the body is gone, not hidden");
    assert.ok(tomb.rows[0]!.removed_at);
    const view = (await m.getSkillDiscussion(access(watcher), skill)).messages.find((x) => x.id === rootId)! as { removed?: boolean; body?: string; authorId?: string };
    assert.equal(view.removed, true);
    assert.equal(view.body, undefined, "a tombstone carries no body");
    assert.equal(view.authorId, undefined, "…and no author");
    assert.equal(statusOf(await post(replierB, "late", null, a1Id)), 409, "no replies into a tombstoned thread");
    assert.equal(statusOf(await m.deleteSkillDiscussionMessage(mod, skill, rootId)), 404, "a tombstone is not a delete target");
    const before = await m.skillDiscussionCount(skillId);
    assert.deepEqual(await m.deleteSkillDiscussionMessage(mod, skill, a1Id), { ok: true, outcome: "deleted", tombstoneRemoved: true }, "the last reply sweeps the tombstone");
    assert.equal((await pool.query(`select 1 from messages where id = $1`, [rootId])).rowCount, 0, "the emptied tombstone is gone");
    assert.equal(await m.skillDiscussionCount(skillId), before - 1, "the tombstone never counted; only the reply did");
    const lone = await post(watcher, "lonely", null);
    assert.deepEqual(await m.deleteSkillDiscussionMessage(mod, skill, idOf(lone)), { ok: true, outcome: "deleted", tombstoneRemoved: false }, "a childless root: hard delete");

    // ── Audit payload fields (never the body) ──
    const audits = (await pool.query<{ after: Record<string, unknown> }>(
      `select after from audit_log where action = 'skill.discussion_message_deleted' and target_id = $1 order by created_at`,
      [skillId],
    )).rows.map((r) => r.after);
    const byId = (id: string) => audits.find((a) => a.messageId === id)!;
    assert.deepEqual([byId(b1Id).parentId, byId(b1Id).tombstoned, byId(b1Id).tombstoneRemoved], [rootId, false, false]);
    assert.deepEqual([byId(rootId).parentId, byId(rootId).tombstoned, byId(rootId).tombstoneRemoved], [null, true, false]);
    assert.deepEqual([byId(a1Id).parentId, byId(a1Id).tombstoned, byId(a1Id).tombstoneRemoved], [rootId, false, true]);
    assert.equal(audits.filter((a) => a.messageId === rootId).length, 1, "the swept tombstone gets no audit row of its own");
    assert.ok(audits.every((a) => a.body === undefined), "the body is never recorded");
  } finally {
    for (const sid of skillIds) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("set local skilly.allow_version_delete = 'on'");
        await c.query(`delete from conversations where subject_type = 'skill' and subject_id = $1`, [sid]);
        await c.query(`delete from skills where id = $1`, [sid]);
        await c.query("commit");
      } catch { await c.query("rollback").catch(() => {}); } finally { c.release(); }
    }
    for (const uid of userIds) {
      await pool.query(`delete from notifications where user_id = $1`, [uid]).catch(() => {});
      await pool.query(`delete from users where id = $1`, [uid]).catch(() => {});
    }
    if (nsId) await pool.query(`delete from namespaces where id = $1`, [nsId]).catch(() => {});
    await pool.end();
  }
});
