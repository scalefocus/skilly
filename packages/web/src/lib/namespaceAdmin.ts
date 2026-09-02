// Namespace administration (SKILLY_SPEC.md §30.6) — the per-namespace settings surface for
// namespace admins, and the same writes platform admins already make from Administration.
//
// This is deliberately a DUAL surface, not a migration: Administration → Namespaces keeps every
// control it had, and both paths write through here so validation and audit are identical.
import type { EffectiveAccess } from "@skilly/shared";
import { PUBLIC_SCOPE, canManageNamespaceSettings, marketplaceName, maintainerContactError, normalizeMaintainerContact } from "@skilly/shared";
import { pool } from "./db";
import { appendAudit } from "./audit";
import { marketplaceSkillCount, revokeNamespaceMarketplaceTokens } from "./marketplaces";

/** The `global` namespace always requires review (§4/§8) — the page renders it read-only. */
export const GLOBAL_SLUG = "global";

export interface NamespaceAdminView {
  id: string;
  slug: string;
  displayName: string;
  requireReview: boolean;
  /** `require_review` is immutable for `global`. */
  requireReviewLocked: boolean;
  maintainerContact: string | null;
  marketplaceEnabled: boolean;
  /** Computed public-facing marketplace name, e.g. `skilly-team-a`. */
  marketplaceName: string;
  /** How many skills this namespace's marketplace publishes right now. */
  marketplaceSkillCount: number;
}

/** Namespace ids the caller may administer: all of them for a platform admin, else the ones
 *  where they hold `namespace_admin`. */
function administeredIds(access: EffectiveAccess): string[] {
  return [...access.namespaceRoles.entries()].filter(([, role]) => role === "namespace_admin").map(([id]) => id);
}

/** True when the caller administers at least one namespace (drives the nav entry). */
export function administersAnyNamespace(access: EffectiveAccess): boolean {
  return access.isPlatformAdmin || administeredIds(access).length > 0;
}

/** Every namespace the caller administers, with its settings. Platform admins see all. */
export async function listAdministeredNamespaces(access: EffectiveAccess, prefix: string): Promise<NamespaceAdminView[]> {
  const ids = administeredIds(access);
  if (!access.isPlatformAdmin && ids.length === 0) return [];
  const { rows } = await pool.query<{
    id: string; slug: string; display_name: string; require_review: boolean;
    maintainer_contact: string | null; marketplace_enabled: boolean;
  }>(
    access.isPlatformAdmin
      ? `select id, slug, display_name, require_review, maintainer_contact, marketplace_enabled
           from namespaces order by slug`
      : `select id, slug, display_name, require_review, maintainer_contact, marketplace_enabled
           from namespaces where id = any($1::uuid[]) order by slug`,
    access.isPlatformAdmin ? [] : [ids],
  );

  return Promise.all(
    rows.map(async (n) => ({
      id: n.id,
      slug: n.slug,
      displayName: n.display_name,
      requireReview: n.require_review,
      requireReviewLocked: n.slug === GLOBAL_SLUG,
      maintainerContact: n.maintainer_contact,
      marketplaceEnabled: n.marketplace_enabled,
      marketplaceName: marketplaceName(prefix, { kind: "namespace", namespaceSlug: n.slug }),
      marketplaceSkillCount: await marketplaceSkillCount({ kind: "namespace", namespaceSlug: n.slug }, n.id),
    })),
  );
}

export interface NamespaceSettingsPatch {
  requireReview?: boolean;
  maintainerContact?: string | null;
  marketplaceEnabled?: boolean;
}

export type NamespaceSettingsResult =
  | { ok: true; view: NamespaceAdminView; tokensRevoked: number }
  | { ok: false; status: 403 | 404 | 422; error: string };

/**
 * Apply a settings patch to one namespace. Authority is checked here so both the new page and
 * the Administration card get the same rule. Every change is audited: the marketplace toggle
 * under its own action (§30.8), the rest under the existing `namespace.updated`.
 */
export async function updateNamespaceSettings(
  access: EffectiveAccess,
  namespaceId: string,
  patch: NamespaceSettingsPatch,
  actorUserId: string,
  prefix: string,
): Promise<NamespaceSettingsResult> {
  const { rows } = await pool.query<{
    id: string; slug: string; display_name: string; require_review: boolean;
    maintainer_contact: string | null; marketplace_enabled: boolean;
  }>(
    `select id, slug, display_name, require_review, maintainer_contact, marketplace_enabled
       from namespaces where id = $1`,
    [namespaceId],
  );
  const before = rows[0];
  if (!before) return { ok: false, status: 404, error: "namespace not found" };
  if (!canManageNamespaceSettings(access, namespaceId)) {
    return { ok: false, status: 403, error: "namespace admin required" };
  }
  if (patch.requireReview === false && before.slug === GLOBAL_SLUG) {
    return { ok: false, status: 422, error: "the global namespace always requires review" };
  }
  // The contact is published as `owner.email` in this namespace's marketplace manifest (§30.3),
  // so it must be an address or empty. Same shared check the browser runs, so the two surfaces
  // (and the client) cannot disagree on what is acceptable (§30.6).
  if (patch.maintainerContact !== undefined) {
    const contactError = maintainerContactError(patch.maintainerContact);
    if (contactError) return { ok: false, status: 422, error: contactError };
  }

  const requireReview = patch.requireReview ?? before.require_review;
  const maintainerContact =
    patch.maintainerContact === undefined ? before.maintainer_contact : normalizeMaintainerContact(patch.maintainerContact);
  const marketplaceEnabled = patch.marketplaceEnabled ?? before.marketplace_enabled;

  await pool.query(
    `update namespaces set require_review = $2, maintainer_contact = $3, marketplace_enabled = $4 where id = $1`,
    [namespaceId, requireReview, maintainerContact, marketplaceEnabled],
  );

  // Turning the marketplace OFF revokes its tokens (§30.6): the repo stops being served at once
  // (the gateway reads the flag) and the worker removes it from disk on its next pass. Plugins
  // already on a consumer's machine keep working — only adding and updating stop.
  let tokensRevoked = 0;
  const toggled = patch.marketplaceEnabled !== undefined && patch.marketplaceEnabled !== before.marketplace_enabled;
  if (toggled && !marketplaceEnabled) tokensRevoked = await revokeNamespaceMarketplaceTokens(namespaceId);

  if (toggled) {
    await appendAudit(pool, {
      actorUserId,
      action: marketplaceEnabled ? "namespace.marketplace_enabled" : "namespace.marketplace_disabled",
      targetType: "namespace",
      targetId: before.slug,
      namespaceId,
      before: { marketplaceEnabled: before.marketplace_enabled },
      after: marketplaceEnabled
        ? { marketplaceEnabled: true, marketplaceName: marketplaceName(prefix, { kind: "namespace", namespaceSlug: before.slug }) }
        : { marketplaceEnabled: false, tokensRevoked },
    });
  }
  if (requireReview !== before.require_review || maintainerContact !== before.maintainer_contact) {
    await appendAudit(pool, {
      actorUserId,
      action: "namespace.updated",
      targetType: "namespace",
      targetId: before.slug,
      namespaceId,
      before: { requireReview: before.require_review, maintainerContact: before.maintainer_contact },
      after: { requireReview, maintainerContact },
    });
  }

  return {
    ok: true,
    tokensRevoked,
    view: {
      id: before.id,
      slug: before.slug,
      displayName: before.display_name,
      requireReview,
      requireReviewLocked: before.slug === GLOBAL_SLUG,
      maintainerContact,
      marketplaceEnabled,
      marketplaceName: marketplaceName(prefix, { kind: "namespace", namespaceSlug: before.slug }),
      marketplaceSkillCount: await marketplaceSkillCount({ kind: "namespace", namespaceSlug: before.slug }, before.id),
    },
  };
}

/** The public marketplace's summary for the Administration card (§30.1). */
export async function publicMarketplaceView(prefix: string, enabled: boolean) {
  return {
    name: marketplaceName(prefix, PUBLIC_SCOPE),
    enabled,
    skillCount: await marketplaceSkillCount(PUBLIC_SCOPE, null),
  };
}
