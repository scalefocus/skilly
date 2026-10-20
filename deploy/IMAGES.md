# Pinned container images

Every third-party image skilly deploys is pinned by **tag + digest** (`image:tag@sha256:…`,
SKILLY_SPEC.md §49.12). The digest is the multi-arch **image index** digest, so the same pin
resolves on amd64 and arm64. With a digest present, container runtimes ignore the tag for
resolution — the tag is kept for humans (and to show what the digest *should* be).

Pins live in exactly three places and must stay in sync:

| Where | What it pins |
|---|---|
| `deploy/docker-compose.yml` | postgres (×2: `postgres`, `migrate`), minio (×2: `minio`, `minio-init`), alpine (`git-perms`), clamav, caddy (`proxy`) |
| `deploy/helm/skilly/values.yaml` | postgres, minio, clamav (`<component>.image`) |
| `packages/web/Dockerfile`, `packages/worker/Dockerfile` | the Node base images (build stage + runtime stage) |

## Current pins

| Image | Tag | Digest (index) | Used by |
|---|---|---|---|
| `node` | `22-alpine` | `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402` | web build + runtime, worker build (`packages/*/Dockerfile`) |
| `node` | `22-slim` | `sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392` | worker runtime (`packages/worker/Dockerfile`; Debian for `git-http-backend`) |
| `postgres` | `16-alpine` | `sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea` | compose `postgres` + `migrate`; Helm `postgres.image` |
| `minio/minio` | `RELEASE.2025-09-07T16-13-09Z` | `sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e` | compose `minio` + `minio-init` (the image ships `mc` RELEASE.2025-08-13T08-35-41Z, used for the bucket + scoped account bootstrap); Helm `minio.image` |
| `clamav/clamav` | `1.5.4` | `sha256:638d90201ee7ee6a82d249a2fc23b132e578673b5f1f2766852b127676ca1ef6` | compose `clamav`; Helm `clamav.image` |
| `caddy` | `2.11.7-alpine` | `sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f` | compose `proxy` (dev-only sample) |
| `alpine` | `3.24.2` | `sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6` | compose `git-perms` (one-shot chown) |

Resolved 2026-10-16 from Docker Hub.

> **MinIO note.** MinIO no longer serves its `minio/minio` and `minio/mc` images anonymously from
> Docker Hub or quay.io (pulls answer `insufficient_scope` / `401` / `pull access denied`). The
> digest above is the index digest of the last publicly pulled image (the Jenkins deploy agent and
> dev machines have it cached; `docker image inspect minio/minio:latest --format '{{json .RepoDigests}}'`).
> This is also why `minio-init` runs `mc` from the `minio/minio` image instead of pulling a separate
> `minio/mc` image: one pinned MinIO image is one image the deploy host already has. A fresh
> host must pull them from an internal mirror or a registry proxy — the CI pipeline already has the
> `CI_MINIO_IMAGE` override for its e2e stack, and the same mirror serves production. When a mirror
> re-tags the image, the **digest stays the same** as long as the image is copied unmodified
> (`crane copy` / `skopeo copy --all`), so the pin keeps working.

## Bump procedure

Bumps are deliberate, reviewed changes — there is no Renovate/Dependabot (Jenkins-only CI,
SKILLY_SPEC.md §49.16).

1. **Pick the new tag.** Concrete release tags only (`clamav/clamav:1.5.5`, `caddy:2.11.8-alpine`,
   `alpine:3.24.3`, `minio/minio:RELEASE.…`); never `latest`. The Node images keep the major-line
   tags `22-alpine` / `22-slim` (the digest pins the exact build).
2. **Resolve the index digest** (not a per-platform manifest digest):
   ```bash
   docker buildx imagetools inspect clamav/clamav:1.5.5      # prints "Digest: sha256:…"
   # or, without docker:  crane digest clamav/clamav:1.5.5
   # or:                  skopeo inspect --raw docker://clamav/clamav:1.5.5 | sha256sum
   ```
   `MediaType` must be an image index / manifest list
   (`application/vnd.oci.image.index.v1+json` or `…manifest.list.v2+json`).
3. **Update every place** that pins the image (table at the top): compose, Helm `values.yaml`, and
   both Dockerfiles for Node. Update the *Current pins* table above (tag, digest, resolve date).
4. **Validate locally.**
   ```bash
   docker compose -f deploy/docker-compose.yml config >/dev/null   # with a filled deploy/.env
   helm lint deploy/helm/skilly
   docker compose -f deploy/docker-compose.yml build                # Node bumps rebuild web + worker
   ```
   For a Node major bump also raise `engines.node` in the root `package.json` and run the full
   test suite; for a Postgres major bump plan the data-directory upgrade separately (a digest bump
   within `16-alpine` needs no migration).
5. **Open a reviewed PR** titled `chore(deploy): bump <image> to <tag> (vX.Y.Z)` with the old and
   new digests in the body and the release notes link. Image bumps are app changes: bump
   `APP_VERSION` (patch) and add the changelog entry per `CLAUDE.md`. Merge only after review;
   the deploy pipeline then pulls by digest.

## Why digests, briefly

A tag is mutable: a registry can move `1.5` (or even `1.5.4`) to a different image at any time,
and a compromised or mistaken upstream push would be pulled silently on the next `docker compose
up`. A digest is the content hash of the image index — the runtime verifies it on pull, so the
bytes you reviewed are the bytes you run. The cost is that security updates arrive only through
this bump procedure, which is why the pins should be revisited on a schedule (ClamAV and Caddy
publish patch releases regularly; MinIO monthly).
