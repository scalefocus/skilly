-- Nav "new items" badge for the System log (SKILLY_SPEC.md §25, §10), platform admins only.
-- One per-user "last viewed" marker, same pattern as catalog_seen_at / review_seen_at (0026):
-- the System log nav link shows a superscript count of system_event rows newer than this.
-- DEFAULT now() so existing admins start clean (no historical flood).
ALTER TABLE users ADD COLUMN IF NOT EXISTS system_log_seen_at TIMESTAMPTZ NOT NULL DEFAULT now();
