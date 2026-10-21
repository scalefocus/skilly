#!/bin/sh
# The once-per-build half of the gated e2e stage. Jenkins runs it as a branch beside the run
# (ci/e2e-run.sh), which provisions Postgres + MinIO meanwhile, then waits for the marker this
# script leaves before it starts the dev server.
#
# Input (env): WORKSPACE. Run from the repo root.
# Leaves ${WORKSPACE}/.ci-e2e-prepare.done on success, ${WORKSPACE}/.ci-e2e-prepare.failed otherwise.
set -eu
. "${HOME}/.asdf/asdf.sh"

: "${WORKSPACE:?}"
trap 'rc=$?; if [ "$rc" -ne 0 ]; then touch "${WORKSPACE}/.ci-e2e-prepare.failed"; fi' EXIT

# Fetch the Chromium browser (+ its OS deps).
pnpm --filter @skilly/web exec playwright install --with-deps chromium

# Wait for the parallel Typecheck branch: `next dev` rewrites packages/web/next-env.d.ts (and
# generates the types folder it imports) on start, and the web `tsc --noEmit` reads both. The e2e
# dev server rewrites it to point at its own build folder (.next-e2e), so it may not start before
# Typecheck is done. Typecheck touches the marker when it finishes (a red Typecheck aborts
# this branch via failFast anyway).
until [ -f "${WORKSPACE}/.ci-typecheck.done" ]; do
  echo "waiting for the Typecheck branch before the dev servers may start…"
  sleep 5
done

touch "${WORKSPACE}/.ci-e2e-prepare.done"
