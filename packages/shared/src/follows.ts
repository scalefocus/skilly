// Following people (SKILLY_SPEC.md §35). The rules both tiers must agree on:
//
//   - who is followable (§35.1) — a pure predicate plus the equivalent SQL fragment;
//   - the follower fan-out (§35.6) — ONE builder for the `insert into notifications … select`
//     statement, used by web (requests, awardAchievement) and worker (publish sweep, MCP writes,
//     the mirrored award helper), so the visibility gate (invariant #3), the status filters, the
//     pause rule and the dedup exclusion cannot drift between processes;
//   - the human sentence and link for each follow.* type, shared by the worker renderer and the
//     in-app notifications page (§12: every notification is human-readable, never JSON).
//
// Client-safe (no node deps); exported via the barrel and the `@skilly/shared/follows` subpath.

export const FOLLOW_NOTIFICATION_TYPES = [
  "follow.new_skill",
  "follow.new_version",
  "follow.achievement",
  "follow.request_created",
  "follow.request_fulfilled",
] as const;

export type FollowNotificationType = (typeof FOLLOW_NOTIFICATION_TYPES)[number];

export function isFollowNotificationType(type: unknown): type is FollowNotificationType {
  return typeof type === "string" && (FOLLOW_NOTIFICATION_TYPES as readonly string[]).includes(type);
}

/** The follower milestone behind the `followers_10` badge (§35.8). */
export const FOLLOWERS_MILESTONE = 10;

/** The PUT/DELETE follow endpoint's per-user budget — the watch endpoint's limit (§35.10). */
export const FOLLOW_RATE_LIMIT_PER_MIN = 120;

// ── Followable (§35.1 / §35.4) ────────────────────────────────────────────────────────────────

export interface FollowableFields {
  status: string;
  erasedAt: Date | string | null;
  allowFollows: boolean;
}

/** Viewer-independent: can anyone (other than the person themselves) follow this user right now? */
export function isFollowable(u: FollowableFields): boolean {
  return u.status === "active" && u.erasedAt == null && u.allowFollows === true;
}

/** The SQL equivalent of {@link isFollowable} for a `users` alias. */
export function followableSql(alias = "u"): string {
  return `(${alias}.status = 'active' and ${alias}.erased_at is null and ${alias}.allow_follows)`;
}

/** A follow row's state from the follower's side (§35.5): gone-quiet reasons first. */
export type FollowState = "active" | "paused" | "inactive";

export function followState(u: { status: string; allowFollows: boolean }): FollowState {
  if (u.status !== "active") return "inactive";
  return u.allowFollows ? "active" : "paused";
}

// ── Fan-out (§35.6) ───────────────────────────────────────────────────────────────────────────

export interface FollowFanOutInput {
  type: FollowNotificationType;
  /** The followee whose action this is. */
  actorId: string;
  /** Subject fields for the payload; `actorId` / `actorName` are added by the statement itself. */
  payload: Record<string, unknown>;
  /**
   * The skill whose visibility gates recipients, or null when the event names no skill
   * (achievements, a new request). Org-visible skills reach every follower; a namespace-scoped
   * one only followers in a group mapped to that namespace, or platform admins (§35.6).
   */
  skill: { namespaceId: string; visibility: string } | null;
  /** Users already notified about this same event (the dedup rule, §35.6). */
  excludeUserIds?: readonly string[];
}

/**
 * Build the single `INSERT … SELECT` that notifies the actor's followers. Recipients are active,
 * non-erased followers; nothing is inserted unless the actor is active, not erased and has
 * `allow_follows` on at event time (the pause, §35.3). Returns the statement and its values.
 */
export function followFanOutSql(input: FollowFanOutInput): { text: string; values: unknown[] } {
  if (!isFollowNotificationType(input.type)) throw new Error(`not a follow notification type: ${String(input.type)}`);
  const values: unknown[] = [input.type, JSON.stringify(input.payload ?? {}), input.actorId, [...(input.excludeUserIds ?? [])]];
  let gate = "";
  if (input.skill) {
    values.push(input.skill.visibility, input.skill.namespaceId);
    const vis = `$${values.length - 1}`;
    const ns = `$${values.length}`;
    gate = `
       and (
         ${vis}::text = 'org'
         or exists (
           select 1 from group_memberships gm
             join role_mappings rm on rm.group_id = gm.group_id
            where gm.user_id = f.follower_id
              and (rm.role = 'platform_admin' or rm.namespace_id = ${ns}::uuid)
         )
       )`;
  }
  const text = `insert into notifications (user_id, type, payload)
     select f.follower_id, $1::text,
            $2::jsonb || jsonb_build_object('actorId', au.id::text, 'actorName', coalesce(nullif(au.display_name, ''), au.email))
       from user_follows f
       join users fu on fu.id = f.follower_id and fu.status = 'active' and fu.erased_at is null
       join users au on au.id = f.followee_id and ${followableSql("au")}
      where f.followee_id = $3::uuid
        and f.follower_id <> all($4::uuid[])${gate}`;
  return { text, values };
}

/** Minimal query surface so the helper runs on a pg Pool or PoolClient without importing pg. */
export interface FollowQueryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

/** Run {@link followFanOutSql} on `db` (inside the caller's transaction when `db` is a client). */
export async function fanOutToFollowers(db: FollowQueryable, input: FollowFanOutInput): Promise<void> {
  const { text, values } = followFanOutSql(input);
  await db.query(text, values);
}

// ── Content (§35.6) ───────────────────────────────────────────────────────────────────────────

export interface FollowContent {
  /** One plain sentence. */
  sentence: string;
  /** The CTA label and the app-relative path it links to. */
  ctaLabel: string;
  path: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The sentence + CTA for a follow.* row; null for any other type. Never throws on odd payloads. */
export function followNotificationContent(type: string, payload: Record<string, unknown> | null | undefined): FollowContent | null {
  if (!isFollowNotificationType(type)) return null;
  const p = payload ?? {};
  const actor = str(p.actorName) ?? "Someone you follow";
  const ns = str(p.namespaceSlug);
  const slug = str(p.skillSlug);
  const skillRef = ns && slug ? `${ns}/${slug}` : "a skill";
  const skillPath = ns && slug ? `/skills/${ns}/${slug}` : "/catalog";
  switch (type) {
    case "follow.new_skill":
      return { sentence: `${actor} published a new skill, ${skillRef}.`, ctaLabel: "View the skill", path: skillPath };
    case "follow.new_version": {
      const semver = str(p.semver);
      return {
        sentence: semver ? `${actor} published version ${semver} of ${skillRef}.` : `${actor} published a new version of ${skillRef}.`,
        ctaLabel: "View the skill",
        path: skillPath,
      };
    }
    case "follow.achievement": {
      const badge = str(p.badgeName) ?? "a new";
      const actorId = str(p.actorId);
      const key = str(p.badgeKey);
      const path = actorId ? `/achievements/${actorId}${key ? `?badge=${encodeURIComponent(key)}` : ""}` : "/leaderboard";
      return { sentence: `${actor} earned the ${badge} badge.`, ctaLabel: "See their badges", path };
    }
    case "follow.request_created": {
      const title = str(p.requestTitle) ?? "a new skill";
      const requestId = str(p.requestId);
      return {
        sentence: `${actor} requested a skill: "${title}".`,
        ctaLabel: "View the request",
        path: requestId ? `/requests/${requestId}` : "/requests",
      };
    }
    case "follow.request_fulfilled": {
      const title = str(p.requestTitle) ?? "a skill request";
      return { sentence: `${actor} fulfilled the request "${title}" with ${skillRef}.`, ctaLabel: "View the skill", path: skillPath };
    }
    default:
      return null;
  }
}
