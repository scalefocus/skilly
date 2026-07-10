# skilly

Enterprise-grade, open-source, self-hosted registry for governing Anthropic-style
`SKILL.md` agent skills across an organization and its business units, with identity
and access anchored in Microsoft Entra ID.

- **Spec:** [`SKILLY_SPEC.md`](./SKILLY_SPEC.md) — authoritative build spec.
- **Working context:** [`CLAUDE.md`](./CLAUDE.md).
- **Contributing:** [`CONTRIBUTING.md`](./CONTRIBUTING.md) · **Security policy:** [`SECURITY.md`](./SECURITY.md).
- **License:** [Apache 2.0](./LICENSE).

## Monorepo layout
```
packages/
  web/        Next.js app — themeable UI + REST API + OIDC (Auth.js/Entra)
  worker/     SCIM 2.0 + Entra reconciliation + git smart server + publish/scan sweeps (singleton, leader-locked)
  shared/     domain types, RBAC, semver, validation, scanners, external-tool adapter
db/migrations/  plain SQL migrations, applied in order by the migrate service
db/seed.dev.sql dev-only seed data (NOT for production)
deploy/         docker-compose, .env.example, sample reverse proxy (Caddy)
docs/           operator + developer docs
```

## Quickstart: install a skill (consumers)
**Just want to use a skill?** skilly ships **no CLI** — install with the external
`vercel-labs/skills` client. Copy the ready-made command from a skill's page in the catalog,
or build it yourself:

```bash
npx skills add https://x-access-token:<token>@skilly.example.com/team-a/foo.git#v1.2.0
```

skilly serves each skill as a git repo over an authenticated git smart server — one skill =
one repo, each version = an immutable tag. The `<token>` is a skill-scoped, reusable
**install token** minted per user (revoked by uninstall; SKILLY_SPEC.md §23), embedded as
git basic-auth in the URL.

> **Running your own registry instead?** Everything below — prerequisites, testing, local
> dev, and deployment — is for **operators self-hosting skilly**. Jump straight to
> [Deployment](#deployment-self-hosted-production).

---

## Prerequisites
- **Node.js ≥ 20** (22/25 fine) and **pnpm 9** (`corepack enable pnpm`).
- **git** on PATH — the worker shells out to it for repo synthesis and pointer mirroring;
  tests need it too.
- **Docker** — for the full stack and the live-DB integration tests.
- Windows users: see the **Defender exclusion** note at the bottom.

```bash
pnpm install
```

---

## Testing

### Hermetic suite (no Docker, runs offline)
```bash
pnpm --filter @skilly/shared build   # build shared first — web/worker typecheck needs its emitted types
pnpm -r typecheck     # type-check every package
pnpm -r test          # unit + integration tests (shared + worker), uses fakes
pnpm --filter @skilly/web build   # production build of the UI
```
`pnpm -r test` is fully hermetic — the DB-backed tests below are gated by `SKILLY_DB_E2E`
and skip unless that env var is set.

### Live-DB integration tests (need Docker)
Spin up a throwaway Postgres, apply **all** migrations, then run the gated tests:

```bash
# 1) start Postgres and apply migrations
docker run -d --name skilly-test \
  -e POSTGRES_PASSWORD=test -e POSTGRES_USER=skilly -e POSTGRES_DB=skilly \
  -p 55433:5432 postgres:16-alpine
for f in db/migrations/*.sql; do
  docker exec -i skilly-test psql -v ON_ERROR_STOP=1 -U skilly -d skilly < "$f"
done

export SKILLY_DB_E2E=1
export DATABASE_URL=postgres://skilly:test@127.0.0.1:55433/skilly

# 2) publish chain (hosted + pointer + pending-mirror) → synthesize → real `git clone`
pnpm --filter @skilly/worker build
node --test packages/worker/dist/integration/publishFlow.test.js

# 3) admin flows (namespaces + role mappings + audit), run via tsx
pnpm --filter @skilly/web test:db

# cleanup
docker rm -f skilly-test
```

### UI end-to-end (Playwright, opt-in)
Browser smoke tests live in `packages/web/e2e/` and run against a **running** web server (they
need browsers + a live stack, so they are not part of `pnpm -r test`):

```bash
npx playwright install            # one-time: fetch browsers
pnpm --filter @skilly/web dev     # terminal 1 (http://localhost:3000)
pnpm --filter @skilly/web e2e     # terminal 2 (override target with PLAYWRIGHT_BASE_URL)
```

---

## Running locally

### Option A — full stack in Docker (closest to production)
```bash
cp deploy/.env.example deploy/.env      # then edit deploy/.env (see Deployment below)
docker compose -f deploy/docker-compose.yml up --build
```
Brings up **postgres · migrate · minio · clamav · worker · web · proxy**. Migrations run
automatically. The dev reverse proxy (Caddy) listens on **http://localhost:8080** and
routes `/scim/*` and `*.git` smart-HTTP to the worker, everything else to the web app.

Two one-time setup steps:
- **Create the artifact bucket** in MinIO (console at http://localhost:9001, login =
  `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`): create a bucket named `skilly-artifacts`
  (or whatever you set `S3_BUCKET` to).
- **Sign-in** needs a real Entra app (see Deployment) **or** dev auth (below).

### Option B — fast dev loop (apps via pnpm, infra in Docker)
Best for UI/iteration. Run Postgres + MinIO yourself, seed demo data, use **dev auth**
(no Entra needed), and run the apps with hot reload.

```bash
# infra
docker run -d --name skilly-pg -e POSTGRES_PASSWORD=test -e POSTGRES_USER=skilly \
  -e POSTGRES_DB=skilly -p 5432:5432 postgres:16-alpine
docker run -d --name skilly-minio -e MINIO_ROOT_USER=skilly -e MINIO_ROOT_PASSWORD=skillyminio \
  -p 9000:9000 -p 9001:9001 minio/minio server /data --console-address ":9001"
# create the bucket once (console http://localhost:9001) → "skilly-artifacts"

# schema + demo data
for f in db/migrations/*.sql; do
  docker exec -i skilly-pg psql -v ON_ERROR_STOP=1 -U skilly -d skilly < "$f"; done
docker exec -i skilly-pg psql -v ON_ERROR_STOP=1 -U skilly -d skilly < db/seed.dev.sql
```

Create **`packages/web/.env.local`** (gitignored):
```ini
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=dev-only-secret
SKILLY_REGISTRY_URL=http://localhost:3000
DATABASE_URL=postgres://skilly:test@127.0.0.1:5432/skilly
# dev sign-in (no Entra): seeded user "dev-admin-oid" is a platform admin
SKILLY_DEV_AUTH=1
SKILLY_DEV_OID=dev-admin-oid
# object storage
S3_ENDPOINT=http://127.0.0.1:9000
S3_ACCESS_KEY=skilly
S3_SECRET_KEY=skillyminio
S3_BUCKET=skilly-artifacts
```

Run the apps (separate terminals):
```bash
pnpm --filter @skilly/web dev       # http://localhost:3000
GIT_REPO_ROOT=./data/git DATABASE_URL=postgres://skilly:test@127.0.0.1:5432/skilly \
  S3_ENDPOINT=http://127.0.0.1:9000 S3_ACCESS_KEY=skilly S3_SECRET_KEY=skillyminio \
  S3_BUCKET=skilly-artifacts pnpm --filter @skilly/worker dev
```
Then open http://localhost:3000, go to **`/api/auth/signin`**, and choose **“Dev sign-in.”**
You’ll be the seeded platform admin (catalog, review queue, and admin screens populated).

---

## Deployment (self-hosted, production)

skilly is container-native and runs entirely inside your environment. The reference
deployment is the `deploy/docker-compose.yml` stack behind **your org’s TLS-terminating
reverse proxy**.

### 1. Configure `deploy/.env` (copy from `.env.example`)
| Var | Purpose |
|---|---|
| `PUBLIC_BASE_URL` | External HTTPS URL (used for OIDC redirect + install-command generation) |
| `POSTGRES_*`, `SKILLY_APP_PASSWORD` | DB creds; app connects as least-privilege `skilly_app` |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32` |
| `ENTRA_TENANT_ID`/`ENTRA_CLIENT_ID`/`ENTRA_CLIENT_SECRET` | Entra app for OIDC SSO (and Graph reconciliation) |
| `SKILLY_BOOTSTRAP_ADMIN_GROUP` | Entra **group object id** whose members are Platform Admins from first boot |
| `SCIM_BEARER_TOKEN` | Secret token Entra presents to the SCIM endpoint |
| `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, `S3_BUCKET` | Object storage creds + bucket |
| `ONE_TIME_TOKEN_TTL_SECONDS` | Legacy/no-op — install tokens don't use it (kept for compatibility) |
| `SMTP_*` (optional) | Email notifications; falls back to in-app only if unset |

### 2. Microsoft Entra ID setup
- **OIDC SSO** — register an app; add redirect URI `https://<host>/api/auth/callback/azure-ad`;
  put tenant/client id/secret into `ENTRA_*`.
- **SCIM provisioning** — in the Enterprise App → *Provisioning*, set the tenant URL to
  `https://<host>/scim/v2` and the secret token to `SCIM_BEARER_TOKEN`. Assign the groups
  you want synced. (The worker hosts `/scim/v2`; the proxy routes it there.)
- **Reconciliation (optional)** — grant the app the Graph application permission
  `GroupMember.Read.All` (or `Directory.Read.All`) with admin consent; the worker then
  periodically reconciles membership for role-mapped groups (`RECONCILE_INTERVAL_MS`).
- **Bootstrap** — set `SKILLY_BOOTSTRAP_ADMIN_GROUP`; its members can sign in and create
  namespaces + role mappings (Administration screen) before any mapping exists.

### 3. Bring it up
```bash
docker compose -f deploy/docker-compose.yml up -d --build
```
- The **migrate** service applies `db/migrations/*.sql` in order on every start.
- **Create the `S3_BUCKET`** in MinIO once (or pre-create it in your real S3).
- Terminate **TLS at your reverse proxy** and route to the stack (see `deploy/Caddyfile`
  for the routing shape: `/scim/*` and `*.git/...` → `worker:4000`, else → `web:3000`).

### 4. Persistence & operations
- **Volumes to persist/back up:** Postgres data, MinIO data, and the **git repo volume**
  (`deploy/data/git`, the worker’s `GIT_REPO_ROOT`). Back up all three (e.g. `pg_dump` +
  object-store snapshot + tar of the git volume).
- **Health:** `GET /healthz` (liveness) and `GET /readyz` (DB check) on both web and worker.
- **Metrics:** `GET /metrics` (Prometheus text exposition) on both web and worker — scrape each
  instance. Set `METRICS_TOKEN` to require an `Authorization: Bearer <token>` on the endpoint;
  leave it unset to expose metrics unauthenticated on the internal network. Counters cover
  proposals/actions, tokens, installs, searches, git clones, publishes/mirrors, notification
  delivery, and pointer drift.
- **Rate limiting:** per-instance, in-memory limits on propose / token-mint / install-mint /
  search (429 + `Retry-After`). Horizontal scaling makes these per-replica; a shared store is a
  future upgrade.
- **Pointer refresh:** the leader re-clones + re-scans mirrored pointer refs on a schedule
  (`POINTER_REFRESH_INTERVAL_MS`, default 24h), refreshing scan findings and flagging upstream
  drift on pinned refs into the audit log.
- **Scaling:** the web app is **stateless** (scale horizontally behind the proxy); the
  **worker is a singleton** (Postgres advisory-lock leader election — only the leader runs
  SCIM reconciliation, publish/mirror, scan, and token sweeps).
- **Outbound network** is required at runtime for **pointer mirroring** and **ClamAV
  signature updates**. UI fonts are vendored (self-hosted) — no CDN dependency. Fully
  air-gapped deployments must mirror pointer sources internally and disable ClamAV updates.
### Kubernetes (Helm)
A chart lives at [`deploy/helm/skilly`](./deploy/helm/skilly): stateless web (Deployment +
Service + **HPA**), leader-locked worker (Deployment + git PVC), a migrations **Job**
(pre-install/upgrade hook), an **Ingress** that routes `/scim` and `*.git` to the worker and
everything else to web, plus bundled Postgres/MinIO/ClamAV you can disable to use managed
services.

```bash
# migrations are applied by a Job from a ConfigMap built off the repo:
kubectl -n skilly create configmap skilly-migrations --from-file=db/migrations
helm install skilly deploy/helm/skilly -n skilly \
  --set publicBaseUrl=https://skilly.example.com \
  --set ingress.host=skilly.example.com
# re-create the ConfigMap + `helm upgrade` whenever you add a migration.
```

- **HA:** web scales horizontally (HPA, stateless JWT sessions); the worker is leader-locked
  (advisory lock) so extra replicas are safe — scaling it past 1 needs ReadWriteMany git
  storage. Per-instance rate limiting becomes per-replica (a shared store is the next upgrade).
- The Ingress git route uses a regex (ingress-nginx annotations by default); on other
  controllers ensure `*.git/...` reaches the worker Service or `npx skills add` clones fail.
- See the chart's `NOTES.txt` for the bucket-creation + Entra wiring steps.

---

## Windows: Microsoft Defender exclusion (important)
Real-time Defender scanning intermittently **quarantines files inside `node_modules`**
(notably Next.js’ bundled `jest-worker/processChild.js`), breaking `next build`/`next dev`
and package resolution (`MODULE_NOT_FOUND`, missing `next/dist/bin/next`).

**Fix — add a Defender folder exclusion** (PowerShell, *as Administrator*):
```powershell
Add-MpPreference -ExclusionPath "<path-to-your-clone>\node_modules"
Add-MpPreference -ExclusionPath (pnpm store path)   # the global pnpm content store
```
**Recovery** if it already happened: `pnpm install --force`.

---

## Status
Backend subsystems are implemented and tested (identity: OIDC + SCIM + reconciliation +
RBAC; catalog + authenticated git smart server; proposals / validation / scanning / audit;
hybrid hosted + pointer; yank/archive, promotion-to-global, direct publish), with a
themeable React UI. **Tiers 2–4 complete:** CI (GitHub Actions), notification delivery (in-app center +
SMTP + webhook), scoped audit-log viewer, catalog facets + rendered SKILL.md, PAT management,
Prometheus `/metrics` + rate limiting, install-count analytics, pointer refresh/drift-check,
a Playwright smoke harness, a **Helm chart** (web HPA + leader-locked worker + Ingress +
bundled or external deps), **tamper-evident audit hash-chaining**, and **watch/follow** with
new-version notifications. Explicitly deferred (see `SKILLY_SPEC.md` §16): per-version
visibility (conflicts with the per-skill invariant), SAML, OpenTelemetry, i18n. 78+ tests
pass; two gated suites verify the live-DB + real-git paths (incl. .zip bundles, pointer
refresh, audit-chain tamper detection, and watch→notify); `helm lint` runs in CI.
