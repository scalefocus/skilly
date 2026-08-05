// Live-DB integration tests for mentions (SKILLY_SPEC.md §24 "Mentions", §12 `message.mention`):
// post-time validation (audience/visibility/cap), `message_mentions` persistence, the
// UN-coalesced mention fan-out (superseding the coalesced row for mentioned recipients), the
// per-reader resolution map (restricted redaction / deleted-label fallback / erased tombstone),
// the people typeahead, and the Discussion card's viewport read action. Gated behind
// SKILLY_DB_E2E=1 (needs a migrated Postgres):
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess } from "@skilly/shared";
import type { SkillDiscussionSkill } from "./messages";

const enabled = process.env.SKILLY_DB_E2E === "1";

type NsRole = "namespace_admin" | "namespace_member";
const access = (userId: string | null, opts: { admin?: boolean; roles?: [string, NsRole][] } = {}) =>
  ({ userId, isPlatformAdmin: opts.admin ?? false, namespaceRoles: new Map(opts.roles ?? []) }) as unknown as EffectiveAccess & { userId: string | null };

const tok = (sigil: "@" | "#", id: string) => `<${sigil}${id}>`;

test("mentions: validate/persist/notify/resolve across contexts (§24)", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const m = await import("./messages");
  const mm = await import("./mentions");
  const K = "mention-test";

  const created: { skills: string[]; users: string[]; namespaces: string[] } = { skills: [], users: [], namespaces: [] };
  const mkUser = async (key: string, name: string, opts: { discussionOn?: boolean; status?: "active" | "inactive" } = {}) => {
    const id = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name, discussion_notifications, status)
       values ($1,$2,$3,$4,$5)
       on conflict (entra_object_id) do update set display_name = excluded.display_name,
         discussion_notifications = excluded.discussion_notifications, status = excluded.status, erased_at = null
       returning id`,
      [`${K}-${key}`, `${K}-${key}@t`, name, opts.discussionOn ?? true, opts.status ?? "active"],
    )).rows[0]!.id;
    created.users.push(id);
    return id;
  };
  const mkSkill = async (nsId: string, slug: string, visibility: "org" | "namespace") => {
    const id = (await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility)
       values ($1,$2,initcap(replace($2,'-',' ')),'d','generic','hosted',$3) returning id`,
      [nsId, slug, visibility],
    )).rows[0]!.id;
    created.skills.push(id);
    await pool.query(`insert into skill_versions (skill_id, semver, is_prerelease, status) values ($1,'1.0.0',false,'active')`, [id]);
    return id;
  };

  try {
    const nsId = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ($1,$1,true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
      [`${K}-ns`],
    )).rows[0]!.id;
    created.namespaces.push(nsId);
    // A member group for the namespace, so restricted-skill audiences resolve.
    const grp = (await pool.query<{ id: string }>(
      `insert into groups (entra_object_id, display_name) values ($1,'Mention Members')
       on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
      [`${K}-grp`],
    )).rows[0]!.id;
    await pool.query(`insert into role_mappings (group_id, namespace_id, role) values ($1,$2,'namespace_member') on conflict do nothing`, [grp, nsId]);

    const author = await mkUser("author", "Author");
    const watcher = await mkUser("watcher", "Watcher");
    const pinged = await mkUser("pinged", "Pinged Person");
    const muted = await mkUser("muted", "Muted", { discussionOn: false });
    const outsider = await mkUser("outsider", "Outsider");
    const inactive = await mkUser("inactive", "Inactive", { status: "inactive" });
    // author + pinged + muted are namespace members; outsider is not.
    for (const uid of [author, pinged, muted]) {
      await pool.query(`insert into group_memberships (group_id, user_id) values ($1,$2) on conflict do nothing`, [grp, uid]);
    }

    const orgSkillId = await mkSkill(nsId, `${K}-org-skill`, "org");
    const restrictedId = await mkSkill(nsId, `${K}-secret`, "namespace");
    const doomedId = await mkSkill(nsId, `${K}-doomed`, "org");
    await pool.query(`insert into skill_watches (user_id, skill_id) values ($1,$2),($3,$2) on conflict do nothing`, [watcher, orgSkillId, pinged]);

    const orgSkill: SkillDiscussionSkill = { id: orgSkillId, namespaceId: nsId, namespaceSlug: `${K}-ns`, skillSlug: `${K}-org-skill`, visibility: "org", archived: false };
    const authorAccess = access(author, { roles: [[nsId, "namespace_member"]] });

    // ── Validation ────────────────────────────────────────────────────────────
    // >10 distinct mentions → 422.
    const manyIds = await Promise.all(Array.from({ length: 11 }, (_, i) => mkUser(`bulk-${i}`, `Bulk ${i}`)));
    const tooMany = await m.postSkillDiscussionMessage(authorAccess, orgSkill, manyIds.map((id) => tok("@", id)).join(" "), "1.0.0");
    assert.equal(tooMany.ok, false);
    assert.equal((tooMany as { status: number }).status, 422);

    // Unknown user / inactive user → 422.
    for (const bad of ["00000000-0000-0000-0000-000000000000", inactive]) {
      const r = await m.postSkillDiscussionMessage(authorAccess, orgSkill, `hi ${tok("@", bad)}`, "1.0.0");
      assert.equal(r.ok, false, `expected reject for ${bad}`);
    }

    // A skill the author can't see → 422 (posted into a request thread, where everyone may post
    // but the AUTHOR's visibility gates the # mention). The outsider can't see the restricted skill.
    const reqId = (await pool.query<{ id: string }>(
      `insert into skill_requests (requester_user_id, title, description, tool_harness) values ($1,'t','d','generic') returning id`,
      [outsider],
    )).rows[0]!.id;
    const badSkillMention = await m.postRequestMessage(access(outsider), reqId, `see ${tok("#", restrictedId)}`);
    assert.equal(badSkillMention.ok, false, "author-invisible skill mention rejected");
    assert.equal((badSkillMention as { status: number }).status, 422);

    // Length rule: tokens count as ONE char — 490 x's + a token fits the 500 cap.
    const nearCap = await m.postSkillDiscussionMessage(authorAccess, orgSkill, "x".repeat(490) + " " + tok("@", pinged), "1.0.0");
    assert.ok(nearCap.ok, `collapsed-length post failed: ${JSON.stringify(nearCap)}`);

    // Markdown masking: a token inside a code fence is literal — no mention row, no ping.
    const fenced = await m.postSkillDiscussionMessage(authorAccess, orgSkill, "```\n" + tok("@", muted) + "\n```", "1.0.0");
    assert.ok(fenced.ok);
    const fencedRows = await pool.query(`select 1 from message_mentions where message_id = $1`, [(fenced as { message: { id: string } }).message.id]);
    assert.equal(fencedRows.rowCount, 0, "code-fenced token creates no mention row");

    // ── Happy path: skill discussion with a user + skill mention ─────────────
    // Earlier NON-mentioning posts (the fenced one) legitimately gave `pinged` — a watcher — a
    // coalesced skill.discussion row. Clear it so the supersede assertion below isolates THIS
    // post's fan-out: a mentioning message must not create/refresh the mentioned user's row.
    const preCid = (nearCap as { conversationId: string }).conversationId;
    await pool.query(`delete from notifications where user_id = $1 and type = 'skill.discussion' and payload->>'conversationId' = $2`, [pinged, preCid]);
    const body = `ping ${tok("@", pinged)} about ${tok("#", restrictedId)}`;
    const posted = await m.postSkillDiscussionMessage(authorAccess, orgSkill, body, "1.0.0");
    assert.ok(posted.ok, `post failed: ${JSON.stringify(posted)}`);
    const messageId = (posted as { message: { id: string } }).message.id;
    const conversationId = (posted as { conversationId: string }).conversationId;

    const rows = await pool.query<{ kind: string; target_id: string; label: string | null }>(
      `select kind, target_id, label from message_mentions where message_id = $1 order by kind`,
      [messageId],
    );
    assert.equal(rows.rowCount, 2);
    assert.deepEqual(rows.rows.find((r) => r.kind === "user"), { kind: "user", target_id: pinged, label: null }, "user mentions store no label");
    assert.deepEqual(rows.rows.find((r) => r.kind === "skill"), { kind: "skill", target_id: restrictedId, label: `${K}-ns/${K}-secret` }, "skill mentions capture the ns/slug label");

    // Fan-out: the mentioned user gets the UN-coalesced mention row and is SKIPPED by the
    // coalesced skill.discussion fan-out; the plain watcher gets the coalesced row only.
    const count = async (uid: string, type: string) =>
      Number((await pool.query<{ n: string }>(`select count(*)::text as n from notifications where user_id = $1 and type = $2 and payload->>'conversationId' = $3`, [uid, type, conversationId])).rows[0]!.n);
    assert.equal(await count(pinged, "message.mention"), 2, "one mention row per mentioning message (near-cap + this one)");
    assert.equal(await count(pinged, "skill.discussion"), 0, "the mention supersedes the coalesced row for the mentioned watcher");
    assert.equal(await count(watcher, "skill.discussion"), 1, "unmentioned watcher keeps the coalesced row");
    assert.equal(await count(watcher, "message.mention"), 0);

    // Un-coalesced: a THIRD mentioning message → a third mention row (never refreshed in place).
    await m.postSkillDiscussionMessage(authorAccess, orgSkill, `again ${tok("@", pinged)}`, "1.0.0");
    assert.equal(await count(pinged, "message.mention"), 3, "mention rows are un-coalesced (§12)");

    // Opt-out: discussion_notifications=false silences mention pings too (§12 — same toggle)…
    const mutedPost = await m.postSkillDiscussionMessage(authorAccess, orgSkill, `psst ${tok("@", muted)}`, "1.0.0");
    assert.ok(mutedPost.ok);
    assert.equal(await count(muted, "message.mention"), 0, "opted-out user gets no mention ping");
    // …but the mention row itself persists (it still renders as a chip).
    const mutedRows = await pool.query(`select 1 from message_mentions where message_id = $1 and kind = 'user'`, [(mutedPost as { message: { id: string } }).message.id]);
    assert.equal(mutedRows.rowCount, 1);

    // ── Per-reader resolution (invariant #3) ──────────────────────────────────
    // A namespace member sees the restricted skill mention resolved (ns-prefixed).
    const asMember = await mm.resolveMentions(access(pinged, { roles: [[nsId, "namespace_member"]] }), [messageId]);
    const skillTok = tok("#", restrictedId);
    const userTok = tok("@", pinged);
    assert.equal(asMember[skillTok]?.kind, "skill");
    assert.deepEqual(asMember[skillTok], { kind: "skill", id: restrictedId, state: "ok", title: (asMember[skillTok] as { title: string }).title, ns: `${K}-ns`, slug: `${K}-secret`, restricted: true });
    assert.deepEqual(asMember[userTok], { kind: "user", id: pinged, name: "Pinged Person", erased: false });

    // An outsider gets the REDACTED entry — no name fields serialized at all.
    const asOutsider = await mm.resolveMentions(access(outsider), [messageId]);
    assert.deepEqual(asOutsider[skillTok], { kind: "skill", id: restrictedId, state: "restricted" });

    // The thread GET carries the same map, reader-scoped.
    const outsiderThread = await m.getSkillDiscussion(access(outsider), orgSkill);
    assert.equal((outsiderThread.mentions[skillTok] as { state?: string })?.state, "restricted");
    assert.equal(outsiderThread.mentionContext, null, "org skill → whole-directory typeahead");

    // Deleted skill → 'gone' + the stored label.
    const doomedPost = await m.postSkillDiscussionMessage(authorAccess, orgSkill, `re ${tok("#", doomedId)}`, "1.0.0");
    assert.ok(doomedPost.ok);
    const doomedMsg = (doomedPost as { message: { id: string } }).message.id;
    {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query("set local skilly.allow_version_delete = 'on'");
        await c.query(`delete from skills where id = $1`, [doomedId]);
        await c.query("commit");
      } finally { c.release(); }
    }
    const afterDelete = await mm.resolveMentions(authorAccess, [doomedMsg]);
    assert.deepEqual(afterDelete[tok("#", doomedId)], { kind: "skill", id: doomedId, state: "gone", label: `${K}-ns/${K}-doomed` });

    // Erased user → live tombstone label, erased flag set.
    const doomedUser = await mkUser("erased", "Ex Person");
    const erasedPost = await m.postSkillDiscussionMessage(authorAccess, orgSkill, `bye ${tok("@", doomedUser)}`, "1.0.0");
    assert.ok(erasedPost.ok);
    await pool.query(`update users set display_name = 'x@t - Deleted', email = '', erased_at = now(), status = 'inactive' where id = $1`, [doomedUser]);
    const afterErase = await mm.resolveMentions(authorAccess, [(erasedPost as { message: { id: string } }).message.id]);
    assert.deepEqual(afterErase[tok("@", doomedUser)], { kind: "user", id: doomedUser, name: "x@t - Deleted", erased: true });

    // ── The viewport read action (§24): GET does NOT clear; the read endpoint does ─────────────
    const unreadOf = async (uid: string, type: string) =>
      Number((await pool.query<{ n: string }>(`select count(*)::text as n from notifications where user_id = $1 and type = $2 and read_at is null and payload->>'conversationId' = $3`, [uid, type, conversationId])).rows[0]!.n);
    assert.ok((await unreadOf(pinged, "message.mention")) > 0, "mention rows pending");
    await m.getSkillDiscussion(access(pinged, { roles: [[nsId, "namespace_member"]] }), orgSkill, { offset: 0 });
    assert.ok((await unreadOf(pinged, "message.mention")) > 0, "fetching the thread is NOT the read action anymore");
    assert.equal(await unreadOf(watcher, "skill.discussion"), 1, "coalesced row also survives a mere fetch");
    await m.markSkillDiscussionRead(access(pinged, { roles: [[nsId, "namespace_member"]] }), orgSkill);
    assert.equal(await unreadOf(pinged, "message.mention"), 0, "viewport read clears the mention rows");
    await m.markSkillDiscussionRead(access(watcher), orgSkill);
    assert.equal(await unreadOf(watcher, "skill.discussion"), 0, "viewport read clears the coalesced row");

    // ── People typeahead ──────────────────────────────────────────────────────
    // Whole directory: matches name AND email; excludes inactive users.
    const byName = await mm.suggestUsers("Pinged", null);
    assert.ok(byName.some((u) => u.id === pinged), "name match");
    const byEmail = await mm.suggestUsers(`${K}-watcher@`, null);
    assert.ok(byEmail.some((u) => u.id === watcher), "email match");
    const inactiveHit = await mm.suggestUsers("Inactive", null);
    assert.equal(inactiveHit.some((u) => u.id === inactive), false, "inactive users never suggested");
    const erasedHit = await mm.suggestUsers("Deleted", null);
    assert.equal(erasedHit.some((u) => u.id === doomedUser), false, "erased users never suggested");
    // Restricted-skill audience: outsiders are not in the candidate pool.
    const nsAudience = await mm.suggestUsers(K, { kind: "skill", namespaceId: nsId, visibility: "namespace" }, 10);
    assert.ok(nsAudience.some((u) => u.id === pinged), "namespace member offered");
    assert.equal(nsAudience.some((u) => u.id === outsider), false, "outsider not offered for a restricted skill");

    // ── Request context: whole directory mentionable; mention notifies ───────
    const reqPost = await m.postRequestMessage(access(outsider), reqId, `hey ${tok("@", watcher)}`);
    assert.ok(reqPost.ok, `request post failed: ${JSON.stringify(reqPost)}`);
    const reqConv = (reqPost as { conversationId: string }).conversationId;
    const reqMention = await pool.query(`select 1 from notifications where user_id = $1 and type = 'message.mention' and payload->>'conversationId' = $2`, [watcher, reqConv]);
    assert.equal(reqMention.rowCount, 1, "request-thread mention notifies");

    // ── Direct context: a third party renders but is NEVER notified ──────────
    const conv = await m.getOrCreateDirectConversation(access(author), watcher);
    assert.ok("conversationId" in conv);
    const dmCid = (conv as { conversationId: string }).conversationId;
    const dm = await m.postToConversation(access(author), dmCid, `about ${tok("@", pinged)} and you ${tok("@", watcher)}`);
    assert.ok(dm.ok, `dm failed: ${JSON.stringify(dm)}`);
    const dmMentions = async (uid: string) =>
      Number((await pool.query<{ n: string }>(`select count(*)::text as n from notifications where user_id = $1 and type = 'message.mention' and payload->>'conversationId' = $2`, [uid, dmCid])).rows[0]!.n);
    assert.equal(await dmMentions(watcher), 1, "the participant peer is pinged");
    assert.equal(await dmMentions(pinged), 0, "a non-participant third party is rendered but never notified");
    // …and the peer's coalesced message.new was superseded by the mention for this message.
    const dmNew = await pool.query(`select 1 from notifications where user_id = $1 and type = 'message.new' and payload->>'conversationId' = $2`, [watcher, dmCid]);
    assert.equal(dmNew.rowCount, 0, "mention supersedes message.new for the mentioned recipient");
    // Opening the thread clears the mention rows (markConversationRead).
    await m.markConversationRead(access(watcher), dmCid);
    const dmUnread = await pool.query(`select 1 from notifications where user_id = $1 and type = 'message.mention' and read_at is null and payload->>'conversationId' = $2`, [watcher, dmCid]);
    assert.equal(dmUnread.rowCount, 0, "opening the thread reads the mention rows");
  } finally {
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
    await pool.query(`delete from skill_requests where requester_user_id = any(select id from users where entra_object_id like $1)`, [`${K}-%`]).catch(() => {});
    for (const uid of created.users) {
      await pool.query(`delete from notifications where user_id = $1`, [uid]).catch(() => {});
      await pool.query(`delete from conversation_participants where user_id = $1`, [uid]).catch(() => {});
      await pool.query(`delete from messages where author_id = $1`, [uid]).catch(() => {});
      await pool.query(`delete from users where id = $1`, [uid]).catch(() => {});
    }
    await pool.query(`delete from conversations c where c.subject_type = 'direct' and not exists (select 1 from conversation_participants p where p.conversation_id = c.id)`).catch(() => {});
    await pool.query(`delete from role_mappings where group_id in (select id from groups where entra_object_id = $1)`, [`${K}-grp`]).catch(() => {});
    await pool.query(`delete from groups where entra_object_id = $1`, [`${K}-grp`]).catch(() => {});
    for (const nid of created.namespaces) await pool.query(`delete from namespaces where id = $1`, [nid]).catch(() => {});
    await pool.end();
  }
});

test("mentions: proposal-thread audience is enforced on post (§24)", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const m = await import("./messages");
  const K = "mention-prop";
  const userIds: string[] = [];
  let nsId = "";
  let proposalId = "";
  let grpId = "";
  try {
    nsId = (await pool.query<{ id: string }>(
      `insert into namespaces (slug, display_name, require_review) values ($1,$1,true)
       on conflict (slug) do update set display_name = excluded.display_name returning id`,
      [`${K}-ns`],
    )).rows[0]!.id;
    const mkUser = async (key: string, name: string) => {
      const id = (await pool.query<{ id: string }>(
        `insert into users (entra_object_id, email, display_name) values ($1,$2,$3)
         on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
        [`${K}-${key}`, `${K}-${key}@t`, name],
      )).rows[0]!.id;
      userIds.push(id);
      return id;
    };
    const submitter = await mkUser("sub", "Submitter");
    const reviewer = await mkUser("rev", "Reviewer");
    const stranger = await mkUser("str", "Stranger");
    grpId = (await pool.query<{ id: string }>(
      `insert into groups (entra_object_id, display_name) values ($1,'Prop Admins')
       on conflict (entra_object_id) do update set display_name = excluded.display_name returning id`,
      [`${K}-grp`],
    )).rows[0]!.id;
    await pool.query(`insert into role_mappings (group_id, namespace_id, role) values ($1,$2,'namespace_admin') on conflict do nothing`, [grpId, nsId]);
    await pool.query(`insert into group_memberships (group_id, user_id) values ($1,$2) on conflict do nothing`, [grpId, reviewer]);

    proposalId = (await pool.query<{ id: string }>(
      `insert into proposals (submitted_by, target_namespace_id, proposed_semver, state)
       values ($1,$2,'1.0.0','proposed') returning id`,
      [submitter, nsId],
    )).rows[0]!.id;

    const subAccess = access(submitter);
    // Mentioning the reviewer (in-audience) works and pings them.
    const ok = await m.postProposalMessage(subAccess, proposalId, `ready for you <@${reviewer}>`);
    assert.ok(ok.ok, `proposal mention failed: ${JSON.stringify(ok)}`);
    const cid = (ok as { conversationId: string }).conversationId;
    const ping = await pool.query(`select 1 from notifications where user_id = $1 and type = 'message.mention' and payload->>'conversationId' = $2`, [reviewer, cid]);
    assert.equal(ping.rowCount, 1, "in-audience mention pings");

    // Mentioning a stranger (outside submitter ∪ reviewers ∪ maintainers) → 422, nothing stored.
    const rejected = await m.postProposalMessage(subAccess, proposalId, `psst <@${stranger}>`);
    assert.equal(rejected.ok, false, "out-of-audience mention rejected (the thread's membership must not leak)");
    assert.equal((rejected as { status: number }).status, 422);

    // The typeahead audience matches: stranger not offered, reviewer offered.
    const aud = await m.proposalMentionAudience(subAccess, proposalId);
    assert.ok(aud && aud.kind === "proposal");
    const mm = await import("./mentions");
    const candidates = await mm.suggestUsers(K, aud, 10);
    assert.ok(candidates.some((u) => u.id === reviewer), "reviewer offered");
    assert.ok(candidates.some((u) => u.id === submitter), "submitter offered");
    assert.equal(candidates.some((u) => u.id === stranger), false, "stranger not offered");
    // A caller with no access to the proposal gets NO audience (404 upstream, no leak).
    assert.equal(await m.proposalMentionAudience(access(stranger), proposalId), null);
  } finally {
    if (proposalId) {
      await pool.query(
        `delete from notifications where type in ('message.new','message.mention')
          and payload->>'conversationId' in (select id::text from conversations where subject_type = 'proposal' and subject_id = $1)`,
        [proposalId],
      ).catch(() => {});
      await pool.query(`delete from conversations where subject_type = 'proposal' and subject_id = $1`, [proposalId]).catch(() => {});
      await pool.query(`delete from proposals where id = $1`, [proposalId]).catch(() => {});
    }
    if (grpId) {
      await pool.query(`delete from role_mappings where group_id = $1`, [grpId]).catch(() => {});
      await pool.query(`delete from groups where id = $1`, [grpId]).catch(() => {});
    }
    for (const uid of userIds) {
      await pool.query(`delete from notifications where user_id = $1`, [uid]).catch(() => {});
      await pool.query(`delete from users where id = $1`, [uid]).catch(() => {});
    }
    if (nsId) await pool.query(`delete from namespaces where id = $1`, [nsId]).catch(() => {});
    await pool.end();
  }
});
