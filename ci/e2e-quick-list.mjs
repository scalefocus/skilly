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
// Every line names its test's Playwright project (`[project] › file › …`): the suite's projects come
// from e2e/groups.ts, and the Jenkins run executes them in two phases (ci/e2e-run.sh), each loading
// only its own projects, so a line must say which phase's project owns it. SKILLY_SPEC.md §16 item 18.
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
// pnpm writes its own notices to stdout ahead of the report, and one of them may itself open with a
// brace (an agent on an older Node gets `WARN Unsupported engine: wanted: {"node":">=22"} ...`), so
// the report is the first `{` from which the rest of stdout parses as one JSON document.
const parseReport = (stdout) => {
  for (let at = stdout.indexOf("{"); at !== -1; at = stdout.indexOf("{", at + 1)) {
    try {
      return JSON.parse(stdout.slice(at));
    } catch {
      // not the report's opening brace — keep looking
    }
  }
  console.error(stdout, listing.stderr);
  console.error("could not find the Playwright JSON report in the listing output");
  process.exit(1);
};
const report = parseReport(listing.stdout);

// Flatten the report into { file, project, titles, count } per test, titles = describe titles + test
// title. Every spec file belongs to exactly one project (e2e/groups.ts), so a spec's first test names it.
const tests = [];
const walk = (suite, file, titles) => {
  for (const spec of suite.specs ?? []) {
    const project = spec.tests?.[0]?.projectName;
    if (!project) {
      console.error(`no Playwright project listed for ${file} › ${[...titles, spec.title].join(" › ")}`);
      process.exit(1);
    }
    tests.push({ file, project, titles: [...titles, spec.title], count: spec.tests?.length ?? 1 });
  }
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
  const prefix = `[${fileTests[0].project}] › `;
  if (SERIAL.test(source) || fileTests.some((t) => t.titles.some(unsafeTitle))) {
    units.push({ file, line: prefix + file, count: fileTests.reduce((n, t) => n + t.count, 0) });
  } else {
    for (const t of fileTests) units.push({ file, line: prefix + [file, ...t.titles].join(" › "), count: t.count });
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
for (const u of picked) console.log(`  ${u.line}${u.line.endsWith(`] › ${u.file}`) ? `  (whole file, ${u.count} test${u.count === 1 ? "" : "s"})` : ""}`);
