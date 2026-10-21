// ci/e2e-worker-plan.sh: how many Playwright workers the Jenkins e2e run gets on an agent of a given
// size, and the dev server's heap ceiling (SKILLY_SPEC.md §16 item 18). Runs the real script with
// E2E_MEM_TOTAL_MB standing in for /proc/meminfo; skipped where no POSIX `sh` is on the PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "ci", "e2e-worker-plan.sh");
const hasSh = spawnSync("sh", ["-c", "exit 0"]).status === 0;

function plan(requested: string, totalMb: number, env: Record<string, string> = {}) {
  const r = spawnSync("sh", [script, requested], {
    encoding: "utf-8",
    env: { ...process.env, E2E_MEM_TOTAL_MB: String(totalMb), ...env },
  });
  return { status: r.status, out: r.stdout.trim(), log: r.stderr };
}

test("a 16 GB agent fits the default 4 workers at the full 8 GB heap", { skip: !hasSh }, () => {
  // budget 16384 - 3072 = 13312; 13312 - 2048 - 4 * 768 = 8192
  assert.equal(plan("4", 16384).out, "4 8192");
});

test("more workers than fit are dropped one at a time until the heap reaches its floor", { skip: !hasSh }, () => {
  // 16 workers: 13312 - 2048 - 16 * 768 < 4096; 9 workers: 13312 - 2048 - 6912 = 4352 >= 4096
  const r = plan("16", 16384);
  assert.equal(r.out, "9 4352");
  assert.match(r.log, /E2E_WORKERS=16 does not fit this agent — running 9 worker\(s\) instead/);
});

test("the heap is capped at E2E_MAX_HEAP_MB on a large agent", { skip: !hasSh }, () => {
  assert.equal(plan("4", 65536).out, "4 8192");
});

test("never below one worker, with a warning when even one does not fit", { skip: !hasSh }, () => {
  const r = plan("4", 8192);
  // budget 5120; 5120 - 2048 - 768 = 2304 < 4096 even at one worker
  assert.equal(r.out, "1 2304");
  assert.match(r.log, /warning: the dev server heap ceiling is only 2304 MB/);
});

test("the sizes are overridable", { skip: !hasSh }, () => {
  assert.equal(plan("4", 16384, { E2E_WORKER_MB: "1024" }).out, "4 7168");
});

test("a worker count outside 1-16 is refused", { skip: !hasSh }, () => {
  for (const bad of ["0", "17", "x", "-1", "4.5"]) {
    const r = plan(bad, 16384);
    assert.notEqual(r.status, 0, bad);
    assert.match(r.log, /whole number from 1 to 16/, bad);
  }
});
