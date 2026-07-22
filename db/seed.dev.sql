-- DEV-ONLY seed data for local visual/auth passes. NOT for production.
-- Apply after migrations 0001/0003/0004. Idempotent.
-- The dev user 'dev-admin-oid' matches SKILLY_DEV_OID and is made a platform admin.
BEGIN;

INSERT INTO users (entra_object_id, email, display_name) VALUES
  ('dev-admin-oid', 'dev@skilly.local', 'Dev Admin'),
  ('alice-oid', 'alice@org', 'Alice Chen'),
  ('bob-oid', 'bob@org', 'Bob Ng')
ON CONFLICT (entra_object_id) DO UPDATE SET display_name = EXCLUDED.display_name;

INSERT INTO groups (entra_object_id, display_name) VALUES
  ('g-platform', 'Platform Admins'),
  ('g-team-a', 'Team A Admins'),
  ('g-team-a-members', 'Team A Members')
ON CONFLICT (entra_object_id) DO UPDATE SET display_name = EXCLUDED.display_name;

INSERT INTO group_memberships (group_id, user_id)
  SELECT g.id, u.id FROM groups g, users u
   WHERE g.entra_object_id IN ('g-platform', 'g-team-a') AND u.entra_object_id = 'dev-admin-oid'
ON CONFLICT DO NOTHING;
INSERT INTO group_memberships (group_id, user_id)
  SELECT g.id, u.id FROM groups g, users u
   WHERE g.entra_object_id = 'g-team-a-members' AND u.entra_object_id IN ('alice-oid','bob-oid')
ON CONFLICT DO NOTHING;

INSERT INTO namespaces (slug, display_name, require_review) VALUES ('team-a', 'Team A', true)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO role_mappings (group_id, namespace_id, role)
  SELECT g.id, NULL, 'platform_admin' FROM groups g WHERE g.entra_object_id = 'g-platform'
ON CONFLICT DO NOTHING;
INSERT INTO role_mappings (group_id, namespace_id, role)
  SELECT g.id, n.id, 'namespace_admin' FROM groups g, namespaces n
   WHERE g.entra_object_id = 'g-team-a' AND n.slug = 'team-a'
ON CONFLICT DO NOTHING;
INSERT INTO role_mappings (group_id, namespace_id, role)
  SELECT g.id, n.id, 'namespace_member' FROM groups g, namespaces n
   WHERE g.entra_object_id = 'g-team-a-members' AND n.slug = 'team-a'
ON CONFLICT DO NOTHING;

INSERT INTO categories (name, description) VALUES
  ('documents', 'Document tooling'), ('devtools', 'Developer tooling'), ('data', 'Data & scraping')
ON CONFLICT (name) DO NOTHING;

-- Skills
INSERT INTO skills (namespace_id, slug, title, description, category_id, tool_harness, tags, type, visibility, install_count)
  SELECT n.id, 'pdf-tools', 'PDF Tools', 'Read, merge, split and watermark PDF files directly from your agent.',
         (SELECT id FROM categories WHERE name='documents'), 'claude-code', ARRAY['pdf','documents','merge'], 'hosted', 'org', 142
    FROM namespaces n WHERE n.slug='global'
ON CONFLICT (namespace_id, slug) DO NOTHING;
INSERT INTO skills (namespace_id, slug, title, description, category_id, tool_harness, tags, type, visibility, install_count)
  SELECT n.id, 'lint-fixer', 'Lint Fixer', 'Auto-applies your org ESLint + Prettier config and explains each fix.',
         (SELECT id FROM categories WHERE name='devtools'), 'claude-code', ARRAY['lint','formatting'], 'hosted', 'org', 88
    FROM namespaces n WHERE n.slug='global'
ON CONFLICT (namespace_id, slug) DO NOTHING;
INSERT INTO skills (namespace_id, slug, title, description, category_id, tool_harness, tags, type, visibility, install_count)
  SELECT n.id, 'web-scraper', 'Web Scraper', 'Mirrored from an upstream repo — polite, rate-limited scraping helpers.',
         (SELECT id FROM categories WHERE name='data'), 'cursor', ARRAY['scraping','http'], 'pointer', 'org', 57
    FROM namespaces n WHERE n.slug='global'
ON CONFLICT (namespace_id, slug) DO NOTHING;
INSERT INTO skills (namespace_id, slug, title, description, category_id, tool_harness, tags, type, visibility, install_count)
  SELECT n.id, 'secret-helper', 'Secret Helper', 'Team-only: resolves secrets from the internal vault for local runs.',
         (SELECT id FROM categories WHERE name='devtools'), 'claude-code', ARRAY['secrets','internal'], 'hosted', 'namespace', 11
    FROM namespaces n WHERE n.slug='team-a'
ON CONFLICT (namespace_id, slug) DO NOTHING;

-- Categories as tags (many-to-many) — pdf-tools intentionally has two.
INSERT INTO skill_categories (skill_id, category_id)
  SELECT s.id, c.id
    FROM skills s JOIN namespaces n ON n.id = s.namespace_id, categories c
   WHERE (n.slug, s.slug, c.name) IN (
     ('global','pdf-tools','documents'),
     ('global','pdf-tools','data'),
     ('global','lint-fixer','devtools'),
     ('global','web-scraper','data'),
     ('team-a','secret-helper','devtools')
   )
ON CONFLICT DO NOTHING;

-- Versions. NOTE: git_published=false — these rows reference artifact keys that have NO bytes
-- in object storage yet, so they are NOT actually serveable. Run the dev seed-bundle uploader
-- (packages/worker/scripts/seed-bundles.mjs) after seeding: it uploads a minimal valid SKILL.md
-- bundle for each key, and the worker's publish sweep then synthesizes the git repo/tags. Marking
-- them published here (the old behavior) left them stuck as "repository not provisioned".
INSERT INTO skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, git_published, created_by)
  SELECT s.id, v.semver, v.pre, 'active', 'k-'||s.slug||'-'||v.semver, 'sha-'||v.semver, false,
         (SELECT id FROM users WHERE entra_object_id='dev-admin-oid')
    FROM skills s JOIN namespaces n ON n.id=s.namespace_id
    JOIN (VALUES ('pdf-tools','1.0.0',false),('pdf-tools','1.1.0',false),('pdf-tools','1.2.0-beta.1',true),
                 ('lint-fixer','2.3.0',false),('secret-helper','0.9.0',false)) AS v(slug,semver,pre)
      ON v.slug = s.slug
   WHERE s.type='hosted'
ON CONFLICT (skill_id, semver) DO NOTHING;

-- Pointer version (mirrored: has artifact + external provenance)
INSERT INTO skill_versions (skill_id, semver, is_prerelease, status, artifact_object_key, artifact_sha256, external_ref, external_origin_url, git_published, created_by)
  SELECT s.id, '1.2.0', false, 'active', 'pointers/'||s.id||'/v1.2.0.tgz', 'sha-ptr', 'v1.2.0', 'https://github.com/acme/web-scraper.git', true,
         (SELECT id FROM users WHERE entra_object_id='dev-admin-oid')
    FROM skills s JOIN namespaces n ON n.id=s.namespace_id WHERE n.slug='global' AND s.slug='web-scraper'
ON CONFLICT (skill_id, semver) DO NOTHING;

-- A proposal under review with a high scan finding (shows the override flow)
DO $$
DECLARE pid uuid; uid uuid; nid uuid;
BEGIN
  SELECT id INTO uid FROM users WHERE entra_object_id='alice-oid';
  SELECT id INTO nid FROM namespaces WHERE slug='team-a';
  IF NOT EXISTS (SELECT 1 FROM proposals WHERE target_namespace_id=nid AND proposed_semver='1.0.0' AND state='under_review') THEN
    INSERT INTO proposals (target_namespace_id, target_skill_id, proposed_semver, state, submitted_by)
      VALUES (nid, NULL, '1.0.0', 'under_review', uid) RETURNING id INTO pid;
    INSERT INTO proposal_revisions (proposal_id, revision_no, payload, author, note)
      VALUES (pid, 1,
        '{"metadata":{"skillSlug":"deploy-bot","title":"Deploy Bot","description":"Automates staging deploys with one-command rollback.","toolHarness":"claude-code","visibility":"namespace"},"artifactObjectKey":"uploads/dev/deploy-bot.tgz","artifactSha256":"abc123"}'::jsonb,
        uid, 'initial submission');
    INSERT INTO scan_reports (subject_type, subject_id, scanner, findings, severity, status)
      VALUES ('artifact', 'uploads/dev/deploy-bot.tgz', 'pipeline',
        '[{"scanner":"static-heuristics","severity":"high","rule":"pipe-to-shell","message":"remote script piped to a shell","path":"scripts/install.sh"},{"scanner":"secret-scan","severity":"medium","rule":"generic-secret","message":"hardcoded secret-like assignment","path":"config.env"}]'::jsonb,
        'high', 'scanned');
  END IF;
END $$;

-- Installed skills for the dev user (SKILLY_SPEC.md §23): a few USED install tokens so the
-- Installed Skills page — and its "Search installed skills" header filter — has rows to show in
-- local dev and e2e. `used_at` set = they list on /installed; the hashed_token is a dev placeholder
-- (these URLs are never actually cloned). Three distinct titles across two namespaces exercise the
-- title/namespace/skill-slug substring match; secret-helper is intentionally expired (inactive) to
-- prove the filter still matches inactive rows. Idempotent via a per-(user,skill) existence guard.
INSERT INTO tokens (user_id, type, hashed_token, skill_id, pinned_semver, scope, expires_at, used_at, client_user_agent)
  SELECT u.id, 'install', 'devhash-'||n.slug||'-'||s.slug, s.id, v.pinned,
         jsonb_build_object('skillId', s.id, 'semver', v.pinned),
         v.expires, now() - (v.age_days || ' days')::interval, 'git/2.43.0'
    FROM users u,
         skills s JOIN namespaces n ON n.id = s.namespace_id
    JOIN (VALUES ('pdf-tools',     '1.1.0', NULL::timestamptz,          3),
                 ('lint-fixer',    NULL,    NULL::timestamptz,         10),
                 ('secret-helper', '0.9.0', now() - interval '1 day',  20)) AS v(slug, pinned, expires, age_days)
      ON v.slug = s.slug
   WHERE u.entra_object_id = 'dev-admin-oid'
     AND NOT EXISTS (
       SELECT 1 FROM tokens t
        WHERE t.user_id = u.id AND t.skill_id = s.id AND t.type = 'install'
     );

COMMIT;
