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
