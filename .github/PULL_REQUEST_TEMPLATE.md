<!-- Thanks for contributing to skilly! Fill this in so review goes fast. See CONTRIBUTING.md. -->

## What & why
<!-- What does this change, and what problem does it solve? Link related issues, e.g. Closes #123 -->

## Type of change
- [ ] Bug fix
- [ ] Feature / new behavior
- [ ] Docs / infra only (no app behavior change)
- [ ] Breaking change (install contract, API shape, required config)

## Checklist
<!-- Doc/infra-only PRs skip the spec, version, and changelog items. -->
- [ ] **Spec** — `SKILLY_SPEC.md` updated to describe the new behavior first (spec-first), if behavior/data/contracts changed.
- [ ] **Version** — `APP_VERSION` bumped in `packages/shared/src/version.ts` (patch / minor / major per CONTRIBUTING.md).
- [ ] **Changelog** — matching `{ version, date, summary }` prepended to `packages/web/src/app/whats-new/changelog.ts`.
- [ ] **Tests** — new domain/RBAC/semver/validation logic has unit tests; API/DB/SCIM changes have integration tests; user-facing flows have e2e coverage.
- [ ] **Green checks** — `pnpm --filter @skilly/shared build`, then `pnpm -r typecheck` and `pnpm -r test` pass locally.
- [ ] **Invariants respected** — immutable versions, append-only audit, strict visibility filtering, SCIM-resolved roles, the pinned `npx skills add` contract (see CLAUDE.md).
- [ ] **Commit subject** — `type(scope): summary (vX.Y.Z)` (omit the version suffix on doc/infra-only changes).
- [ ] No secrets in the diff, and no security-vulnerability disclosure (report those privately per SECURITY.md).
