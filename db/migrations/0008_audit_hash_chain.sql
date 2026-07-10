-- Tier 4: tamper-evident audit log via hash chaining. Each row's entry_hash covers its
-- content + the previous row's entry_hash, so any in-place edit, deletion, or reordering
-- breaks the chain and is detectable by verify_audit_chain(). The append-only trigger +
-- least-privilege role already prevent mutation; this makes tampering *provable*.
-- SKILLY_SPEC.md §11, §16 (deferred → now delivered).
BEGIN;

ALTER TABLE audit_log ADD COLUMN seq        BIGSERIAL;   -- monotonic append order
ALTER TABLE audit_log ADD COLUMN prev_hash  TEXT;        -- previous row's entry_hash (NULL at genesis)
ALTER TABLE audit_log ADD COLUMN entry_hash TEXT;        -- sha256 over (prev_hash + canonical content)

-- Canonical hash of a row given the previous entry_hash. IMMUTABLE + shared by the insert
-- trigger and the verifier so they can never diverge.
CREATE OR REPLACE FUNCTION audit_entry_hash(prev TEXT, r audit_log) RETURNS TEXT AS $$
  SELECT encode(digest(
    coalesce(prev,'')                || '|' || r.seq::text                      || '|' ||
    coalesce(r.actor_user_id::text,'') || '|' || r.action                       || '|' ||
    r.target_type                    || '|' || coalesce(r.target_id,'')         || '|' ||
    coalesce(r.namespace_id::text,'') || '|' || coalesce(r.before::text,'')     || '|' ||
    coalesce(r.after::text,'')       || '|' || r.source::text                   || '|' ||
    coalesce(r.request_id,'')        || '|' || r.created_at::text,
  'sha256'), 'hex');
$$ LANGUAGE sql IMMUTABLE;

-- BEFORE INSERT: serialize appenders (advisory lock) so the chain is strictly linear, read
-- the tail hash, and stamp prev_hash + entry_hash. Column defaults (seq, created_at) are
-- already materialized on NEW before this fires.
CREATE OR REPLACE FUNCTION audit_chain() RETURNS trigger AS $$
DECLARE prev TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(778899);
  SELECT entry_hash INTO prev FROM audit_log ORDER BY seq DESC LIMIT 1;
  NEW.prev_hash  := prev;
  NEW.entry_hash := audit_entry_hash(prev, NEW);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_chain
  BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_chain();

-- Verifier: returns one row per broken link (empty result = intact chain).
CREATE OR REPLACE FUNCTION verify_audit_chain() RETURNS TABLE(bad_seq BIGINT, reason TEXT) AS $$
DECLARE r audit_log; prev TEXT := NULL;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY seq ASC LOOP
    IF r.prev_hash IS DISTINCT FROM prev THEN
      bad_seq := r.seq; reason := 'prev_hash mismatch'; RETURN NEXT;
    END IF;
    IF r.entry_hash IS DISTINCT FROM audit_entry_hash(prev, r) THEN
      bad_seq := r.seq; reason := 'entry_hash mismatch'; RETURN NEXT;
    END IF;
    prev := r.entry_hash;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- The app role inserts audit rows, so it needs the new sequence (default nextval).
GRANT USAGE, SELECT ON SEQUENCE audit_log_seq_seq TO skilly_app;

COMMIT;
