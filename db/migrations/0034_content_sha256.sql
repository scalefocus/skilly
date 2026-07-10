-- Duplicate-proposal detection (SKILLY_SPEC.md §6, §8).
-- A content-set digest of each version's bundle: sha256 over the SORTED list of per-file
-- sha256(raw bytes), filenames disregarded (junk files like .DS_Store/__MACOSX excluded).
-- This is packaging-independent — a re-exported .skill zip whose archive bytes differ but whose
-- files are identical produces the SAME content_sha256 — so a byte-identical upload is caught
-- even when artifact_sha256 (the whole-bundle hash) differs. Backfilled from S3 by a one-off
-- worker job for pre-existing versions; null until then (treated as "no match").
alter table skill_versions add column if not exists content_sha256 text;

create index if not exists idx_skill_versions_content_sha256
  on skill_versions (content_sha256) where content_sha256 is not null;
