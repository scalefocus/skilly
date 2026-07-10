-- 0048: "Request a skill" (SKILLY_SPEC.md §26). Org-visible wishes for skills that don't exist
-- yet. Lightweight and unreviewed (not proposals); fulfilled when a proposal explicitly linked to
-- the request (proposals.origin_request_id) is accepted. App-role grants inherit from 0002.
BEGIN;

CREATE TABLE skill_requests (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_user_id    UUID NOT NULL REFERENCES users(id),
  title                TEXT NOT NULL,
  description          TEXT NOT NULL DEFAULT '',
  usage_examples       TEXT,
  tool_harness         TEXT NOT NULL DEFAULT 'generic',
  state                TEXT NOT NULL DEFAULT 'open'
                       CHECK (state IN ('open', 'fulfilled', 'withdrawn', 'removed')),
  -- Fulfilment snapshot (set once, when a linked proposal is accepted): the created skill, who
  -- fulfilled it (the proposal's submitter), and when. Never cleared; the state flip hides the row.
  fulfilled_skill_id   UUID REFERENCES skills(id) ON DELETE SET NULL,
  fulfilled_by_user_id UUID REFERENCES users(id),
  fulfilled_at         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_skill_requests_open ON skill_requests (created_at DESC) WHERE state = 'open';
-- Leaderboard "requests fulfilled": count per fulfiller in a time window (self-credit excluded in the query).
CREATE INDEX idx_skill_requests_fulfiller ON skill_requests (fulfilled_by_user_id, fulfilled_at) WHERE state = 'fulfilled';

-- Categories reuse the shared controlled vocabulary (same as skill_categories).
CREATE TABLE skill_request_categories (
  request_id  UUID NOT NULL REFERENCES skill_requests(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (request_id, category_id)
);

-- Optional example files (reference material for whoever builds the skill). Bytes live in S3;
-- scanned at upload like any other upload; capped by max_bundle_bytes. §26.
CREATE TABLE skill_request_files (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   UUID NOT NULL REFERENCES skill_requests(id) ON DELETE CASCADE,
  s3_key       TEXT NOT NULL,
  filename     TEXT NOT NULL,
  size_bytes   BIGINT NOT NULL,
  content_type TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_skill_request_files_request ON skill_request_files (request_id);

-- Explicit fulfilment link: set when a proposal is created via a request's "Propose a skill"
-- button. Advisory until acceptance; the FIRST accepted linked proposal fulfils the request.
ALTER TABLE proposals ADD COLUMN origin_request_id UUID REFERENCES skill_requests(id) ON DELETE SET NULL;

COMMIT;
