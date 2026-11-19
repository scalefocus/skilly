-- 0114: signed skill versions (SKILLY_SPEC.md §73).
--
--  * signing_keys — every platform signing key the worker has used: the Ed25519 PUBLIC key, its
--    keyId and fingerprint, when it was retired, and its revocation. Private keys are never stored;
--    the worker holds the active one in memory from SKILLY_SIGNING_KEY (§73.9). At most one key is
--    active (neither retired nor revoked). A key's identity never changes and a revocation is final.
--  * skill_version_attestations — one APPEND-ONLY row per signed statement (§73.13): a version's own
--    statement (variant_key '') or one of its variants (a skilly-made rewrite, §73.5), signed by one
--    key. The DSSE envelope is stored exactly as signed. skill_versions is untouched.
BEGIN;

CREATE TABLE IF NOT EXISTS signing_keys (
  key_id          TEXT PRIMARY KEY CHECK (key_id ~ '^[0-9a-f]{16}$'),
  algorithm       TEXT NOT NULL DEFAULT 'ed25519' CHECK (algorithm = 'ed25519'),
  public_key_pem  TEXT NOT NULL,
  fingerprint     TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  revoked_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_reason  TEXT CHECK (revoked_reason IS NULL OR char_length(revoked_reason) BETWEEN 1 AND 500),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

-- At most one active key.
CREATE UNIQUE INDEX IF NOT EXISTS signing_keys_one_active
  ON signing_keys ((true)) WHERE retired_at IS NULL AND revoked_at IS NULL;

-- A key's identity is immutable, a revocation cannot be undone or rewritten (the revoker may only
-- become NULL, through ON DELETE SET NULL), and keys are never deleted: every statement names one.
CREATE OR REPLACE FUNCTION signing_keys_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'signing keys are never deleted';
  END IF;
  IF NEW.key_id <> OLD.key_id OR NEW.algorithm <> OLD.algorithm
     OR NEW.public_key_pem <> OLD.public_key_pem OR NEW.fingerprint <> OLD.fingerprint
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a signing key''s identity is immutable';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (
       NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
       OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason
       OR (NEW.revoked_by IS DISTINCT FROM OLD.revoked_by AND NEW.revoked_by IS NOT NULL)) THEN
    RAISE EXCEPTION 'a signing key revocation is final';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_signing_keys_guard ON signing_keys;
CREATE TRIGGER trg_signing_keys_guard
  BEFORE UPDATE OR DELETE ON signing_keys
  FOR EACH ROW EXECUTE FUNCTION signing_keys_guard();

CREATE TABLE IF NOT EXISTS skill_version_attestations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_version_id  UUID NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  variant_rewrites  TEXT[] NOT NULL DEFAULT '{}'
                    CHECK (variant_rewrites <@ ARRAY['deprecation', 'marketplace_hoist']::text[]),
  variant_key       TEXT NOT NULL DEFAULT '' CHECK (variant_key = '' OR variant_key ~ '^[0-9a-f]{64}$'),
  kind              TEXT NOT NULL CHECK (kind IN ('publish', 'backfill', 'resign')),
  key_id            TEXT NOT NULL REFERENCES signing_keys(key_id),
  computed_hash     TEXT NOT NULL CHECK (computed_hash ~ '^[0-9a-f]{64}$'),
  envelope          JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((variant_key = '') = (cardinality(variant_rewrites) = 0)),
  UNIQUE (skill_version_id, variant_key, key_id)
);

CREATE INDEX IF NOT EXISTS idx_attestations_version ON skill_version_attestations (skill_version_id, variant_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attestations_computed_hash ON skill_version_attestations (computed_hash);
CREATE INDEX IF NOT EXISTS idx_attestations_key ON skill_version_attestations (key_id);

-- Append-only: no UPDATE, whatever the role. Rows go only with their version (the FK cascade of a
-- permanently deleted skill), so DELETE is left to the cascade and revoked from the app role below.
DROP TRIGGER IF EXISTS trg_attestations_append_only ON skill_version_attestations;
CREATE TRIGGER trg_attestations_append_only
  BEFORE UPDATE ON skill_version_attestations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- 0002's default privileges grant the app role full DML on new tables; take back what §73.13 forbids.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skilly_app') THEN
    REVOKE UPDATE, DELETE ON skill_version_attestations FROM skilly_app;
    GRANT SELECT, INSERT ON skill_version_attestations TO skilly_app;
    REVOKE DELETE ON signing_keys FROM skilly_app;
    GRANT SELECT, INSERT, UPDATE ON signing_keys TO skilly_app;
  END IF;
END $$;

COMMIT;
