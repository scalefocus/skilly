-- Per-version "What changed" note (SKILLY_SPEC.md §8, §10).
-- A short, proposer-authored PLAIN-TEXT summary of what a version changes — surfaced on the skill
-- detail page (per version) and to reviewers. Distinct from usage_examples (how to USE the skill);
-- this is WHAT MOVED between versions. Required on new versions (proposal + direct publish),
-- omitted (NULL) on a skill's first version and on global promotion. Immutable with the version.
alter table skill_versions add column if not exists what_changed text;

-- The pointer-mirror work queue carries per-version metadata forward to the worker, which inserts
-- the immutable version after cloning. Carry the note the same way usage_examples is carried, so a
-- pointer new-version's note lands on the materialized version row.
alter table pending_mirrors add column if not exists what_changed text;
