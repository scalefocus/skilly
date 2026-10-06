// Namespaces visible to a signed-in user — powers the propose form's namespace combobox.
// "Visible" = the org-wide `global` namespace (everyone can file an org-wide skill there)
// plus every namespace the user holds a role in. Platform admins see them all. This never
// exposes skills, only the namespace directory the user can already contribute to.
import { pool } from "./db";
import type { EffectiveAccess } from "@skilly/shared";

export interface NamespaceOption {
  slug: string;
  displayName: string;
}

export async function listVisibleNamespaces(access: EffectiveAccess): Promise<NamespaceOption[]> {
  if (access.isPlatformAdmin) {
    const { rows } = await pool.query<{ slug: string; display_name: string }>(
      `select slug, display_name from namespaces order by (slug = 'global') desc, slug asc`,
    );
    return rows.map((r) => ({ slug: r.slug, displayName: r.display_name }));
  }
  const nsIds = [...access.namespaceRoles.keys()];
  const { rows } = await pool.query<{ slug: string; display_name: string }>(
    `select slug, display_name from namespaces
      where slug = 'global' or id = any($1::uuid[])
      order by (slug = 'global') desc, slug asc`,
    [nsIds],
  );
  return rows.map((r) => ({ slug: r.slug, displayName: r.display_name }));
}

export interface ShareTarget {
  id: string;
  slug: string;
  displayName: string;
}

/**
 * Every namespace a restricted skill may be shared with (§42.1, §42.3): all namespaces in the org
 * except `global`. The caller removes the skill's own owner. Exposes the namespace directory
 * (names only — never skills) to any signed-in user, which is what lets a proposer pick a grantee
 * they aren't a member of (§42.3: any namespace in the org).
 */
export async function listShareTargets(): Promise<ShareTarget[]> {
  const { rows } = await pool.query<{ id: string; slug: string; display_name: string }>(
    `select id, slug, display_name from namespaces where slug <> 'global' order by lower(display_name), slug`,
  );
  return rows.map((r) => ({ id: r.id, slug: r.slug, displayName: r.display_name }));
}
