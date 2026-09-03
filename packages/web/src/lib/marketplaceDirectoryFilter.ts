// Pure helpers for the Marketplaces page (SKILLY_SPEC.md §30.6, Page 3): the header-search
// predicate, the three-state contact resolution, the caller's "added" state, and the freshness
// label. Framework- and DB-free so every rule the page renders is unit-testable; the DB module
// (lib/marketplaceDirectory.ts) and the page both call these rather than re-deriving them.

/** How a namespace's `maintainer_contact` renders on a marketplace row (§30.6 Page 3). */
export type DirectoryContact =
  /** No contact set → an inert `N/A` bubble, Reach out disabled. */
  | { kind: "none" }
  /** Resolves to an ACTIVE skilly user → the full leaderboard treatment (bubble, hover card, DM). */
  | { kind: "user"; userId: string; displayName: string; avatar: string | null }
  /** Set but resolves to nobody (distribution list, external, leaver) → group glyph + mailto. */
  | { kind: "email"; email: string };

/** The caller's relationship to a marketplace, from their own USED `marketplace` tokens. */
export type AddedState = "none" | "active" | "expired";

export interface DirectorySearchFields {
  scope: "public" | "namespace";
  namespaceSlug: string | null;
  displayName: string;
  /** The public-facing marketplace name, e.g. `skilly-team-a`. */
  name: string;
  contact: DirectoryContact;
}

/**
 * Resolve the stored contact into its display state. `matched` is the active user whose email
 * equals the contact case-insensitively, or null when no such user exists — the DB module does the
 * lookup; this function only encodes the three-state rule so the page and the tests share it.
 */
export function resolveContact(
  maintainerContact: string | null | undefined,
  matched: { userId: string; displayName: string; avatar: string | null } | null,
): DirectoryContact {
  const email = maintainerContact?.trim() ?? "";
  if (!email) return { kind: "none" };
  if (matched) return { kind: "user", userId: matched.userId, displayName: matched.displayName, avatar: matched.avatar };
  return { kind: "email", email };
}

/**
 * "added" when at least one used token is still valid; "expired" when the caller has used tokens
 * but every one of them is past its expiry; "none" when they have never added this marketplace.
 * `expiresAt` null means never expires. §30.4/§30.6.
 */
export function addedState(usedTokens: readonly { expiresAt: string | null }[], now = Date.now()): AddedState {
  if (usedTokens.length === 0) return "none";
  const live = usedTokens.some((t) => t.expiresAt === null || new Date(t.expiresAt).getTime() > now);
  return live ? "active" : "expired";
}

/**
 * Does a row match a pre-normalized needle (trimmed + lower-cased)? Empty matches everything.
 * Matches the display name, slug, marketplace name, and — for a resolved or unresolved contact —
 * the person's name or the address, so "team-a", "Team A", "skilly-team-a" and "ops@" all work.
 */
export function directoryMatches(row: DirectorySearchFields, needle: string): boolean {
  if (!needle) return true;
  if (row.displayName.toLowerCase().includes(needle)) return true;
  if (row.name.toLowerCase().includes(needle)) return true;
  if (row.namespaceSlug?.toLowerCase().includes(needle)) return true;
  if (row.scope === "public" && "public".includes(needle)) return true;
  if (row.contact.kind === "user" && row.contact.displayName.toLowerCase().includes(needle)) return true;
  if (row.contact.kind === "email" && row.contact.email.toLowerCase().includes(needle)) return true;
  return false;
}

/**
 * Filter rows by a raw (untrimmed, any-case) query, preserving order. An empty or whitespace-only
 * query returns the same reference, so clearing the header box restores the full list.
 */
export function filterDirectory<T extends DirectorySearchFields>(rows: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => directoryMatches(r, needle));
}

/**
 * Freshness line under the skill count (§30.5/§30.6): "not synced yet" for a marketplace the sweep
 * has not evaluated since it was enabled, otherwise a coarse relative age. Coarse on purpose — the
 * point is "is the count I see the clone I get?", not a timestamp (the sweep runs every
 * `marketplace_sync_minutes`, so minute precision is already generous).
 */
export function syncedLabel(syncedAt: string | null, now = Date.now()): string {
  if (!syncedAt) return "not synced yet";
  const ms = now - new Date(syncedAt).getTime();
  if (!Number.isFinite(ms) || ms < 60_000) return "synced just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `synced ${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `synced ${h} h ago`;
  return `synced ${Math.floor(h / 24)} d ago`;
}
