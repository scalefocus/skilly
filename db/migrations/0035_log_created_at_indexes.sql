-- Audit + System log filtering (SKILLY_SPEC.md §11, §25): the viewers page newest-first and now
-- also filter by a From/To date range. A descending created_at index keeps both the default
-- "newest 100 + infinite scroll" paging and any date-range window fast.
create index if not exists idx_audit_log_created_at on audit_log (created_at desc);
create index if not exists idx_system_event_created_at on system_event (created_at desc);
