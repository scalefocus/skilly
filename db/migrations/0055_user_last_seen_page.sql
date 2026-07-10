-- Presence: alongside last_seen (0036), record a human-readable label of the page the user
-- was last on, for the "Currently online" admin list (SKILLY_SPEC.md §4). Nullable + no
-- backfill — existing rows show "—" until their next client-side beacon.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_page TEXT;
