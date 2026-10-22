// Feature ideas — the web tier (SKILLY_SPEC.md §60): the Coming soon list with its votes (every
// item is a published `feature_ideas` row), the proposer's own suggestions (who may suggest, and the
// two caps under a per-user advisory lock), the votes, and the platform-admin review actions with
// their notifications, badges and audit rows. The pure rules — limits, validators, who may suggest,
// the order and the notification wording — live in @skilly/shared/ideas.
//
// Ideas and votes are ordinary mutable rows: the proposer's own actions and every vote are never
// audited; the admin's decisions are (§60.10). Every admin write re-reads the row FOR UPDATE and
// checks its status, so two admins can never decide one idea twice (§60.5).
import type { Pool, PoolClient } from "pg";
import {
  IDEA_ADMIN_PAGE,
  IDEA_DAILY_MAX,
  IDEA_MINE_LIMIT,
  IDEA_PENDING_MAX,
  comingSoonOrder,
  dailyRetryAfterSeconds,
  ideaExcerpt,
  ideaLimitRefusal,
  isIdeaCloseOutcome,
  maySuggestIdea,
  validateIdeaDescription,
  validateIdeaNote,
  validateIdeaTitle,
  type ComingSoonItem,
  type IdeaLimitRefusal,
  type IdeaOutcome,
  type IdeaStatus,
} from "@skilly/shared/ideas";
import { pool } from "./db";
import { appendAudit } from "./audit";
import { awardAchievement } from "./achievements";
import { getFeatureIdeasEnabled } from "./settings";
import { nameSql } from "./userLabel";

type Db = Pool | PoolClient;

export interface IdeaViewer {
  userId: string;
  isPlatformAdmin: boolean;
}

// ── Reading: the Coming soon payload (§60.3) ───────────────────────────────────────────────────

export interface MyIdeaView {
  id: string;
  status: Exclude<IdeaStatus, "withdrawn">;
  description: string;
  title: string | null;
  outcome: IdeaOutcome | null;
  adminNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  closedAt: string | null;
  /** Live count while published; 0 otherwise (closing deletes the votes). */
  votes: number;
}

export interface ComingSoonLimits {
  pending: number;
  pendingMax: number;
  today: number;
  dailyMax: number;
}

export interface ComingSoonView {
  items: ComingSoonItem[];
  mine: MyIdeaView[];
  limits: ComingSoonLimits;
  /** May the caller suggest right now? Platform admins always, everyone else while the switch is on. */
  canSuggest: boolean;
}

/** §60.4 who may suggest, against the live switch. */
export async function canSuggest(viewer: IdeaViewer): Promise<boolean> {
  return maySuggestIdea(viewer, await getFeatureIdeasEnabled());
}

const iso = (d: Date | string | null): string | null => (d == null ? null : new Date(d).toISOString());

/** Every published item, ordered; the caller's own ideas; where they stand against the caps. */
export async function getComingSoon(viewer: IdeaViewer, db: Db = pool): Promise<ComingSoonView> {
  const [items, mine, limits, suggest] = await Promise.all([
    db.query<{
      id: string; title: string; description: string; published_at: Date; author_id: string | null;
      display_name: string | null; avatar: string | null; attributed: boolean; votes: number; voted: boolean;
    }>(
      `select i.id, i.title, i.description, i.published_at, i.author_id,
              ${nameSql("u.display_name", "u.email")} as display_name, u.avatar,
              (u.id is not null and u.erased_at is null and not u.idea_attribution_hidden) as attributed,
              (select count(*) from feature_idea_votes v where v.idea_id = i.id)::int as votes,
              exists (select 1 from feature_idea_votes v where v.idea_id = i.id and v.user_id = $1) as voted
         from feature_ideas i
         left join users u on u.id = i.author_id
        where i.status = 'published'`,
      [viewer.userId],
    ),
    listMyIdeas(viewer.userId, db),
    limitCounts(db, viewer.userId),
    canSuggest(viewer),
  ]);
  return {
    items: comingSoonOrder(
      items.rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        votes: r.votes,
        voted: r.voted,
        suggestedBy: r.attributed && r.author_id ? { id: r.author_id, displayName: r.display_name ?? "", avatar: r.avatar } : null,
        publishedAt: iso(r.published_at)!,
      })),
    ),
    mine,
    limits: { pending: limits.pending, pendingMax: IDEA_PENDING_MAX, today: limits.today, dailyMax: IDEA_DAILY_MAX },
    canSuggest: suggest,
  };
}

async function listMyIdeas(userId: string, db: Db): Promise<MyIdeaView[]> {
  const { rows } = await db.query<{
    id: string; status: Exclude<IdeaStatus, "withdrawn">; description: string; title: string | null; outcome: IdeaOutcome | null;
    admin_note: string | null; created_at: Date; decided_at: Date | null; closed_at: Date | null; votes: number;
  }>(
    `select i.id, i.status, i.description, i.title, i.outcome, i.admin_note, i.created_at, i.decided_at, i.closed_at,
            (select count(*) from feature_idea_votes v where v.idea_id = i.id)::int as votes
       from feature_ideas i
      where i.author_id = $1 and i.status <> 'withdrawn'
      order by i.created_at desc, i.id desc
      limit $2`,
    [userId, IDEA_MINE_LIMIT],
  );
  return rows.map((r) => ({
    id: r.id, status: r.status, description: r.description, title: r.title, outcome: r.outcome, adminNote: r.admin_note,
    createdAt: iso(r.created_at)!, decidedAt: iso(r.decided_at), closedAt: iso(r.closed_at), votes: r.votes,
  }));
}

/** Pending rows, and rows created in the trailing 24 h in ANY status (withdrawn included, §60.4). */
async function limitCounts(db: Db, userId: string): Promise<{ pending: number; today: number; oldestToday: Date | null }> {
  const { rows } = await db.query<{ pending: number; today: number; oldest: Date | null }>(
    `select count(*) filter (where status = 'pending')::int as pending,
            count(*) filter (where created_at > now() - interval '24 hours')::int as today,
            min(created_at) filter (where created_at > now() - interval '24 hours') as oldest
       from feature_ideas where author_id = $1`,
    [userId],
  );
  return { pending: rows[0]?.pending ?? 0, today: rows[0]?.today ?? 0, oldestToday: rows[0]?.oldest ?? null };
}

// ── The proposer's actions (§60.4) ─────────────────────────────────────────────────────────────

export type SubmitIdeaResult =
  | { ok: true; idea: MyIdeaView }
  | { ok: false; status: 403; reason: "suggestions_off" }
  | { ok: false; status: 422; error: string }
  | { ok: false; status: 429; reason: IdeaLimitRefusal; retryAfterSeconds: number | null };

/**
 * Submit a suggestion. While the switch is off only platform admins may (403 otherwise). Both caps
 * are checked inside the insert's transaction under a per-user advisory lock, so two tabs can't slip
 * past them. Every platform admin (minus the author and the `idea_notifications` opt-outs) gets the
 * coalesced `idea.submitted` row in the same transaction.
 */
export async function submitIdea(viewer: IdeaViewer, rawDescription: unknown): Promise<SubmitIdeaResult> {
  if (!(await canSuggest(viewer))) return { ok: false, status: 403, reason: "suggestions_off" };
  const userId = viewer.userId;
  const v = validateIdeaDescription(rawDescription);
  if (!v.ok) return { ok: false, status: 422, error: v.error };
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`select pg_advisory_xact_lock(hashtext('idea:' || $1::text))`, [userId]);
    const counts = await limitCounts(client, userId);
    const refusal = ideaLimitRefusal(counts);
    if (refusal) {
      await client.query("rollback");
      const retry = refusal === "daily_limit" && counts.oldestToday ? dailyRetryAfterSeconds(counts.oldestToday) : null;
      return { ok: false, status: 429, reason: refusal, retryAfterSeconds: retry };
    }
    const { rows } = await client.query<{ id: string; created_at: Date }>(
      `insert into feature_ideas (author_id, description, submitted_description) values ($1, $2, $2) returning id, created_at`,
      [userId, v.value],
    );
    await notifyAdminsOfSubmission(client, userId);
    await client.query("commit");
    const r = rows[0]!;
    return {
      ok: true,
      idea: { id: r.id, status: "pending", description: v.value, title: null, outcome: null, adminNote: null, createdAt: iso(r.created_at)!, decidedAt: null, closedAt: null, votes: 0 },
    };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * §60.7 `idea.submitted`, coalesced per admin until read: a new submission bumps the unread row's
 * count in place (partial unique index, migration 0100), keeping its delivery bookkeeping, so an
 * admin is emailed at most once until they read it. Platform admins = active members of a group
 * mapped to platform_admin, plus the bootstrap admin group (§5).
 */
async function notifyAdminsOfSubmission(db: Db, authorId: string): Promise<void> {
  const bootstrap = process.env.SKILLY_BOOTSTRAP_ADMIN_GROUP?.trim() || null;
  await db.query(
    `with admins as (
       select u.id
         from role_mappings rm
         join group_memberships gm on gm.group_id = rm.group_id
         join users u on u.id = gm.user_id
        where rm.role = 'platform_admin'
       union
       select u.id
         from groups g
         join group_memberships gm on gm.group_id = g.id
         join users u on u.id = gm.user_id
        where $2::text is not null and g.entra_object_id = $2
     )
     insert into notifications (user_id, type, payload)
     select u.id, 'idea.submitted', '{"count": 1}'::jsonb
       from admins a join users u on u.id = a.id
      where u.id <> $1 and u.status = 'active' and u.erased_at is null and u.idea_notifications
      -- A fixed order, so two simultaneous submissions lock the admins' rows in the same order.
      order by u.id
     on conflict (user_id) where type = 'idea.submitted' and read_at is null
     do update set payload = jsonb_build_object('count', coalesce((notifications.payload->>'count')::int, 0) + 1),
                   created_at = now()`,
    [authorId, bootstrap],
  );
}

export type OwnIdeaResult = { ok: true } | { ok: false; status: 404 | 409 | 422; error: string };

/** Which refusal fits an own-idea write that changed nothing: not theirs → 404, not pending → 409. */
async function ownIdeaRefusal(userId: string, id: string): Promise<OwnIdeaResult> {
  const { rows } = await pool.query<{ author_id: string | null }>(`select author_id from feature_ideas where id = $1`, [id]);
  if (!rows[0] || rows[0].author_id !== userId) return { ok: false, status: 404, error: "not found" };
  return { ok: false, status: 409, error: "this idea is no longer pending" };
}

/** The proposer edits their own pending idea. */
export async function editOwnIdea(userId: string, id: string, rawDescription: unknown): Promise<OwnIdeaResult> {
  const v = validateIdeaDescription(rawDescription);
  if (!v.ok) return { ok: false, status: 422, error: v.error };
  const r = await pool.query(
    `update feature_ideas set description = $3, submitted_description = $3, updated_at = now()
      where id = $1 and author_id = $2 and status = 'pending'`,
    [id, userId, v.value],
  );
  return (r.rowCount ?? 0) > 0 ? { ok: true } : ownIdeaRefusal(userId, id);
}

/** The proposer withdraws their own pending idea. The row stays (hidden) for the daily cap. */
export async function withdrawOwnIdea(userId: string, id: string): Promise<OwnIdeaResult> {
  const r = await pool.query(
    `update feature_ideas set status = 'withdrawn', updated_at = now()
      where id = $1 and author_id = $2 and status = 'pending'`,
    [id, userId],
  );
  return (r.rowCount ?? 0) > 0 ? { ok: true } : ownIdeaRefusal(userId, id);
}

// ── Votes (§60.6) ──────────────────────────────────────────────────────────────────────────────

export type VoteResult = { ok: true; votes: number; voted: boolean } | { ok: false; status: 404 };

/**
 * Upvote or un-vote a published idea. Idempotent. The idea row is read FOR SHARE, which waits for a
 * concurrent close (FOR UPDATE) — so a vote can never land on an idea that was just closed.
 */
export async function voteIdea(userId: string, id: string, on: boolean): Promise<VoteResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ status: IdeaStatus }>(`select status from feature_ideas where id = $1 for share`, [id]);
    if (rows[0]?.status !== "published") {
      await client.query("rollback");
      return { ok: false, status: 404 };
    }
    if (on) {
      await client.query(`insert into feature_idea_votes (idea_id, user_id) values ($1, $2) on conflict do nothing`, [id, userId]);
    } else {
      await client.query(`delete from feature_idea_votes where idea_id = $1 and user_id = $2`, [id, userId]);
    }
    const n = await client.query<{ votes: number }>(`select count(*)::int as votes from feature_idea_votes where idea_id = $1`, [id]);
    await client.query("commit");
    return { ok: true, votes: n.rows[0]?.votes ?? 0, voted: on };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── The admin page (§60.5) ─────────────────────────────────────────────────────────────────────

export type AdminIdeaTab = "pending" | "published" | "closed";

export interface AdminIdeaView {
  id: string;
  status: Exclude<IdeaStatus, "withdrawn">;
  title: string | null;
  description: string;
  submittedDescription: string;
  outcome: IdeaOutcome | null;
  adminNote: string | null;
  author: { id: string; displayName: string; nameHidden: boolean; erased: boolean } | null;
  votes: number;
  createdAt: string;
  decidedAt: string | null;
  publishedAt: string | null;
  closedAt: string | null;
  shippedAt: string | null;
  /** The row's `updated_at` at full precision — sent back as `expectedUpdatedAt` on publish / reject. */
  version: string;
}

export interface AdminIdeaList {
  tab: AdminIdeaTab;
  ideas: AdminIdeaView[];
  counts: Record<AdminIdeaTab, number>;
  hasMore: boolean;
}

const TAB_WHERE: Record<AdminIdeaTab, string> = {
  pending: `i.status = 'pending'`,
  published: `i.status = 'published'`,
  closed: `i.status in ('rejected', 'closed')`,
};
const TAB_ORDER: Record<AdminIdeaTab, string> = {
  pending: `i.created_at asc, i.id`,
  published: `votes desc, i.published_at desc, i.id`,
  closed: `coalesce(i.closed_at, i.decided_at) desc, i.id`,
};

export async function listAdminIdeas(tab: AdminIdeaTab, offset = 0, db: Db = pool): Promise<AdminIdeaList> {
  const limit = IDEA_ADMIN_PAGE;
  const [list, counts] = await Promise.all([
    db.query<{
      id: string; status: Exclude<IdeaStatus, "withdrawn">; title: string | null; description: string; submitted_description: string;
      outcome: IdeaOutcome | null; admin_note: string | null; author_id: string | null; display_name: string | null;
      idea_attribution_hidden: boolean | null; erased: boolean | null; votes: number; created_at: Date; decided_at: Date | null;
      published_at: Date | null; closed_at: Date | null; shipped_at: Date | null; version: string;
    }>(
      `select i.id, i.status, i.title, i.description, i.submitted_description, i.outcome, i.admin_note, i.author_id,
              ${nameSql("u.display_name", "u.email")} as display_name, u.idea_attribution_hidden, (u.erased_at is not null) as erased,
              (select count(*) from feature_idea_votes v where v.idea_id = i.id)::int as votes,
              i.created_at, i.decided_at, i.published_at, i.closed_at, i.shipped_at, i.updated_at::text as version
         from feature_ideas i
         left join users u on u.id = i.author_id
        where ${TAB_WHERE[tab]}
        order by ${TAB_ORDER[tab]}
        limit $1 offset $2`,
      [limit + 1, Math.max(0, offset)],
    ),
    db.query<{ status: string; n: number }>(`select status, count(*)::int as n from feature_ideas group by status`),
  ]);
  const by = new Map(counts.rows.map((r) => [r.status, r.n]));
  const rows = list.rows.slice(0, limit);
  return {
    tab,
    hasMore: list.rows.length > limit,
    counts: { pending: by.get("pending") ?? 0, published: by.get("published") ?? 0, closed: (by.get("rejected") ?? 0) + (by.get("closed") ?? 0) },
    ideas: rows.map((r) => ({
      id: r.id, status: r.status, title: r.title, description: r.description, submittedDescription: r.submitted_description,
      outcome: r.outcome, adminNote: r.admin_note,
      author: r.author_id ? { id: r.author_id, displayName: r.display_name ?? "", nameHidden: r.idea_attribution_hidden === true, erased: r.erased === true } : null,
      votes: r.votes, createdAt: iso(r.created_at)!, decidedAt: iso(r.decided_at), publishedAt: iso(r.published_at),
      closedAt: iso(r.closed_at), shippedAt: iso(r.shipped_at), version: r.version,
    })),
  };
}

/** The sidebar badge (§60.5): a plain count of the queue. */
export async function pendingIdeaCount(db: Db = pool): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from feature_ideas where status = 'pending'`);
  return rows[0]?.n ?? 0;
}

export type AdminIdeaResult = { ok: true } | { ok: false; status: 404 | 409 | 422; error: string };

interface LockedIdea {
  id: string;
  status: IdeaStatus;
  title: string | null;
  description: string;
  submitted_description: string;
  outcome: IdeaOutcome | null;
  author_id: string | null;
  author_live: boolean;
  version: string;
}

/**
 * Run an admin write in one transaction around the idea row, locked FOR UPDATE. `fn` returns null to
 * commit, or a refusal to roll back with.
 */
async function withLockedIdea(id: string, fn: (db: PoolClient, idea: LockedIdea) => Promise<AdminIdeaResult | null>): Promise<AdminIdeaResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<LockedIdea>(
      `select i.id, i.status, i.title, i.description, i.submitted_description, i.outcome, i.author_id,
              coalesce(u.status = 'active' and u.erased_at is null, false) as author_live, i.updated_at::text as version
         from feature_ideas i left join users u on u.id = i.author_id
        where i.id = $1
        for update of i`,
      [id],
    );
    const idea = rows[0];
    if (!idea || idea.status === "withdrawn") {
      await client.query("rollback");
      return { ok: false, status: 404, error: "not found" };
    }
    const refused = await fn(client, idea);
    if (refused) {
      await client.query("rollback");
      return refused;
    }
    await client.query("commit");
    return { ok: true };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const conflict = (error: string): AdminIdeaResult => ({ ok: false, status: 409, error });
const invalid = (error: string): AdminIdeaResult => ({ ok: false, status: 422, error });

/** A notification for the idea's author — never for an inactive, erased or missing one (§60.7). */
async function notifyAuthor(db: Db, idea: LockedIdea, type: string, payload: Record<string, unknown>): Promise<void> {
  if (!idea.author_id || !idea.author_live) return;
  await db.query(`insert into notifications (user_id, type, payload) values ($1, $2, $3::jsonb)`, [idea.author_id, type, JSON.stringify(payload)]);
}

/** A badge for the idea's author, inside the admin's transaction. Not a Habits event: the admin acted (§60.8). */
async function awardAuthor(db: Db, idea: LockedIdea, key: "idea_published" | "idea_shipped"): Promise<void> {
  if (!idea.author_id || !idea.author_live) return;
  await awardAchievement(db, idea.author_id, key, { noHabits: true });
}

export interface PublishInput {
  title: unknown;
  description: unknown;
  expectedUpdatedAt: unknown;
}

/** Publish a pending idea: title + (edited) text, the proposer's vote, Bright Idea, the notification. */
export async function publishIdea(actorUserId: string, id: string, input: PublishInput): Promise<AdminIdeaResult> {
  const title = validateIdeaTitle(input.title);
  if (!title.ok) return invalid(title.error);
  const description = validateIdeaDescription(input.description);
  if (!description.ok) return invalid(description.error);
  return withLockedIdea(id, async (db, idea) => {
    if (idea.status !== "pending") return conflict("this idea is no longer pending");
    if (!(await sameVersion(db, idea.id, input.expectedUpdatedAt))) return conflict("this idea changed since you opened it");
    await db.query(
      `update feature_ideas
          set status = 'published', title = $2, description = $3, decided_by = $4, decided_at = now(),
              published_at = now(), updated_at = now()
        where id = $1`,
      [id, title.value, description.value, actorUserId],
    );
    // §60.1 decision 7: the idea starts with its proposer's vote.
    if (idea.author_id) {
      await db.query(`insert into feature_idea_votes (idea_id, user_id) values ($1, $2) on conflict do nothing`, [id, idea.author_id]);
    }
    await awardAuthor(db, idea, "idea_published");
    await notifyAuthor(db, idea, "idea.published", { ideaId: id, title: title.value });
    await appendAudit(db, {
      actorUserId,
      action: "idea.published",
      targetType: "feature_idea",
      targetId: id,
      before: { description: idea.submitted_description },
      after: { title: title.value, description: description.value },
    });
    return null;
  });
}

/** Reject a pending idea, with an optional reason the proposer is told. */
export async function rejectIdea(actorUserId: string, id: string, input: { reason: unknown; expectedUpdatedAt: unknown }): Promise<AdminIdeaResult> {
  const reason = validateIdeaNote(input.reason);
  if (!reason.ok) return invalid(reason.error);
  return withLockedIdea(id, async (db, idea) => {
    if (idea.status !== "pending") return conflict("this idea is no longer pending");
    if (!(await sameVersion(db, idea.id, input.expectedUpdatedAt))) return conflict("this idea changed since you opened it");
    await db.query(
      `update feature_ideas set status = 'rejected', admin_note = $2, decided_by = $3, decided_at = now(), updated_at = now() where id = $1`,
      [id, reason.value, actorUserId],
    );
    await notifyAuthor(db, idea, "idea.rejected", { ideaId: id, reason: reason.value, excerpt: ideaExcerpt(idea.description) });
    await appendAudit(db, {
      actorUserId,
      action: "idea.rejected",
      targetType: "feature_idea",
      targetId: id,
      after: { reason: reason.value },
    });
    return null;
  });
}

/** Edit a published idea's title and/or text. No notification. */
export async function editPublishedIdea(actorUserId: string, id: string, input: { title?: unknown; description?: unknown }): Promise<AdminIdeaResult> {
  const title = input.title === undefined ? null : validateIdeaTitle(input.title);
  if (title && !title.ok) return invalid(title.error);
  const description = input.description === undefined ? null : validateIdeaDescription(input.description);
  if (description && !description.ok) return invalid(description.error);
  if (!title && !description) return invalid("nothing to change");
  return withLockedIdea(id, async (db, idea) => {
    if (idea.status !== "published") return conflict("only a published idea can be edited");
    const nextTitle = title?.ok ? title.value : idea.title;
    const nextDescription = description?.ok ? description.value : idea.description;
    if (nextTitle === idea.title && nextDescription === idea.description) return null;
    await db.query(`update feature_ideas set title = $2, description = $3, updated_at = now() where id = $1`, [id, nextTitle, nextDescription]);
    await appendAudit(db, {
      actorUserId,
      action: "idea.updated",
      targetType: "feature_idea",
      targetId: id,
      before: { title: idea.title, description: idea.description },
      after: { title: nextTitle, description: nextDescription },
    });
    return null;
  });
}

/**
 * Close a published idea with an outcome. Its votes are deleted; Shipped also awards Made It Real.
 * Never Planned any more (§60.1 decision 3): being on the list is what "planned" means.
 */
export async function closeIdea(actorUserId: string, id: string, input: { outcome: unknown; note: unknown }): Promise<AdminIdeaResult> {
  const outcome = input.outcome;
  if (!isIdeaCloseOutcome(outcome)) return invalid("outcome must be shipped, duplicate or wont_do");
  const note = validateIdeaNote(input.note);
  if (!note.ok) return invalid(note.error);
  return withLockedIdea(id, async (db, idea) => {
    if (idea.status !== "published") return conflict("only a published idea can be closed");
    const deleted = await db.query(`delete from feature_idea_votes where idea_id = $1`, [id]);
    await db.query(
      `update feature_ideas
          set status = 'closed', outcome = $2::text, admin_note = $3, closed_by = $4, closed_at = now(),
              shipped_at = case when $2::text = 'shipped' then now() end, updated_at = now()
        where id = $1`,
      [id, outcome, note.value, actorUserId],
    );
    await appendAudit(db, {
      actorUserId,
      action: "idea.closed",
      targetType: "feature_idea",
      targetId: id,
      after: { outcome, note: note.value, votes: deleted.rowCount ?? 0 },
    });
    if (outcome === "shipped") {
      await awardAuthor(db, idea, "idea_shipped");
      await notifyAuthor(db, idea, "idea.shipped", { ideaId: id, title: idea.title });
    } else {
      await notifyAuthor(db, idea, "idea.closed", { ideaId: id, title: idea.title, outcome, adminNote: note.value });
    }
    return null;
  });
}

/** Planned (closed before v2.41.0) → Shipped, one way: awards Made It Real and tells the proposer. */
export async function markIdeaShipped(actorUserId: string, id: string): Promise<AdminIdeaResult> {
  return withLockedIdea(id, async (db, idea) => {
    if (idea.status !== "closed" || idea.outcome !== "planned") return conflict("only an idea closed as Planned can be marked shipped");
    await db.query(`update feature_ideas set outcome = 'shipped', shipped_at = now(), updated_at = now() where id = $1`, [id]);
    await appendAudit(db, {
      actorUserId,
      action: "idea.marked_shipped",
      targetType: "feature_idea",
      targetId: id,
      before: { outcome: "planned" },
      after: { outcome: "shipped" },
    });
    await awardAuthor(db, idea, "idea_shipped");
    await notifyAuthor(db, idea, "idea.shipped", { ideaId: id, title: idea.title });
    return null;
  });
}

/** The four author types (§60.7) whose rows name one idea — what a delete takes with it. */
const AUTHOR_NOTIFICATION_TYPES = ["idea.published", "idea.rejected", "idea.closed", "idea.shipped"];

/**
 * Delete any idea the admin page shows, for good (§60.1 decision 17, §60.5). A pending one must still
 * match the version the admin saw. The audit row keeps a snapshot first; the author's notifications
 * about the idea go; its votes cascade with the row. Nobody is told, and no badge is awarded or revoked.
 */
export async function deleteIdea(actorUserId: string, id: string, input: { reason: unknown; expectedUpdatedAt: unknown }): Promise<AdminIdeaResult> {
  const reason = validateIdeaNote(input.reason);
  if (!reason.ok) return invalid(reason.error);
  return withLockedIdea(id, async (db, idea) => {
    if (idea.status === "pending" && !(await sameVersion(db, idea.id, input.expectedUpdatedAt))) return conflict("this idea changed since you opened it");
    const { rows } = await db.query<{ admin_note: string | null; created_at: Date; published_at: Date | null; votes: number }>(
      `select admin_note, created_at, published_at,
              (select count(*) from feature_idea_votes v where v.idea_id = i.id)::int as votes
         from feature_ideas i where id = $1`,
      [id],
    );
    const snap = rows[0]!;
    await appendAudit(db, {
      actorUserId,
      action: "idea.deleted",
      targetType: "feature_idea",
      targetId: id,
      before: {
        status: idea.status, title: idea.title, description: idea.description, submittedDescription: idea.submitted_description,
        outcome: idea.outcome, adminNote: snap.admin_note, authorId: idea.author_id,
        createdAt: iso(snap.created_at), publishedAt: iso(snap.published_at),
      },
      after: { reason: reason.value, votes: snap.votes },
    });
    if (idea.author_id) {
      await db.query(
        `delete from notifications where user_id = $1 and type = any($2::text[]) and payload->>'ideaId' = $3`,
        [idea.author_id, AUTHOR_NOTIFICATION_TYPES, id],
      );
    }
    await db.query(`delete from feature_ideas where id = $1`, [id]);
    return null;
  });
}

/**
 * Does the client's `expectedUpdatedAt` still match the row? It is the `updated_at::text` the list
 * handed out (every pool connection renders it in the same zone), compared as text so a malformed
 * value can never abort the surrounding transaction.
 */
async function sameVersion(db: Db, id: string, expected: unknown): Promise<boolean> {
  if (typeof expected !== "string" || !expected.trim()) return false;
  const { rows } = await db.query<{ same: boolean }>(`select updated_at::text = $2 as same from feature_ideas where id = $1`, [id, expected]);
  return rows[0]?.same === true;
}
