-- Tier 3: the worker's pointer-refresh job records governance events (e.g. upstream drift on
-- a pinned ref) in the audit log, so audit_source needs a 'worker' value.
-- NOTE: ALTER TYPE ... ADD VALUE cannot run inside a transaction that also uses the new value,
-- so this migration is intentionally NOT wrapped in BEGIN/COMMIT (psql autocommits it).
ALTER TYPE audit_source ADD VALUE IF NOT EXISTS 'worker';
