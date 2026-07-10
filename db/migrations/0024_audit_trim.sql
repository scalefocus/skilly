-- Audit retention: platform admins may TRIM events older than a cutoff (SKILLY_SPEC.md §11).
-- This deliberately relaxes invariant #5 (append-only) for ONE explicit, transaction-scoped,
-- audited operation. The append-only protection stays in force for every other path: the
-- guard below only yields when `skilly.allow_audit_trim = 'on'` is set for the transaction.
-- Trimming the oldest rows would dangle the hash chain (0008), so the trim re-baselines the
-- chain over the survivors — after which verify_audit_chain() passes again, but tamper-
-- evidence only covers events since the most recent trim. The trim itself is recorded as an
-- `audit.trimmed` entry before the delete.
BEGIN;

-- Replace the append-only guard with one that permits UPDATE/DELETE under the scoped flag.
CREATE OR REPLACE FUNCTION audit_guard() RETURNS trigger AS $$
BEGIN
  IF current_setting('skilly.allow_audit_trim', true) = 'on' THEN
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

-- Recompute prev_hash/entry_hash for every surviving row in seq order, so the chain is a
-- valid linear chain again after rows were removed. Uses the same audit_entry_hash() as the
-- insert trigger + verifier, so they can't diverge. Runs only inside an allow_audit_trim txn.
CREATE OR REPLACE FUNCTION rebaseline_audit_chain() RETURNS void AS $$
DECLARE r audit_log; prev TEXT := NULL; h TEXT;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY seq ASC LOOP
    h := audit_entry_hash(prev, r);
    UPDATE audit_log SET prev_hash = prev, entry_hash = h WHERE seq = r.seq;
    prev := h;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- The prod app role (skilly_app) is otherwise denied UPDATE/DELETE on audit_log; the trim path
-- needs both. The trigger above remains the real gate. Guarded for envs without the role.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skilly_app') THEN
    GRANT UPDATE, DELETE ON audit_log TO skilly_app;
  END IF;
END $$;

COMMIT;
