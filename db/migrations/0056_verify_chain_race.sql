-- Fix a seq/chain ordering race that made verify_audit_chain() report spurious tampering.
--
-- The append trigger (0008) serializes chain construction with pg_advisory_xact_lock(778899),
-- but `seq` is a BIGSERIAL whose default is materialized on NEW *before* the trigger fires —
-- i.e. OUTSIDE the lock. Two concurrent appenders could therefore draw seq N and N+1 in one
-- order and acquire the lock in the opposite order: the N+1 row chains onto N-1's hash, then
-- the N row chains onto N+1's. The chain is a valid line in LOCK order, but the verifier
-- (and any reader) walks SEQ order, where the inverted pair yields 'prev_hash mismatch' +
-- 'entry_hash mismatch' on both rows — 4 findings — PERMANENTLY: a healthy instance reports
-- tampering forever after one unlucky concurrent write. (Observed as a flaky admin dbtest in
-- CI, where the parallel db-test files append concurrently; equally reachable in production
-- via GET /api/audit/verify, SKILLY_SPEC.md §11.)
BEGIN;

-- 1) Root fix: (re-)assign seq INSIDE the advisory lock, so seq order, chain order, and
--    commit-visibility order are all the same total order. The column default still fires
--    first (harmless extra nextval; keeps NOT NULL satisfied if the trigger is ever absent),
--    and entry_hash is computed after the reassignment, over the final seq.
CREATE OR REPLACE FUNCTION audit_chain() RETURNS trigger AS $$
DECLARE prev TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(778899);
  NEW.seq := nextval('audit_log_seq_seq');
  SELECT entry_hash INTO prev FROM audit_log ORDER BY seq DESC LIMIT 1;
  NEW.prev_hash  := prev;
  NEW.entry_hash := audit_entry_hash(prev, NEW);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2) Repair: existing databases may already hold inverted pairs (the permanent false
--    positives above). Re-baseline the chain over all rows in seq order — the same
--    audited-trim helper (0024) the retention path uses, under its transaction-scoped
--    flag so the append-only guard admits the UPDATEs. No-op on a fresh database.
SET LOCAL skilly.allow_audit_trim = 'on';
SELECT rebaseline_audit_chain();

COMMIT;
