-- 0028: indexes for the most-frequent queries not already covered by 0027.
-- Identified from the hot request paths (token validation on every git fetch, RBAC resolution on
-- every authenticated request, PAT management, the polled nav-badge count).

-- Token validation runs on EVERY git fetch / `npx skills add` clone: `where hashed_token = $1`.
-- hashed_token is NOT NULL and is a hash of a unique secret, so a UNIQUE index is correct and
-- turns a sequential scan of `tokens` into a single-row lookup.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tokens_hashed ON tokens (hashed_token);

-- PAT listing (`where user_id = $1 and type = 'pat'`) and the SCIM / skill-delete cleanups
-- (`delete from tokens where user_id = $1`) filter by user_id, which was unindexed.
CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens (user_id);

-- loadUserGroupIds — part of resolveUserAccess, the single most-common query (every authenticated
-- request) — joins group_memberships by user_id. The PK is (group_id, user_id), so a user_id
-- lookup can't seek; this dedicated index serves the join directly.
CREATE INDEX IF NOT EXISTS idx_group_memberships_user ON group_memberships (user_id);

-- The Catalog nav badge polls `count(*) ... where status='active' and created_at > <last seen>`.
-- A partial index on created_at (active rows only) makes it an index range scan of just the new
-- skills instead of scanning every active skill and filtering.
CREATE INDEX IF NOT EXISTS idx_skills_active_created ON skills (created_at) WHERE status = 'active';
