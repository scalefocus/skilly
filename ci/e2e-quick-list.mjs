#!/usr/bin/env node
// Picks the random sample of e2e tests a QUICK e2e run executes (Jenkins E2E_TESTS=QUICK_E2E_TESTS):
// about 10% of the suite, written as a Playwright --test-list file (https://playwright.dev/docs/test-cli).
//
// Usage (from the repo root):  node ci/e2e-quick-list.mjs <out-file> [fraction=0.1]
// Then:                        pnpm --filter @skilly/web e2e --test-list <absolute out-file>
//
// The sample is drawn in UNITS, not raw tests, so it never breaks a test's preconditions:
//   - a spec file with any serial group (`test.describe.serial`, `mode: "serial"`) is ONE unit — its
//     tests build on one another, so it runs whole or not at all;
//   - every other test is a unit of its own (the suite is fullyParallel, so those are independent).
// Units are shuffled and taken while they still fit under the target count, so the sample lands on
// the target exactly unless only oversized units are left; then the smallest one tops it up.
import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [outArg, fractionArg = "0.1"] = process.argv.slice(2);
const fraction = Number(fractionArg);
if (!outArg || !(fraction > 0 && fraction <= 1)) {
  console.error("usage: node ci/e2e-quick-list.mjs <out-file> [fraction in (0,1], default 0.1]");
  process.exit(2);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const e2eDir = join(repoRoot, "packages", "web", "e2e");

// Enumerate the suite without running it: --list loads the config + specs only (no globalSetup, no
// webServer, no browser). Spec paths in the report are relative to the config's rootDir (e2eDir).
// (Windows only resolves pnpm's .cmd shim through a shell, which takes one command string.)
const listArgs = ["--filter", "@skilly/web", "exec", "playwright", "test", "-c", "e2e/playwright.config.ts", "--list", "--reporter=json"];
const spawnOpts = { cwd: repoRoot, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 };
const listing =
  process.platform === "win32"
    ? spawnSync(["pnpm", ...listArgs].join(" "), { ...spawnOpts, shell: true })
    : spawnSync("pnpm", listArgs, spawnOpts);
if (listing.status !== 0) {
  console.error(listing.stdout, listing.stderr);
  console.error("could not list the e2e suite");
  process.exit(1);
}
const report = JSON.parse(listing.stdout.slice(listing.stdout.indexOf("{")));

// Flatten the report into { file, titles, count } per test, titles = describe titles + test title.
const tests = [];
const walk = (suite, file, titles) => {
  for (const spec of suite.specs ?? []) tests.push({ file, titles: [...titles, spec.title], count: spec.tests?.length ?? 1 });
  for (const child of suite.suites ?? []) walk(child, file, child.title ? [...titles, child.title] : titles);
};
for (const fileSuite of report.suites ?? []) walk(fileSuite, fileSuite.file, []);
const total = tests.reduce((n, t) => n + t.count, 0);
if (total === 0) {
  console.error("the e2e suite listed no tests");
  process.exit(1);
}

// A per-test line is `file › describe › title`, matched by exact title prefix. A title the format
// can't carry (one containing the delimiter, or padded with whitespace the parser trims) makes its
// whole file one unit instead.
const SERIAL = /describe\.serial\b|mode:\s*["'`]serial["'`]/;
const unsafeTitle = (t) => t.includes("›") || t !== t.trim();
const byFile = new Map();
for (const t of tests) byFile.set(t.file, [...(byFile.get(t.file) ?? []), t]);
const units = [];
for (const [file, fileTests] of byFile) {
  const source = readFileSync(join(e2eDir, file), "utf-8");
  if (SERIAL.test(source) || fileTests.some((t) => t.titles.some(unsafeTitle))) {
    units.push({ file, line: file, count: fileTests.reduce((n, t) => n + t.count, 0) });
  } else {
    for (const t of fileTests) units.push({ file, line: [file, ...t.titles].join(" › "), count: t.count });
  }
}

// Fisher-Yates shuffle, then fill up to the target.
for (let i = units.length - 1; i > 0; i--) {
  const j = randomInt(i + 1);
  [units[i], units[j]] = [units[j], units[i]];
}
const target = Math.max(1, Math.ceil(total * fraction));
const picked = [];
let count = 0;
for (const u of units) {
  if (count >= target) break;
  if (count + u.count <= target) {
    picked.push(u);
    count += u.count;
  }
}
if (count < target) {
  const smallest = units.filter((u) => !picked.includes(u)).sort((a, b) => a.count - b.count)[0];
  if (smallest) {
    picked.push(smallest);
    count += smallest.count;
  }
}

picked.sort((a, b) => a.line.localeCompare(b.line));
const out = resolve(outArg);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  [`# quick e2e: ${count} of ${total} tests (${Math.round((count / total) * 100)}%), random sample`, ...picked.map((u) => u.line), ""].join("\n"),
);
console.log(`quick e2e: ${count} of ${total} tests from ${new Set(picked.map((u) => u.file)).size} spec files → ${out}`);
for (const u of picked) console.log(`  ${u.line}${u.line === u.file ? `  (whole file, ${u.count} test${u.count === 1 ? "" : "s"})` : ""}`);
