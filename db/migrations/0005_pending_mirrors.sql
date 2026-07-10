-- Pointer skills can't be mirrored by the web app (no git). When a pointer proposal is
-- accepted (or a pointer is direct-published), we enqueue a pending mirror; the worker's
-- mirror sweep clones the pinned ref, scans it, and inserts the immutable skill_version.
-- SKILLY_SPEC.md §6 (pointer mirroring), §8.
BEGIN;

CREATE TABLE pending_mirrors (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id       UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  semver         TEXT NOT NULL,
  external_url   TEXT NOT NULL,
  external_ref   TEXT NOT NULL,
  is_prerelease  BOOLEAN NOT NULL DEFAULT false,
  usage_examples TEXT,
  created_by     UUID REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, semver)
);

COMMIT;
