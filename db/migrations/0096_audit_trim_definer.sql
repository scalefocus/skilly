-- 0096: the audit trim becomes a SECURITY DEFINER function and invariant #5 is grant-enforced
-- again (SKILLY_SPEC.md §3 "Append-only is grant-enforced AND trigger-enforced", §49.6; October
-- 2026 OWASP review, V12).
--
-- Why. Migration 0002 revoked UPDATE/DELETE on audit_log from the app role. Migration 0024 then
-- re-GRANTED both to skilly_app for the platform-admin retention trim and let audit_guard() yield
-- to a plain session-settable GUC (`skilly.allow_audit_trim = 'on'`). Together those meant any SQL
-- executed under the app connection — a bug, an injection, a compromised process — could set the
-- GUC, delete audit rows and call rebaseline_audit_chain() to make the tamper-evident chain verify
-- clean again. This migration closes that:
--
--   * trim_audit_log(p_actor, p_older_than) — SECURITY DEFINER, owned by the migration (table
--     owner) role, search_path pinned. It is the ONLY delete path: floor check (>= 1 year), the
--     `audit.trimmed` row through the normal insert path (the 0056 chain trigger assigns seq inside
--     its advisory lock), the transaction-local GUC, the delete (sparing the row it just wrote),
--     the chain re-baseline, and the count back. It also takes the chain's advisory xact lock up
--     front so no appender can chain onto a pre-rebaseline tail hash while the trim is in flight.
--   * audit_guard() yields only when the GUC is set AND the caller is demonstrably inside a definer
--     function owned by the table owner (`current_user <> session_user AND current_user = owner`)
--     — or when there is no privilege separation to protect at all: the skilly_app role does not
--     exist, or the session itself is the table owner (dev, CI and e2e databases connect as the
--     migration role, which can disable the trigger anyway). Under the app role, a plain
--     UPDATE/DELETE raises `audit_log is append-only` even with the GUC set.
--   * Grants: UPDATE/DELETE on audit_log revoked from skilly_app again; EXECUTE on
--     trim_audit_log granted to skilly_app (and revoked from PUBLIC); EXECUTE on
--     rebaseline_audit_chain() revoked from PUBLIC and skilly_app — only the definer calls it.
--
-- Also here (§49.5): registered OAuth clients whose redirect URIs carry a refused scheme
-- (javascript:, data:, vbscript:, file:, blob:, about:) are deleted; grants, tokens and pending
-- authorizations cascade. None are expected.
--
-- Guarded like 0024: every GRANT/REVOKE on skilly_app is skipped where the role does not exist.
BEGIN;

-- ── The single delete path ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trim_audit_log(p_actor uuid, p_older_than interval) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_cutoff  timestamptz;
  v_count   integer;
  v_row_id  uuid;
BEGIN
  -- The one-year floor, compared on the cutoff instant rather than on the intervals: interval
  -- comparison normalizes a year to 360 days, which would let '364 days' through.
  v_cutoff := now() - p_older_than;
  IF p_older_than IS NULL OR v_cutoff > now() - interval '1 year' THEN
    RAISE EXCEPTION 'audit_trim_floor' USING ERRCODE = 'check_violation';
  END IF;

  -- Serialize with the append trigger (0008/0056): appenders wait until this transaction
  -- commits, so nobody chains onto a tail hash the re-baseline below is about to rewrite.
  PERFORM pg_advisory_xact_lock(778899);

  SELECT count(*)::integer INTO v_count FROM audit_log WHERE created_at < v_cutoff;

  -- Record the trim FIRST, through the normal insert path (chained like any other row). It
  -- post-dates the cutoff and is excluded from the delete explicitly as well.
  INSERT INTO audit_log
    (actor_user_id, action, target_type, target_id, namespace_id, before, after, source, request_id)
  VALUES
    (p_actor, 'audit.trimmed', 'audit_log', NULL, NULL, NULL,
     jsonb_build_object('deletedCount', v_count, 'olderThan', p_older_than::text, 'cutoff', v_cutoff),
     'web', NULL)
  RETURNING id INTO v_row_id;

  PERFORM set_config('skilly.allow_audit_trim', 'on', true);

  IF v_count > 0 THEN
    DELETE FROM audit_log WHERE created_at < v_cutoff AND id <> v_row_id;
    PERFORM rebaseline_audit_chain();
  END IF;

  RETURN v_count;
END;
$$;

-- ── The guard yields only inside that function ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION audit_guard() RETURNS trigger AS $$
DECLARE
  v_owner name := (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.audit_log'::regclass);
BEGIN
  IF current_setting('skilly.allow_audit_trim', true) = 'on'
     AND (
       -- inside a SECURITY DEFINER function owned by the table owner, executed by a different
       -- (the app) session role. The owner check keeps a plain SET ROLE from counting.
       (current_user <> session_user AND current_user = v_owner)
       -- or there is no privilege separation to protect: no app role …
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skilly_app')
       -- … or the session IS the table owner (dev / CI databases; it could disable the trigger anyway)
       OR session_user = v_owner
     ) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_append_only ON audit_log;
CREATE TRIGGER trg_audit_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_guard();

-- ── Grants ──────────────────────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION trim_audit_log(uuid, interval) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION rebaseline_audit_chain() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skilly_app') THEN
    REVOKE UPDATE, DELETE ON audit_log FROM skilly_app;
    GRANT  SELECT, INSERT ON audit_log TO skilly_app;
    GRANT  EXECUTE ON FUNCTION trim_audit_log(uuid, interval) TO skilly_app;
    REVOKE EXECUTE ON FUNCTION rebaseline_audit_chain() FROM skilly_app;
  END IF;
END
$$;

-- ── §49.5: drop OAuth clients registered with a refused redirect-URI scheme ─────────────────
-- redirect_uris is TEXT[] (0063). oauth_grants, oauth_tokens (via grants) and
-- oauth_pending_authorizations all cascade on the client row.
DELETE FROM oauth_clients c
 WHERE EXISTS (
   SELECT 1 FROM unnest(c.redirect_uris) AS u(uri)
    WHERE lower(ltrim(u.uri)) ~ '^(javascript|data|vbscript|file|blob|about):'
 );

COMMIT;
