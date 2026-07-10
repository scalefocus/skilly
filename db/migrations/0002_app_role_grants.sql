-- skilly — least-privilege grants for the application DB role.
-- The app connects as `skilly_app` and must NOT be able to UPDATE/DELETE audit_log.
-- (A trigger also blocks it; this is belt-and-suspenders — SKILLY_SPEC.md §11.)
--
-- Run as the DB owner/superuser after 0001. The migrate service connects as the
-- owner; the web/worker services should connect as skilly_app (see deploy/.env.example).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skilly_app') THEN
    -- Password is set via ALTER ROLE from an env-provided secret by the migrate step,
    -- or create the role out-of-band. Placeholder password must be overridden.
    CREATE ROLE skilly_app LOGIN PASSWORD 'change-me-in-deploy';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO skilly_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO skilly_app;

-- Audit log: append + read only. No UPDATE/DELETE.
REVOKE UPDATE, DELETE ON audit_log FROM skilly_app;
GRANT  SELECT, INSERT ON audit_log TO skilly_app;

-- skill_versions: app may INSERT and may UPDATE (only `status`, enforced by trigger),
-- but must not DELETE.
REVOKE DELETE ON skill_versions FROM skilly_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO skilly_app;
