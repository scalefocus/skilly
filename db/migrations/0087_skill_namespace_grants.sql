-- Sharing a restricted skill with other namespaces (SKILLY_SPEC.md §42).
--
--   skill_namespace_grants  one row per (skill, grantee namespace). A `namespace`-visibility skill
--                           is visible to its OWNING namespace (skills.namespace_id) plus every
--                           namespace listed here — the §3/§42 "owner ∪ grants" audience. Rows are
--                           meaningful only while skills.visibility = 'namespace'; the app deletes
--                           them when a skill becomes org-visible (§42.4). Grants confer visibility,
--                           never roles (invariant #1): a grantee namespace's admins do not review,
--                           publish, yank or archive the skill.
--
-- The owning namespace and `global` are never valid grantees (§42.1). Both are rejected by every
-- app write path and, as defence in depth, by the trigger below.
--
-- No backfill: the table starts empty — every existing restricted skill keeps exactly today's
-- audience. Grants come from the 0002 default privileges (SELECT, INSERT, UPDATE, DELETE): these
-- are ordinary mutable governance rows, not audit rows.
BEGIN;

CREATE TABLE IF NOT EXISTS skill_namespace_grants (
  skill_id     UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  namespace_id UUID NOT NULL REFERENCES namespaces(id) ON DELETE CASCADE,
  granted_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, namespace_id)
);

-- The visibility predicate's EXISTS probes by (skill_id, namespace_id) — covered by the PK; the
-- namespace marketplace synthesizer and the namespace catalog view look grants up by namespace.
CREATE INDEX IF NOT EXISTS idx_skill_namespace_grants_namespace ON skill_namespace_grants (namespace_id);

CREATE OR REPLACE FUNCTION skill_namespace_grants_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM skills s WHERE s.id = NEW.skill_id AND s.namespace_id = NEW.namespace_id) THEN
    RAISE EXCEPTION 'skill_namespace_grants: the owning namespace is never a grantee'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM namespaces n WHERE n.id = NEW.namespace_id AND n.slug = 'global') THEN
    RAISE EXCEPTION 'skill_namespace_grants: global is never a grantee'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_skill_namespace_grants_guard ON skill_namespace_grants;
CREATE TRIGGER trg_skill_namespace_grants_guard
  BEFORE INSERT OR UPDATE ON skill_namespace_grants
  FOR EACH ROW EXECUTE FUNCTION skill_namespace_grants_guard();

COMMIT;
