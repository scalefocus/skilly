// Mentions (SKILLY_SPEC.md §24 "Mentions", §12 `message.mention`). Server side of the `#`/`@`
// tokens embedded in message bodies: post-time validation (audience + visibility + the ≤10 cap),
// `message_mentions` persistence, PER-READER resolution for rendering (a restricted skill's name
// is never serialized to a reader outside its namespace — invariant #3), the un-coalesced
// `message.mention` notification fan-out, and the people typeahead behind the composer `@`
// picker + the header search's people mode (§10).
import { pool } from "./db";
import { nameSql, userLabel } from "./userLabel";
import {
  MAX_MENTIONS_PER_MESSAGE,
  extractMentions,
  isSkillVisible,
  mentionToken,
  type EffectiveAccess,
  type MentionRef,
} from "@skilly/shared";

type Access = EffectiveAccess & { userId: string | null };

/** The thread context a mention is posted into — decides who is mentionable (§24). */
export type MentionAudience =
  | { kind: "proposal"; submitterId: string; namespaceId: string; skillId: string | null }
  | { kind: "request" }
  | { kind: "skill"; namespaceId: string; visibility: "org" | "namespace" }
  | { kind: "direct" };

/** A validated mention, ready to persist. `label` is the ns/slug handle (skill mentions only). */
export interface PreparedMention extends MentionRef {
  label: string | null;
}

/** What the reader is entitled to see for each token — the value side of the `mentions` map. */
export type ResolvedMention =
  | { kind: "user"; id: string; name: string; erased: boolean }
  | { kind: "skill"; id: string; state: "ok"; title: string; ns: string; slug: string; restricted: boolean }
  | { kind: "skill"; id: string; state: "restricted" }
  | { kind: "skill"; id: string; state: "gone"; label: string | null };

export type MentionMap = Record<string, ResolvedMention>;

// ── The audience predicate (shared by validation and the typeahead) ─────────

/**
 * SQL predicate over `u` (a `users` row): is this user inside the thread's mentionable set?
 * Pushes its bind values onto `params` and returns the fragment. The whole-directory contexts
 * (request threads, org-skill discussions, direct chats) return `true` — anyone active.
 * Mirrors the visibility filter shape used by fanOutSkillDiscussion (§24).
 */
function audiencePredicate(aud: MentionAudience, params: unknown[]): string {
  if (aud.kind === "proposal") {
    // submitter ∪ platform admins ∪ target-namespace admins ∪ target-skill maintainers
    params.push(aud.submitterId);
    const pSubmitter = params.length;
    params.push(aud.namespaceId);
    const pNs = params.length;
    params.push(aud.skillId);
    const pSkill = params.length;
    return `(u.id = $${pSubmitter}
      or exists (select 1 from group_memberships gm join role_mappings rm on rm.group_id = gm.group_id
                  where gm.user_id = u.id and (rm.role = 'platform_admin' or (rm.role = 'namespace_admin' and rm.namespace_id = $${pNs})))
      or ($${pSkill}::uuid is not null and exists (select 1 from skill_maintainers sm where sm.skill_id = $${pSkill} and sm.user_id = u.id)))`;
  }
  if (aud.kind === "skill" && aud.visibility === "namespace") {
    params.push(aud.namespaceId);
    return `exists (
      select 1 from group_memberships gm
      join role_mappings rm on rm.group_id = gm.group_id
      where gm.user_id = u.id and (rm.role = 'platform_admin' or rm.namespace_id = $${params.length})
    )`;
  }
  return "true";
}

// ── Post-time validation ─────────────────────────────────────────────────────

/**
 * Validate a body's mentions against the author's access and the thread's audience, and prepare
 * them for persistence. Returns 422 errors with user-facing wording. `markdown: true` (the skill
 * discussion) ignores tokens inside code fences/backticks (§24).
 */
export async function validateMentions(
  access: Access,
  body: string,
  audience: MentionAudience,
  opts: { markdown?: boolean } = {},
): Promise<{ ok: true; mentions: PreparedMention[] } | { ok: false; status: number; error: string }> {
  const refs = extractMentions(body, { markdown: opts.markdown });
  if (refs.length === 0) return { ok: true, mentions: [] };
  if (refs.length > MAX_MENTIONS_PER_MESSAGE) {
    return { ok: false, status: 422, error: `too many mentions (max ${MAX_MENTIONS_PER_MESSAGE})` };
  }

  const userIds = refs.filter((r) => r.kind === "user").map((r) => r.id);
  const skillIds = refs.filter((r) => r.kind === "skill").map((r) => r.id);
  const prepared: PreparedMention[] = [];

  if (userIds.length) {
    // Everyone mentioned must be a live directory member (non-erased, active)…
    const params: unknown[] = [userIds];
    const ok = audiencePredicate(audience, params);
    const { rows } = await pool.query<{ id: string; ok: boolean }>(
      `select u.id, ${ok} as ok from users u
        where u.id = any($1::uuid[]) and u.status = 'active' and u.erased_at is null`,
      params,
    );
    const byId = new Map(rows.map((r) => [r.id, r.ok]));
    for (const id of userIds) {
      const inAudience = byId.get(id);
      if (inAudience === undefined) return { ok: false, status: 422, error: "mentioned user not found" };
      // …and, outside the whole-directory contexts, inside the thread's audience (§24: a
      // proposal thread's membership must not leak; a restricted skill's discussion mentions
      // only its viewers). Direct chats allow any user (rendered, never notified).
      if (!inAudience) return { ok: false, status: 422, error: "mentioned user can't see this discussion" };
      prepared.push({ kind: "user", id, label: null });
    }
  }

  if (skillIds.length) {
    const { rows } = await pool.query<{ id: string; status: string; visibility: "org" | "namespace"; namespace_id: string; slug: string; ns_slug: string }>(
      `select s.id, s.status, s.visibility, s.namespace_id, s.slug, n.slug as ns_slug
         from skills s join namespaces n on n.id = s.namespace_id
        where s.id = any($1::uuid[])`,
      [skillIds],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of skillIds) {
      const s = byId.get(id);
      // Mentionable = a skill the AUTHOR can currently see in the catalog (active + visible);
      // readers are handled per-reader at render time (redaction), not here.
      if (!s || s.status !== "active" || !isSkillVisible(access, { namespaceId: s.namespace_id, visibility: s.visibility })) {
        return { ok: false, status: 422, error: "mentioned skill not found" };
      }
      prepared.push({ kind: "skill", id, label: `${s.ns_slug}/${s.slug}` });
    }
  }

  return { ok: true, mentions: prepared };
}

// ── Persistence ──────────────────────────────────────────────────────────────

/** Insert the message's mention rows (one per distinct mention; §24). */
export async function insertMentionRows(messageId: string, mentions: PreparedMention[]): Promise<void> {
  if (!mentions.length) return;
  const values: string[] = [];
  const params: unknown[] = [messageId];
  for (const m of mentions) {
    params.push(m.kind, m.id, m.label);
    values.push(`($1, $${params.length - 2}, $${params.length - 1}, $${params.length})`);
  }
  await pool.query(
    `insert into message_mentions (message_id, kind, target_id, label) values ${values.join(", ")} on conflict do nothing`,
    params,
  );
}

// ── Notification fan-out (§12 message.mention — deliberately UN-coalesced) ──

export interface MentionNotifyContext {
  conversationId: string;
  messageId: string;
  fromName: string;
  /** Context link fields — whichever apply (the §12 renderer picks the CTA from them). */
  proposalId?: string | null;
  requestId?: string | null;
  namespaceSlug?: string | null;
  skillSlug?: string | null;
  title?: string | null;
}

/**
 * Notify the mentioned users: one row per message per mentioned user (never coalesced — §12), so
 * each one emails (subject to the channel-level opt-out). Recipients were already validated as
 * thread-audience members at post time, EXCEPT in direct chats — there anyone may be referenced
 * but only actual participants are pinged (§24, `participantsOnly`). Everyone is further filtered
 * by the `discussion_notifications` toggle (the same switch gates mentions in every context, §12)
 * and `status='active'`. Returns the user ids actually MENTIONED (author excluded), so the
 * coalesced fan-out can skip them — the mention supersedes their `message.new`/`skill.discussion`
 * row for this message (§12) whether or not their opt-outs silenced the ping itself.
 */
export async function fanOutMentions(
  mentionedUserIds: string[],
  authorId: string,
  ctx: MentionNotifyContext,
  opts: { participantsOnly?: boolean } = {},
): Promise<string[]> {
  const targets = [...new Set(mentionedUserIds)].filter((id) => id !== authorId);
  if (!targets.length) return [];
  const payload = JSON.stringify({
    conversationId: ctx.conversationId,
    messageId: ctx.messageId,
    fromName: ctx.fromName,
    proposalId: ctx.proposalId ?? null,
    requestId: ctx.requestId ?? null,
    namespaceSlug: ctx.namespaceSlug ?? null,
    skillSlug: ctx.skillSlug ?? null,
    title: ctx.title ?? null,
  });
  await pool.query(
    `insert into notifications (user_id, type, payload)
     select u.id, 'message.mention', $2::jsonb
       from users u
      where u.id = any($1::uuid[]) and u.status = 'active' and u.erased_at is null and u.discussion_notifications
        and ($4 = false or exists (
          select 1 from conversation_participants cp where cp.conversation_id = $3 and cp.user_id = u.id
        ))`,
    [targets, payload, ctx.conversationId, opts.participantsOnly ?? false],
  );
  return targets;
}

// ── Per-reader resolution (render time) ─────────────────────────────────────

/**
 * Resolve the mentions of a page of messages FOR THE REQUESTING READER — the client renders
 * chips from this map (keyed by the literal token) and falls back to plain text for any token
 * not in it. A skill the reader can't see resolves to a nameless `restricted` entry; a deleted
 * skill to `gone` + the post-time label; users resolve live (erased → the tombstone label).
 */
export async function resolveMentions(access: Access, messageIds: string[]): Promise<MentionMap> {
  if (!messageIds.length) return {};
  const { rows } = await pool.query<{
    kind: "user" | "skill"; target_id: string; label: string | null;
    u_name: string | null; u_erased: string | null;
    s_title: string | null; s_slug: string | null; s_status: string | null;
    s_visibility: "org" | "namespace" | null; s_namespace_id: string | null; ns_slug: string | null;
  }>(
    `select distinct mm.kind, mm.target_id, mm.label,
            case when mm.kind = 'user' then ${nameSql("u.display_name", "u.email")} end as u_name,
            u.erased_at::text as u_erased,
            s.title as s_title, s.slug as s_slug, s.status as s_status,
            s.visibility as s_visibility, s.namespace_id as s_namespace_id, n.slug as ns_slug
       from message_mentions mm
       left join users u on mm.kind = 'user' and u.id = mm.target_id
       left join skills s on mm.kind = 'skill' and s.id = mm.target_id
       left join namespaces n on n.id = s.namespace_id
      where mm.message_id = any($1::uuid[])`,
    [messageIds],
  );

  // Archived skills are owner-only (§7): for any archived mentioned skill, check whether the
  // reader is an explicit maintainer (platform/ns-admin ownership resolves from access alone).
  const archivedIds = rows.filter((r) => r.kind === "skill" && r.s_status === "archived").map((r) => r.target_id);
  const maintainerOf = new Set<string>();
  if (archivedIds.length && access.userId) {
    const m = await pool.query<{ skill_id: string }>(
      `select skill_id from skill_maintainers where user_id = $1 and skill_id = any($2::uuid[])`,
      [access.userId, archivedIds],
    );
    for (const r of m.rows) maintainerOf.add(r.skill_id);
  }

  const map: MentionMap = {};
  for (const r of rows) {
    const token = mentionToken(r.kind, r.target_id);
    if (r.kind === "user") {
      // A dangling user id (should not happen — users are never hard-deleted) renders literal.
      if (r.u_name == null) continue;
      map[token] = { kind: "user", id: r.target_id, name: userLabel(r.u_name, null), erased: r.u_erased != null };
      continue;
    }
    if (!r.s_slug || !r.s_namespace_id || !r.ns_slug) {
      map[token] = { kind: "skill", id: r.target_id, state: "gone", label: r.label };
      continue;
    }
    const visible =
      r.s_status === "archived"
        ? access.isPlatformAdmin ||
          access.namespaceRoles.get(r.s_namespace_id) === "namespace_admin" ||
          maintainerOf.has(r.target_id)
        : isSkillVisible(access, { namespaceId: r.s_namespace_id, visibility: r.s_visibility ?? "namespace" });
    map[token] = visible
      ? { kind: "skill", id: r.target_id, state: "ok", title: r.s_title ?? r.s_slug, ns: r.ns_slug, slug: r.s_slug, restricted: r.s_visibility === "namespace" }
      : { kind: "skill", id: r.target_id, state: "restricted" };
  }
  return map;
}

// ── People typeahead (§24 composer `@` picker + §10 header people mode) ─────

export interface UserSuggestion { id: string; name: string; email: string; avatar: string | null }

/**
 * Suggest mentionable people: substring over display name AND email, non-erased `active` users
 * only, bounded. `audience` narrows the pool to the thread's mentionable set (§24) — proposal
 * threads and restricted-skill discussions; everywhere else it is the whole directory (§28
 * precedent: people have no per-user visibility model).
 */
export async function suggestUsers(q: string, audience: MentionAudience | null, limit = 6): Promise<UserSuggestion[]> {
  const capped = Math.min(10, Math.max(1, limit));
  const params: unknown[] = [`%${q}%`];
  const aud = audiencePredicate(audience ?? { kind: "direct" }, params);
  params.push(capped);
  const { rows } = await pool.query<{ id: string; name: string; email: string; avatar: string | null }>(
    `select u.id, ${nameSql("u.display_name", "u.email")} as name, u.email, u.avatar
       from users u
      where u.status = 'active' and u.erased_at is null
        and (u.display_name ilike $1 or u.email ilike $1)
        and ${aud}
      order by u.display_name asc, u.email asc
      limit $${params.length}`,
    params,
  );
  return rows;
}

/** Clear the reader's `message.mention` rows for one conversation (part of the read action). */
export async function clearMentionNotifications(userId: string, conversationId: string): Promise<void> {
  await pool.query(
    `update notifications set read_at = now()
      where user_id = $1 and type = 'message.mention' and read_at is null and payload->>'conversationId' = $2`,
    [userId, conversationId],
  );
}
