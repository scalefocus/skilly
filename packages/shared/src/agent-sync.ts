// Agent sync API (SKILLY_SPEC.md §69): the pieces the web tier (the sync endpoint) and the worker
// (the git gateway) must agree on. A desktop agent — first client: AION — exchanges an Entra access
// token for the skills its user may see plus one short-lived AGENT KEY, then clones those skills.
//
// Nothing here knows about HTTP or Entra; that lives in web's lib/agentSync.ts + lib/entraToken.ts.
import type { Queryable } from "./search.js";
import { resolveLatest } from "./semver.js";

/** The delegated scope an Entra access token must carry (§69.2). */
export const AGENT_SYNC_SCOPE = "Skills.Sync";

/** Agent key lifetime bounds, in whole hours (§69.5 / §69.10). */
export const AGENT_KEY_TTL_HOURS_DEFAULT = 12;
export const AGENT_KEY_TTL_HOURS_MIN = 1;
export const AGENT_KEY_TTL_HOURS_MAX = 24;

/** A user keeps at most this many unexpired agent keys; a mint deletes the oldest beyond it (§69.5). */
export const AGENT_KEY_CAP = 5;

/** Sync requests per user per hour (§69.8). */
export const AGENT_SYNC_RATE_PER_HOUR = 30;

/** The `source` every agent key stamps on its install records and access-log rows (§69.7). */
export const AGENT_INSTALL_SOURCE = "aion";
export type AgentInstallSource = typeof AGENT_INSTALL_SOURCE;

/**
 * Resolve `SKILLY_AGENT_KEY_TTL_HOURS` (§69.10). Unset/blank silently takes the default. A whole
 * number above the maximum is clamped to it; anything else invalid (zero, negative, fractional,
 * non-numeric) takes the default. Both of the latter return a `warning` naming the variable.
 */
export function parseAgentKeyTtlHours(raw: string | undefined): { hours: number; warning: string | null } {
  const v = (raw ?? "").trim();
  if (!v) return { hours: AGENT_KEY_TTL_HOURS_DEFAULT, warning: null };
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (n >= AGENT_KEY_TTL_HOURS_MIN && n <= AGENT_KEY_TTL_HOURS_MAX) return { hours: n, warning: null };
    if (n > AGENT_KEY_TTL_HOURS_MAX) {
      return {
        hours: AGENT_KEY_TTL_HOURS_MAX,
        warning: `SKILLY_AGENT_KEY_TTL_HOURS is above the maximum; using ${AGENT_KEY_TTL_HOURS_MAX}`,
      };
    }
  }
  return {
    hours: AGENT_KEY_TTL_HOURS_DEFAULT,
    warning: `SKILLY_AGENT_KEY_TTL_HOURS must be a whole number from ${AGENT_KEY_TTL_HOURS_MIN} to ${AGENT_KEY_TTL_HOURS_MAX}; using the default ${AGENT_KEY_TTL_HOURS_DEFAULT}`,
  };
}

export interface AgentCloneInput {
  userId: string;
  skillId: string;
  userAgent: string | null;
  clientIp: string | null;
  source?: AgentInstallSource;
}

/**
 * Record one clone or fetch served to an agent key (§69.7) — what the gateway runs INSTEAD OF the
 * install-token trio (first-use stamp, freshness stamp, `record_git_access`):
 *
 *   - upsert the (user, skill, source) row in `agent_installs`: `first_cloned_at`, user agent and
 *     client IP are set on the first clone only; `last_cloned_at` and `last_served_semver` are
 *     refreshed every time. The served version is the skill's latest stable among its active
 *     versions — the same resolution an unpinned install token is stamped with (§23).
 *   - insert an `access_log` row with the agent's source, so the fetch is on the forensic record
 *     but outside every §21 metric (they read `source = 'git'`).
 *
 * Deliberately nothing else: no `skill_installs` row, no `install_count`, no `install_credits`, no
 * `install_counters`, no achievement. An agent installs every entitled skill for every user, so
 * counting it as adoption would flatten all of those (§69.1 #6).
 */
export async function recordAgentClone(db: Queryable, input: AgentCloneInput): Promise<void> {
  const source = input.source ?? AGENT_INSTALL_SOURCE;
  const { rows } = await db.query(`select semver from skill_versions where skill_id = $1 and status = 'active'`, [input.skillId]);
  const latest = resolveLatest((rows as { semver: string }[]).map((r) => r.semver));
  await db.query(
    `with up as (
       insert into agent_installs (user_id, skill_id, source, last_served_semver, client_user_agent, client_ip)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (user_id, skill_id, source) do update
         set last_cloned_at = now(), last_served_semver = excluded.last_served_semver
       returning 1
     )
     insert into access_log (actor_user_id, skill_id, skill_version_id, source, is_system)
     values ($1, $2, null, $3, false)`,
    [input.userId, input.skillId, source, latest, input.userAgent, input.clientIp],
  );
}
