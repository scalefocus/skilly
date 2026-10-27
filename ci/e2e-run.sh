#!/bin/sh
# The gated Playwright e2e suite on ONE stack with parallel workers (SKILLY_SPEC.md §16 item 18): an
# ephemeral Postgres + MinIO (Docker-assigned loopback ports), one serving-git root, ONE `next dev`
# on a free port, and Playwright driving it with E2E_WORKERS workers. The Jenkins `E2E tests` stage
# runs this on its own: it installs the browser and waits for the Typecheck branch itself.
#
# The suite runs in two phases against the same server and database (projects: e2e/groups.ts):
#   1. exclusive — specs that change state every other spec can see (platform settings, AI config,
#      role mappings, …), one worker, nothing alongside;
#   2. shared    — every group (one worker each, files in order) and the fully parallel class.
# Each Playwright worker signs in as its own seeded user (E2E_WORKER_USERS=1, db/seed.e2e.sql).
# Both phases always run, so a red phase 1 still reports phase 2; the script fails if either did.
#
# Inputs (env):
#   E2E_WORKERS                   Playwright workers, 1-16 (the Jenkins stage passes the planned count)
#   E2E_HEAP_MB                   dev server heap ceiling (optional; ci/e2e-worker-plan.sh sizes it)
#   E2E_TEST_LIST                 optional: absolute path of a Playwright --test-list file; only
#                                 those tests run (the quick e2e sample, ci/e2e-quick-list.mjs)
#   E2E_WARM                      optional route warm-up scope, all | core | pages
#                                 (e2e/global-setup.ts); defaults to core
#   BUILD_TAG, WORKSPACE          Jenkins build identity + checkout root
#   CI_PG_IMAGES, CI_MINIO_IMAGES space-separated image candidate lists (first reachable wins)
#   CI_E2E_PG_CONTAINER, CI_E2E_MINIO_CONTAINER, CI_E2E_MINIO_PASSWORD
#
# Every container carries the label skilly-ci-e2e=<BUILD_TAG>, so the stage's cleanup removes them.
# Run from the repo root.
set -eu
. "${HOME}/.asdf/asdf.sh"

: "${E2E_WORKERS:?}" "${BUILD_TAG:?}" "${WORKSPACE:?}"
case "${E2E_WORKERS}" in
  [1-9]|1[0-6]) ;;
  *) echo "[e2e] E2E_WORKERS must be a whole number from 1 to 16 (got '${E2E_WORKERS}')" >&2; exit 1 ;;
esac
PG_CONTAINER="${CI_E2E_PG_CONTAINER}"
MINIO_CONTAINER="${CI_E2E_MINIO_CONTAINER}"
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

# Fetch the Chromium browser (+ its OS deps) before anything else: a missing browser fails the stage
# here, before a stack is provisioned. On a warm agent Playwright's cache makes this a no-op.
pnpm --filter @skilly/web exec playwright install --with-deps chromium

PG_IMAGE="$(resolve_image "${CI_PG_IMAGES}")"
MINIO_IMAGE="$(resolve_image "${CI_MINIO_IMAGES}")"
echo "[e2e] postgres image: ${PG_IMAGE} | minio image: ${MINIO_IMAGE}"

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
echo "[e2e] postgres on 127.0.0.1:${E2E_PG_PORT} | minio on 127.0.0.1:${E2E_MINIO_PORT}"

# The dev server's heap ceiling. The Jenkins stage plans it (ci/e2e-worker-plan.sh, which also caps
# the worker count) and passes E2E_HEAP_MB. Run by hand without it, plan here, and refuse a worker
# count this agent cannot hold rather than let the OOM killer pick the dev server mid-run. A
# caller's own --max-old-space-size wins.
case "${NODE_OPTIONS:-}" in
  *max-old-space-size*|*max_old_space_size*) ;;
  *)
    if [ -z "${E2E_HEAP_MB:-}" ]; then
      set -- $(sh ci/e2e-worker-plan.sh "${E2E_WORKERS}")
      if [ "$1" -lt "${E2E_WORKERS}" ]; then
        echo "[e2e] this agent's RAM fits $1 worker(s), not ${E2E_WORKERS} — lower E2E_WORKERS" >&2
        exit 1
      fi
      E2E_HEAP_MB="$2"
    fi
    export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${E2E_HEAP_MB}"
    echo "[e2e] dev server heap ceiling: ${E2E_HEAP_MB} MB"
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
  echo "[e2e] Postgres did not become ready in time" >&2
  docker logs "${PG_CONTAINER}" >&2 || true
  exit 1
fi

# Least-privilege app role, all migrations, the DEV seed (dev-admin user + fixtures), then the E2E
# seed: one platform-admin user per Playwright worker (db/seed.e2e.sql — e2e stacks only).
docker exec "${PG_CONTAINER}" psql -U skilly -d skilly -c \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='skilly_app') THEN CREATE ROLE skilly_app LOGIN PASSWORD 'test'; END IF; END \$\$;"
for f in db/migrations/*.sql; do
  echo "[e2e] applying $f"
  docker exec -i "${PG_CONTAINER}" psql -U skilly -d skilly -v ON_ERROR_STOP=1 < "$f" >/dev/null
done
docker exec -i "${PG_CONTAINER}" psql -U skilly -d skilly -v ON_ERROR_STOP=1 < db/seed.dev.sql >/dev/null
docker exec -i "${PG_CONTAINER}" psql -U skilly -d skilly -v ON_ERROR_STOP=1 < db/seed.e2e.sql >/dev/null

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
export GIT_REPO_ROOT="${WORKSPACE}/.ci-e2e-git"
rm -rf "${GIT_REPO_ROOT}" && mkdir -p "${GIT_REPO_ROOT}"
( cd packages/worker
  export DATABASE_URL="${CI_E2E_DATABASE_URL}"
  export S3_ENDPOINT="${CI_E2E_S3_ENDPOINT}"
  export S3_ACCESS_KEY=skilly S3_SECRET_KEY="${CI_E2E_MINIO_PASSWORD}" S3_BUCKET=skilly-artifacts
  node scripts/seed-bundles.mjs
  node scripts/publish-once.mjs
)

# Hold the dev server until the parallel Typecheck branch is done: `next dev` rewrites
# packages/web/next-env.d.ts (and generates the types folder it imports) on start, and the web
# `tsc --noEmit` reads both. The e2e dev server rewrites it to point at its own build folder
# (.next-e2e), so it may not start before Typecheck is done. Typecheck touches the marker when it
# finishes, pass or fail (a red Typecheck aborts this branch via failFast anyway).
until [ -f "${WORKSPACE}/.ci-typecheck.done" ]; do
  echo "[e2e] stack ready; waiting for the Typecheck branch before the dev server may start…"
  sleep 5
done

rm -rf packages/web/e2e/results/exclusive packages/web/e2e/results/shared \
  packages/web/e2e/test-results/exclusive packages/web/e2e/test-results/shared
mkdir -p packages/web/e2e/test-results

# Every run warms the pages plus the core API routes (e2e/global-setup.ts); the other API routes
# compile on first use. The dev server runs Turbopack with full memory eviction, so warmed routes
# live in the build folder's disk cache, not in memory.
E2E_WARM="${E2E_WARM:-core}"
echo "[e2e] route warm-up scope: ${E2E_WARM}"

# The kernel's running count of OOM kills (/proc/vmstat, readable without root — dmesg often is
# not). Sampled around the run so a dev server the OOM killer took is named as such in the log,
# instead of surfacing only as a wall of ECONNREFUSED test failures. It counts the whole agent.
oom_kills() { awk '/^oom_kill / { n = $2 } END { print n + 0 }' /proc/vmstat 2>/dev/null || echo 0; }

# The ONE dev server both phases drive. Started here, not by Playwright's webServer, which would
# start (and tear down) a fresh one per invocation; E2E_EXTERNAL_SERVER=1 makes the config reuse
# it. A free port, because a fixed :3000 collides with whatever else the agent runs. Its own build
# folder (.next-e2e) and the env the Playwright webServer would give it (e2e/playwright.config.ts).
# Started in a session of its own (setsid) so stopping it stops `next` and its children too.
E2E_WEB_PORT="$(node -e "const s=require('net').createServer().listen(0,()=>{console.log(s.address().port);s.close()})")"
E2E_WEB_URL="http://localhost:${E2E_WEB_PORT}"
DEV_LOG="packages/web/e2e/test-results/dev-server.log"
export SKILLY_DEV_AUTH=1 SKILLY_DEV_OID=dev-admin-oid SKILLY_E2E_DEV_SERVER=1 LEADERBOARD_CACHE_TTL_MS=0
export INSTALL_TOKEN_ENC_KEY="${INSTALL_TOKEN_ENC_KEY:-c2tpbGx5LWUyZS1pbnN0YWxsLXRva2VuLWtleS0zMmI=}"
export DATABASE_URL="${CI_E2E_DATABASE_URL}"
export NEXTAUTH_SECRET=ci-e2e-not-a-secret NEXTAUTH_URL="${E2E_WEB_URL}"
export AI_TOKEN_ENC_KEY=YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=
# The AI specs stand up an Open WebUI-shaped stub provider on 127.0.0.1 inside the test process;
# the §49.11 egress guard refuses a private/loopback base URL unless the operator opts in.
export AI_ALLOW_PRIVATE_BASE_URL=1
export SKILLY_REGISTRY_URL="${E2E_WEB_URL}" PLAYWRIGHT_BASE_URL="${E2E_WEB_URL}"
export S3_ENDPOINT="${CI_E2E_S3_ENDPOINT}" S3_ACCESS_KEY=skilly S3_SECRET_KEY="${CI_E2E_MINIO_PASSWORD}" S3_BUCKET=skilly-artifacts
echo "[e2e] web dev server on ${E2E_WEB_URL} (log: ${DEV_LOG})"
OOM_BEFORE="$(oom_kills)"
SKILLY_NEXT_DIST_DIR=.next-e2e setsid pnpm --filter @skilly/web exec next dev --turbopack -p "${E2E_WEB_PORT}" > "${DEV_LOG}" 2>&1 &
DEV_PID=$!
stop_dev_server() { kill -TERM -- "-${DEV_PID}" 2>/dev/null || kill -TERM "${DEV_PID}" 2>/dev/null || true; }
trap stop_dev_server EXIT

server_up() { kill -0 "${DEV_PID}" 2>/dev/null; }
up=0
for i in $(seq 1 150); do
  if ! server_up; then break; fi
  if node -e "fetch(process.argv[1]).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))" "${E2E_WEB_URL}/healthz"; then up=1; break; fi
  sleep 2
done
if [ "${up}" != 1 ]; then
  echo "[e2e] the dev server did not come up on ${E2E_WEB_URL} — last lines of its log:" >&2
  tail -n 60 "${DEV_LOG}" >&2 || true
  exit 1
fi
echo "[e2e] dev server up"

# One phase: one Playwright invocation against the running server. --pass-with-no-tests so a quick
# sample with no test in a phase does not fail it.
run_phase() {
  echo "[e2e] phase ${1}: ${E2E_WORKERS} worker(s)"
  E2E_PHASE="$1" E2E_EXTERNAL_SERVER=1 E2E_WORKER_USERS=1 E2E_WORKERS="${E2E_WORKERS}" E2E_WARM="${E2E_WARM}" CI=1 \
    pnpm --filter @skilly/web e2e --pass-with-no-tests ${E2E_TEST_LIST:+--test-list "${E2E_TEST_LIST}"}
}
check_server() {
  if ! server_up; then
    echo "[e2e] the dev server has exited (${2}) — last lines of its log:" >&2
    tail -n 60 "${DEV_LOG}" >&2 || true
  fi
}

rc=0
set +e
run_phase exclusive || rc=$?
check_server exclusive "after phase 1"
run_phase shared || rc=$?
check_server shared "after phase 2"
set -e

OOM_AFTER="$(oom_kills)"
if [ "${OOM_AFTER}" -gt "${OOM_BEFORE}" ]; then
  echo "[e2e] the kernel OOM-killed $((OOM_AFTER - OOM_BEFORE)) process(es) on this agent during the run." \
    "A killed dev server fails every later test with ECONNREFUSED. Lower E2E_WORKERS, or raise" \
    "E2E_WORKER_MB / E2E_STACK_OVERHEAD_MB so ci/e2e-worker-plan.sh fits fewer workers. The heap ceiling" \
    "(${E2E_HEAP_MB:-unset} MB here) does not bound the dev server: most of its memory is Turbopack's native" \
    "memory outside the V8 heap (warm-up scope here: ${E2E_WARM})." >&2
fi
exit "${rc}"
