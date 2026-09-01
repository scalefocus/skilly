-- 0065: Claude Code plugin marketplaces (SKILLY_SPEC.md §30).
--
-- skilly gains a SECOND consumption contract alongside `npx skills add`: N+1 marketplace git
-- repos served from the same authenticated gateway — one platform-wide PUBLIC marketplace
-- (every active org-visible skill) plus one per namespace (that namespace's namespace-visibility
-- skills only). The two sets are disjoint and each is gated at the repo boundary, never by
-- filtering inside a served file (invariant #3).
--
-- NO BEGIN/COMMIT: psql autocommits each statement, so `ALTER TYPE ... ADD VALUE` commits before
-- the partial indexes below reference the new label. Same pattern as 0029.

-- The marketplace token type. Scoped to a marketplace, not a skill.
ALTER TYPE token_type ADD VALUE IF NOT EXISTS 'marketplace';

-- Per-namespace switch. OFF for every existing and newly created namespace — nothing is served
-- until a namespace admin (or a platform admin) opts in. §30.6.
ALTER TABLE namespaces ADD COLUMN IF NOT EXISTS marketplace_enabled BOOLEAN NOT NULL DEFAULT false;

-- Marketplace-token columns. `skill_id` is already nullable (added nullable by 0029), so a
-- marketplace row simply leaves it NULL and carries its scope here instead.
--   marketplace_scope  : 'public' | 'namespace'
--   namespace_id       : set iff scope = 'namespace'; CASCADE so deleting a namespace revokes
--                        its marketplace tokens along with everything else it owns
--   last_served_commit : the §30.7 attribution cursor — the marketplace `main` commit this token
--                        was last served, so the next fetch can credit exactly the skills that
--                        changed in between
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS marketplace_scope  TEXT;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS namespace_id       UUID REFERENCES namespaces(id) ON DELETE CASCADE;
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS last_served_commit TEXT;

-- Discriminant: an `install` row is skill-scoped and carries no marketplace scope; a
-- `marketplace` row is the exact inverse, and is never a system token (system marketplaces are
-- deliberately deferred — §30.4). Dormant legacy labels (pat/one_time) stay unconstrained.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tokens_scope_discriminant') THEN
    ALTER TABLE tokens ADD CONSTRAINT tokens_scope_discriminant CHECK (
      CASE type
        WHEN 'install' THEN
          skill_id IS NOT NULL AND marketplace_scope IS NULL AND namespace_id IS NULL
        WHEN 'marketplace' THEN
          skill_id IS NULL
          AND marketplace_scope IN ('public', 'namespace')
          AND (namespace_id IS NOT NULL) = (marketplace_scope = 'namespace')
          AND is_system = false
        ELSE TRUE
      END
    );
  END IF;
END $$;

-- The /marketplaces page lists a user's marketplace tokens; disable revokes by namespace.
CREATE INDEX IF NOT EXISTS idx_tokens_marketplace_user ON tokens (user_id)      WHERE type = 'marketplace';
CREATE INDEX IF NOT EXISTS idx_tokens_marketplace_ns   ON tokens (namespace_id) WHERE type = 'marketplace';

-- Platform settings (§30.2, §30.5). Seeded explicitly so they are visible in the table; the app
-- also falls back to these same defaults when a row is absent.
INSERT INTO platform_settings (key, value) VALUES ('marketplace_public_enabled', 'false'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('marketplace_sync_minutes', '30'::jsonb)
  ON CONFLICT (key) DO NOTHING;
INSERT INTO platform_settings (key, value) VALUES ('marketplace_name_prefix', '"skilly"'::jsonb)
  ON CONFLICT (key) DO NOTHING;
