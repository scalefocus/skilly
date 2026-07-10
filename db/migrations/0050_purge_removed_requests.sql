-- Backfill for the fix that made admin request-removal a hard delete (SKILLY_SPEC.md §26): any
-- skill_requests rows already sitting in state='removed' from before that fix were soft-deleted
-- only — purge them now so removal is consistently a permanent delete going forward. Categories
-- cascade (skill_request_categories FK); any proposal.origin_request_id pointing at one of these
-- sets null via the existing FK. Open/fulfilled/withdrawn requests are untouched.
BEGIN;

DELETE FROM skill_requests WHERE state = 'removed';

COMMIT;
