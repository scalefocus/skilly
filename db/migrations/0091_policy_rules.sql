-- Policy rules — policy-as-prompt (SKILLY_SPEC.md §47), judged inside the §46 pre-review run.
--
--   policy_rules                  a plain-language governance rule: platform-wide (namespace_id
--                                 NULL) or one namespace's. State shadow | enforced | disabled. The
--                                 CURRENT revision is the row's highest revision_no.
--   policy_rule_revisions         the immutable title / rule / context snapshot written on every
--                                 text edit — the exact wording a result cites. Append-only.
--   ai_prereviews.rules_fingerprint  the sha256 of the sorted rule_id:revision_id pairs a run judged
--                                 (null: no rule applied). Joins the §46.4 cache key, so a cached
--                                 run is reused only where exactly the same rule revisions apply.
--   ai_prereviews.trigger         gains 'policy' (a re-check queued by a rule change, §47.6).
--   ai_prereview_policy_results   one row per rule a run judged: outcome, explanation and
--                                 server-verified evidence. The ONLY AI-derived data the accept
--                                 gate reads (§47.13). RESTRICT FKs keep a cited rule undeletable.
--   policy_flag_dismissals        an admin's dismissal of one (version, rule revision) violation —
--                                 or the one an accept-with-override writes. Keyed by skill + semver
--                                 so an accept can record it before a pointer version is mirrored.
--                                 Append-only.
--   proposals.routed_reason       gains 'policy' (a direct publish routed to review, §47.7).
--   users.policy_notifications    the Profile opt-out for skill.policy_flag (§47.10).
--
-- No backfill: nothing is judged until an admin writes a rule.
BEGIN;

CREATE TABLE IF NOT EXISTS policy_rules (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope             TEXT NOT NULL CHECK (scope IN ('platform', 'namespace')),
  namespace_id      UUID REFERENCES namespaces(id) ON DELETE CASCADE,
  state             TEXT NOT NULL DEFAULT 'shadow' CHECK (state IN ('shadow', 'enforced', 'disabled')),
  created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  state_changed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT policy_rules_scope_shape CHECK ((scope = 'platform') = (namespace_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_policy_rules_ns_state ON policy_rules (namespace_id, state);

CREATE TABLE IF NOT EXISTS policy_rule_revisions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id      UUID NOT NULL REFERENCES policy_rules(id) ON DELETE CASCADE,
  revision_no  INTEGER NOT NULL CHECK (revision_no >= 1),
  title        TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  body         TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  context      TEXT CHECK (context IS NULL OR char_length(context) <= 4000),
  author       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rule_id, revision_no)
);

ALTER TABLE ai_prereviews ADD COLUMN IF NOT EXISTS rules_fingerprint TEXT;
ALTER TABLE ai_prereviews DROP CONSTRAINT IF EXISTS ai_prereviews_trigger_check;
ALTER TABLE ai_prereviews
  ADD CONSTRAINT ai_prereviews_trigger_check
  CHECK (trigger IN ('submit', 'revision', 'enable', 'direct_publish', 'mirror', 'rerun', 'policy'));
DROP INDEX IF EXISTS idx_ai_prereviews_cache;
CREATE INDEX IF NOT EXISTS idx_ai_prereviews_cache ON ai_prereviews (content_sha256, prompt_version, rules_fingerprint, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_prereview_policy_results (
  run_id             UUID NOT NULL REFERENCES ai_prereviews(id) ON DELETE CASCADE,
  rule_id            UUID NOT NULL REFERENCES policy_rules(id) ON DELETE RESTRICT,
  revision_id        UUID NOT NULL REFERENCES policy_rule_revisions(id) ON DELETE RESTRICT,
  rule_state         TEXT NOT NULL CHECK (rule_state IN ('shadow', 'enforced')),
  outcome            TEXT NOT NULL CHECK (outcome IN ('complies', 'not_applicable', 'uncertain', 'violates')),
  explanation        TEXT NOT NULL DEFAULT '' CHECK (char_length(explanation) <= 700),
  evidence           JSONB NOT NULL DEFAULT '[]',
  evidence_rejected  BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (run_id, rule_id)
);
CREATE INDEX IF NOT EXISTS idx_ai_prereview_policy_results_rule ON ai_prereview_policy_results (rule_id, outcome);

CREATE TABLE IF NOT EXISTS policy_flag_dismissals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id      UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  semver        TEXT NOT NULL,
  rule_id       UUID NOT NULL REFERENCES policy_rules(id) ON DELETE RESTRICT,
  revision_id   UUID NOT NULL REFERENCES policy_rule_revisions(id) ON DELETE RESTRICT,
  kind          TEXT NOT NULL CHECK (kind IN ('false_positive', 'accepted_exception')),
  reason        TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  source        TEXT NOT NULL CHECK (source IN ('override', 'manual')),
  dismissed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  dismissed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_policy_flag_dismissals_version ON policy_flag_dismissals (skill_id, semver);

ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_routed_reason_check;
ALTER TABLE proposals
  ADD CONSTRAINT proposals_routed_reason_check CHECK (routed_reason IS NULL OR routed_reason IN ('content_risk', 'policy'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS policy_notifications BOOLEAN NOT NULL DEFAULT true;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'skilly_app') THEN
    REVOKE UPDATE, DELETE ON policy_rule_revisions FROM skilly_app;
    REVOKE UPDATE, DELETE ON policy_flag_dismissals FROM skilly_app;
  END IF;
END
$$;

COMMIT;
