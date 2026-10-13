#!/bin/sh
# One shard of the gated Playwright e2e suite, on a full stack of its own: an ephemeral Postgres +
# MinIO (Docker-assigned loopback ports), its own serving-git root, and its own `next dev` on a free
# port. The Jenkins `E2E tests` stage runs E2E_SHARD_TOTAL of these in parallel on one agent; with
# E2E_SHARD_TOTAL=1 it is the whole suite, exactly as the stage ran it before sharding.
#
# Inputs (env):
#   E2E_SHARD, E2E_SHARD_TOTAL   this shard (1-based) and the shard count
#   E2E_HEAP_MB                   dev server heap ceiling (optional; ci/e2e-shard-plan.sh sizes it)
#   E2E_TEST_LIST                 optional: absolute path of a Playwright --test-list file; only
#                                 those tests run (the quick e2e sample, ci/e2e-quick-list.mjs)
#   E2E_WARM                      optional route warm-up scope, all | pages (e2e/global-setup.ts);
#                                 defaults to pages when E2E_TEST_LIST is set, all otherwise
#   BUILD_TAG, WORKSPACE          Jenkins build identity + checkout root
#   CI_PG_IMAGES, CI_MINIO_IMAGES space-separated image candidate lists (first reachable wins)
#   CI_E2E_PG_CONTAINER, CI_E2E_MINIO_CONTAINER, CI_E2E_MINIO_PASSWORD
#
# Every container carries the label skilly-ci-e2e=<BUILD_TAG>, so the stage's cleanup removes all
# shards' containers without having to know how many there were.
#
# Run from the repo root. The Chromium install and the wait for the Typecheck branch happen once, in
# ci/e2e-prepare.sh, running beside the shards; each shard provisions its stack meanwhile and waits
# for that script's marker before it starts its dev server.
set -eu
. "${HOME}/.asdf/asdf.sh"

: "${E2E_SHARD:?}" "${E2E_SHARD_TOTAL:?}" "${BUILD_TAG:?}" "${WORKSPACE:?}"
TAG="shard ${E2E_SHARD}/${E2E_SHARD_TOTAL}"
PG_CONTAINER="${CI_E2E_PG_CONTAINER}-s${E2E_SHARD}"
MINIO_CONTAINER="${CI_E2E_MINIO_CONTAINER}-s${E2E_SHARD}"
LABEL="skilly-ci-e2e=${BUILD_TAG}"

# Resolve usable images from the candidate lists (first hit wins): local copy, else pull.
resolve_image() {
  for _img in $1; do
    if docker image inspect "$_img" >/dev/null 2>&1 || docker pull "$_img" >/dev/null; then
      echo "$_img"
      return 0
    fi
    echo "could not obtain $_img — trying the next candidate" >&2
  done
  echo "none of these images are reachable from this agent: $1" >&2
  echo "set the matching CI_*_IMAGE build parameter to an image this agent can pull." >&2
  return 1
}

# The loopback host port Docker assigned to a container's published port.
host_port() {
  _hp="$(docker port "$1" "$2/tcp" | head -n 1 | sed 's/.*://')"
  if [ -z "$_hp" ]; then echo "no host port published for $1:$2" >&2; return 1; fi
  echo "$_hp"
}

PG_IMAGE="$(resolve_image "${CI_PG_IMAGES}")"
MINIO_IMAGE="$(resolve_image "${CI_MINIO_IMAGES}")"
echo "[${TAG}] postgres image: ${PG_IMAGE} | minio image: ${MINIO_IMAGE}"

# Ephemeral Postgres + MinIO for this shard's live stack, on Docker-assigned loopback ports.
docker run -d --rm --name "${PG_CONTAINER}" --label "${LABEL}" \
  -e POSTGRES_USER=skilly -e POSTGRES_PASSWORD=test -e POSTGRES_DB=skilly \
  -p 127.0.0.1::5432 "${PG_IMAGE}"
docker run -d --rm --name "${MINIO_CONTAINER}" --label "${LABEL}" \
  -e MINIO_ROOT_USER=skilly -e MINIO_ROOT_PASSWORD="${CI_E2E_MINIO_PASSWORD}" \
  -p 127.0.0.1::9000 "${MINIO_IMAGE}" server /data
E2E_PG_PORT="$(host_port "${PG_CONTAINER}" 5432)"
E2E_MINIO_PORT="$(host_port "${MINIO_CONTAINER}" 9000)"
CI_E2E_DATABASE_URL="postgres://skilly:test@127.0.0.1:${E2E_PG_PORT}/skilly"
CI_E2E_S3_ENDPOINT="http://127.0.0.1:${E2E_MINIO_PORT}"
echo "[${TAG}] postgres on 127.0.0.1:${E2E_PG_PORT} | minio on 127.0.0.1:${E2E_MINIO_PORT}"

# The web dev server gets a free port too: a fixed :3000 collides with whatever else the agent runs
# there (another shard, another job, a stale dev server), and Playwright's webServer refuses an
# occupied URL under CI=1. Ask the OS for an ephemeral port; playwright.config.ts starts `next dev`
# on PLAYWRIGHT_BASE_URL's port.
E2E_WEB_PORT="$(node -e "const s=require('net').createServer().listen(0,()=>{console.log(s.address().port);s.close()})")"
E2E_WEB_URL="http://localhost:${E2E_WEB_PORT}"
echo "[${TAG}] web dev server on ${E2E_WEB_URL}"

# Several dev servers share this agent's RAM. ci/e2e-shard-plan.sh sizes each one's heap ceiling
# from the agent's RAM and the shard count; the Jenkins stage runs it once (it also caps the shard
# count at what fits) and passes the result as E2E_HEAP_MB. Run by hand without it, plan here — and
# refuse a shard count this agent cannot hold rather than let the OOM killer pick a dev server
# mid-run. A caller's own --max-old-space-size wins.
case "${NODE_OPTIONS:-}" in
  *max-old-space-size*|*max_old_space_size*) ;;
  *)
    if [ -z "${E2E_HEAP_MB:-}" ]; then
      set -- $(sh ci/e2e-shard-plan.sh "${E2E_SHARD_TOTAL}")
      if [ "$1" -lt "${E2E_SHARD_TOTAL}" ]; then
        echo "[${TAG}] this agent's RAM fits $1 e2e shard(s), not ${E2E_SHARD_TOTAL} — lower E2E_SHARD_TOTAL" >&2
        exit 1
      fi
      E2E_HEAP_MB="$2"
    fi
    export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${E2E_HEAP_MB}"
    echo "[${TAG}] dev server heap ceiling: ${E2E_HEAP_MB} MB"
    ;;
esac

# Wait for Postgres readiness. Probe over TCP and query the target database: on first boot the
# official image runs a temporary, socket-only server while it creates POSTGRES_DB, so a bare
# in-container pg_isready can succeed before the `skilly` database exists (flaky
# 'database "skilly" does not exist'). The temp server never listens on TCP.
ready=0
for i in $(seq 1 60); do
  if docker exec "${PG_CONTAINER}" psql -h 127.0.0.1 -U skilly -d skilly -tAc 'select 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
if [ "$ready" != 1 ]; then
  echo "[${TAG}] Postgres did not become ready in time" >&2
  docker logs "${PG_CONTAINER}" >&2 || true
  exit 1
fi

# Least-privilege app role, all migrations, then the DEV seed (dev-admin user + fixtures).
docker exec "${PG_CONTAINER}" psql -U skilly -d skilly -c \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='skilly_app') THEN CREATE ROLE skilly_app LOGIN PASSWORD 'test'; END IF; END \$\$;"
for f in db/migrations/*.sql; do
  echo "[${TAG}] applying $f"
  docker exec -i "${PG_CONTAINER}" psql -U skilly -d skilly -v ON_ERROR_STOP=1 < "$f" >/dev/null
done
docker exec -i "${PG_CONTAINER}" psql -U skilly -d skilly -v ON_ERROR_STOP=1 < db/seed.dev.sql >/dev/null

# Wait for MinIO, then create the artifact bucket the web upload path writes to.
for i in $(seq 1 30); do
  if docker exec "${MINIO_CONTAINER}" mc alias set local http://localhost:9000 skilly "${CI_E2E_MINIO_PASSWORD}" >/dev/null 2>&1 \
     && docker exec "${MINIO_CONTAINER}" mc ready local >/dev/null 2>&1; then break; fi
  sleep 2
done
docker exec "${MINIO_CONTAINER}" mc mb -p local/skilly-artifacts >/dev/null 2>&1 || true

# Provision the seeded skills' serving git repos. The seed deliberately creates HOSTED versions with
# git_published=false whose artifact keys have NO bytes; seed-bundles uploads a minimal valid bundle
# for each, and the publish sweep (normally the worker daemon's job — it does not run here)
# synthesizes the repo/tags and flips the flag. Skip this and every hosted skill sits on the detail
# page's "Publishing this skill…" placeholder: the Install panel never renders and every spec
# driving it fails. publish-once exits non-zero if anything is still unpublished, so the gap fails
# HERE rather than as a confusing suite-wide failure. SKILLY_SPEC.md §6/§9, roadmap item 18.
export GIT_REPO_ROOT="${WORKSPACE}/.ci-e2e-git/shard-${E2E_SHARD}"
rm -rf "${GIT_REPO_ROOT}" && mkdir -p "${GIT_REPO_ROOT}"
( cd packages/worker
  export DATABASE_URL="${CI_E2E_DATABASE_URL}"
  export S3_ENDPOINT="${CI_E2E_S3_ENDPOINT}"
  export S3_ACCESS_KEY=skilly S3_SECRET_KEY="${CI_E2E_MINIO_PASSWORD}" S3_BUCKET=skilly-artifacts
  node scripts/seed-bundles.mjs
  node scripts/publish-once.mjs
)

# Hold the dev server until ci/e2e-prepare.sh is done: browser installed, Typecheck finished.
until [ -f "${WORKSPACE}/.ci-e2e-prepare.done" ]; do
  if [ -f "${WORKSPACE}/.ci-e2e-prepare.failed" ]; then
    echo "[${TAG}] e2e preparation failed (see the prepare branch) — not starting the suite" >&2
    exit 1
  fi
  echo "[${TAG}] stack ready; waiting for the prepare branch (browser install + Typecheck)…"
  sleep 5
done

# Run this shard's slice. Playwright's webServer starts `next dev` (SKILLY_DEV_AUTH=1 is forbidden
# in a production build), inheriting the env below; CI=1 makes it start a fresh server. E2E_SHARD /
# E2E_SHARD_TOTAL select the slice and this shard's own build/result folders (playwright.config.ts);
# E2E_TEST_LIST, when set, narrows the run to the tests that file names.
rm -rf "packages/web/e2e/results/shard-${E2E_SHARD}" "packages/web/e2e/test-results/shard-${E2E_SHARD}"

# A sampled run warms the pages only. Warming every route pins all ~190 in one webpack compiler: a
# fully warmed dev server measured ~9.7 GB private memory under an 8 GB heap ceiling and ~31 min of
# warm-up, and on the 16 GB agent the kernel OOM-killed it mid-warm-up — a quick run that never
# ran a test. The sample's API routes compile on first use instead (e2e/global-setup.ts).
if [ -n "${E2E_TEST_LIST:-}" ]; then E2E_WARM="${E2E_WARM:-pages}"; fi
E2E_WARM="${E2E_WARM:-all}"
echo "[${TAG}] route warm-up scope: ${E2E_WARM}"

# The kernel's running count of OOM kills (/proc/vmstat, readable without root — dmesg often is
# not). Sampled around the run so a dev server the OOM killer took is named as such in the log,
# instead of surfacing only as a wall of ECONNREFUSED test failures. It counts the whole agent, so
# another shard or job being killed shows up here too.
oom_kills() { awk '/^oom_kill / { n = $2 } END { print n + 0 }' /proc/vmstat 2>/dev/null || echo 0; }
OOM_BEFORE="$(oom_kills)"

set +e
SKILLY_DEV_AUTH=1 SKILLY_DEV_OID=dev-admin-oid \
SKILLY_DEV_KEEP_ROUTES=1 LEADERBOARD_CACHE_TTL_MS=0 E2E_WARM="${E2E_WARM}" \
DATABASE_URL="${CI_E2E_DATABASE_URL}" \
NEXTAUTH_SECRET=ci-e2e-not-a-secret NEXTAUTH_URL="${E2E_WEB_URL}" \
AI_TOKEN_ENC_KEY=YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE= \
SKILLY_REGISTRY_URL="${E2E_WEB_URL}" PLAYWRIGHT_BASE_URL="${E2E_WEB_URL}" \
S3_ENDPOINT="${CI_E2E_S3_ENDPOINT}" S3_ACCESS_KEY=skilly S3_SECRET_KEY="${CI_E2E_MINIO_PASSWORD}" S3_BUCKET=skilly-artifacts \
CI=1 \
  pnpm --filter @skilly/web e2e ${E2E_TEST_LIST:+--test-list "${E2E_TEST_LIST}"}
rc=$?
set -e

OOM_AFTER="$(oom_kills)"
if [ "${OOM_AFTER}" -gt "${OOM_BEFORE}" ]; then
  echo "[${TAG}] the kernel OOM-killed $((OOM_AFTER - OOM_BEFORE)) process(es) on this agent while this shard ran." \
    "A killed dev server fails every later test with ECONNREFUSED. With several shards: lower" \
    "E2E_SHARDS, or raise E2E_MIN_HEAP_MB / E2E_SHARD_OVERHEAD_MB so ci/e2e-shard-plan.sh fits fewer." \
    "With one shard, the heap ceiling (${E2E_HEAP_MB:-unset} MB here) does not bound the dev server:" \
    "most of its memory is the pinned route graph (warm-up scope here: ${E2E_WARM}). A run that pins" \
    "every route needs an agent with more RAM, or fewer Verify branches beside it (E2E_MEM_RESERVE_MB)." >&2
fi
exit "${rc}"
