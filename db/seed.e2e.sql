-- E2E-ONLY seed: one user per Playwright worker for the Jenkins e2e run (SKILLY_SPEC.md §16 item 18).
-- Applied by ci/e2e-run.sh AFTER db/seed.dev.sql — never by deploy/ or local dev, so these users
-- never show up in a developer's directory, leaderboard or active-user counts. NOT for production.
-- Idempotent.
--
-- Under E2E_WORKER_USERS=1 the e2e fixture (packages/web/e2e/fixtures.ts devSignIn) signs worker N
-- in as e2e-worker-NN-oid through the dev credentials provider, which accepts exactly these ids
-- (packages/web/src/lib/devAuth.ts). Each gets the dev admin's group memberships, so it resolves to
-- Platform Admin + team-a Namespace Admin through role_mappings exactly as the dev admin does
-- (invariant #1: roles come from group membership, never from token claims). Onboarded at seed time
-- so the first-login gate never redirects a spec to /quick-start.
BEGIN;

INSERT INTO users (entra_object_id, email, display_name, onboarded_at)
  SELECT format('e2e-worker-%s-oid', lpad(n::text, 2, '0')),
         format('e2e-worker-%s@skilly.local', lpad(n::text, 2, '0')),
         format('E2E Worker %s', lpad(n::text, 2, '0')),
         now()
    FROM generate_series(1, 16) AS n
ON CONFLICT (entra_object_id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      email = EXCLUDED.email,
      onboarded_at = coalesce(users.onboarded_at, EXCLUDED.onboarded_at);

INSERT INTO group_memberships (group_id, user_id)
  SELECT g.id, u.id FROM groups g, users u
   WHERE g.entra_object_id IN ('g-platform', 'g-team-a')
     AND u.entra_object_id ~ '^e2e-worker-(0[1-9]|1[0-6])-oid$'
ON CONFLICT DO NOTHING;

-- The dev admin's seeded installs (db/seed.dev.sql §23 block), mirrored for every worker user, so
-- the Installed Skills specs (installed-freshness, installed-search) find the same three rows in the
-- same three freshness states whichever worker runs them: pdf-tools pinned 1.1.0 → current,
-- lint-fixer tracking latest but last served 2.2.0 → behind, secret-helper pinned 0.9.0 and expired
-- → inactive. The hashed_token is a per-user placeholder (these URLs are never cloned).
INSERT INTO tokens (user_id, type, hashed_token, skill_id, pinned_semver, scope, expires_at, used_at,
                    client_user_agent, last_served_semver, last_cloned_at)
  SELECT u.id, 'install', 'e2ehash-'||u.entra_object_id||'-'||n.slug||'-'||s.slug, s.id, v.pinned,
         jsonb_build_object('skillId', s.id, 'semver', v.pinned),
         v.expires, now() - (v.age_days || ' days')::interval, 'git/2.43.0',
         v.served, now() - (v.age_days || ' days')::interval
    FROM users u,
         skills s JOIN namespaces n ON n.id = s.namespace_id
    JOIN (VALUES ('pdf-tools',     '1.1.0', NULL::timestamptz,         3,  '1.1.0'),
                 ('lint-fixer',    NULL,    NULL::timestamptz,         10, '2.2.0'),
                 ('secret-helper', '0.9.0', now() - interval '1 day', 20, '0.9.0')) AS v(slug, pinned, expires, age_days, served)
      ON v.slug = s.slug
   WHERE u.entra_object_id ~ '^e2e-worker-(0[1-9]|1[0-6])-oid$'
     AND NOT EXISTS (
       SELECT 1 FROM tokens t
        WHERE t.user_id = u.id AND t.skill_id = s.id AND t.type = 'install'
     );

COMMIT;
