-- 0077: the full-text search engine (SKILLY_SPEC.md §34).
--
-- Registry search moves from one substring ILIKE to PostgreSQL's built-in full-text search. This
-- migration reshapes the index the engine queries; it adds NO extension (pg_trgm, used by the typo
-- tier, has been installed since 0027) and needs no dictionary files on the server.
--   * skills.search_tsv is rebuilt: A title + slug, B description, C category names, D usage + the
--     SKILL.md body — both of the INDEXED version (latest stable, else highest active prerelease).
--   * The text-search configuration comes from platform_settings.search_language (absent ⇒ english),
--     read by skilly_search_config(), so indexing and querying always agree on the language.
--   * SKILL.md text lives in a side table (skill_version_search), never on skill_versions, so the
--     immutable version row and its guard (skill_versions_guard) are untouched. The worker fills it.
--   * Platform-admin synonym groups (search_synonym_groups) with their normalized forms.
-- Re-runnable: every object is created with IF NOT EXISTS / CREATE OR REPLACE / DROP … IF EXISTS.
BEGIN;

-- ── The active text-search configuration (§34.9) ───────────────────────────────────────────────
-- Only PostgreSQL's built-in (pg_catalog) configurations are accepted; anything else — or no row —
-- falls back to english, so a bad stored value can never break indexing or a search.
CREATE OR REPLACE FUNCTION skilly_search_config() RETURNS regconfig
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    (SELECT c.oid::regconfig
       FROM platform_settings ps
       JOIN pg_catalog.pg_ts_config c ON c.cfgname = ps.value #>> '{}'
       JOIN pg_catalog.pg_namespace ns ON ns.oid = c.cfgnamespace AND ns.nspname = 'pg_catalog'
      WHERE ps.key = 'search_language'),
    'pg_catalog.english'::regconfig)
$$;

-- A term's normalized form under the active language: its lexemes in position order ("Slides" and
-- "slide" both → 'slide' in English). Synonym matching compares these (§34.8) — stemming happens in
-- PostgreSQL only, never in application code.
CREATE OR REPLACE FUNCTION skilly_search_normalize(t text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_agg(u.lexeme, ' ' ORDER BY p.pos, u.lexeme), '')
    FROM unnest(to_tsvector(skilly_search_config(), coalesce(t, ''))) AS u(lexeme, positions, weights)
    CROSS JOIN LATERAL unnest(u.positions) AS p(pos)
$$;

-- Semver precedence as a byte-comparable key, ordering exactly as @skilly/shared compareSemver:
-- numeric core; a prerelease below its release; prerelease identifiers compared left to right,
-- numeric ones numerically and below alphanumeric ones, a shorter identifier list first. Numbers are
-- length-prefixed so they compare numerically as bytes; build metadata is ignored. NULL if invalid.
CREATE OR REPLACE FUNCTION skilly_semver_key(v text) RETURNS bytea
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  m text[];
  k text;
  ident text;
BEGIN
  m := regexp_match(v, '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$');
  IF m IS NULL THEN
    RETURN NULL;
  END IF;
  k := lpad(length(m[1])::text, 3, '0') || m[1] || '.'
    || lpad(length(m[2])::text, 3, '0') || m[2] || '.'
    || lpad(length(m[3])::text, 3, '0') || m[3];
  IF m[4] IS NULL THEN
    RETURN convert_to(k || '~', 'UTF8'); -- '~' sorts after the '!' every prerelease carries
  END IF;
  k := k || '!';
  FOREACH ident IN ARRAY string_to_array(m[4], '.') LOOP
    IF ident ~ '^[0-9]+$' THEN
      k := k || '0' || lpad(length(ident)::text, 3, '0') || ident || chr(1);
    ELSE
      k := k || '1' || ident || chr(1);
    END IF;
  END LOOP;
  RETURN convert_to(k, 'UTF8');
END $$;

-- ── Per-version extracted SKILL.md text (§3 skill_version_search) ──────────────────────────────
CREATE TABLE IF NOT EXISTS skill_version_search (
  skill_version_id uuid PRIMARY KEY REFERENCES skill_versions(id) ON DELETE CASCADE,
  body_text        text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'indexed', 'absent', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_skill_version_search_open ON skill_version_search (status) WHERE status IN ('pending', 'failed');

-- body_text is write-once: a version's bytes never change (invariant #2), so neither does its text.
CREATE OR REPLACE FUNCTION skill_version_search_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.body_text IS NOT NULL AND NEW.body_text IS DISTINCT FROM OLD.body_text THEN
    RAISE EXCEPTION 'skill_version_search.body_text is write-once';
  END IF;
  -- Stamp every change (the sweep's retry back-off reads it) unless the writer set it explicitly.
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_skill_version_search_guard ON skill_version_search;
CREATE TRIGGER trg_skill_version_search_guard BEFORE UPDATE ON skill_version_search
  FOR EACH ROW EXECUTE FUNCTION skill_version_search_guard();

-- ── skills: the indexed body + the language each vector was built with ─────────────────────────
ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS content_search text,
  ADD COLUMN IF NOT EXISTS search_lang    text;

-- ── Synonym groups (§34.8) ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS search_synonym_groups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  terms           text[] NOT NULL CHECK (cardinality(terms) BETWEEN 2 AND 10),
  normalized      text[] NOT NULL DEFAULT '{}',
  normalized_lang text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_search_synonym_groups_normalized ON search_synonym_groups USING gin (normalized);

CREATE OR REPLACE FUNCTION search_synonym_groups_normalize() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.normalized := ARRAY(SELECT skilly_search_normalize(u.t) FROM unnest(NEW.terms) WITH ORDINALITY AS u(t, ord) ORDER BY u.ord);
  NEW.normalized_lang := skilly_search_config()::text;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_search_synonym_groups_normalize ON search_synonym_groups;
CREATE TRIGGER trg_search_synonym_groups_normalize BEFORE INSERT OR UPDATE ON search_synonym_groups
  FOR EACH ROW EXECUTE FUNCTION search_synonym_groups_normalize();

-- ── The indexed version and the denormalized usage/body (§34.3) ────────────────────────────────
-- The version `latest` resolves to (highest active stable semver); with no active stable version,
-- the highest active prerelease; none when the skill has no active version.
CREATE OR REPLACE FUNCTION skilly_indexed_version(p_skill uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT sv.id
    FROM skill_versions sv
   WHERE sv.skill_id = p_skill AND sv.status = 'active'
   ORDER BY sv.is_prerelease ASC, skilly_semver_key(sv.semver) DESC NULLS LAST, sv.created_at DESC
   LIMIT 1
$$;

-- Point skills.usage_search / content_search at the indexed version's usage and body. Writing
-- either column re-fires trg_skills_tsv; the IS DISTINCT FROM guard skips no-op rewrites.
CREATE OR REPLACE FUNCTION skilly_refresh_skill_search(p_skill uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_id    uuid := skilly_indexed_version(p_skill);
  v_usage text;
  v_body  text;
BEGIN
  IF v_id IS NOT NULL THEN
    SELECT sv.usage_examples, svs.body_text INTO v_usage, v_body
      FROM skill_versions sv
      LEFT JOIN skill_version_search svs ON svs.skill_version_id = sv.id
     WHERE sv.id = v_id;
  END IF;
  UPDATE skills SET usage_search = v_usage, content_search = v_body
   WHERE id = p_skill
     AND (usage_search IS DISTINCT FROM v_usage OR content_search IS DISTINCT FROM v_body);
END $$;

-- ── The vector (§34.3). Replaces the 0068 definition. ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION skills_tsv_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cfg regconfig := skilly_search_config();
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector(cfg, coalesce(NEW.title, '') || ' ' || coalesce(NEW.slug, '')), 'A') ||
    setweight(to_tsvector(cfg, coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector(cfg, coalesce((SELECT string_agg(c.name, ' ' ORDER BY c.name)
                                           FROM skill_categories sc
                                           JOIN categories c ON c.id = sc.category_id
                                          WHERE sc.skill_id = NEW.id), '')), 'C') ||
    setweight(to_tsvector(cfg, coalesce(NEW.usage_search, '') || ' ' || coalesce(NEW.content_search, '')), 'D');
  NEW.search_lang := cfg::text;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_skills_tsv ON skills;
CREATE TRIGGER trg_skills_tsv
  BEFORE INSERT OR UPDATE OF title, slug, description, usage_search, content_search, search_lang ON skills
  FOR EACH ROW EXECUTE FUNCTION skills_tsv_update();

-- Category names are weight C, so assigning or removing a category refreshes the skill's vector.
-- (Touching search_lang is the cheap way to re-fire trg_skills_tsv; the trigger sets it back.)
CREATE OR REPLACE FUNCTION skill_categories_tsv_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE skills SET search_lang = NULL WHERE id = NEW.skill_id;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    UPDATE skills SET search_lang = NULL WHERE id = OLD.skill_id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_skill_categories_tsv ON skill_categories;
CREATE TRIGGER trg_skill_categories_tsv AFTER INSERT OR UPDATE OR DELETE ON skill_categories
  FOR EACH ROW EXECUTE FUNCTION skill_categories_tsv_touch();

-- Version inserts and status changes (yank AND restore) move the indexed version. Replaces the
-- 0020 rule, which took the newest-created active version and drifted from `latest`.
CREATE OR REPLACE FUNCTION skills_usage_search_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM skilly_refresh_skill_search(NEW.skill_id);
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_skill_versions_usage_search ON skill_versions;
CREATE TRIGGER trg_skill_versions_usage_search
  AFTER INSERT OR UPDATE OF usage_examples, status ON skill_versions
  FOR EACH ROW EXECUTE FUNCTION skills_usage_search_sync();

-- Every new version — and a restored one that has none — gets a `pending` extraction row, whatever
-- path created it; the worker fills it (§34.10).
CREATE OR REPLACE FUNCTION skill_versions_search_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'active' THEN
    INSERT INTO skill_version_search (skill_version_id) VALUES (NEW.id)
    ON CONFLICT (skill_version_id) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_skill_versions_search_row ON skill_versions;
CREATE TRIGGER trg_skill_versions_search_row AFTER INSERT OR UPDATE OF status ON skill_versions
  FOR EACH ROW EXECUTE FUNCTION skill_versions_search_row();

-- A body landing in skill_version_search flows into skills.content_search when it belongs to the
-- skill's indexed version.
CREATE OR REPLACE FUNCTION skill_version_search_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM skilly_refresh_skill_search((SELECT skill_id FROM skill_versions WHERE id = NEW.skill_version_id));
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS trg_skill_version_search_sync ON skill_version_search;
CREATE TRIGGER trg_skill_version_search_sync AFTER UPDATE OF body_text ON skill_version_search
  FOR EACH ROW EXECUTE FUNCTION skill_version_search_sync();

-- ── Backfill ───────────────────────────────────────────────────────────────────────────────────
-- A pending extraction row for every active version (the worker's sweep drains them after deploy).
INSERT INTO skill_version_search (skill_version_id)
  SELECT id FROM skill_versions WHERE status = 'active'
  ON CONFLICT (skill_version_id) DO NOTHING;

-- Re-point usage_search at the indexed version (the §34.3 fix), then rebuild every vector so the
-- slug (A) and category names (C) are indexed right away. Bodies arrive as the sweep extracts them.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT id FROM skills LOOP
    PERFORM skilly_refresh_skill_search(r.id);
  END LOOP;
END $$;
UPDATE skills SET search_lang = NULL;

-- Table grants for skilly_app come from the 0002 default privileges; both new tables have UUID
-- keys, so there is no sequence to grant (cf. 0075). Functions are EXECUTE-able by PUBLIC.

COMMIT;
