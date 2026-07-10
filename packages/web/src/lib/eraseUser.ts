// "Delete User Info" / GDPR erasure (SKILLY_SPEC.md §4). Anonymize-in-place: the users row is kept
// and scrubbed (a hard delete is impossible — messages/proposals FKs + append-only audit), its Entra
// link detached (so the person can return later as a fresh account), and the user's personal data
// deleted. Skills remain; messages/proposals/reviews de-identify to "<email> - Deleted" via userLabel.
import { pool } from "./db";
import { appendAudit } from "./audit";
import { userLabel } from "./userLabel";
import { invalidateLeaderboard } from "./leaderboard";

export interface UserSearchResult { userId: string; displayName: string; email: string; status: "active" | "inactive"; avatar: string | null }

/** Typeahead over non-erased users (≥3 chars enforced by the caller). Name/email ILIKE.
 *  Returns status (enabled/disabled) + avatar so the admin pickers render a full user card. */
export async function searchUsers(q: string, limit = 10): Promise<UserSearchResult[]> {
  const like = `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { rows } = await pool.query<{ id: string; display_name: string; email: string; status: "active" | "inactive"; avatar: string | null }>(
    `select id, display_name, email, status, avatar
       from users
      where erased_at is null
        and (display_name ilike $1 escape '\\' or email ilike $1 escape '\\')
      order by display_name asc
      limit $2`,
    [like, limit],
  );
  return rows.map((r) => ({ userId: r.id, displayName: userLabel(r.display_name, r.email), email: r.email, status: r.status, avatar: r.avatar }));
}

export type EraseResult =
  | { ok: true; transferred: number; skipped: { ns: string; slug: string }[] }
  | { ok: false; status: number; error: string };

/**
 * Erase a user: optionally transfer their explicit maintainerships to `transferTo`, delete their
 * personal data, then scrub + detach the row. One transaction. SKILLY_SPEC.md §4.
 */
export async function eraseUser(actorUserId: string, targetUserId: string, transferTo: string | null): Promise<EraseResult> {
  if (targetUserId === actorUserId) return { ok: false, status: 422, error: "you can’t delete your own account" };
  if (transferTo && transferTo === targetUserId) return { ok: false, status: 422, error: "the replacement maintainer can’t be the user being deleted" };

  const client = await pool.connect();
  try {
    await client.query("begin");

    const u = (await client.query<{ erased_at: string | null; email: string | null }>(`select erased_at, email from users where id = $1 for update`, [targetUserId])).rows[0];
    if (!u) { await client.query("rollback"); return { ok: false, status: 404, error: "user not found" }; }
    if (u.erased_at) { await client.query("rollback"); return { ok: false, status: 409, error: "this user is already deleted" }; }
    if (transferTo) {
      const ok = (await client.query(`select 1 from users where id = $1 and erased_at is null`, [transferTo])).rowCount;
      if (!ok) { await client.query("rollback"); return { ok: false, status: 422, error: "replacement maintainer not found" }; }
    }

    // Transfer EXPLICIT maintainerships to the target where eligible (visibility, invariant #3).
    let transferred = 0;
    const skipped: { ns: string; slug: string }[] = [];
    if (transferTo) {
      const maint = await client.query<{ skill_id: string; namespace_id: string; visibility: string; ns_slug: string; skill_slug: string }>(
        `select s.id as skill_id, s.namespace_id, s.visibility, n.slug as ns_slug, s.slug as skill_slug
           from skill_maintainers sm
           join skills s on s.id = sm.skill_id
           join namespaces n on n.id = s.namespace_id
          where sm.user_id = $1`,
        [targetUserId],
      );
      for (const m of maint.rows) {
        const eligible = m.visibility === "org"
          ? true
          : (await client.query<{ ok: boolean }>(
              `select exists (
                 select 1 from group_memberships gm
                 join role_mappings rm on rm.group_id = gm.group_id
                 where gm.user_id = $1 and (rm.role = 'platform_admin' or rm.namespace_id = $2)
               ) as ok`,
              [transferTo, m.namespace_id],
            )).rows[0]?.ok === true;
        if (!eligible) { skipped.push({ ns: m.ns_slug, slug: m.skill_slug }); continue; }
        const ins = await client.query(
          `insert into skill_maintainers (skill_id, user_id, added_by) values ($1, $2, $3) on conflict do nothing`,
          [m.skill_id, transferTo, actorUserId],
        );
        transferred += ins.rowCount ?? 0;
      }
    }

    // Delete the user's personal data (group memberships also strip implicit admin/maintainer
    // status). install_credits goes too: the user's leaderboard attribution is erased (credits-only
    // — the shared access_log clone events / install_count / co-maintainers' credit are untouched;
    // the install still counts for everyone else). SKILLY_SPEC.md §21/§4.
    for (const tbl of ["skill_maintainers", "install_credits", "group_memberships", "skill_ratings", "skill_watches", "notifications", "tokens"]) {
      await client.query(`delete from ${tbl} where user_id = $1`, [targetUserId]);
    }

    // Scrub + detach the row (tombstone). Detaching entra_object_id lets a returning person get a
    // brand-new account. The display label retains the former email ("<email> - Deleted") so a
    // deleted author stays identifiable in message/proposal threads (SKILLY_SPEC.md §4); the
    // structured email column is still cleared. Falls back to "Deleted User" if there was no email.
    const deletedLabel = u.email && u.email.trim() ? `${u.email.trim()} - Deleted` : "Deleted User";
    await client.query(
      `update users set display_name = $2, email = '', avatar = null,
              entra_object_id = null, status = 'inactive', erased_at = now()
        where id = $1`,
      [targetUserId, deletedLabel],
    );

    await appendAudit(client, {
      actorUserId,
      action: "user.erased",
      targetType: "user",
      targetId: targetUserId,
      after: { transferredTo: transferTo, skillsTransferred: transferred, skillsSkipped: skipped.length },
    });

    await client.query("commit");
    // Their install_credits are gone + the row is now inactive — drop the cached boards so they
    // disappear immediately rather than after the TTL (best-effort, this web process only).
    invalidateLeaderboard();
    return { ok: true, transferred, skipped };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    return { ok: false, status: 500, error: String((e as Error).message ?? e) };
  } finally {
    client.release();
  }
}
