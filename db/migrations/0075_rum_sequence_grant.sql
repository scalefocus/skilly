-- §32.3 Real user monitoring — the app-role grant 0074 forgot.
--
-- rum_samples.id is a bigserial; the default privileges from 0002 cover TABLES only, so
-- skilly_app could SELECT/INSERT the table but not call nextval() on its sequence. In production
-- every `POST /api/rum` therefore failed with a 500 (permission denied for sequence
-- rum_samples_id_seq) while the reads kept working — the Monitoring page showed an empty range
-- with no error. Same fix as audit_log_seq_seq (0008) and usage_events_id_seq (0015).
--
-- Rule (SKILLY_SPEC.md §32.3): a serial/identity column ships with its sequence grant in the
-- same migration. The live-DB test (rum.dbtest.ts) asserts USAGE on every sequence in public.
BEGIN;

GRANT USAGE, SELECT ON SEQUENCE rum_samples_id_seq TO skilly_app;

COMMIT;
