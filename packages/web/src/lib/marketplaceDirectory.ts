// The Marketplaces page's directory (SKILLY_SPEC.md §30.6, Page 3): every Claude plugin marketplace
// the caller can ADD, with what they need to decide — payload size, freshness, who to ask, and
// whether they already added it.
//
// Invariant #3 is enforced by the row set, not by masking: a namespace row exists in the result
// ONLY when the caller holds a role in that namespace (platform admins: all), which is exactly the
// mint rule (`canUseNamespaceMarketplace`, §30.4). A restricted namespace's existence, count and
// contact are therefore never revealed to an outsider. Disabled marketplaces are omitted — there is
// no repo, no URL, and a mint would 404, so a row would have no working action.
import { PUBLIC_SCOPE, marketplaceName, type EffectiveAccess } from "@skilly/shared";
import { pool } from "./db";
import { marketplaceSkillCount } from "./marketplaces";
import { addedState, resolveContact, type AddedState, type DirectoryContact } from "./marketplaceDirectoryFilter";

export interface DirectoryRow {
  scope: "public" | "namespace";
  /** Namespace slug; null for the public marketplace. */
  namespaceSlug: string | null;
  /** Namespace display name; "Public marketplace" for the public one. */
  displayName: string;
  /** The public-facing marketplace name, e.g. `skilly-team-a` (§30.2). */
  name: string;
  /** The marketplace PAYLOAD — the skills it publishes (§30.1) — not the namespace's catalog size. */
  skillCount: number;
  /** When the sweep last evaluated this marketplace; null = not since it was enabled (§30.5). */
  syncedAt: string | null;
  contact: DirectoryContact;
  added: AddedState;
}

const toIso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Rows for one caller. `publicEnabled` is the platform switch (§30.1) — the public row appears iff
 * it is on. The caller's own used `marketplace` tokens decide each row's `added` state.
 */
export async function listMarketplaceDirectory(
  access: EffectiveAccess,
  userId: string,
  prefix: string,
  publicEnabled: boolean,
): Promise<DirectoryRow[]> {
  const nsIds = [...access.namespaceRoles.keys()];

  // The namespaces the caller may mint for, with the contact resolved to an ACTIVE, non-erased
  // user by case-insensitive email. LATERAL + LIMIT 1 so a duplicated address can never fan a
  // namespace into two rows.
  const { rows: nsRows } = await pool.query<{
    id: string; slug: string; display_name: string; maintainer_contact: string | null; marketplace_synced_at: Date | string | null;
    contact_user_id: string | null; contact_display_name: string | null; contact_avatar: string | null;
  }>(
    `select n.id, n.slug, n.display_name, n.maintainer_contact, n.marketplace_synced_at,
            u.id as contact_user_id, u.display_name as contact_display_name, u.avatar as contact_avatar
       from namespaces n
       left join lateral (
         select id, display_name, avatar from users
          where n.maintainer_contact is not null
            and lower(email) = lower(n.maintainer_contact)
            and status = 'active' and erased_at is null
          order by created_at asc
          limit 1
       ) u on true
      where n.marketplace_enabled
        and ($1::boolean or n.id = any($2::uuid[]))
      order by n.slug asc`,
    [access.isPlatformAdmin, nsIds],
  );

  const ids = nsRows.map((r) => r.id);
  // Payload counts in one grouped query — the same qualifying rule as marketplaceSkillCount and
  // the worker (active skill, ≥1 active git-published version, namespace visibility).
  const counts = new Map<string, number>();
  if (ids.length > 0) {
    const { rows } = await pool.query<{ namespace_id: string; n: string }>(
      `select s.namespace_id, count(distinct s.id) as n
         from skills s
         join skill_versions sv on sv.skill_id = s.id and sv.status = 'active' and sv.git_published
        where s.status = 'active' and s.visibility = 'namespace' and s.namespace_id = any($1::uuid[])
        group by s.namespace_id`,
      [ids],
    );
    for (const r of rows) counts.set(r.namespace_id, Number(r.n));
  }

  // The caller's USED tokens, grouped per marketplace → added state.
  const { rows: tokenRows } = await pool.query<{ marketplace_scope: "public" | "namespace"; namespace_id: string | null; expires_at: Date | string | null }>(
    `select marketplace_scope, namespace_id, expires_at
       from tokens
      where user_id = $1 and type = 'marketplace' and used_at is not null`,
    [userId],
  );
  const used = new Map<string, { expiresAt: string | null }[]>();
  for (const t of tokenRows) {
    const key = t.marketplace_scope === "public" ? "public" : `ns:${t.namespace_id}`;
    const list = used.get(key) ?? [];
    list.push({ expiresAt: toIso(t.expires_at) });
    used.set(key, list);
  }

  const out: DirectoryRow[] = [];

  if (publicEnabled) {
    const [skillCount, stamp] = await Promise.all([
      marketplaceSkillCount(PUBLIC_SCOPE, null),
      pool.query<{ value: unknown }>(`select value from platform_settings where key = 'marketplace_public_synced_at'`),
    ]);
    const raw = stamp.rows[0]?.value;
    out.push({
      scope: "public",
      namespaceSlug: null,
      displayName: "Public marketplace",
      name: marketplaceName(prefix, PUBLIC_SCOPE),
      skillCount,
      syncedAt: typeof raw === "string" ? toIso(raw) : null,
      contact: { kind: "none" }, // the platform owns it — no person to reach (§30.3)
      added: addedState(used.get("public") ?? []),
    });
  }

  for (const n of nsRows) {
    out.push({
      scope: "namespace",
      namespaceSlug: n.slug,
      displayName: n.display_name,
      name: marketplaceName(prefix, { kind: "namespace", namespaceSlug: n.slug }),
      skillCount: counts.get(n.id) ?? 0,
      syncedAt: toIso(n.marketplace_synced_at),
      contact: resolveContact(
        n.maintainer_contact,
        n.contact_user_id ? { userId: n.contact_user_id, displayName: n.contact_display_name ?? "", avatar: n.contact_avatar } : null,
      ),
      added: addedState(used.get(`ns:${n.id}`) ?? []),
    });
  }
  return out;
}
