-- 0049: "Request a skill" becomes text-only (SKILLY_SPEC.md §26). The optional example-file
-- upload is removed entirely: drop the skill_request_files table and the two platform settings
-- that bounded it. Requests keep title/description/usage/categories/tool only. The S3 objects the
-- dropped rows referenced are left to normal object-store lifecycle (never re-linked).
BEGIN;

DROP TABLE IF EXISTS skill_request_files;

-- These admin-configurable limits governed the now-removed uploader; the setters and API surface
-- are gone, so purge any stored values.
DELETE FROM platform_settings WHERE key IN ('request_max_files', 'request_max_file_bytes');

COMMIT;
