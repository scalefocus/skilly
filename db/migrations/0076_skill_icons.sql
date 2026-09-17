-- Skill icons + signed share links (SKILLY_SPEC.md §33). Icons are optional, skill-level
-- metadata (image and/or emoji); share links are a fourth, separate token regime (like
-- oauth_*, never a row in `tokens`) that unlocks per-skill Open Graph metadata only.
BEGIN;

CREATE TABLE IF NOT EXISTS skill_icons (
  sha256      text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bytes       bytea NOT NULL,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS skill_share_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hashed_token  text NOT NULL UNIQUE,
  skill_id      uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX IF NOT EXISTS skill_share_links_skill_idx ON skill_share_links (skill_id);
CREATE INDEX IF NOT EXISTS skill_share_links_expires_idx ON skill_share_links (expires_at);

ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS icon_sha256 text REFERENCES skill_icons(sha256) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS icon_emoji  text,
  ADD COLUMN IF NOT EXISTS icon_source text CHECK (icon_source IS NULL OR icon_source IN ('frontmatter', 'bundle', 'upload'));

-- Table-level grants for skilly_app are inherited from the default privileges set in 0002; no
-- serial/identity column here, so no sequence grant is needed (skill_share_links.id is a UUID
-- default, not a sequence).

COMMIT;
