// Category vocabulary writes — SKILLY_SPEC.md §3 `categories`, §10 *Category slugs*.
//
// Categories are created on the fly by whoever names one (a proposal, a request, the MCP tools).
// Every creation path funnels through these two helpers so the rules cannot drift: the name must
// yield a real, non-reserved slug, and that slug must not already belong to a differently-named
// category (it would be the same marketplace plugin name, §30.3). The check runs at SUBMIT time
// so the proposer sees the message — never the reviewer at accept.
import type { Pool, PoolClient } from "pg";
import { categorySlug, checkCategoryNames, normalizeCategoryNames, type KnownCategory } from "@skilly/shared";

type Db = Pool | PoolClient;

/** Load the existing categories whose slug matches any candidate — the input `checkCategoryNames` needs. */
export async function knownCategoriesFor(db: Db, names: readonly string[]): Promise<KnownCategory[]> {
  const slugs = [...new Set(names.map(categorySlug).filter(Boolean))];
  if (slugs.length === 0) return [];
  const { rows } = await db.query<KnownCategory>(`select name, slug from categories where slug = any($1::text[])`, [slugs]);
  return rows;
}

/**
 * The user-facing 422 message for a submitted category list, or null when it may be persisted.
 * Names are normalized first (trim/lowercase/de-dupe), exactly as the writers store them.
 */
export async function categoryListError(db: Db, names: readonly string[] | null | undefined): Promise<string | null> {
  const clean = normalizeCategoryNames(names);
  if (clean.length === 0) return null;
  return checkCategoryNames(clean, await knownCategoriesFor(db, clean));
}

/**
 * Upsert one category by (lowercase) name and return its id. The slug is derived here, once, and
 * never rewritten on conflict (§3 — immutable). Callers run `categoryListError` first; the UNIQUE
 * index on slug is the backstop for a race, surfaced as a plain error rather than a 500 by the
 * API layer's generic 23505 handling.
 */
export async function upsertCategory(db: Db, name: string): Promise<string> {
  const clean = name.trim().toLowerCase();
  const slug = categorySlug(clean);
  if (!slug) throw new Error(`category name yields no slug: ${JSON.stringify(name)}`);
  const { rows } = await db.query<{ id: string }>(
    `insert into categories (name, slug) values ($1, $2)
       on conflict (name) do update set name = excluded.name
     returning id`,
    [clean, slug],
  );
  return rows[0]!.id;
}
