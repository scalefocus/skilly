// Category identity — SKILLY_SPEC.md §3 `categories`, §10 *Category slugs*.
//
// A category's `slug` is derived ONCE from its name at creation and never rewritten: it is the
// category's plugin name in every Claude plugin marketplace (§30.3), so it must stay put. This
// module is client-safe (no node imports) — the propose form runs the same checks inline that
// the server enforces at submit time, so the two can never disagree on what is allowed.

/** Slugs no category may take: `general` names the plugin that collects uncategorized skills. */
export const RESERVED_CATEGORY_SLUGS: readonly string[] = ["general"];

/** The reserved bucket plugin (§30.3). */
export const GENERAL_PLUGIN_SLUG = "general";

export const CATEGORY_SLUG_MAX = 64;

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Derive a category slug from its name: lowercase → NFKD with diacritics stripped → every run of
 * non-[a-z0-9] becomes one `-` → leading/trailing `-` trimmed → capped at CATEGORY_SLUG_MAX.
 * Returns "" when nothing survives (the caller rejects that — `categoryNameError`).
 */
export function categorySlug(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // combining marks left behind by NFKD
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const capped = base.slice(0, CATEGORY_SLUG_MAX).replace(/-+$/g, "");
  return SLUG_RE.test(capped) ? capped : "";
}

/** True when `slug` is a well-formed category slug (also what the DB CHECK enforces). */
export function isValidCategorySlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= CATEGORY_SLUG_MAX && SLUG_RE.test(slug);
}

/** Canonical stored form of a category name (§3: names are stored lowercase). */
export function normalizeCategoryName(name: string): string {
  return name.trim().toLowerCase();
}

/** Trim/lowercase/de-dupe a submitted category list, dropping blanks, capped at `max`. */
export function normalizeCategoryNames(names: readonly string[] | null | undefined, max = 12): string[] {
  return [...new Set((names ?? []).map(normalizeCategoryName).filter(Boolean))].slice(0, max);
}

/**
 * The name-only problems with a category (no vocabulary needed): a name that reduces to no slug,
 * or one whose slug is reserved. Returns the user-facing message, or null when fine. The
 * reserved message deliberately explains WHAT `general` is for (§10) rather than just saying no.
 */
export function categoryNameError(name: string): string | null {
  const shown = name.trim();
  const slug = categorySlug(name);
  if (!slug) return `a category name needs at least one letter or digit (“${shown}” has none)`;
  if (RESERVED_CATEGORY_SLUGS.includes(slug)) {
    return `“${shown}” is reserved — it names the marketplace plugin that collects skills without a category. Choose a more specific category for this skill.`;
  }
  return null;
}

/** A category the vocabulary already holds. */
export interface KnownCategory {
  name: string;
  slug: string;
}

/**
 * The collision problem with a NEW category name against the existing vocabulary: a different
 * name whose slug it would share. Returns the message naming the winner, or null. An exact name
 * match is never a collision (it is the same category).
 */
export function categoryCollisionError(name: string, known: readonly KnownCategory[]): string | null {
  const normalized = normalizeCategoryName(name);
  const slug = categorySlug(name);
  if (!slug) return null; // categoryNameError covers it
  const clash = known.find((k) => k.slug === slug && normalizeCategoryName(k.name) !== normalized);
  if (!clash) return null;
  return `“${name.trim()}” would share the plugin name \`${slug}\` with the existing category “${clash.name}” — pick that category instead.`;
}

/**
 * Every check a category list must pass before it may be persisted (§10): normalized names, each
 * with a real, non-reserved slug, none colliding with a differently-named existing category.
 * `known` need only contain the categories whose slug matches one of the candidates. Returns the
 * first problem, or null.
 */
export function checkCategoryNames(names: readonly string[], known: readonly KnownCategory[]): string | null {
  for (const name of names) {
    const err = categoryNameError(name) ?? categoryCollisionError(name, known);
    if (err) return err;
  }
  return null;
}
