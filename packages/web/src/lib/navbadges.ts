// Nav "new items" badge counts (SKILLY_SPEC.md §8, §10).
//   catalog — # of skills that became available since the user last opened the catalog.
//   review  — # of proposals needing the user's attention on the Proposals page since they last
//             opened it: proposals awaiting their review (reviewers) PLUS their OWN proposals that
//             were sent back as `changes_requested` (proposers). One combined badge.
// Both are strictly visibility/authorization filtered (#3): the catalog count uses the same
// org|namespace predicate as searchSkills, and the review-scope count is limited to the namespaces
// the user may actually review (platform admin → all; namespace admin → their namespaces; else 0).
// The proposer half is naturally self-scoped (submitted_by = the caller).
import type { Pool } from "pg";
import { pool } from "./db";
import type { EffectiveAccess } from "@skilly/shared";
import { getNavSeen } from "./settings";

export interface NavBadges {
  catalog: number;
  review: number;
  /** System log events new since the platform admin last opened it. 0 for non-admins. */
  systemLog: number;
  /** Open skill requests posted since the caller last opened Requested skills. Org-wide — no
   *  visibility filter (requests have no namespace) and no distinction by who posted them (a
   *  requester sees their own just-posted request as "new" too, same as anyone else). */
  requests: number;
}

export async function getNavBadges(access: EffectiveAccess & { userId: string | null }, db: Pool = pool): Promise<NavBadges> {
  if (!access.userId) return { catalog: 0, review: 0, systemLog: 0, requests: 0 };
  const seen = await getNavSeen(access.userId, db);

  // Catalog: active skills visible to the caller, created after they last looked. A new VERSION
  // of an existing skill creates no new skill row, so it isn't counted — only genuinely new skills.
  const catParams: unknown[] = [seen.catalogSeenAt];
  let catVis = "";
  if (!access.isPlatformAdmin) {
    catParams.push([...access.namespaceRoles.keys()]);
    catVis = ` and (s.visibility = 'org' or s.namespace_id = any($${catParams.length}::uuid[]))`;
  }
  const catalog = Number(
    (
      await db.query<{ n: string }>(
        `select count(*)::text as n from skills s
          where s.status = 'active' and s.created_at > $1${catVis}`,
        catParams,
      )
    ).rows[0]?.n ?? 0,
  );

  // Reviewer side: proposals needing a reviewer's action since they last looked — `proposed` (a
  // first look) or `under_review` (incl. a just-resubmitted one). `changes_requested` is the
  // PROPOSER's turn (their half, below), NOT the reviewer's. Matched on `updated_at` so a RESUBMIT
  // (which moves it back to under_review but doesn't change created_at) re-arms the badge — the
  // reviewer-side mirror of the proposer being badged when changes are requested. §8.
  let review = 0;
  const reviewableStates = `p.state in ('proposed','under_review')`;
  if (access.isPlatformAdmin) {
    review = Number(
      (
        await db.query<{ n: string }>(
          `select count(*)::text as n from proposals p where ${reviewableStates} and p.updated_at > $1`,
          [seen.reviewSeenAt],
        )
      ).rows[0]?.n ?? 0,
    );
  } else {
    const nsIds = [...access.namespaceRoles.entries()].filter(([, r]) => r === "namespace_admin").map(([id]) => id);
    if (nsIds.length > 0) {
      review = Number(
        (
          await db.query<{ n: string }>(
            `select count(*)::text as n from proposals p
              where ${reviewableStates} and p.updated_at > $1 and p.target_namespace_id = any($2::uuid[])`,
            [seen.reviewSeenAt, nsIds],
          )
        ).rows[0]?.n ?? 0,
      );
    }
  }

  // Proposer side, folded into the SAME badge (§8): the caller's OWN proposals that entered
  // `changes_requested` since they last opened the queue — i.e. it's their turn to revise & resubmit.
  // Compared on updated_at (the request_changes transition stamps it, and nothing else touches a
  // proposal while it sits in changes_requested) against the shared reviewSeenAt, so it clears on the
  // same visit as the reviewer count. (A reviewer's own in-scope proposal could be counted by both
  // halves — acceptable for a soft 1–9+ indicator.)
  review += Number(
    (
      await db.query<{ n: string }>(
        `select count(*)::text as n from proposals p
          where p.submitted_by = $1 and p.state = 'changes_requested' and p.updated_at > $2`,
        [access.userId, seen.reviewSeenAt],
      )
    ).rows[0]?.n ?? 0,
  );

  // System log: error events recorded since the admin last opened it. Platform admins only —
  // the screen and its API are platform-admin-gated (§25), so non-admins always get 0.
  let systemLog = 0;
  if (access.isPlatformAdmin) {
    systemLog = Number(
      (
        await db.query<{ n: string }>(
          `select count(*)::text as n from system_event where created_at > $1`,
          [seen.systemLogSeenAt],
        )
      ).rows[0]?.n ?? 0,
    );
  }

  // Requested skills: open requests posted since the caller last opened the page. Org-wide (no
  // namespace/visibility predicate — requests have none) and no requester exclusion (§26 call).
  const requests = Number(
    (
      await db.query<{ n: string }>(
        `select count(*)::text as n from skill_requests where state = 'open' and created_at > $1`,
        [seen.requestsSeenAt],
      )
    ).rows[0]?.n ?? 0,
  );

  return { catalog, review, systemLog, requests };
}
