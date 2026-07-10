-- Pointer skills are MIRRORED into skilly's storage (locked decision, SKILLY_SPEC.md §6,
-- §7), so a mirrored version has BOTH stored bytes (artifact_object_key) AND external
-- provenance (external_ref/external_origin_url). The original XOR constraint forbade that.
-- Drop it; the publish sweep already requires artifact_object_key to synthesize.
BEGIN;

ALTER TABLE skill_versions DROP CONSTRAINT IF EXISTS hosted_or_pointer_payload;

COMMIT;
