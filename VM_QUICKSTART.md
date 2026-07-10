# skilly — Manual VM Deployment (Docker Compose)

A concise runbook for deploying skilly on a brand-new Linux VM (Ubuntu assumed).
The repo ships a Docker Compose topology, which is the simplest manual deploy.
Full detail — especially Microsoft Entra ID integration — lives in [`deployment_manual.md`](deployment_manual.md).

## 1. Install prerequisites

```bash
sudo apt-get update && sudo apt-get install -y git docker.io docker-compose-plugin openssl
sudo usermod -aG docker $USER   # re-login afterwards
```

## 2. Clone

```bash
git clone <this-repository-url> skilly
cd skilly/deploy
```

## 3. Configure secrets

Copy the template and fill it in:

```bash
cp .env.example .env
openssl rand -base64 32   # use for NEXTAUTH_SECRET
openssl rand -base64 32   # use for SCIM_BEARER_TOKEN
```

Edit `.env` and set, at minimum:

| Variable | Value |
|---|---|
| `PUBLIC_BASE_URL` | External HTTPS URL, e.g. `https://skilly.acme.com` |
| `POSTGRES_PASSWORD`, `SKILLY_APP_PASSWORD`, `MINIO_ROOT_PASSWORD` | Strong passwords |
| `NEXTAUTH_SECRET`, `SCIM_BEARER_TOKEN` | The generated values |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` | From your Entra app registration |
| `SKILLY_BOOTSTRAP_ADMIN_GROUP` | Entra group object id granted platform-admin on first login |

## 4. Bring it up

Builds the web + worker images, runs DB migrations, and starts
postgres / minio / clamav plus a dev Caddy proxy on `:8080`.

```bash
docker compose up --build -d
docker compose ps          # all healthy; the "migrate" service should have exited 0
```

## 5. Create the object-storage bucket (one-time)

```bash
docker compose exec minio sh -c \
 'mc alias set s3 http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" && mc mb -p s3/skilly-artifacts'
```

Must match `S3_BUCKET` (default `skilly-artifacts`). Alternatively, create it in the
MinIO console at `http://<VM>:9001`.

## 6. Verify

```bash
curl -fsS http://localhost:8080/healthz   # web up
curl -fsS http://localhost:8080/readyz    # web + DB reachable
```

The app is now reachable via the bundled proxy at `http://<VM>:8080`.

## 7. Front with TLS and wire Entra (production)

- Put your org reverse proxy (or the bundled Caddy) in front, terminating HTTPS at
  `PUBLIC_BASE_URL`. Route `/` → `web:3000`, and **`/scim/*` and `*.git` → `worker:4000`**.
  Expose only the proxy; keep Postgres and MinIO private.
- In the Entra app registration:
  - **Redirect URI:** `https://<host>/api/auth/callback/azure-ad`
  - **SCIM provisioning endpoint:** `https://<host>/scim/v2`, secret token = your `SCIM_BEARER_TOKEN`
  - Members of `SKILLY_BOOTSTRAP_ADMIN_GROUP` become platform admins on first login
    (chicken-and-egg fix). Sign in once via Entra, then assign roles in the admin panel.
  - See [`deployment_manual.md`](deployment_manual.md) §7 for the full app-registration + SCIM walkthrough.

## Upgrades

```bash
git pull && docker compose up --build -d
```

Migrations re-run in order; they are forward-only.

## Notes

- **Never** set `SKILLY_DEV_AUTH=1` in production — the app hard-fails on boot if you do.
- ClamAV signature updates and pointer-skill mirroring require outbound network; an
  air-gapped VM needs adjustment.
- **Bare-metal alternative (no Docker):** install Node 20+, pnpm 9, Postgres 16, and MinIO;
  apply `db/migrations/*.sql` in order; `pnpm install && pnpm -r build`; then run
  `node packages/web/.next/standalone/server.js` (web) and
  `node packages/worker/dist/index.js` (worker) with the same environment variables,
  behind your reverse proxy. The Compose path is recommended.
