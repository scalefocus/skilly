# skilly — Deployment & Microsoft Entra ID Integration Manual

A step-by-step guide to deploying and configuring **skilly** locally, and integrating it with
**Microsoft Entra ID** for single sign-on (OIDC), group/role provisioning (SCIM), and optional
directory reconciliation (Microsoft Graph).

This manual focuses on a **local / single-host** deployment. For the high-level project
overview see [`README.md`](./README.md); for the authoritative design see
[`SKILLY_SPEC.md`](./SKILLY_SPEC.md); for Kubernetes see [`deploy/helm/skilly`](./deploy/helm/skilly).

---

## Table of contents
1. [Architecture at a glance](#1-architecture-at-a-glance)
2. [Prerequisites](#2-prerequisites)
3. [Deployment option A — full stack with Docker Compose](#3-deployment-option-a--full-stack-with-docker-compose)
4. [Deployment option B — fast dev loop (no Entra needed)](#4-deployment-option-b--fast-dev-loop-no-entra-needed)
5. [Database migrations & object storage](#5-database-migrations--object-storage)
6. [Environment variable reference](#6-environment-variable-reference)
7. [Microsoft Entra ID integration](#7-microsoft-entra-id-integration)
   - [7.1 Register the application (OIDC SSO)](#71-register-the-application-oidc-sso)
   - [7.2 Wire the redirect URI and secrets into skilly](#72-wire-the-redirect-uri-and-secrets-into-skilly)
   - [7.3 Bootstrap the first Platform Admin](#73-bootstrap-the-first-platform-admin)
   - [7.4 Sync users & groups — SCIM vs. Graph reconciliation](#74-sync-users--groups--scim-vs-graph-reconciliation)
   - [7.5 Map Entra groups to roles](#75-map-entra-groups-to-roles)
8. [Verify the deployment](#8-verify-the-deployment)
9. [Consuming skills (`npx skills add`)](#9-consuming-skills-npx-skills-add)
10. [Operations](#10-operations)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Architecture at a glance

skilly is a TypeScript monorepo (pnpm workspaces) with three deployable pieces plus stateful
backends:

| Component | Port | Role |
|---|---|---|
| **web** (`packages/web`) | 3000 | Next.js app: UI + REST API + OIDC sign-in (Auth.js/Entra) |
| **worker** (`packages/worker`) | 4000 | SCIM 2.0 endpoint, Entra reconciliation, the **git smart server**, publish/scan/notify/pointer sweeps. Singleton (Postgres advisory-lock leader). |
| **proxy** (Caddy, dev sample) | 8080 | Routes `/scim/*` and `*.git/...` → worker; everything else → web |
| **Postgres** | 5432 | Metadata, FTS, append-only audit |
| **MinIO / S3** | 9000 (API), 9001 (console) | Immutable skill artifact storage |
| **ClamAV** (optional) | 3310 | Malware scanning at ingest |

Key routing rule (any proxy must honor it): **`/scim/*` and `*.git/...` go to the worker; all
other paths go to web.** Both share the same hostname so install URLs and SCIM/OIDC line up.

---

## 2. Prerequisites

- **Node.js ≥ 20** and **pnpm 9** (`corepack enable pnpm`) — for the dev loop / building images.
- **git** on `PATH` — the worker shells out to it for repo synthesis and pointer mirroring.
- **Docker** (Desktop on Windows/macOS) — for the stack and the bundled Postgres/MinIO/ClamAV.
- A **Microsoft Entra ID tenant** where you can register an application (for SSO). Admin consent
  rights are needed for SCIM provisioning and Graph reconciliation.
- Windows users: add a **Microsoft Defender exclusion** for the repo + `node_modules` (Defender
  intermittently quarantines Next.js internals — see [Troubleshooting](#11-troubleshooting)).

```bash
git clone <this-repository-url> skilly
cd skilly
pnpm install
```

---

## 3. Deployment option A — full stack with Docker Compose

This is the closest to production and the recommended way to test the **full Entra integration**
locally. It brings up postgres · migrate · minio · clamav · worker · web · proxy.

### Step 1 — create the env file
```bash
cp deploy/.env.example deploy/.env
```
Edit `deploy/.env`. At minimum set the secrets (see the [env reference](#6-environment-variable-reference)):
```ini
PUBLIC_BASE_URL=http://localhost:8080
POSTGRES_PASSWORD=change-me-strong
SKILLY_APP_PASSWORD=change-me-strong-app
NEXTAUTH_SECRET=<openssl rand -base64 32>
MINIO_ROOT_PASSWORD=change-me-minio
SCIM_BEARER_TOKEN=<long random string>
# Entra (fill after section 7.1)
ENTRA_TENANT_ID=
ENTRA_CLIENT_ID=
ENTRA_CLIENT_SECRET=
SKILLY_BOOTSTRAP_ADMIN_GROUP=
```
> `PUBLIC_BASE_URL` is the single source of truth for both the OIDC redirect and the generated
> install commands. For local Compose it's `http://localhost:8080` (the proxy port). Entra permits
> `http://localhost` redirect URIs, so no TLS cert is required for local testing.

### Step 2 — bring it up
```bash
docker compose -f deploy/docker-compose.yml up -d --build
```
- The **migrate** service applies `db/migrations/*.sql` in order, then sets the least-privilege
  `skilly_app` DB password from `SKILLY_APP_PASSWORD`.
- web and worker start once Postgres is healthy and migrations have completed.
- The Caddy proxy listens on **http://localhost:8080**.

### Step 3 — create the artifact bucket (one time)
MinIO does not auto-create the bucket. Open the console at **http://localhost:9001**
(login = `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`) and create a bucket named **`skilly-artifacts`**
(or whatever you set `S3_BUCKET` to). CLI alternative:
```bash
docker run --rm --entrypoint /bin/sh minio/mc -c \
  "mc alias set h http://host.docker.internal:9000 <MINIO_ROOT_USER> <MINIO_ROOT_PASSWORD> && mc mb -p h/skilly-artifacts"
```

### Step 4 — sign in
Open **http://localhost:8080**. To use Entra SSO, complete [section 7](#7-microsoft-entra-id-integration)
first. (For a quick look without Entra, use option B's dev auth.)

---

## 4. Deployment option B — fast dev loop (no Entra needed)

Best for UI iteration: run Postgres + MinIO in Docker, run the apps with hot reload, and sign in
with the built-in **dev auth** provider (no Entra tenant required).

```bash
# 1) infra
docker run -d --name skilly-pg -e POSTGRES_PASSWORD=test -e POSTGRES_USER=skilly \
  -e POSTGRES_DB=skilly -p 5432:5432 postgres:16-alpine
docker run -d --name skilly-minio -e MINIO_ROOT_USER=skilly -e MINIO_ROOT_PASSWORD=skillyminio \
  -p 9000:9000 -p 9001:9001 minio/minio server /data --console-address ":9001"

# 2) schema + demo data (see section 5 for the migration-order note)
for f in db/migrations/*.sql; do
  docker exec -i skilly-pg psql -v ON_ERROR_STOP=1 -U skilly -d skilly < "$f"; done
docker exec -i skilly-pg psql -v ON_ERROR_STOP=1 -U skilly -d skilly < db/seed.dev.sql

# 3) bucket
docker run --rm --entrypoint /bin/sh minio/mc -c \
  "mc alias set h http://host.docker.internal:9000 skilly skillyminio && mc mb -p h/skilly-artifacts"
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
S3_ENDPOINT=http://127.0.0.1:9000
S3_ACCESS_KEY=skilly
S3_SECRET_KEY=skillyminio
S3_BUCKET=skilly-artifacts
```

Run the apps (two terminals):
```bash
pnpm --filter @skilly/web dev          # http://localhost:3000

GIT_REPO_ROOT=./data/git DATABASE_URL=postgres://skilly:test@127.0.0.1:5432/skilly \
  S3_ENDPOINT=http://127.0.0.1:9000 S3_ACCESS_KEY=skilly S3_SECRET_KEY=skillyminio \
  S3_BUCKET=skilly-artifacts WORKER_PORT=4000 pnpm --filter @skilly/worker dev
```
Open **http://localhost:3000 → `/api/auth/signin` → "Dev sign-in"**. You're the seeded platform
admin. `SKILLY_DEV_AUTH` is **dev-only** and must never be enabled in production.

> You can still integrate Entra in the dev loop: drop `SKILLY_DEV_AUTH`, add the `ENTRA_*` vars to
> `.env.local`, and set the redirect URI to `http://localhost:3000/api/auth/callback/azure-ad`.

---

## 5. Database migrations & object storage

- Migrations are plain SQL in **`db/migrations/`** (`0001` … `0011`), applied **in lexical order**.
  In Compose the `migrate` service does this; manually, loop over the files with `psql`.
- **Postgres init race (manual runs):** the official image starts a temporary server during
  first-boot init, so `pg_isready` can briefly succeed before the real server is up. If `0001`
  fails with a socket error, wait for a real `psql -c "select 1"` to succeed, then re-apply.
- **`skilly_app` role:** migration `0002` creates a least-privilege role (no UPDATE/DELETE on the
  append-only `audit_log`). Compose's `migrate.sh` sets its password from `SKILLY_APP_PASSWORD`;
  web/worker connect as `skilly_app`. (In the dev loop we connect as the owner `skilly` for
  simplicity.)
- **Artifact bucket** (`S3_BUCKET`, default `skilly-artifacts`) must exist before uploading skills.
- **When you add a migration**, re-run the migrate step (Compose: `docker compose ... up migrate`;
  Helm: recreate the `skilly-migrations` ConfigMap and `helm upgrade`).

---

## 6. Environment variable reference

| Variable | Used by | Required | Purpose |
|---|---|---|---|
| `PUBLIC_BASE_URL` | web, worker | yes (prod) | External base URL; drives OIDC redirect + install-command host |
| `NEXTAUTH_URL` | web | yes | Auth.js base URL (Compose sets it to `PUBLIC_BASE_URL`) |
| `NEXTAUTH_SECRET` | web | yes | Session/JWT signing secret (`openssl rand -base64 32`) |
| `DATABASE_URL` | web, worker | yes | `postgres://skilly_app:<pw>@<host>:5432/skilly` |
| `ENTRA_TENANT_ID` | web, worker | for SSO | Entra tenant (directory) id |
| `ENTRA_CLIENT_ID` | web, worker | for SSO | App registration (client) id |
| `ENTRA_CLIENT_SECRET` | web, worker | for SSO | App client secret |
| `SKILLY_BOOTSTRAP_ADMIN_GROUP` | web, worker | recommended | Entra **group object id** whose members are Platform Admins from first boot |
| `SCIM_BEARER_TOKEN` | worker | for SCIM | Bearer token Entra presents to `/scim/v2` |
| `S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET` | web, worker | yes | Object storage connection + bucket |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | minio (compose) | yes | Bundled MinIO credentials |
| `GIT_REPO_ROOT` | worker | yes | Filesystem path where skill git repos are synthesized (persist it!) |
| `WORKER_PORT` | worker | no | Worker HTTP port (default 4000) |
| `ONE_TIME_TOKEN_TTL_SECONDS` | web | no | Legacy/no-op — install tokens don't use it (kept for compatibility) |
| `METRICS_TOKEN` | web, worker | no | If set, `GET /metrics` requires `Authorization: Bearer <token>` |
| `POINTER_REFRESH_INTERVAL_MS` | worker | no | Pointer re-scan/drift cadence (default 24h) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` | worker | no | Email notification delivery (in-app always works) |
| `NOTIFY_WEBHOOK_URL` | worker | no | Outbound webhook (Teams/Slack) for notifications |
| `SKILLY_DEV_AUTH` / `SKILLY_DEV_OID` | web | no | **Dev only** — enable the password-less "Dev sign-in" provider |

> **Secrets** are injected via env / mounted only — never commit `deploy/.env` or `.env.local`.

---

## 7. Microsoft Entra ID integration

skilly uses Entra for three distinct concerns:
- **Authentication (OIDC):** who you are (sign-in).
- **Provisioning (SCIM) or reconciliation (Graph):** which users/groups exist and who belongs to which group.
- **Authorization (RBAC):** resolved from **SCIM-synced group membership + role mappings** —
  **never** from OIDC token claims (this is a hard invariant; it avoids Entra's ~200-group claim cap).

> **Reachability note for local setups.** OIDC sign-in is browser-driven, so it works against
> `localhost` with no inbound access. **SCIM provisioning is push-based from Azure** and therefore
> needs your instance reachable from the internet (a public URL or a tunnel like ngrok). For a
> purely local box, prefer **Graph reconciliation** (the worker *pulls* membership outbound — see
> [7.4](#74-sync-users--groups--scim-vs-graph-reconciliation)), or seed membership manually.

### 7.1 Register the application (OIDC SSO)

In the [Azure portal](https://portal.azure.com) → **Microsoft Entra ID → App registrations → New registration**:

1. **Name:** `skilly`.
2. **Supported account types:** *Accounts in this organizational directory only* (single tenant).
3. **Redirect URI:** platform **Web**, value:
   - Local Compose: `http://localhost:8080/api/auth/callback/azure-ad`
   - Local dev loop: `http://localhost:3000/api/auth/callback/azure-ad`
   - Production: `https://<your-host>/api/auth/callback/azure-ad`
   The path segment `azure-ad` is fixed by the provider id — don't change it.
4. Click **Register**. Copy the **Application (client) ID** and **Directory (tenant) ID**.
5. **Certificates & secrets → New client secret** → copy the **secret value** immediately.
6. (Default is fine) **API permissions** for sign-in only needs delegated `openid`, `profile`,
   `email` — skilly requests these scopes and reads no groups from the token.

You can register **multiple redirect URIs** (e.g. localhost + prod) on the same app.

### 7.2 Wire the redirect URI and secrets into skilly

Set these so skilly builds the **exact** callback URL Entra expects:

| Deployment | Set | Result |
|---|---|---|
| Compose | `PUBLIC_BASE_URL=http://localhost:8080` in `deploy/.env` | callback `…:8080/api/auth/callback/azure-ad` |
| Dev loop | `NEXTAUTH_URL=http://localhost:3000` in `.env.local` | callback `…:3000/api/auth/callback/azure-ad` |
| Production | `PUBLIC_BASE_URL=https://<host>` | callback `https://<host>/…` |

Also set `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`. Restart web (and worker) so
they pick up the values. The "Sign in with Entra ID" button now performs the OIDC flow.

> Behind a TLS-terminating reverse proxy, `PUBLIC_BASE_URL`/`NEXTAUTH_URL` must be the **external
> `https://` URL**, not the internal `http://web:3000` — Auth.js builds the redirect verbatim. A
> mismatch causes `AADSTS50011: redirect URI … does not match`.

### 7.3 Bootstrap the first Platform Admin

There's a chicken-and-egg: you can't create role mappings until you're an admin. Solve it with
the **bootstrap group**:

1. In Entra, create (or pick) a security group, e.g. `skilly-platform-admins`. Copy its **Object Id**.
2. Add yourself (and other initial admins) as **members**.
3. Set `SKILLY_BOOTSTRAP_ADMIN_GROUP=<that object id>` for **web and worker**; restart.

Any signed-in user whose **synced** membership includes this group is treated as Platform Admin
from first boot — even before any `role_mappings` exist. (Membership must be synced via SCIM or
Graph reconciliation, or seeded — see 7.4. The bootstrap is the only place a group grants access
without an explicit role mapping.)

### 7.4 Sync users & groups — SCIM vs. Graph reconciliation

A user only has access once their **user row and group memberships exist in skilly's database**.
Signing in via OIDC alone does **not** create the row. Choose one mechanism:

**Option 1 — SCIM provisioning (recommended for production; needs inbound reachability):**
1. In Entra → **Enterprise applications** → your app → **Provisioning** → *Get started*.
2. **Provisioning Mode:** Automatic.
3. **Admin Credentials:**
   - **Tenant URL:** `https://<your-host>/scim/v2`
   - **Secret Token:** the value of `SCIM_BEARER_TOKEN`
   - **Test Connection** → should succeed (the worker validates the bearer token).
4. **Mappings:** keep the default Groups mapping. For **Users**, change the **`externalId`**
   attribute to map from **`objectId`** (Entra's default maps `externalId` to `mailNickname`,
   which does **not** match the OIDC `oid` claim used at sign-in — leaving SCIM-provisioned users
   unable to log in). skilly also consumes `userName`/email, `displayName`, `active`, and group
   membership. (As a safety net, skilly self-heals a mis-keyed user on their next sign-in by
   relinking the row matched by email to their real objectId — but mapping `externalId → objectId`
   is the correct fix.)
5. **Settings → Scope:** *Sync only assigned users and groups*; under **Users and groups**, assign
   the groups you want skilly to know about (include your bootstrap group).
6. **Save**, then **Start provisioning**. Initial cycle can take a few minutes.

> The worker serves SCIM at `/scim/v2`; the proxy routes `/scim/*` to it. Deprovisioning a user in
> Entra marks them inactive in skilly and revokes their tokens.

**Option 2 — Graph reconciliation (great for local; outbound only):**
The worker can *pull* membership from Microsoft Graph on a schedule — no inbound access needed,
so it works from `localhost`.
1. In the app registration → **API permissions → Add a permission → Microsoft Graph →
   Application permissions** → add **`GroupMember.Read.All`** (or `Directory.Read.All`).
2. Click **Grant admin consent**.
3. Ensure `ENTRA_TENANT_ID`/`ENTRA_CLIENT_ID`/`ENTRA_CLIENT_SECRET` are set for the **worker**.
4. The worker reconciles membership for the **role-mapped groups + the bootstrap group** every
   `RECONCILE_INTERVAL_MS` (default 15 min), upserting users and converging memberships. Restart
   the worker to force an immediate sweep.

**Option 3 — manual seed (offline/dev):** insert rows into `users`, `groups`, and
`group_memberships` directly (see `db/seed.dev.sql` for the shape).

### 7.5 Map Entra groups to roles

Once you're a Platform Admin and groups are syncing:
1. Sign in and open **Administration** (`/admin`).
2. **Platform admins:** bind groups that should administer the whole org.
3. **Namespaces:** create business-unit namespaces (e.g. `team-a`). The reserved `global`
   namespace always requires review.
4. **Role mappings:** per namespace, bind a synced Entra group to **Namespace Admin** (review &
   manage) or **Namespace Member** (propose & direct-publish where allowed).
5. (Optional) **Contribution policy:** toggle whether *any* signed-in user can propose, or only
   members/admins of the target namespace.

Roles take effect on the user's next access resolution (next request/sign-in). Membership always
comes from the synced groups — editing mappings never touches Entra.

---

## 8. Verify the deployment

```bash
# liveness / readiness (both services)
curl http://localhost:8080/healthz            # web (via proxy)
curl http://localhost:8080/readyz             # web — checks DB
curl http://localhost:4000/readyz             # worker (direct)

# metrics (Prometheus exposition; add -H "Authorization: Bearer $METRICS_TOKEN" if set)
curl http://localhost:4000/metrics
```
Then in the browser:
- Sign in via Entra (or Dev sign-in) — you should land authenticated.
- **`/admin`** is visible (you're a Platform Admin) and lists your synced groups.
- **Catalog** loads; **Propose a skill** works; submitting creates a notification (bell).

---

## 9. Consuming skills (`npx skills add`)

skilly ships **no CLI**. Skills are consumed with the external `vercel-labs/skills` tool, which
clones a git repo. From a skill's page, **Generate install command**:

- **Org-wide skill:** `npx skills add https://<host>/<namespace>/<slug>.git#v1.2.0`
- **Restricted skill:** a short-lived one-time token is embedded as git basic-auth:
  `npx skills add https://x-access-token:<token>@<host>/<namespace>/<slug>.git#v1.2.0`
- **CI/automation:** mint a **Personal Access Token** at `/tokens` and use it in place of the
  one-time token.

The git smart server (worker) validates the token, enforces visibility, and logs the fetch
(never the credentials).

---

## 10. Operations

- **Persist these volumes:** Postgres data, MinIO data, and the **git repo volume**
  (`GIT_REPO_ROOT`, `deploy/data/git` in Compose). Back up all three.
- **Git volume ownership:** the worker runs unprivileged as uid 1000, so the git repo volume
  must be writable by uid 1000. Compose handles this automatically via the one-shot `git-perms`
  init service (`chown -R 1000:1000 /data/git` before the worker starts); Helm uses `fsGroup: 1000`
  on the worker pod. If a deploy ever skips this, the publish sweep fails with
  `EACCES: permission denied, mkdir '/data/git/global'` and skills stay stuck at
  `repository not provisioned`.
- **Scaling:** web is stateless (JWT sessions) — scale horizontally. The worker is a **singleton**
  (Postgres advisory-lock leader); extra replicas are safe but only the leader runs the sweeps.
- **Outbound network** is needed for pointer mirroring, ClamAV signature updates, and Graph
  reconciliation. Fonts are vendored (no CDN).
- **Large hosted-skill uploads (the 200 MB default and the 1 GB tier):** the admin "Maximum upload
  size" setting is honored end-to-end, but three infra limits gate very large bundles:
  - **Reverse-proxy body limit:** any proxy in front of skilly must accept request bodies at
    least as large as the configured cap (nginx: `client_max_body_size`, whose default is only
    1 MB). A proxy with a lower limit answers **413 itself** — the request never reaches skilly,
    so the uploader gets the app's generic too-large message instead of the cap-quoting one, and
    the rejection cannot appear in the admin System log. The bundled dev Caddyfile sets no limit.
  - **ClamAV `clamd`** refuses streams larger than its `StreamMaxLength` (the `clamav/clamav`
    image default is well under 1 GB). To keep AV scanning bundles up to your chosen cap, raise it,
    e.g. `clamd --max-scansize=1100M --max-filesize=1100M --stream-max-length=1100M` (or set
    `StreamMaxLength`/`MaxScanSize`/`MaxFileSize` in `clamd.conf`), and give the clamav container
    enough memory. Otherwise oversized uploads get an AV error rather than a clean scan.
  - **Memory:** the web tier buffers the entire upload in memory (and the worker holds the bundle
    while packing/synthesizing), so size web/worker memory for your largest allowed bundle plus
    headroom. The 1 GB tier in particular needs generous limits on both.
- **Observability:** scrape `/metrics` on web and worker; gate with `METRICS_TOKEN` if exposed.
- **Audit integrity:** `/audit` has a "Verify integrity" action (the hash chain is tamper-evident).

---

## 11. Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `AADSTS50011: redirect URI … does not match` | The registered redirect URI ≠ `PUBLIC_BASE_URL`/`NEXTAUTH_URL` + `/api/auth/callback/azure-ad`. Make them identical (scheme, host, port, no trailing slash). Behind a proxy, use the external `https://` URL. |
| Signed in but **no access** / `/admin` hidden | Your user/group membership isn't synced yet. Run SCIM provisioning or enable Graph reconciliation (7.4), and make sure you're in the bootstrap group. |
| SCIM **Test Connection** fails / 401 | `SCIM_BEARER_TOKEN` mismatch, or the tenant URL isn't reachable from Azure (localhost needs a public tunnel). Confirm the proxy routes `/scim/*` → worker. |
| Graph reconciliation does nothing | Missing **admin consent** on `GroupMember.Read.All`, or `ENTRA_*` not set for the worker, or the group isn't role-mapped/bootstrap (only those are reconciled). |
| Upload/publish fails with a storage error | The `S3_BUCKET` doesn't exist — create `skilly-artifacts` in MinIO (Step 3). |
| `git clone`/`npx skills add` prompts for a username | The repo is restricted and the URL has no/expired token. Generate a fresh install command or use a PAT. |
| Migration `0001` fails with a socket error (manual) | Postgres first-boot init race — wait for `psql -c "select 1"` to succeed, then re-apply migrations. |
| Web 500 with `MODULE_NOT_FOUND` / `Cannot find module './impl'` (Windows) | Microsoft Defender quarantined a Next.js internal. Add a Defender **exclusion** for the repo + `node_modules`, then `pnpm install --force` and restart. |
| Worker keeps restarting after `pnpm install` (dev) | `tsx watch` reacts to `node_modules` churn. Run the worker from a build instead: `pnpm --filter @skilly/worker build` then `node packages/worker/dist/index.js`. |

---

*For the phased feature plan and security invariants, see [`SKILLY_SPEC.md`](./SKILLY_SPEC.md) and
[`CLAUDE.md`](./CLAUDE.md).*
