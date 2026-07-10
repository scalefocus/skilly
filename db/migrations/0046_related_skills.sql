-- 0046: "Skills you might like" — precomputed per-skill co-install neighbours (SKILLY_SPEC.md §10).
-- A nightly worker sweep recomputes this from skill_installs (0043): two skills are related when the
-- same users adopted both; shared_count = number of shared adopters. We keep a wider candidate list
-- per skill (top ~12) so the read path can visibility-filter per viewer (invariant #3) and still fill
-- the top 3 the viewer can see. Purely derived/advisory — rebuilt wholesale each run. App-role grants
-- inherit from the 0002 default privileges.
CREATE TABLE IF NOT EXISTS related_skills (
  skill_id         UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  related_skill_id UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  shared_count     INT  NOT NULL,
  PRIMARY KEY (skill_id, related_skill_id)
);
CREATE INDEX IF NOT EXISTS idx_related_skills_lookup ON related_skills (skill_id, shared_count DESC);
