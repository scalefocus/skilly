// Messaging (SKILLY_SPEC.md §24). A general conversation/message layer. Contexts: 'proposal'
// (review discussion between the submitter and the namespace's reviewers + the target skill's
// maintainers), 'request' (a skill request's discussion, §26 — open to any authenticated user,
// since the request itself is org-visible), and 'direct' (1:1 DMs). Deliberately context-
// polymorphic; adding 'request' did not change the proposal review flow's own access rules.
//
// Read model: a conversation is VISIBLE to its context audience (checked dynamically). A
// `conversation_participants` row tracks each engaged user's last_read_at; new messages coalesce
// into ONE unread `message.new` notification per recipient per conversation, and "reading" is
// opening the thread (markRead advances last_read_at AND clears that conversation's notification).
import { pool } from "./db";
import { resolveUserAccess } from "./access";
import { appendAudit } from "./audit";
import { nameSql, userLabel as label } from "./userLabel";
import type { RequestState } from "./requests";
import { canReviewNamespace, isSkillVisible, type EffectiveAccess } from "@skilly/shared";

export const MAX_MESSAGE_LEN = 4000;
/** Skill-discussion comments are capped tighter than the general message body (§24). */
export const MAX_SKILL_DISCUSSION_LEN = 500;
type Access = EffectiveAccess & { userId: string | null };

export interface MessageView {
  id: string; authorId: string; authorName: string; authorAvatar: string | null; mine: boolean; body: string; createdAt: string;
  /** "Original Requester" tag (§26) — set only on a skill request's own messages. */
  authorBadge?: string;
}
export interface ThreadView {
  id: string; title: string; href: string | null; canPost: boolean; closed: boolean; messages: MessageView[]; peerName: string | null; peerAvatar: string | null; peerUserId: string | null;
  /** UI copy for the locked state, when it differs from the generic default (proposal/direct keep
   *  ChatBox's built-in wording; only set here for contexts that need their own, e.g. a request). */
  closedHint: string | null;
}
export interface ConversationSummary { id: string; title: string; href: string | null; unread: number; lastBody: string | null; lastFromName: string | null; lastAt: string | null; peerName: string | null; peerAvatar: string | null; peerUserId: string | null }
export interface SubmitterCard { userId: string; displayName: string; email: string; avatar: string | null; role: string; priorSubmissions: number }

// ── Proposal context ───────────────────────────────────────────────────────
interface ProposalCtx {
  kind: "proposal";
  proposalId: string; submitterId: string; namespaceId: string; skillId: string | null;
  namespaceSlug: string; skillSlug: string | null; semver: string; state: string;
}

async function loadProposalCtx(proposalId: string): Promise<ProposalCtx | null> {
  const { rows } = await pool.query<{
    id: string; submitted_by: string; target_namespace_id: string; target_skill_id: string | null;
    proposed_semver: string; state: string; ns_slug: string; skill_slug: string | null;
  }>(
    `select p.id, p.submitted_by, p.target_namespace_id, p.target_skill_id, p.proposed_semver, p.state,
            n.slug as ns_slug, coalesce(s.slug, rev.slug) as skill_slug
       from proposals p
       join namespaces n on n.id = p.target_namespace_id
       left join skills s on s.id = p.target_skill_id
       left join lateral (
         select payload->'metadata'->>'skillSlug' as slug from proposal_revisions
          where proposal_id = p.id order by revision_no desc limit 1
       ) rev on true
      where p.id = $1`,
    [proposalId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    kind: "proposal",
    proposalId: r.id, submitterId: r.submitted_by, namespaceId: r.target_namespace_id,
    skillId: r.target_skill_id, namespaceSlug: r.ns_slug, skillSlug: r.skill_slug,
    semver: r.proposed_semver, state: r.state,
  };
}

const ctxTitle = (c: ProposalCtx) => `@${c.namespaceSlug}/${c.skillSlug ?? "?"} · v${c.semver}`;
const TERMINAL = new Set(["accepted", "rejected"]);

async function isSkillMaintainer(userId: string, skillId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`select 1 from skill_maintainers where skill_id = $1 and user_id = $2`, [skillId, userId]);
  return (rowCount ?? 0) > 0;
}

/** Can this caller see/participate in a proposal's review thread? Submitter ∪ namespace reviewers
 *  ∪ target-skill maintainers — checked dynamically so it tracks admin-group changes. Untouched by
 *  the request-discussion feature below (§26) — the review/approval flow's access rules are unchanged. */
async function canAccessProposal(access: Access, c: ProposalCtx): Promise<boolean> {
  if (!access.userId) return false;
  if (c.submitterId === access.userId) return true;
  if (canReviewNamespace(access, c.namespaceId)) return true;
  if (c.skillId && (await isSkillMaintainer(access.userId, c.skillId))) return true;
  return false;
}

// ── Skill-request context (§26) ─────────────────────────────────────────────
// A request's discussion is a SEPARATE, additive context alongside 'proposal' — it does not alter
// the proposal review flow above. A request is org-visible to every authenticated user (no
// namespace, no reviewers), so its thread is correspondingly open: any signed-in user may post.
interface RequestCtx {
  kind: "request";
  requestId: string; requesterId: string; title: string; state: RequestState;
}

async function loadRequestCtx(requestId: string): Promise<RequestCtx | null> {
  const { rows } = await pool.query<{ requester_user_id: string; title: string; state: RequestState }>(
    `select requester_user_id, title, state from skill_requests where id = $1`,
    [requestId],
  );
  const r = rows[0];
  if (!r) return null;
  return { kind: "request", requestId, requesterId: r.requester_user_id, title: r.title, state: r.state };
}

// ── Generic context helpers (proposal ∪ request) ────────────────────────────
type ConvCtx = ProposalCtx | RequestCtx;

function isClosedCtx(ctx: ConvCtx): boolean {
  return ctx.kind === "proposal" ? TERMINAL.has(ctx.state) : ctx.state !== "open";
}
function closedMessageOf(ctx: ConvCtx): string {
  return ctx.kind === "proposal"
    ? "this proposal is closed — the discussion is read-only"
    : `this request is ${ctx.state} — the discussion is read-only`;
}
/** Any authenticated user may post/read a request's discussion (§26); proposal access is unchanged. */
async function canAccessCtx(access: Access, ctx: ConvCtx): Promise<boolean> {
  return ctx.kind === "proposal" ? canAccessProposal(access, ctx) : !!access.userId;
}
function titleOfCtx(ctx: ConvCtx): string {
  return ctx.kind === "proposal" ? ctxTitle(ctx) : `Request: ${ctx.title}`;
}
function hrefOfCtx(ctx: ConvCtx): string {
  return ctx.kind === "proposal" ? `/proposals/${ctx.proposalId}` : `/requests/${ctx.requestId}`;
}
function ownerIdOfCtx(ctx: ConvCtx): string {
  return ctx.kind === "proposal" ? ctx.submitterId : ctx.requesterId;
}

// ── Conversation get/create ─────────────────────────────────────────────────
export async function findConversation(subjectType: string, subjectId: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(`select id from conversations where subject_type = $1 and subject_id = $2`, [subjectType, subjectId]);
  return rows[0]?.id ?? null;
}

async function getOrCreateConversation(subjectType: string, subjectId: string): Promise<string> {
  await pool.query(
    `insert into conversations (subject_type, subject_id) values ($1, $2)
       on conflict (subject_type, subject_id) where subject_id is not null do nothing`,
    [subjectType, subjectId],
  );
  return (await findConversation(subjectType, subjectId))!;
}

/** Get-or-create the 1:1 DIRECT conversation between the caller and another user (e.g. "reach out"
 *  to a maintainer). Deduped by the exact two-participant set so repeat clicks reuse the thread. */
export async function getOrCreateDirectConversation(access: Access, targetUserId: string):
  Promise<{ ok: true; conversationId: string } | { ok: false; status: number; error: string }> {
  if (!access.userId) return { ok: false, status: 403, error: "unknown user" };
  const isSelf = targetUserId === access.userId;
  // Messaging yourself is pointless in production, but under dev passwordless sign-in we allow it so
  // a solo developer can exercise the "Reach out" flow without a second account.
  if (isSelf && process.env.SKILLY_DEV_AUTH !== "1") {
    return { ok: false, status: 422, error: "you can't message yourself" };
  }
  if (!isSelf && (await pool.query(`select 1 from users where id = $1`, [targetUserId])).rowCount === 0) {
    return { ok: false, status: 404, error: "user not found" };
  }
  if (isSelf) {
    // A self-thread is a direct conversation whose only participant is you — deduped on that.
    const mine = await pool.query<{ id: string }>(
      `select c.id from conversations c
         join conversation_participants p on p.conversation_id = c.id
        where c.subject_type = 'direct'
        group by c.id having count(*) = 1 and bool_and(p.user_id = $1)`,
      [access.userId],
    );
    if (mine.rows[0]) return { ok: true, conversationId: mine.rows[0].id };
    const conv = await pool.query<{ id: string }>(`insert into conversations (subject_type, subject_id) values ('direct', null) returning id`);
    const cid = conv.rows[0]!.id;
    await pool.query(
      `insert into conversation_participants (conversation_id, user_id, last_read_at) values ($1, $2, now()) on conflict do nothing`,
      [cid, access.userId],
    );
    return { ok: true, conversationId: cid };
  }
  const found = await pool.query<{ id: string }>(
    `select c.id from conversations c
       join conversation_participants p on p.conversation_id = c.id
      where c.subject_type = 'direct'
      group by c.id
      having count(*) = 2 and bool_or(p.user_id = $1) and bool_or(p.user_id = $2)`,
    [access.userId, targetUserId],
  );
  if (found.rows[0]) return { ok: true, conversationId: found.rows[0].id };
  const conv = await pool.query<{ id: string }>(`insert into conversations (subject_type, subject_id) values ('direct', null) returning id`);
  const cid = conv.rows[0]!.id;
  await pool.query(
    `insert into conversation_participants (conversation_id, user_id, last_read_at)
       values ($1, $2, now()), ($1, $3, now()) on conflict do nothing`,
    [cid, access.userId, targetUserId],
  );
  return { ok: true, conversationId: cid };
}

// ── Posting ─────────────────────────────────────────────────────────────────
/** Post into a proposal thread (get-or-creating it). Returns 403/404/422 as a discriminated error. */
export async function postProposalMessage(access: Access, proposalId: string, rawBody: string):
  Promise<{ ok: true; conversationId: string; message: MessageView } | { ok: false; status: number; error: string }> {
  if (!access.userId) return { ok: false, status: 403, error: "unknown user" };
  const c = await loadProposalCtx(proposalId);
  if (!c) return { ok: false, status: 404, error: "not found" };
  if (!(await canAccessProposal(access, c))) return { ok: false, status: 404, error: "not found" }; // no leak
  if (TERMINAL.has(c.state)) return { ok: false, status: 409, error: "this proposal is closed — the discussion is read-only" };
  const body = rawBody.trim();
  if (!body) return { ok: false, status: 422, error: "message is empty" };
  if (body.length > MAX_MESSAGE_LEN) return { ok: false, status: 422, error: `message too long (max ${MAX_MESSAGE_LEN})` };

  const conversationId = await getOrCreateConversation("proposal", proposalId);
  const message = await insertMessage(conversationId, access.userId, body);
  await fanOut(conversationId, access.userId, c);
  return { ok: true, conversationId, message };
}

/** Post into a skill request's discussion (get-or-creating it). Any authenticated user may post —
 *  the request itself is org-visible to everyone (§26). Separate from postProposalMessage above;
 *  the proposal review flow is unaffected. */
export async function postRequestMessage(access: Access, requestId: string, rawBody: string):
  Promise<{ ok: true; conversationId: string; message: MessageView } | { ok: false; status: number; error: string }> {
  if (!access.userId) return { ok: false, status: 403, error: "unknown user" };
  const c = await loadRequestCtx(requestId);
  if (!c) return { ok: false, status: 404, error: "not found" };
  if (isClosedCtx(c)) return { ok: false, status: 409, error: closedMessageOf(c) };
  const body = rawBody.trim();
  if (!body) return { ok: false, status: 422, error: "message is empty" };
  if (body.length > MAX_MESSAGE_LEN) return { ok: false, status: 422, error: `message too long (max ${MAX_MESSAGE_LEN})` };

  const conversationId = await getOrCreateConversation("request", requestId);
  const message = await insertMessage(conversationId, access.userId, body);
  await fanOut(conversationId, access.userId, c);
  return { ok: true, conversationId, message };
}

/** Post into an existing conversation by id (used by the global messages UI). */
export async function postToConversation(access: Access, conversationId: string, rawBody: string):
  Promise<{ ok: true; message: MessageView } | { ok: false; status: number; error: string }> {
  if (!access.userId) return { ok: false, status: 403, error: "unknown user" };
  const conv = await loadConversation(conversationId);
  if (!conv) return { ok: false, status: 404, error: "not found" };
  if (conv.ctx) {
    if (!(await canAccessCtx(access, conv.ctx))) return { ok: false, status: 404, error: "not found" };
    if (isClosedCtx(conv.ctx)) return { ok: false, status: 409, error: closedMessageOf(conv.ctx) };
  } else if (!(await isParticipant(conversationId, access.userId))) {
    return { ok: false, status: 404, error: "not found" };
  }
  const body = rawBody.trim();
  if (!body) return { ok: false, status: 422, error: "message is empty" };
  if (body.length > MAX_MESSAGE_LEN) return { ok: false, status: 422, error: `message too long (max ${MAX_MESSAGE_LEN})` };
  const message = await insertMessage(conversationId, access.userId, body);
  await fanOut(conversationId, access.userId, conv.ctx);
  return { ok: true, message };
}

async function insertMessage(
  conversationId: string,
  authorId: string,
  body: string,
  opts: { contextSemver?: string | null; trackParticipant?: boolean } = {},
): Promise<MessageView & { contextSemver: string | null }> {
  const contextSemver = opts.contextSemver ?? null;
  const trackParticipant = opts.trackParticipant ?? true;
  const { rows } = await pool.query<{ id: string; created_at: string; display_name: string; avatar: string | null }>(
    `with m as (
       insert into messages (conversation_id, author_id, body, context_semver) values ($1, $2, $3, $4) returning id, created_at, author_id
     )
     select m.id, m.created_at, u.display_name, u.avatar from m join users u on u.id = m.author_id`,
    [conversationId, authorId, body, contextSemver],
  );
  await pool.query(`update conversations set updated_at = now() where id = $1`, [conversationId]);
  // The author has implicitly read up to their own message. Skill discussions are open forums
  // with NO participant rows (§24) — skip the upsert so a skill thread never surfaces in the
  // topbar messages menu (which is participant-scoped).
  if (trackParticipant) {
    await pool.query(
      `insert into conversation_participants (conversation_id, user_id, last_read_at) values ($1, $2, now())
         on conflict (conversation_id, user_id) do update set last_read_at = now()`,
      [conversationId, authorId],
    );
  }
  const r = rows[0]!;
  return { id: r.id, authorId, authorName: r.display_name, authorAvatar: r.avatar, mine: true, body, createdAt: r.created_at, contextSemver };
}

/** Coalesced fan-out: one unread `message.new` notification per recipient per conversation. */
async function fanOut(conversationId: string, authorId: string, ctx: ConvCtx | null): Promise<void> {
  const audience = new Set<string>();
  const parts = await pool.query<{ user_id: string }>(`select user_id from conversation_participants where conversation_id = $1`, [conversationId]);
  for (const p of parts.rows) audience.add(p.user_id);
  if (ctx) audience.add(ownerIdOfCtx(ctx)); // submitter/requester is always a party, even before they engage
  audience.delete(authorId);
  if (audience.size === 0) return;
  const fromName = (await pool.query<{ display_name: string }>(`select display_name from users where id = $1`, [authorId])).rows[0]?.display_name ?? "Someone";
  const title = ctx ? titleOfCtx(ctx) : "Direct message";
  const proposalId = ctx?.kind === "proposal" ? ctx.proposalId : null;
  const requestId = ctx?.kind === "request" ? ctx.requestId : null;
  for (const uid of audience) {
    // Coalesce IN PLACE, atomically: one upsert against the partial unique index
    // idx_notifications_msgnew_unread (migration 0053) refreshes the existing unread alert's
    // payload/recency while PRESERVING its delivery bookkeeping (delivered_at etc.) — a
    // delete+reinsert would reset delivered_at and the §12 email channel would re-email on
    // every new message, and a non-atomic update-then-insert could race two concurrent posts
    // into duplicate rows (= duplicate emails). This keeps the contract "at most one email
    // per conversation until read" (SKILLY_SPEC.md §12/§24).
    const payload = JSON.stringify({ conversationId, proposalId, requestId, title, fromName });
    await pool.query(
      `insert into notifications (user_id, type, payload) values ($1, 'message.new', $2::jsonb)
       on conflict (user_id, (payload->>'conversationId')) where type = 'message.new' and read_at is null
       do update set payload = excluded.payload, created_at = now()`,
      [uid, payload],
    );
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────
async function isParticipant(conversationId: string, userId: string): Promise<boolean> {
  const { rowCount } = await pool.query(`select 1 from conversation_participants where conversation_id = $1 and user_id = $2`, [conversationId, userId]);
  return (rowCount ?? 0) > 0;
}

/** The other party (id + name + avatar) in a 1:1 direct conversation — for its title/header bubble. */
async function otherParticipant(conversationId: string, selfId: string): Promise<{ userId: string; name: string; avatar: string | null } | null> {
  const { rows } = await pool.query<{ user_id: string; display_name: string; avatar: string | null }>(
    `select u.id as user_id, ${nameSql("u.display_name", "u.email")} as display_name, u.avatar from conversation_participants p join users u on u.id = p.user_id
      where p.conversation_id = $1 and p.user_id <> $2 order by p.created_at asc limit 1`,
    [conversationId, selfId],
  );
  return rows[0] ? { userId: rows[0].user_id, name: rows[0].display_name, avatar: rows[0].avatar } : null;
}

/** A user's own id + name + avatar — used as the "peer" for a self-thread (dev test) that has no other party. */
async function userIdentity(userId: string): Promise<{ userId: string; name: string; avatar: string | null } | null> {
  const { rows } = await pool.query<{ display_name: string; avatar: string | null }>(`select ${nameSql("display_name", "email")} as display_name, avatar from users where id = $1`, [userId]);
  return rows[0] ? { userId, name: rows[0].display_name, avatar: rows[0].avatar } : null;
}

async function loadConversation(conversationId: string): Promise<{ id: string; subjectType: string; subjectId: string | null; ctx: ConvCtx | null } | null> {
  const { rows } = await pool.query<{ subject_type: string; subject_id: string | null }>(`select subject_type, subject_id from conversations where id = $1`, [conversationId]);
  const r = rows[0];
  if (!r) return null;
  // Skill discussions (§24) are served ONLY by their dedicated endpoints, never the generic
  // messages surface — treat them as not-found here so /api/messages/:id can't read or post to
  // a skill thread (they carry no participant rows and are page-anchored, not in the inbox).
  if (r.subject_type === "skill") return null;
  const ctx: ConvCtx | null =
    r.subject_type === "proposal" && r.subject_id ? await loadProposalCtx(r.subject_id) :
    r.subject_type === "request" && r.subject_id ? await loadRequestCtx(r.subject_id) :
    null;
  // Orphaned thread (its proposal/request was deleted): treat as not found so it's never
  // opened/posted-to and can't render as "@null/?". Cleanup happens on skill delete (§24) / on
  // request withdraw-or-remove (§26, both hard-delete the row).
  if ((r.subject_type === "proposal" || r.subject_type === "request") && !ctx) return null;
  return { id: conversationId, subjectType: r.subject_type, subjectId: r.subject_id, ctx };
}

/** Mark a conversation read for a user (the read action) — advances last_read_at AND clears the
 *  coalesced bell notification for this thread. */
export async function markConversationRead(access: Access, conversationId: string): Promise<boolean> {
  if (!access.userId) return false;
  const conv = await loadConversation(conversationId);
  if (!conv) return false;
  if (conv.ctx) { if (!(await canAccessCtx(access, conv.ctx))) return false; }
  else if (!(await isParticipant(conversationId, access.userId))) return false;
  await pool.query(
    `insert into conversation_participants (conversation_id, user_id, last_read_at) values ($1, $2, now())
       on conflict (conversation_id, user_id) do update set last_read_at = now()`,
    [conversationId, access.userId],
  );
  await pool.query(`update notifications set read_at = now() where user_id = $1 and type = 'message.new' and read_at is null and payload->>'conversationId' = $2`, [access.userId, conversationId]);
  return true;
}

export async function getThread(access: Access, conversationId: string): Promise<ThreadView | null> {
  if (!access.userId) return null;
  const conv = await loadConversation(conversationId);
  if (!conv) return null;
  if (conv.ctx) { if (!(await canAccessCtx(access, conv.ctx))) return null; }
  else if (!(await isParticipant(conversationId, access.userId))) return null;
  const closed = conv.ctx ? isClosedCtx(conv.ctx) : false;
  // Direct threads show the OTHER participant (name + avatar) in the header; proposal/request
  // threads use their own label. A self-thread (dev test) has no other participant → peer stays null.
  // Direct: the other party; for a self-thread (no other party) fall back to your own identity.
  const peer = conv.ctx ? null : ((await otherParticipant(conversationId, access.userId)) ?? (await userIdentity(access.userId)));
  const title = conv.ctx ? titleOfCtx(conv.ctx) : peer?.name ?? "Direct message";
  const { rows } = await pool.query<{ id: string; author_id: string; display_name: string; avatar: string | null; body: string; created_at: string }>(
    `select m.id, m.author_id, ${nameSql("u.display_name", "u.email")} as display_name, u.avatar, m.body, m.created_at
       from messages m join users u on u.id = m.author_id
      where m.conversation_id = $1 order by m.created_at asc`,
    [conversationId],
  );
  return {
    id: conversationId,
    title,
    href: conv.ctx ? hrefOfCtx(conv.ctx) : null,
    canPost: !closed,
    closed,
    closedHint: conv.ctx?.kind === "request" ? "This discussion is read-only — the request has been fulfilled." : null,
    peerName: peer?.name ?? null,
    peerAvatar: peer?.avatar ?? null,
    peerUserId: peer?.userId ?? null,
    messages: rows.map((m) => ({
      id: m.id, authorId: m.author_id, authorName: m.display_name, authorAvatar: m.avatar, mine: m.author_id === access.userId, body: m.body, createdAt: m.created_at,
      // "Original Requester" tag (§26) — only meaningful in a request's thread, only on the requester's own messages.
      ...(conv.ctx?.kind === "request" && m.author_id === conv.ctx.requesterId ? { authorBadge: "Original Requester" } : {}),
    })),
  };
}

/** Thread for a proposal (lazy: returns conversationId null + empty when none exists yet). */
export async function getProposalThread(access: Access, proposalId: string): Promise<{ conversationId: string | null; canPost: boolean; closed: boolean; messages: MessageView[] } | null> {
  if (!access.userId) return null;
  const c = await loadProposalCtx(proposalId);
  if (!c) return null;
  if (!(await canAccessProposal(access, c))) return null;
  const closed = TERMINAL.has(c.state);
  const conversationId = await findConversation("proposal", proposalId);
  if (!conversationId) return { conversationId: null, canPost: !closed, closed, messages: [] };
  const t = await getThread(access, conversationId);
  return { conversationId, canPost: !closed, closed, messages: t?.messages ?? [] };
}

/** Thread for a skill request (§26) — same lazy shape as getProposalThread. Any authenticated user
 *  may read/post (the request is org-visible); separate from the proposal path above. */
export async function getRequestThread(access: Access, requestId: string): Promise<{ conversationId: string | null; canPost: boolean; closed: boolean; messages: MessageView[] } | null> {
  if (!access.userId) return null;
  const c = await loadRequestCtx(requestId);
  if (!c) return null;
  const closed = isClosedCtx(c);
  const conversationId = await findConversation("request", requestId);
  if (!conversationId) return { conversationId: null, canPost: !closed, closed, messages: [] };
  const t = await getThread(access, conversationId);
  return { conversationId, canPost: !closed, closed, messages: t?.messages ?? [] };
}

// ── Skill discussion (§24 "Skill discussion") ───────────────────────────────
// The skill detail page's Discussion card — a third messaging context
// (subject_type='skill', subject_id=skills.id). An OPEN forum: read/post = anyone who can see
// the skill (visibility inherited exactly, invariant #3; archived → owner-only, read-only). No
// participant rows (so it never appears in the topbar messages menu). Each comment stamps the
// version it's about (context_semver) at post time. Moderator hard-delete (effective
// maintainers ∪ platform admins) is the only message delete in the system. New comments fan out
// a coalesced `skill.discussion` notification to watchers ∪ effective maintainers.
export interface SkillDiscussionSkill {
  id: string;
  namespaceId: string;
  namespaceSlug: string;
  skillSlug: string;
  visibility: "org" | "namespace";
  archived: boolean;
}
export interface SkillDiscussionMessage extends MessageView {
  /** The version the comment is about (§24). Null when the skill had no active version at post time. */
  contextSemver: string | null;
}
export interface SkillDiscussionThread {
  conversationId: string | null;
  count: number;
  archived: boolean;
  canPost: boolean;
  canModerate: boolean;
  messages: SkillDiscussionMessage[];
  hasMore: boolean;
}

/** True if the caller may see the skill's discussion — mirrors the detail route's gate exactly. */
export function canReadSkill(access: Access, skill: SkillDiscussionSkill, isOwner: boolean): boolean {
  if (skill.archived) return isOwner; // archived skills are owner-only (§7)
  return isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility });
}

/** True if the caller may delete comments: platform admin, the namespace's admin, or an
 *  explicit maintainer of this skill (the effective-maintainer set, §19). */
export async function canModerateSkillDiscussion(access: Access, skill: SkillDiscussionSkill): Promise<boolean> {
  if (!access.userId) return false;
  if (access.isPlatformAdmin) return true;
  if (access.namespaceRoles.get(skill.namespaceId) === "namespace_admin") return true;
  const { rowCount } = await pool.query(`select 1 from skill_maintainers where skill_id = $1 and user_id = $2`, [skill.id, access.userId]);
  return (rowCount ?? 0) > 0;
}

/** Live comment count for the collapsed card header ("Discussion (N)") — 0 when no thread yet. */
export async function skillDiscussionCount(skillId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from messages m
       join conversations c on c.id = m.conversation_id
      where c.subject_type = 'skill' and c.subject_id = $1`,
    [skillId],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Fetch a page of a skill's discussion (newest-first). `offset === 0` is the read action: it
 *  clears the caller's coalesced `skill.discussion` alert for this skill (§24). */
export async function getSkillDiscussion(
  access: Access,
  skill: SkillDiscussionSkill,
  opts: { limit?: number; offset?: number } = {},
): Promise<SkillDiscussionThread> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 100));
  const offset = Math.max(0, opts.offset ?? 0);
  const canModerate = await canModerateSkillDiscussion(access, skill);
  const conversationId = await findConversation("skill", skill.id);
  const canPost = !skill.archived;
  if (!conversationId) return { conversationId: null, count: 0, archived: skill.archived, canPost, canModerate, messages: [], hasMore: false };

  const [{ rows }, count] = await Promise.all([
    pool.query<{ id: string; author_id: string; display_name: string; avatar: string | null; body: string; context_semver: string | null; created_at: string }>(
      `select m.id, m.author_id, ${nameSql("u.display_name", "u.email")} as display_name, u.avatar, m.body, m.context_semver, m.created_at
         from messages m join users u on u.id = m.author_id
        where m.conversation_id = $1 order by m.created_at desc, m.id desc limit $2 offset $3`,
      [conversationId, limit + 1, offset],
    ),
    skillDiscussionCount(skill.id),
  ]);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // The read action: clear this user's coalesced skill.discussion bell for the thread.
  if (offset === 0 && access.userId) {
    await pool.query(
      `update notifications set read_at = now() where user_id = $1 and type = 'skill.discussion' and read_at is null and payload->>'conversationId' = $2`,
      [access.userId, conversationId],
    );
  }

  return {
    conversationId,
    count,
    archived: skill.archived,
    canPost,
    canModerate,
    hasMore,
    messages: page.map((m) => ({
      id: m.id, authorId: m.author_id, authorName: m.display_name, authorAvatar: m.avatar,
      mine: m.author_id === access.userId, body: m.body, createdAt: m.created_at, contextSemver: m.context_semver,
    })),
  };
}

/** Post a comment on a skill's discussion (get-or-creating the thread). Validates the body (≤500)
 *  and that `contextSemver`, when given, is an ACTIVE version of the skill; a skill with no active
 *  version accepts a comment with no version (null pill). Fans out a coalesced skill.discussion
 *  notification. Read-only when the skill is archived. §24. */
export async function postSkillDiscussionMessage(
  access: Access,
  skill: SkillDiscussionSkill,
  rawBody: string,
  contextSemver: string | null,
): Promise<{ ok: true; conversationId: string; message: SkillDiscussionMessage } | { ok: false; status: number; error: string }> {
  if (!access.userId) return { ok: false, status: 403, error: "unknown user" };
  if (skill.archived) return { ok: false, status: 409, error: "this skill is archived — the discussion is read-only" };
  const body = rawBody.trim();
  if (!body) return { ok: false, status: 422, error: "message is empty" };
  if (body.length > MAX_SKILL_DISCUSSION_LEN) return { ok: false, status: 422, error: `message too long (max ${MAX_SKILL_DISCUSSION_LEN})` };

  // Resolve the version pill. A non-null semver must be an active (non-yanked) version of this
  // skill; anything else is rejected (a stale/forged pick can't be stamped). Null is allowed
  // only when the skill genuinely has no active version to reference.
  let semver: string | null = null;
  const { rows: active } = await pool.query<{ semver: string }>(
    `select semver from skill_versions where skill_id = $1 and status = 'active'`,
    [skill.id],
  );
  if (contextSemver != null) {
    if (!active.some((v) => v.semver === contextSemver)) return { ok: false, status: 422, error: "unknown or inactive version" };
    semver = contextSemver;
  }

  const conversationId = await getOrCreateConversation("skill", skill.id);
  const message = await insertMessage(conversationId, access.userId, body, { contextSemver: semver, trackParticipant: false });
  await fanOutSkillDiscussion(conversationId, skill, access.userId);
  return { ok: true, conversationId, message };
}

/** Moderator hard-delete of a single comment (§24) — the only message delete in the system.
 *  Authority (effective maintainer ∪ platform admin) is re-verified by the caller AND here.
 *  Audited (`skill.discussion_message_deleted`); the body is never recorded. */
export async function deleteSkillDiscussionMessage(
  access: Access,
  skill: SkillDiscussionSkill,
  messageId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!access.userId) return { ok: false, status: 403, error: "unknown user" };
  if (!(await canModerateSkillDiscussion(access, skill))) return { ok: false, status: 403, error: "not allowed" };
  // Delete only if the message really belongs to THIS skill's discussion thread.
  const { rows } = await pool.query<{ author_id: string }>(
    `delete from messages m
       using conversations c
      where m.id = $1 and m.conversation_id = c.id and c.subject_type = 'skill' and c.subject_id = $2
      returning m.author_id`,
    [messageId, skill.id],
  );
  if (rows.length === 0) return { ok: false, status: 404, error: "not found" };
  await appendAudit(pool, {
    actorUserId: access.userId,
    action: "skill.discussion_message_deleted",
    targetType: "skill",
    targetId: skill.id,
    namespaceId: skill.namespaceId,
    after: { messageId, authorId: rows[0]!.author_id }, // body intentionally NOT recorded (§24)
  });
  return { ok: true };
}

/** Coalesced fan-out for a new skill-discussion comment: one unread `skill.discussion` row per
 *  recipient per skill (upsert against idx_notifications_skilldisc_unread, preserving delivery
 *  bookkeeping — §12). Recipients = watchers ∪ effective maintainers (explicit ∪ ns admins),
 *  minus the author, minus discussion_notifications=false users, visibility-filtered so a watcher
 *  who lost access to a now-restricted skill is skipped (invariant #3). */
async function fanOutSkillDiscussion(conversationId: string, skill: SkillDiscussionSkill, authorId: string): Promise<void> {
  const fromName = (await pool.query<{ display_name: string }>(`select display_name from users where id = $1`, [authorId])).rows[0]?.display_name ?? "Someone";
  const payload = JSON.stringify({ conversationId, namespaceSlug: skill.namespaceSlug, skillSlug: skill.skillSlug, fromName });
  await pool.query(
    `insert into notifications (user_id, type, payload)
     select r.uid, 'skill.discussion', $2::jsonb
       from (
         select w.user_id as uid from skill_watches w where w.skill_id = $1
         union
         select sm.user_id from skill_maintainers sm where sm.skill_id = $1
         union
         select gm.user_id
           from role_mappings rm
           join group_memberships gm on gm.group_id = rm.group_id
          where rm.namespace_id = $3 and rm.role = 'namespace_admin'
       ) r
       join users u on u.id = r.uid and u.status = 'active' and u.discussion_notifications
      where r.uid <> $4
        and (
          $5 = 'org'
          or exists (
            select 1 from group_memberships gm2
            join role_mappings rm2 on rm2.group_id = gm2.group_id
            where gm2.user_id = r.uid and (rm2.role = 'platform_admin' or rm2.namespace_id = $3)
          )
        )
     on conflict (user_id, (payload->>'conversationId')) where type = 'skill.discussion' and read_at is null
     do update set payload = excluded.payload, created_at = now()`,
    [skill.id, payload, skill.namespaceId, authorId, skill.visibility],
  );
}

// ── Listing + unread (global messages UI) ───────────────────────────────────
export async function listConversations(
  access: Access,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ conversations: ConversationSummary[]; unreadConversations: number; hasMore: boolean }> {
  if (!access.userId) return { conversations: [], unreadConversations: 0, hasMore: false };
  const limit = Math.min(200, Math.max(1, opts.limit ?? 100));
  const offset = Math.max(0, opts.offset ?? 0);
  const { rows } = await pool.query<{
    id: string; subject_type: string; subject_id: string | null;
    submitted_by: string | null; ns_slug: string | null; skill_slug: string | null; semver: string | null;
    req_requester: string | null; req_title: string | null;
    last_body: string | null; last_from: string | null; last_at: string | null; other_name: string | null; other_avatar: string | null; other_user_id: string | null; unread: string;
  }>(
    `select c.id, c.subject_type, c.subject_id,
            pr.submitted_by, n.slug as ns_slug, coalesce(s.slug, rev.slug) as skill_slug, pr.proposed_semver as semver,
            req.requester_user_id as req_requester, req.title as req_title,
            lm.body as last_body, lm.from_name as last_from, lm.created_at as last_at,
            coalesce(op.display_name, ${nameSql("cu.display_name", "cu.email")}) as other_name, coalesce(op.avatar, cu.avatar) as other_avatar,
            coalesce(op.user_id, cu.id) as other_user_id,
            (select count(*) from messages m where m.conversation_id = c.id and m.author_id <> $1
               and m.created_at > coalesce(p.last_read_at, 'epoch'::timestamptz))::text as unread
       from conversations c
       left join conversation_participants p on p.conversation_id = c.id and p.user_id = $1
       left join proposals pr on c.subject_type = 'proposal' and pr.id = c.subject_id
       left join skill_requests req on c.subject_type = 'request' and req.id = c.subject_id
       left join namespaces n on n.id = pr.target_namespace_id
       left join skills s on s.id = pr.target_skill_id
       left join lateral (select payload->'metadata'->>'skillSlug' as slug from proposal_revisions where proposal_id = pr.id order by revision_no desc limit 1) rev on true
       left join lateral (select m.body, m.created_at, ${nameSql("u.display_name", "u.email")} as from_name from messages m join users u on u.id = m.author_id where m.conversation_id = c.id order by m.created_at desc limit 1) lm on true
       left join lateral (select pp.user_id, ${nameSql("u2.display_name", "u2.email")} as display_name, u2.avatar from conversation_participants pp join users u2 on u2.id = pp.user_id
                           where pp.conversation_id = c.id and pp.user_id <> $1 order by pp.created_at asc limit 1) op on true
       left join users cu on cu.id = $1
      where (p.user_id is not null or pr.submitted_by = $1 or req.requester_user_id = $1) and lm.created_at is not null
        and (c.subject_type <> 'proposal' or pr.id is not null) -- hide orphaned proposal threads
        and (c.subject_type <> 'request' or req.id is not null) -- hide withdrawn/removed (hard-deleted) request threads
      order by lm.created_at desc
      limit $2 offset $3`,
    [access.userId, limit, offset],
  );
  const conversations = rows.map((r) => ({
    id: r.id,
    title: r.subject_type === "proposal" ? `@${r.ns_slug}/${r.skill_slug ?? "?"} · v${r.semver}`
      : r.subject_type === "request" ? `Request: ${r.req_title ?? "?"}`
      : (r.other_name ?? "Direct message"),
    href: r.subject_type === "proposal" && r.subject_id ? `/proposals/${r.subject_id}`
      : r.subject_type === "request" && r.subject_id ? `/requests/${r.subject_id}`
      : null,
    unread: Number(r.unread),
    lastBody: r.last_body,
    lastFromName: r.last_from,
    lastAt: r.last_at,
    peerName: r.subject_type === "direct" ? r.other_name : null,
    peerAvatar: r.subject_type === "direct" ? r.other_avatar : null,
    peerUserId: r.subject_type === "direct" ? r.other_user_id : null,
  }));
  // Unread badge counts ALL conversations with unread messages — independent of the page above.
  const { rows: cnt } = await pool.query<{ n: string }>(
    `select count(*)::text as n from conversations c
       left join conversation_participants p on p.conversation_id = c.id and p.user_id = $1
       left join proposals pr on c.subject_type = 'proposal' and pr.id = c.subject_id
       left join skill_requests req on c.subject_type = 'request' and req.id = c.subject_id
      where (p.user_id is not null or pr.submitted_by = $1 or req.requester_user_id = $1)
        and (c.subject_type <> 'proposal' or pr.id is not null) -- hide orphaned proposal threads
        and (c.subject_type <> 'request' or req.id is not null) -- hide withdrawn/removed (hard-deleted) request threads
        and exists (select 1 from messages m where m.conversation_id = c.id and m.author_id <> $1
                      and m.created_at > coalesce(p.last_read_at, 'epoch'::timestamptz))`,
    [access.userId],
  );
  return { conversations, unreadConversations: Number(cnt[0]?.n ?? 0), hasMore: rows.length === limit };
}

// ── Submitter card (review page) ────────────────────────────────────────────
export async function getSubmitterCard(submitterId: string, namespaceId: string): Promise<SubmitterCard | null> {
  const { rows } = await pool.query<{ display_name: string; email: string; avatar: string | null; entra_object_id: string }>(
    `select display_name, email, avatar, entra_object_id from users where id = $1`,
    [submitterId],
  );
  const u = rows[0];
  if (!u) return null;
  const prior = Number((await pool.query<{ n: string }>(`select count(*)::text as n from proposals where submitted_by = $1`, [submitterId])).rows[0]?.n ?? 0);
  // Effective role in THIS namespace (reuses the caller-agnostic RBAC resolver by the submitter's oid).
  let role = "Contributor";
  try {
    const a = await resolveUserAccess(u.entra_object_id);
    if (a.isPlatformAdmin) role = "Platform admin";
    else {
      const r = a.namespaceRoles.get(namespaceId);
      role = r === "namespace_admin" ? "Namespace admin" : r === "namespace_member" ? "Namespace member" : "Contributor";
    }
  } catch { /* best-effort; default Contributor */ }
  return { userId: submitterId, displayName: label(u.display_name, u.email), email: u.email, avatar: u.avatar, role, priorSubmissions: prior };
}
