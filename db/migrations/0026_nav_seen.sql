-- Per-user "last viewed" markers for nav badges (SKILLY_SPEC.md §10, §8).
-- The Catalog and Review queue nav items show a small superscript count of items that
-- appeared since the user last opened that surface. We store one timestamp per surface and
-- count rows newer than it (visibility-filtered). DEFAULT now() so existing users start with
-- a clean slate (nothing historical counts as "new") rather than a flood of "9+".
ALTER TABLE users ADD COLUMN IF NOT EXISTS catalog_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS review_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now();
