# CLAUDE.md — skilly project context

> Read this first. It pins the project's intent, decisions, conventions, and the
> single most important constraint. The authoritative spec is **`SKILLY_SPEC.md`**;
> this file is the working context for day-to-day implementation. `§n` references
> throughout this file are the canonical deep-dive pointers into `SKILLY_SPEC.md`.

## What this is
**skilly** — an enterprise-grade, open-source, self-hosted registry for governing
Anthropic-style `SKILL.md` agent skills across an organization and its business units,
with identity/access anchored in Microsoft Entra ID. Greenfield, SKILL.md-compatible.
Apache 2.0.

## Key files (jump straight here)
| File | Role |
|---|---|
| `SKILLY_SPEC.md` | The authoritative spec — every change lands here **first** |
| `packages/shared/src/version.ts` | `APP_VERSION` — bumped on every app change |
| `packages/web/src/app/whats-new/changelog.ts` | The What's new `CHANGELOG` — one entry per version bump |
| `packages/shared/src/external-tool.ts` | The pinned install wire format — the ONLY place it may change |
| `packages/web/e2e/shots.mjs` | Playwright script that captures Quick-start / manual screenshots (manual built ad-hoc, outside the repo) |
| `db/migrations/` | Plain-SQL migrations, applied in order by the `migrate` compose service |
| `deploy/docker-compose.yml` | The full stack (postgres, migrate, minio, clamav, web, worker, proxy) |

## The change workflow (GATED — spec-first with a mandatory stop)
Every change to app behavior goes through this gate. **Never skip straight to code.**

1. **Grill first.** Before touching anything, interrogate the request
   rigorously: ask pointed clarifying questions — scope, edge cases, roles
   affected, visibility implications, data model impact, what happens on
   expiry/deletion/conflict — until the requirement is unambiguous. Depth is
   proportional to the change (a copy fix needs one confirming question; a new
   feature needs a real interview). Do not assume answers you could ask for.
2. **Update `SKILLY_SPEC.md` — and ONLY the spec.** Write the behavior, data, and
   contracts into the relevant sections. No code, no migrations, no manual edits yet.
3. **STOP for verification.** Present the spec diff (what changed, where, and the
   decisions it encodes) and end the turn. **The user must review and approve the
   spec before anything is built.** Do not proceed on silence; wait for explicit
   go-ahead. If the user amends the spec, loop back to step 1/2 as needed.
4. **Implement to match the approved spec.** Code follows spec, never the reverse.
   **New code ships with its tests in the same change:** unit tests for any new
   domain/RBAC/semver/validation logic, integration tests for anything touching the
   API, DB, or SCIM surface, and e2e coverage when the change alters a user-facing
   flow (propose→review→publish→install and the like). Untested new code is an
   incomplete implementation, not a follow-up.
5. **Release ritual.** Version bump → changelog → commit (see the "Before every
   commit" checklist below).

Exempt from the gate: pure internal work with zero behavior change (refactors, CI,
comments) and doc-only edits — but if in doubt, it's gated.

## Commands / dev workflow
Node ≥ 20, pnpm 9.15.x (pinned via `packageManager`). Workspace packages:
`@skilly/shared`, `@skilly/web`, `@skilly/worker`. Shell commands below are
**bash syntax** — on this Windows machine run them in Git Bash (or adapt for PowerShell).

```bash
pnpm install                                   # bootstrap the workspace
cp deploy/.env.example deploy/.env             # once; fill secrets (never commit)
docker compose -f deploy/docker-compose.yml up -d postgres minio clamav migrate
                                               # backends + migrations (migrate exits 0 when done)
pnpm dev                                       # all packages in parallel; web on http://localhost:3000
pnpm --filter @skilly/web dev                  # a single package
pnpm test | pnpm typecheck | pnpm build        # all packages (recursive)
pnpm --filter @skilly/shared test              # a single package's tests
docker compose -f deploy/docker-compose.yml up -d --build   # full containerized stack
```

**Pre-commit gate: `pnpm typecheck` must pass, plus the tests of every package you
touched.** (`lint` is currently a stub outside `web` — don't rely on it.)

## The one constraint that gates everything (CONTRACT PINNED)
**Consumption uses `vercel-labs/skills` (`npx skills add`) — skilly ships NO CLI.**
Verified from source (v1.5.10): the tool clones **git repositories** (or reads an
unauthenticated `.well-known` HTTP index — unusable for us). It runs
`git clone --depth 1 --branch <ref>` and passes the URL to git verbatim.

**Decision:** skilly serves each skill as a git repo over an **authenticated HTTP git
smart server**. One skill = one repo; **each version = an immutable git tag** `v<semver>`;
`SKILL.md` at repo root. Auth = **token-in-URL git basic auth**
(`https://x-access-token:<token>@host/<ns>/<skill>.git#v1.2.0`); the git server validates
the token, enforces visibility, logs the fetch (never the credentials). Pointer skills are
**mirrored** into a skilly-hosted repo at ingest (not redirected). The wire-format details
live ONLY in `packages/shared/src/external-tool.ts` — change them there and nowhere else.

## Architecture (§2)
TypeScript monorepo (pnpm workspaces), three processes + two stateful backends + scanner:
- `packages/web` — Next.js (App Router) standalone server: UI + REST API + admin dashboard + OIDC (Auth.js/Entra). **Never Vercel.**
- `packages/worker` — standalone Node service: hosts SCIM 2.0 endpoints, runs Entra reconciliation, runs the scan pipeline. **Singleton, leader-locked** (Postgres advisory lock).
- `packages/shared` — domain types, RBAC resolution, semver logic, validation, the external-tool adapter.
- Postgres (metadata + `tsvector` FTS + append-only audit), S3/MinIO (immutable artifact tarballs), ClamAV (scanner).

## Non-negotiable invariants
1. **Roles resolve from SCIM-synced group membership + `role_mappings`, NEVER from OIDC token claims** (avoids Entra ~200-group claim overage).
2. **Skill versions are immutable.** A fix is a new version. `latest` = highest *stable* semver among active versions.
3. **All catalog access is auth-required and strictly visibility-filtered.** A restricted skill must never appear in search, autocomplete, or counts for users outside its namespace.
4. **The fetch gateway is the only path to bytes** — Hosted served by skilly, Pointer proxied through skilly. No direct-URL bypass.
5. **`audit_log` is append-only.** The app DB role lacks UPDATE/DELETE; a trigger enforces it too. Never mutate audit rows.
6. **Tokens in URLs are random + scoped; never log credentials/query strings.** Three token regimes coexist:
   - **Legacy `one_time`/`pat` tokens** — the original strict rule: single-use, short-TTL, deleted on use.
   - **`install` tokens** (the consumer install/"installation" handle — §23) — a deliberate carve-out: skill-scoped, **reusable**, user-TTL'd (explicit dates ≤ 1y, or an explicit "Never"), and **not** deleted on use/expiry — they go *inactive* on expiry and are revoked by **uninstall** (owner hard-delete).
   - **System installations** (§23) — relaxed further: platform-owned (no user; minted/managed by platform admins only), **no clone-time visibility re-check**, compensated by mandatory audit of mint/uninstall/reactivate.
7. **Visibility is per-skill** (`org` | `namespace`). No per-individual private, no per-version visibility.

## Roles (§4)
- **Platform Admin** (platform-level), **Namespace Admin** (per-ns), **Namespace Member** (per-ns).
- Implicit for any authenticated user: **propose** and **consume**.
- Review is a **per-namespace `require_review` flag**; `global` namespace is always `true`.

## Before every commit (the release ritual, in order)
For any change that already passed the gated workflow above:

1. **Spec** — `SKILLY_SPEC.md` reflects the change (done and user-approved in the gate).
2. **Implementation** — matches the approved spec, **with its tests** (unit +
   integration, e2e if the change is user-facing — see step 4 of the gated workflow);
   `pnpm typecheck` + touched tests pass.
3. **Version** — bump `APP_VERSION` in `packages/shared/src/version.ts` (rules below).
4. **Changelog** — prepend the matching entry to `changelog.ts` (rules below).
5. **Commit** — subject format `type(scope): summary (vX.Y.Z)` (see Conventions), body as
   needed, ending with the `Co-Authored-By` trailer. Then push.

Steps 3–4 are skipped only when the change is doc-only/infra-only (no `APP_VERSION` bump
→ no changelog entry → no `(vX.Y.Z)` suffix in the subject).

## App version (MANDATORY on every change)
The app's semantic version lives in **`packages/shared/src/version.ts`** (`APP_VERSION`,
exported client-safe via `@skilly/shared/version`) and is displayed in the sidebar
colophon above "Created by Scalefocus".

**Bump it in the SAME commit as ANY change to the app — no matter how small:**
- **patch** (1.0.0 → 1.0.1): bug fixes, styling/layout, copy, refactors, small tweaks
- **minor** (1.0.0 → 1.1.0): new features, new endpoints/pages, new behaviors, DB migrations
- **major** (1.0.0 → 2.0.0): breaking changes (install contract, API shapes, required config)

One bump per commit is enough when a commit batches several changes (use the highest
applicable level). Doc-only or infra-only changes that don't ship app behavior don't bump.
**The new version must be strictly greater than the highest version already shipped** —
check `APP_VERSION` and the top of `changelog.ts` before bumping.

## What's new / changelog (MANDATORY before every commit & push)
The **What's new** page (`/whats-new`, linked in the account menu above *Installed skills*) reads
from **`packages/web/src/app/whats-new/changelog.ts`**. It must always reflect the shipped history.

**Whenever you bump `APP_VERSION`, add a matching entry to `CHANGELOG` in the SAME commit, BEFORE
committing & pushing:**
- Prepend one `{ version, date, summary }` object (newest first) — `version` = the new `APP_VERSION`,
  `date` = today (UTC `YYYY-MM-DD`), `summary` = a single user-facing line derived from the commit
  message (what changed, in plain language — not the internal file list).
- If a commit batches several changes under one bump, write one entry covering them.
- Source of truth for shipped history is **`changelog.ts` itself** — keep it complete and
  ordered newest-first; it is the canonical record, not `git log`.
- No `APP_VERSION` bump (doc/infra-only) → no changelog entry.

## User manual
The user manual is **built ad-hoc, outside this repository** — it is not tracked here and is
never part of a change's checklist. Screenshot capture tooling remains available at
`packages/web/e2e/shots.mjs` (Playwright, dev sign-in; writes to an untracked `docs/manual/shots/`
scratch dir and syncs the Quick-start subset into `packages/web/public/quickstart/`).

## Conventions
- **Commit subjects: `type(scope): summary (vX.Y.Z)`** — conventional-commit prefix
  (`feat`/`fix`/`style`/`chore`/`docs`/`refactor`), scope in parentheses, and the new
  `APP_VERSION` as a `(vX.Y.Z)` suffix. Omit the suffix only on no-bump (doc/infra-only)
  commits.
- Language: TypeScript everywhere, ESM.
- Package manager: **pnpm** (workspaces).
- **Timestamps: store UTC, convert at display.** Every time column is `timestamptz` (UTC); the API serializes UTC ISO strings. Never format a timestamp server-side for the UI — convert to the viewer's own timezone in the browser via the shared formatter (`components/DateFormat.tsx` → `useDateFmt()`). The EU/US display *style* is the platform `date_format` setting (admin panel → `/api/me` → the provider); EU = dd/mm/yyyy + 24h, US = mm/dd/yyyy + AM/PM.
- DB access: parameterized SQL / a thin query layer; migrations are plain SQL files in `db/migrations`, applied in order by the `migrate` compose service.
- Secrets: env / mounted only — never baked into images or committed. See `deploy/.env.example`.
- Logs: structured JSON. Health: `/healthz`, `/readyz`. Metrics: Prometheus `/metrics`.
- Tests: unit (domain, RBAC, semver), integration (API + DB + **SCIM conformance vs Entra payloads**), e2e (propose→review→publish→install).

## Build order (§16)
Phase 0 foundations (incl. pin the external-tool contract) → Phase 1 identity (OIDC + SCIM + RBAC)
→ Phase 2 catalog core (hosted skills, gateway, search) → Phase 3 governance (proposals, review, scan, audit)
→ Phase 4 pointer skills + notifications + polish. Deferred: Helm/K8s, HA, SAML, per-version visibility,
watch/follow, audit hash-chaining, OTel, i18n.

## Accepted assumptions to revisit
- Outbound network available (Pointer proxying + ClamAV updates). Air-gap would change this.
- Audit retains actor PII for provenance (not pseudonymized) — **deliberately exempt** from the "Delete User Info" GDPR erasure (§4): erasure scrubs the `users` row + personal data and de-identifies messages/proposals to "Deleted User", but `audit_log` stays immutable (invariant #5). Revisit if full audit-PII erasure is mandated.

## Don't
- Don't build before the spec is updated AND the user has verified it (the gated workflow above).
- Don't add a skilly CLI. Don't resolve roles from token claims. Don't mutate published versions or audit rows.
- Don't let restricted skills leak via metadata/search/counts. Don't log token query strings.
- Don't introduce Kubernetes/Helm, SAML, or OpenSearch in v1.
