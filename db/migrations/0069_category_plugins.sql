-- Category plugins (SKILLY_SPEC.md §3 `categories` / `marketplace_plugins`, §10 *Category slugs*,
-- §30.3). Every category gets an IMMUTABLE kebab-case `slug` — it is the category's plugin name in
-- every Claude plugin marketplace — and a small table keeps each plugin's `1.0.<n>` version counter.
BEGIN;

-- The backfill mirrors the shared `categorySlug()` derivation (lowercase → diacritics stripped →
-- non-[a-z0-9] runs → '-' → edges trimmed → capped at 64). `unaccent` is a stock contrib module in
-- the postgres image; it is only needed here, for the one-time backfill.
CREATE EXTENSION IF NOT EXISTS unaccent;

ALTER TABLE categories ADD COLUMN slug TEXT;

UPDATE categories
   SET slug = left(
                trim(both '-' from regexp_replace(lower(unaccent(name)), '[^a-z0-9]+', '-', 'g')),
                64);
-- A cut at 64 may land on a trailing hyphen; trim once more.
UPDATE categories SET slug = trim(both '-' from slug);

-- Fail LOUDLY on collisions (§3): two names that slug identically must be merged by hand, never
-- auto-suffixed into an arbitrary plugin name that consumers would then install.
DO $$
DECLARE
  pairs TEXT;
  empties TEXT;
BEGIN
  SELECT string_agg(format('%s ← {%s}', slug, names), '; ')
    INTO pairs
    FROM (SELECT slug, string_agg(quote_literal(name), ', ' ORDER BY name) AS names
            FROM categories GROUP BY slug HAVING count(*) > 1) d;
  IF pairs IS NOT NULL THEN
    RAISE EXCEPTION 'migration 0069: category slug collisions — merge these by hand and re-run: %', pairs;
  END IF;

  SELECT string_agg(quote_literal(name), ', ') INTO empties FROM categories WHERE slug IS NULL OR slug = '';
  IF empties IS NOT NULL THEN
    RAISE EXCEPTION 'migration 0069: categories whose name yields no slug — rename or delete them: %', empties;
  END IF;

  IF EXISTS (SELECT 1 FROM categories WHERE slug = 'general') THEN
    RAISE EXCEPTION 'migration 0069: a category slugged "general" exists — that slug is reserved for the uncategorized bucket plugin; rename it first';
  END IF;
END $$;

ALTER TABLE categories
  ALTER COLUMN slug SET NOT NULL,
  ADD CONSTRAINT categories_slug_key UNIQUE (slug),
  ADD CONSTRAINT categories_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$' AND length(slug) <= 64),
  ADD CONSTRAINT categories_slug_not_reserved CHECK (slug <> 'general');

-- Per-plugin version counter (§30.3 `1.0.<n>`). `marketplace_key` is 'public' or 'ns:<namespace
-- uuid>' — text, not an FK, so a deleted namespace does not cascade; the sweep self-heals orphans.
-- Rows are never decremented or deleted by the sweep: a plugin that vanishes and reappears
-- continues its count, so an installed consumer never sees the version go backwards.
CREATE TABLE marketplace_plugins (
  marketplace_key TEXT NOT NULL,
  plugin_slug     TEXT NOT NULL,
  version_n       INTEGER NOT NULL DEFAULT 1,
  fingerprint     TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (marketplace_key, plugin_slug)
);

COMMIT;
