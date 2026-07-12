// Postgres-backed implementation of the git server's dependencies. SKILLY_SPEC.md §9.
import type { Pool } from "pg";
import { resolveAccess, hashToken, type RoleMapping, type EffectiveAccess } from "@skilly/shared";
import type { GitServerDeps } from "./server.js";
import type { SkillRef, TokenPrincipal } from "./authorize.js";
import { M } from "../metrics.js";

export function pgGitDeps(pool: Pool): GitServerDeps {
  return {
    async findSkill(namespaceSlug, skillSlug): Promise<SkillRef | null> {
      const { rows } = await pool.query<{
        id: string;
        namespace_id: string;
        visibility: "org" | "namespace";
        status: "active" | "archived";
      }>(
        `select s.id, s.namespace_id, s.visibility, s.status
           from skills s join namespaces n on n.id = s.namespace_id
          where n.slug = $1 and s.slug = $2`,
        [namespaceSlug, skillSlug],
      );
      const r = rows[0];
      return r ? { id: r.id, namespaceId: r.namespace_id, visibility: r.visibility, status: r.status } : null;
    },

    async validateToken(rawToken): Promise<TokenPrincipal | null> {
      // install tokens are REUSABLE (no single-use grace) — valid while not expired and the row
      // exists. Revocation is via uninstall (delete) or a passed TTL. The skill_id scopes the
      // token so authorize can reject use against a different skill. System installations have
      // no user (user_id null, is_system true). A personal token additionally requires its owning
      // user to be status='active' (the owner-status gate, SKILLY_SPEC.md §5/§23) — the users join
      // rides the same lookup, and an inactive owner is flagged rather than dropped so the refusal
      // can be recorded to system_event upstream. SKILLY_SPEC.md §23.
      const { rows } = await pool.query<{
        id: string;
        user_id: string | null;
        skill_id: string | null;
        is_system: boolean;
        owner_active: boolean | null;
      }>(
        `select t.id, t.user_id, t.skill_id, t.is_system, (u.status = 'active') as owner_active
           from tokens t
           left join users u on u.id = t.user_id
          where t.hashed_token = $1 and t.type = 'install'
            and t.skill_id is not null
            and (t.expires_at is null or t.expires_at > now())`,
        [hashToken(rawToken)],
      );
      const r = rows[0];
      if (!r) return null;
      const principal: TokenPrincipal = { userId: r.user_id, tokenId: r.id, type: "install", scopedSkillId: r.skill_id!, isSystem: r.is_system };
      if (r.user_id && r.owner_active !== true) principal.ownerInactive = true;
      return principal;
    },

    async resolveAccess(userId): Promise<EffectiveAccess> {
      // User's Entra group ids.
      const { rows: groupRows } = await pool.query<{ group_oid: string }>(
        `select g.entra_object_id as group_oid
           from group_memberships gm join groups g on g.id = gm.group_id
          where gm.user_id = $1`,
        [userId],
      );
      const groupOids = new Set(groupRows.map((g) => g.group_oid));

      const { rows: mapRows } = await pool.query<{
        id: string;
        namespace_id: string | null;
        role: RoleMapping["role"];
        group_oid: string;
      }>(
        `select rm.id, rm.namespace_id, rm.role, g.entra_object_id as group_oid
           from role_mappings rm join groups g on g.id = rm.group_id`,
      );
      const mappings: RoleMapping[] = mapRows.map((m) => ({
        id: m.id,
        groupId: m.group_oid,
        namespaceId: m.namespace_id,
        role: m.role,
      }));
      return resolveAccess(groupOids, mappings);
    },

    async markInstallUsed(tokenId, userAgent, clientIp): Promise<boolean> {
      // First use only: stamp used_at + capture the User-Agent + client IP, and (atomically) purge
      // the OTHER unused install tokens for the same skill on the same side of the system boundary
      // (a personal claim purges the owner's unused personal tokens; a system claim purges unused
      // SYSTEM tokens for that skill across admins — the scopes never cross, §23). The
      // data-modifying CTE updates only when used_at was null, so a later clone finds nothing to
      // update and the DELETE (which keys off the CTE's returned rows) is a no-op — no re-stamp,
      // no re-purge. The IP therefore records where the install was FIRST made from. Returns true
      // on the first use (drives the once-per-system-installation install_count bump).
      const { rows } = await pool.query<{ stamped: boolean }>(
        `with upd as (
           update tokens set used_at = now(), client_user_agent = $2, client_ip = $3
            where id = $1 and type = 'install' and used_at is null
           returning user_id, skill_id, is_system
         ), purged as (
           delete from tokens t using upd
            where t.type = 'install' and t.used_at is null and t.id <> $1
              and t.is_system = upd.is_system
              and t.user_id is not distinct from upd.user_id
              and t.skill_id is not distinct from upd.skill_id
         )
         select exists(select 1 from upd) as stamped`,
        [tokenId, userAgent, clientIp],
      );
      return rows[0]?.stamped ?? false;
    },

    async recordOwnerInactiveRefusal(e): Promise<void> {
      // The §25 carve-out: the only 401 recorded to the system log, source='worker'. The actor
      // snapshot is the TOKEN OWNER (denormalized via correlated subqueries, mirroring web's
      // lib/systemLog.ts insert). Never the query string or the credential. SKILLY_SPEC.md §23/§25.
      await pool.query(
        `insert into system_event
           (status, method, route, path, user_id, actor_name, actor_email, error_code, message, source)
         values (401, $1, $2, $3, $4,
                 (select display_name from users where id = $4),
                 (select email from users where id = $4),
                 'install_token_owner_inactive', $5, 'worker')`,
        [
          e.method,
          e.route.slice(0, 300),
          e.path.slice(0, 500),
          e.ownerUserId,
          `install token refused: owning user is inactive (@${e.namespaceSlug}/${e.skillSlug})`.slice(0, 300),
        ],
      );
    },

    async logAccess(skillId, userId, isSystem, countInstall): Promise<void> {
      // Called once per clone (on the /info/refs advertisement — see server.ts). One round-trip:
      // record_git_access() (migration 0052) inserts the access_log row (flagging system clones),
      // bumps the adoption/activity counters, and — for a system installation's FIRST clone only
      // (countInstall) — bumps skills.install_count once. Never logs credentials.
      await pool.query(`select record_git_access($1, $2, $3, $4)`, [skillId, userId, isSystem, countInstall]);
      M.gitClones.inc();
    },
  };
}
