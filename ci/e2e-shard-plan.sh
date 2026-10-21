#!/bin/sh
# Fit the requested e2e shard count to this agent's RAM, and size each shard's dev-server heap.
#
# Every shard runs a full stack (Postgres + MinIO + Chromium + `next dev`), and every shard's dev
# server warms the pages + core API routes (global-setup.ts), so its memory does not shrink in step
# with its slice of the suite: under webpack, which kept every compiled route in memory, one fully
# warmed dev server was measured past ~6.4 GB of heap. The dev server now runs Turbopack with its
# e2e memory eviction (next.config.mjs, SKILLY_E2E_DEV_SERVER) and needs far less; the defaults
# below still carry the webpack-era sizes until a CI run has re-measured them.
# Splitting a fixed RAM budget across more shards than fit only lowers each ceiling until the
# kernel's OOM killer takes a dev server mid-run, and every later test then fails ECONNREFUSED.
# So: run as many shards as fit, never more than requested, and give each the heap that is left —
# up to a cap.
#
# The cap matters as much as the floor. --max-old-space-size is not a reservation: V8 defers full
# collections while the heap is far below its ceiling, so a dev server given most of the agent's
# RAM fills it with garbage, and its RSS (heap + bundler/SWC memory outside the heap) passes
# physical RAM long before V8 thinks it is short. On the 16 GB agent a single shard given 10.8 GB
# was OOM-killed by the kernel mid-warm-up, where Next's own 8 GB default had never drawn a kill.
# A ceiling at E2E_MAX_HEAP_MB makes V8 collect instead, and if the live set ever truly outgrows
# it the dev server dies with a "heap out of memory" message in the log rather than a silent kill.
#
#   budget = MemTotal - E2E_MEM_RESERVE_MB         (agent JVM, OS, the other Verify branches)
#   fit    = budget / (E2E_MIN_HEAP_MB + E2E_SHARD_OVERHEAD_MB)   (at least 1)
#   shards = min(requested, fit)
#   heap   = min(budget / shards - E2E_SHARD_OVERHEAD_MB, E2E_MAX_HEAP_MB)
#            (overhead: Postgres, MinIO, Chromium, the dev server's memory outside the V8 heap)
#
# Usage: sh ci/e2e-shard-plan.sh <requested shards>
# Prints "<shards> <heap MB>" on stdout; the reasoning goes to stderr (the build log).
set -eu

REQUESTED="${1:?usage: e2e-shard-plan.sh <requested shards>}"
RESERVE_MB="${E2E_MEM_RESERVE_MB:-3072}"
OVERHEAD_MB="${E2E_SHARD_OVERHEAD_MB:-2048}"
MIN_HEAP_MB="${E2E_MIN_HEAP_MB:-7168}"
MAX_HEAP_MB="${E2E_MAX_HEAP_MB:-8192}"

TOTAL_MB="$(awk '/^MemTotal:/ { printf "%d", $2 / 1024 }' /proc/meminfo)"
BUDGET_MB=$((TOTAL_MB - RESERVE_MB))
FIT=$((BUDGET_MB / (MIN_HEAP_MB + OVERHEAD_MB)))
[ "${FIT}" -ge 1 ] || FIT=1
SHARDS="${REQUESTED}"
[ "${SHARDS}" -le "${FIT}" ] || SHARDS="${FIT}"
HEAP_MB=$((BUDGET_MB / SHARDS - OVERHEAD_MB))
[ "${HEAP_MB}" -le "${MAX_HEAP_MB}" ] || HEAP_MB="${MAX_HEAP_MB}"

echo "[e2e plan] agent RAM ${TOTAL_MB} MB, budget ${BUDGET_MB} MB after a ${RESERVE_MB} MB reserve;" \
  "a shard needs ${MIN_HEAP_MB} MB heap + ${OVERHEAD_MB} MB overhead, so ${FIT} fit" >&2
if [ "${SHARDS}" -lt "${REQUESTED}" ]; then
  echo "[e2e plan] E2E_SHARDS=${REQUESTED} does not fit this agent — running ${SHARDS} shard(s) instead" >&2
fi
if [ "${HEAP_MB}" -lt "${MIN_HEAP_MB}" ]; then
  echo "[e2e plan] warning: the dev server heap ceiling is only ${HEAP_MB} MB (wanted ${MIN_HEAP_MB} MB) — expect a heap-limit crash or an OOM kill" >&2
fi
echo "[e2e plan] ${SHARDS} shard(s), dev server heap ceiling ${HEAP_MB} MB each (cap ${MAX_HEAP_MB} MB)" >&2
echo "${SHARDS} ${HEAP_MB}"
