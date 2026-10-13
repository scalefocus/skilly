// Slug match → new version of the existing skill (SKILLY_SPEC.md §8). A NEW-skill submission whose
// slug equals the slug of an active skill the submitter can see — in ANY namespace — is never
// created as a second skill: it becomes a new-version proposal of that skill. This file holds the
// client-safe part (types, the clash rule, the message); the query lives in `slug-match-db.ts`.

export type SkillDeliveryType = "hosted" | "pointer";

/** One visible, active skill carrying the proposed slug. */
export interface SlugMatch {
  skillId: string;
  namespaceSlug: string;
  slug: string;
  title: string;
  type: SkillDeliveryType;
  deprecated: boolean;
}

/** A slug match as the API exposes it (no internal skill id). */
export type SlugMatchView = Omit<SlugMatch, "skillId">;

/** The machine-readable code on every slug-match refusal (409 body, MCP error). */
export const SLUG_EXISTS_CODE = "slug_exists";

/** Slugs are stored lowercase (§6); compare on the trimmed, lowercased form. */
export function normalizeMatchSlug(slug: unknown): string {
  return typeof slug === "string" ? slug.trim().toLowerCase() : "";
}

/**
 * Delivery-type clash (§8): new-version mode keeps its type lock, so a source the proposer ALREADY
 * supplied must match the existing skill's type. No source supplied yet → never a clash (the form
 * simply takes the existing skill's type).
 */
export function slugMatchClashes(match: Pick<SlugMatch, "type">, suppliedSource: SkillDeliveryType | null): boolean {
  return suppliedSource != null && suppliedSource !== match.type;
}

/** The guidance shown for a clashing match. */
export function slugClashMessage(match: Pick<SlugMatch, "namespaceSlug" | "slug" | "type">): string {
  return `${match.namespaceSlug}/${match.slug} exists as a ${match.type} skill — propose a new version with a ${match.type} source, or choose a different slug.`;
}

/** The refusal text for a new-skill submission that has visible slug matches. */
export function slugExistsMessage(matches: readonly Pick<SlugMatch, "namespaceSlug" | "slug">[]): string {
  const names = matches.map((m) => `${m.namespaceSlug}/${m.slug}`);
  if (names.length === 0) return "";
  if (names.length === 1) return `a skill named '${matches[0]!.slug}' already exists as ${names[0]} — propose a new version of it instead`;
  return `a skill named '${matches[0]!.slug}' already exists in several namespaces (${names.join(", ")}) — propose a new version of one of them instead`;
}

/**
 * The reject reason a reviewer gets pre-filled when accept finds a same-slug skill (§8): the slug is
 * locked on revise/resubmit, so the proposer's way forward is a new version of the existing skill.
 */
export function slugRejectReason(matches: readonly Pick<SlugMatch, "namespaceSlug" | "slug">[]): string {
  // No nameable match: the clashing skill is one the proposer can see but this reviewer can't —
  // the reason names nothing (invariant #3); the proposer will find it from their own view.
  if (matches.length === 0) return "A skill with this slug already exists — please propose a new version of it instead (or a new skill under a different slug).";
  const links = matches.map((m) => `/skills/${m.namespaceSlug}/${m.slug}`).join(", ");
  return matches.length === 1
    ? `A skill with this slug already exists: ${links} — please propose a new version of it instead (or a new skill under a different slug).`
    : `Skills with this slug already exist: ${links} — please propose a new version of one of them instead (or a new skill under a different slug).`;
}
