#!/bin/sh
# Fit the requested e2e Playwright worker count to this agent's RAM, and size the dev server's heap.
# SKILLY_SPEC.md §16 item 18.
#
# The Jenkins e2e run (ci/e2e-run.sh) is ONE stack (Postgres + MinIO + one `next dev`) driven by
# E2E_WORKERS Playwright workers, each a headless Chromium of its own. The stack is a fixed cost; each
# worker adds its browser. Asking for more workers than the RAM holds only lowers the dev server's
# heap ceiling until it dies mid-run and every later test fails ECONNREFUSED, so the plan runs as
# many workers as fit, never more than requested, and gives the dev server the heap that is left —
# up to a cap.
#
# The cap matters as much as the floor. --max-old-space-size is not a reservation: V8 defers full
# collections while the heap is far below its ceiling, so a dev server given most of the agent's RAM
# fills it with garbage until the kernel OOM-kills it (a 10.8 GB ceiling on the 16 GB agent did,
# mid-warm-up). A ceiling at E2E_MAX_HEAP_MB makes V8 collect instead.
#
#   budget = MemTotal - E2E_MEM_RESERVE_MB                    (agent JVM, OS, the other Verify branches)
#   heap   = min(E2E_MAX_HEAP_MB, budget - E2E_STACK_OVERHEAD_MB - workers * E2E_WORKER_MB)
#            (stack overhead: Postgres, MinIO, the dev server's memory outside the V8 heap)
#   while heap < E2E_MIN_HEAP_MB and workers > 1: drop one worker
#
# Usage: sh ci/e2e-worker-plan.sh <requested workers>
# Prints "<workers> <heap MB>" on stdout; the reasoning goes to stderr (the build log).
# E2E_MEM_TOTAL_MB overrides the MemTotal read from /proc/meminfo (tests, or a non-Linux shell).
set -eu

REQUESTED="${1:?usage: e2e-worker-plan.sh <requested workers>}"
case "${REQUESTED}" in
  [1-9]|1[0-6]) ;;
  *) echo "[e2e plan] the worker count must be a whole number from 1 to 16 (got '${REQUESTED}')" >&2; exit 1 ;;
esac
RESERVE_MB="${E2E_MEM_RESERVE_MB:-3072}"
STACK_MB="${E2E_STACK_OVERHEAD_MB:-2048}"
WORKER_MB="${E2E_WORKER_MB:-768}"
MIN_HEAP_MB="${E2E_MIN_HEAP_MB:-4096}"
MAX_HEAP_MB="${E2E_MAX_HEAP_MB:-8192}"

TOTAL_MB="${E2E_MEM_TOTAL_MB:-$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo)}"
BUDGET_MB=$((TOTAL_MB - RESERVE_MB))

heap_for() {
  _h=$((BUDGET_MB - STACK_MB - $1 * WORKER_MB))
  [ "${_h}" -le "${MAX_HEAP_MB}" ] || _h="${MAX_HEAP_MB}"
  echo "${_h}"
}

WORKERS="${REQUESTED}"
HEAP_MB="$(heap_for "${WORKERS}")"
while [ "${HEAP_MB}" -lt "${MIN_HEAP_MB}" ] && [ "${WORKERS}" -gt 1 ]; do
  WORKERS=$((WORKERS - 1))
  HEAP_MB="$(heap_for "${WORKERS}")"
done

echo "[e2e plan] agent RAM ${TOTAL_MB} MB, budget ${BUDGET_MB} MB after a ${RESERVE_MB} MB reserve;" \
  "the stack needs ${STACK_MB} MB + a dev server heap of ${MIN_HEAP_MB}-${MAX_HEAP_MB} MB, each worker ${WORKER_MB} MB" >&2
if [ "${WORKERS}" -lt "${REQUESTED}" ]; then
  echo "[e2e plan] E2E_WORKERS=${REQUESTED} does not fit this agent — running ${WORKERS} worker(s) instead" >&2
fi
if [ "${HEAP_MB}" -lt "${MIN_HEAP_MB}" ]; then
  echo "[e2e plan] warning: the dev server heap ceiling is only ${HEAP_MB} MB (wanted ${MIN_HEAP_MB} MB) — expect a heap-limit crash or an OOM kill" >&2
fi
echo "[e2e plan] ${WORKERS} worker(s), dev server heap ceiling ${HEAP_MB} MB (cap ${MAX_HEAP_MB} MB)" >&2
echo "${WORKERS} ${HEAP_MB}"
