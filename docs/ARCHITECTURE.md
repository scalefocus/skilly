# skilly architecture (pointer)

The authoritative design lives in [`../SKILLY_SPEC.md`](../SKILLY_SPEC.md). Working
implementation context is in [`../CLAUDE.md`](../CLAUDE.md). This file is a stub for
deeper architecture/runbook docs added during the build (operator guide, SCIM setup,
backup/restore, scanner configuration).

## Guides
- [`skill-flow.md`](skill-flow.md) — end-to-end technical walkthrough of a hosted skill:
  upload → review/approve → git synthesis → `npx skills add` clone (with file/line refs).

## Key entry points
- `packages/shared/src/external-tool.ts` — **implementation task #1**: pin the external
  `npx skills add` fetch contract here before building URL/proxy behavior.
- `packages/shared/src/rbac.ts` — role resolution + capability checks + visibility.
- `packages/shared/src/semver.ts` — version validation, channel, `latest` resolution.
- `packages/worker/src/scim/router.ts` — SCIM 2.0 endpoints (Entra provisioning target).
- `packages/worker/src/scan/pipeline.ts` — pluggable scan pipeline.
- `db/migrations/0001_init.sql` — schema; `0002_app_role_grants.sql` — least-privilege role.
