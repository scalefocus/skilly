-- Leaderboard "skills requested" (SKILLY_SPEC.md §26): count per requester in a time window.
-- Mirrors idx_skill_requests_fulfiller for the fulfilment stat. Only open/fulfilled rows persist
-- (withdrawn/removed hard-delete), so no partial predicate is needed.
CREATE INDEX IF NOT EXISTS idx_skill_requests_requester ON skill_requests (requester_user_id, created_at);
