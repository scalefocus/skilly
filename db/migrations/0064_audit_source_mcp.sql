-- 0064: the §29 MCP server writes governance audit rows for content an agent created on a user's
-- behalf, so audit_source needs an 'mcp' value. The action names stay the existing ones
-- (proposal.*, skill.*, …) — an MCP-submitted proposal is a proposal, not a new species of
-- governance object — and this source is what tells a reader HOW the act arrived.
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction that also uses the new value,
-- so this migration is intentionally NOT wrapped in BEGIN/COMMIT (psql autocommits it) — same
-- shape as 0007, which added 'worker'.
ALTER TYPE audit_source ADD VALUE IF NOT EXISTS 'mcp';
