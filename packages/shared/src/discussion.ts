// Replies to skill-discussion comments (SKILLY_SPEC.md §24 "Replies to discussion comments").
// The pure decisions both write paths share — the web tier (the Discussion card) and the worker
// (the MCP `post_skill_comment` tool) — so a reply behaves the same however it was posted.
import { userCanSeeSkillSql } from "./visibility.js";

/** Replies shown under a thread before its "Show N more replies" control (§24 Layout). */
export const DISCUSSION_REPLIES_SHOWN = 3;

/** The parent a reply is posted against, as stored. */
export interface ReplyParent {
  id: string;
  /** The parent's own parent: NULL for a top-level comment, the root for a reply. */
  parentId: string | null;
  /** The parent is a moderator tombstone (`removed_at` set). */
  removed: boolean;
}

/**
 * The thread root a reply attaches to. One level only: replying to a reply posts into the same
 * thread, so the parent is normalised to that reply's root (§24 Shape).
 */
export function replyRootId(parent: ReplyParent): string {
  return parent.parentId ?? parent.id;
}

/**
 * The fan-out plan for one discussion message (§12 precedence: one row per person per message).
 * `message.mention` outranks `skill.discussion_reply`, which outranks `skill.discussion`:
 *  - `replyCandidates` — the thread's people (root author ∪ earlier repliers) minus the author and
 *    minus everyone mentioned. The insert still applies opt-outs, status and visibility.
 *  - `discussionExclude` — who the coalesced `skill.discussion` fan-out skips: the mentioned and
 *    the thread's people, since this message already gives them a more specific row (or would have,
 *    were it not for an opt-out that `skill.discussion` honours too).
 */
export function discussionFanOutPlan(
  authorId: string,
  mentionedUserIds: readonly string[],
  threadPeopleIds: readonly string[],
): { replyCandidates: string[]; discussionExclude: string[] } {
  const mentioned = new Set(mentionedUserIds);
  const replyCandidates = [...new Set(threadPeopleIds)].filter((id) => id !== authorId && !mentioned.has(id));
  const discussionExclude = [...new Set([...mentionedUserIds, ...threadPeopleIds])].filter((id) => id !== authorId);
  return { replyCandidates, discussionExclude };
}

/**
 * A thread's people before the new reply landed: the root's author ∪ the distinct authors of the
 * thread's earlier replies. Params: $1 root id, $2 the new reply's id (excluded).
 */
export const DISCUSSION_THREAD_PEOPLE_SQL = `
  select author_id as user_id from messages where id = $1
  union
  select author_id from messages where parent_id = $1 and id <> $2`;

/**
 * The coalesced `skill.discussion_reply` insert (§12): one unread row per (recipient, root),
 * refreshed in place by an upsert against idx_notifications_discreply_unread (migration 0092),
 * so delivery bookkeeping survives and email fires at most once per thread until read.
 * Recipients = the plan's candidates that are active, not erased, not opted out of
 * `discussion_notifications`, and still able to see the skill (invariant #3, owner ∪ §42 grants).
 * `yourComment` tells the renderer whether the recipient wrote the root.
 * Params: $1 skill id, $2 candidate user ids (uuid[]), $3 payload (jsonb), $4 the root's author.
 */
export function discussionReplyNotifySql(): string {
  return `
    insert into notifications (user_id, type, payload)
    select u.id, 'skill.discussion_reply', $3::jsonb || jsonb_build_object('yourComment', u.id = $4::uuid)
      from users u
     where u.id = any($2::uuid[])
       and u.status = 'active' and u.erased_at is null and u.discussion_notifications
       and exists (select 1 from skills sk where sk.id = $1 and ${userCanSeeSkillSql("u.id", "sk")})
    on conflict (user_id, (payload->>'rootId')) where type = 'skill.discussion_reply' and read_at is null
    do update set payload = excluded.payload, created_at = now()`;
}

/** What the moderator delete does to its target (§24 Moderation — tombstones). */
export type DiscussionDeleteAction =
  /** Hard delete the target. `sweepParent`: also hard-delete the target's tombstoned parent. */
  | { kind: "delete"; sweepParent: boolean }
  /** Clear the body and mentions and stamp `removed_at`; the replies stay underneath. */
  | { kind: "tombstone" };

/**
 * Decide the moderator delete:
 *  - a reply → hard delete; when it was the last live reply under a tombstone, the tombstone goes
 *    too (an empty placeholder serves no one);
 *  - a top-level comment with no replies → hard delete;
 *  - a top-level comment with replies → tombstone, so other people's replies aren't lost.
 * `liveReplies` counts the target's replies (for a top-level target) or its siblings including
 * itself (for a reply) — i.e. the thread's replies before this delete.
 */
export function discussionDeleteAction(target: {
  isReply: boolean;
  liveReplies: number;
  parentRemoved: boolean;
}): DiscussionDeleteAction {
  if (target.isReply) return { kind: "delete", sweepParent: target.parentRemoved && target.liveReplies <= 1 };
  return target.liveReplies > 0 ? { kind: "tombstone" } : { kind: "delete", sweepParent: false };
}
