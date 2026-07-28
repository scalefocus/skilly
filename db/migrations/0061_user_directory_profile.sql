-- Directory profile for the hover card (SKILLY_SPEC.md §5, §28).
-- job_title / office_location / department mirror the Entra jobTitle / officeLocation /
-- department attributes. Two writers keep them current — Graph reconciliation (worker,
-- app-only) and the user's own sign-in (web, delegated User.Read) — and BOTH overwrite
-- unconditionally, unlike `avatar` (which is only ever filled when missing): a promotion or
-- an office move must propagate. SCIM carries none of them and never touches these columns.
-- Display-only: nothing in RBAC, visibility or governance reads them (invariant #1).
ALTER TABLE users
  ADD COLUMN job_title        TEXT,
  ADD COLUMN office_location  TEXT,
  ADD COLUMN department       TEXT,
  -- Self-service opt-out (profile page → /api/me): hide job title / office / department from
  -- other people's hover cards. Name, email and presence stay visible. Reset by GDPR erasure.
  ADD COLUMN directory_hidden BOOLEAN NOT NULL DEFAULT false;
