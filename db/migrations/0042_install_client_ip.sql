-- Capture the originating client IP of an install's first clone, for the owner's
-- Installed Skills page (SKILLY_SPEC.md §23). Owner-scoped display only; never logged
-- with the request. Stamped once on first use alongside client_user_agent; null when
-- unknown/unresolved (e.g. TRUST_PROXY unset behind a reverse proxy).
alter table tokens add column if not exists client_ip text;
