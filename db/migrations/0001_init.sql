-- skilly — initial schema (SKILLY_SPEC.md §3)
-- Plain SQL migration, applied in order by the `migrate` compose service.
-- Conventions: snake_case, UUID PKs, timestamptz, FKs explicit.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE user_status      AS ENUM ('active', 'inactive');
CREATE TYPE platform_role    AS ENUM ('platform_admin', 'namespace_admin', 'namespace_member');
CREATE TYPE skill_type       AS ENUM ('hosted', 'pointer');
CREATE TYPE skill_visibility AS ENUM ('org', 'namespace');
CREATE TYPE skill_status     AS ENUM ('active', 'archived');
CREATE TYPE version_status   AS ENUM ('active', 'yanked');
CREATE TYPE proposal_state   AS ENUM ('proposed', 'under_review', 'changes_requested', 'accepted', 'rejected');
CREATE TYPE token_type       AS ENUM ('pat', 'one_time');
CREATE TYPE audit_source     AS ENUM ('web', 'api', 'scim');

-- ---------------------------------------------------------------------------
-- Identity (SCIM-synced) — SKILLY_SPEC.md §5
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entra_object_id TEXT UNIQUE NOT NULL,
  email           TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  status          user_status NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE groups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entra_object_id TEXT UNIQUE NOT NULL,
  display_name    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE group_memberships (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Namespaces & RBAC mapping — SKILLY_SPEC.md §4
-- ---------------------------------------------------------------------------
CREATE TABLE namespaces (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               TEXT UNIQUE NOT NULL,
  display_name       TEXT NOT NULL,
  require_review     BOOLEAN NOT NULL DEFAULT true,
  maintainer_contact TEXT,                       -- set by Platform Admin
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Explicit Entra-group -> (namespace, role) binding.
-- platform_admin rows have namespace_id = NULL.
-- Supports N groups -> one namespace and one group -> N namespaces.
CREATE TABLE role_mappings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  namespace_id UUID REFERENCES namespaces(id) ON DELETE CASCADE,
  role         platform_role NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT platform_admin_has_no_namespace
    CHECK ((role = 'platform_admin') = (namespace_id IS NULL)),
  UNIQUE (group_id, namespace_id, role)
);

-- ---------------------------------------------------------------------------
-- Taxonomy — SKILLY_SPEC.md §10
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT UNIQUE NOT NULL,
  description TEXT
);

-- ---------------------------------------------------------------------------
-- Skills & versions — SKILLY_SPEC.md §6, §7
-- ---------------------------------------------------------------------------
CREATE TABLE skills (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace_id                UUID NOT NULL REFERENCES namespaces(id) ON DELETE RESTRICT,
  slug                        TEXT NOT NULL,
  title                       TEXT NOT NULL,
  description                 TEXT NOT NULL,
  category_id                 UUID REFERENCES categories(id),
  tool_harness                TEXT NOT NULL,            -- controlled enum at app layer
  tags                        TEXT[] NOT NULL DEFAULT '{}',
  type                        skill_type NOT NULL,
  visibility                  skill_visibility NOT NULL DEFAULT 'namespace',
  status                      skill_status NOT NULL DEFAULT 'active',
  promoted_from_skill_version_id UUID,                  -- provenance for global promotion
  install_count               BIGINT NOT NULL DEFAULT 0,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (namespace_id, slug)
);

CREATE TABLE skill_versions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id            UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  semver              TEXT NOT NULL,
  is_prerelease       BOOLEAN NOT NULL,                 -- true => 'beta' channel
  status              version_status NOT NULL DEFAULT 'active',
  usage_examples      TEXT,
  -- hosted
  artifact_object_key TEXT,
  artifact_sha256     TEXT,
  -- pointer (pinned immutable ref)
  external_ref        TEXT,
  external_origin_url TEXT,
  created_by          UUID REFERENCES users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, semver),
  CONSTRAINT hosted_or_pointer_payload CHECK (
    (artifact_object_key IS NOT NULL AND external_ref IS NULL) OR
    (artifact_object_key IS NULL     AND external_ref IS NOT NULL)
  )
);

ALTER TABLE skills
  ADD CONSTRAINT skills_promoted_from_fk
  FOREIGN KEY (promoted_from_skill_version_id) REFERENCES skill_versions(id);

-- Skill versions are immutable once created. Block UPDATE/DELETE.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'rows in % are immutable / append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- Allow status flips (yank) but nothing else: we permit UPDATE only of `status`.
CREATE OR REPLACE FUNCTION skill_versions_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'skill_versions are immutable; delete is forbidden';
  END IF;
  IF NEW.semver <> OLD.semver
     OR NEW.skill_id <> OLD.skill_id
     OR COALESCE(NEW.artifact_sha256,'') <> COALESCE(OLD.artifact_sha256,'')
     OR COALESCE(NEW.external_ref,'')   <> COALESCE(OLD.external_ref,'') THEN
    RAISE EXCEPTION 'published skill_version content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_skill_versions_guard
  BEFORE UPDATE OR DELETE ON skill_versions
  FOR EACH ROW EXECUTE FUNCTION skill_versions_guard();

-- ---------------------------------------------------------------------------
-- Proposals & review — SKILLY_SPEC.md §8
-- ---------------------------------------------------------------------------
CREATE TABLE proposals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_namespace_id   UUID NOT NULL REFERENCES namespaces(id) ON DELETE RESTRICT,
  target_skill_id       UUID REFERENCES skills(id),       -- NULL = new skill
  proposed_semver       TEXT NOT NULL,
  state                 proposal_state NOT NULL DEFAULT 'proposed',
  submitted_by          UUID NOT NULL REFERENCES users(id),
  materialized_version_id UUID REFERENCES skill_versions(id),  -- set on accept
  decision_reason       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Original submission immutable; reviewer edits + resubmissions are revisions.
CREATE TABLE proposal_revisions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  revision_no INT NOT NULL,
  payload     JSONB NOT NULL,        -- metadata + artifact reference for this revision
  author      UUID NOT NULL REFERENCES users(id),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (proposal_id, revision_no)
);

-- ---------------------------------------------------------------------------
-- Scanning — SKILLY_SPEC.md §6
-- ---------------------------------------------------------------------------
CREATE TABLE scan_reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type  TEXT NOT NULL,        -- 'skill_version' | 'pointer_ref'
  subject_id    TEXT NOT NULL,
  scanner       TEXT NOT NULL,
  findings      JSONB NOT NULL DEFAULT '[]',
  severity      TEXT,
  status        TEXT NOT NULL,
  cached_for_ref TEXT,                -- pointer caching per pinned ref
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tokens — SKILLY_SPEC.md §9
-- one_time tokens are DELETED on use or TTL expiry (handled by app + sweeper).
-- ---------------------------------------------------------------------------
CREATE TABLE tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         token_type NOT NULL,
  hashed_token TEXT NOT NULL,
  scope        JSONB,                -- e.g. { skillId, semver } for one_time
  expires_at   TIMESTAMPTZ,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_tokens_expires ON tokens(expires_at);

-- ---------------------------------------------------------------------------
-- Audit (append-only) & access log — SKILLY_SPEC.md §11
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID REFERENCES users(id),
  action        TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT,
  namespace_id  UUID REFERENCES namespaces(id),
  before        JSONB,
  after         JSONB,
  source        audit_source NOT NULL,
  request_id    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Defense-in-depth: forbid UPDATE/DELETE on audit_log regardless of role.
CREATE TRIGGER trg_audit_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE access_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id    UUID REFERENCES users(id),
  skill_version_id UUID REFERENCES skill_versions(id),
  source           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Notifications — SKILLY_SPEC.md §12
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Full-text search — SKILLY_SPEC.md §10
-- Generated tsvector over name/description/tags; usage_examples joined at query
-- time. Visibility filtering is enforced in the query layer, never bypassed.
-- ---------------------------------------------------------------------------
-- NOTE: a GENERATED column cannot use to_tsvector('english', ...) because that
-- expression is only STABLE (the text->regconfig lookup depends on search_path), not
-- IMMUTABLE. Postgres rejects it. We maintain the column with a trigger instead.
ALTER TABLE skills ADD COLUMN search_tsv tsvector;
CREATE INDEX idx_skills_search_tsv ON skills USING gin(search_tsv);

CREATE OR REPLACE FUNCTION skills_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('english', coalesce(NEW.title,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.description,'')), 'B') ||
    setweight(to_tsvector('english', array_to_string(NEW.tags, ' ')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_skills_tsv
  BEFORE INSERT OR UPDATE OF title, description, tags ON skills
  FOR EACH ROW EXECUTE FUNCTION skills_tsv_update();

CREATE INDEX idx_skills_namespace ON skills(namespace_id);
CREATE INDEX idx_skills_visibility ON skills(visibility);
CREATE INDEX idx_skill_versions_skill ON skill_versions(skill_id);
CREATE INDEX idx_proposals_state ON proposals(state);
CREATE INDEX idx_proposals_namespace ON proposals(target_namespace_id);
CREATE INDEX idx_audit_namespace ON audit_log(namespace_id);
CREATE INDEX idx_audit_actor ON audit_log(actor_user_id);

-- Reserved global namespace (always requires review).
INSERT INTO namespaces (slug, display_name, require_review)
VALUES ('global', 'Global (organization-wide)', true)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
