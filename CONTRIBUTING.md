# Contributing to skilly

Thanks for your interest in improving skilly — an enterprise-grade, self-hosted registry for
governing Anthropic-style `SKILL.md` agent skills. Bug reports, fixes, features, and doc
improvements are all welcome.

## Ground rules

- **License.** skilly is Apache-2.0. By submitting a contribution you agree that it is
  licensed under the Apache License 2.0, the same as the rest of the project
  (inbound = outbound). No CLA is required.
- **Security issues are never GitHub issues.** Report vulnerabilities privately — see
  [SECURITY.md](./SECURITY.md).
- **The spec leads; the code follows.** [`SKILLY_SPEC.md`](./SKILLY_SPEC.md) is the
  authoritative spec. Any change to behavior, data, or contracts must update the spec in the
  **same PR** — describe the new behavior there first, then implement to match.
- **Know the invariants.** [`CLAUDE.md`](./CLAUDE.md) records the architecture, conventions,
  and the non-negotiable invariants (immutable versions, append-only audit log, strict
  visibility filtering, SCIM-resolved roles, the pinned `npx skills add` install contract).
  PRs that violate an invariant will not be merged, however clean the code.

## Getting started

Prerequisites, the dev loop (Postgres + MinIO in Docker, apps via pnpm with dev auth), and
the full-stack Docker option are documented in the [README](./README.md#running-locally).
The short version:

```bash
pnpm install
pnpm --filter @skilly/shared build   # shared types must build before web/worker can typecheck
pnpm -r typecheck                    # type-check every package
pnpm -r test                         # hermetic unit/integration tests (no Docker needed)
```

The live-DB integration suites are gated behind `SKILLY_DB_E2E` and need Docker — see
[README → Testing](./README.md#testing). CI runs them on every PR, so running them locally
is recommended when you touch DB paths, migrations, or the publish/mirror chain.

## Mandatory per-change checklist

Every PR that changes the app must include, in the same change:

1. **Spec update** — `SKILLY_SPEC.md` reflects the new behavior (spec-first, see above).
2. **Version bump** — `APP_VERSION` in `packages/shared/src/version.ts`:
   - **patch** — bug fixes, styling/layout, copy, refactors, small tweaks
   - **minor** — new features, new endpoints/pages, new behaviors, DB migrations
   - **major** — breaking changes (install contract, API shapes, required config)
   One bump per PR is enough when it batches several changes (highest applicable level).
3. **Changelog entry** — prepend `{ version, date, summary }` to `CHANGELOG` in
   `packages/web/src/app/whats-new/changelog.ts` (newest first; `date` is UTC `YYYY-MM-DD`;
   `summary` is one user-facing line describing what changed). This file — not `git log` —
   is the canonical record of shipped history; keep it complete.
4. **Green checks** — `pnpm --filter @skilly/shared build`, then `pnpm -r typecheck` and
   `pnpm -r test` pass locally.

Doc-only or infra-only changes that don't ship app behavior skip the version bump and
changelog entry.

## Conventions

- TypeScript everywhere, ESM. Package manager is **pnpm** (workspaces).
- **Timestamps:** store UTC (`timestamptz`), serialize UTC ISO strings, convert to the
  viewer's timezone in the browser via `components/DateFormat.tsx` → `useDateFmt()`. Never
  format a timestamp server-side for the UI.
- **DB:** parameterized SQL only. Migrations are plain SQL files in `db/migrations/`,
  numbered sequentially, forward-only — add a new file, never edit an applied one.
- **Secrets:** env / mounted only — never committed, never baked into images, never logged
  (no token query strings in logs, ever).
- Match the surrounding code's style, naming, and comment density.

## Commit and PR guidelines

- Subject format: `type(scope): summary (vX.Y.Z)` — e.g.
  `fix(catalog): close the sort dropdown on outside click (v1.112.1)`. The `(vX.Y.Z)` is the
  `APP_VERSION` the commit ships (omit for doc/infra-only changes).
- Keep PRs small and focused; one logical change per PR.
- CI must pass: typecheck, hermetic tests, the live-DB suite, the web production build, and
  Helm chart lint. None of these jobs need secrets, so they run on fork PRs too.

## What not to do

- Don't add a skilly CLI — consumption is pinned to the external `vercel-labs/skills` tool,
  and the wire format lives only in `packages/shared/src/external-tool.ts`.
- Don't resolve roles from OIDC token claims.
- Don't mutate published versions or audit rows.
- Don't let restricted skills leak via metadata, search, autocomplete, or counts.
- Don't introduce Kubernetes-only features, SAML, or OpenSearch in v1.
