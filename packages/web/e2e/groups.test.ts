// Keeps the e2e parallelism manifest (groups.ts) whole: SKILLY_SPEC.md §16 item 18. Run by the web
// package's unit `test` script — it reads files only, no browser or stack.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXCLUSIVE, GROUPS, PARALLEL } from "./groups";

const e2eDir = dirname(fileURLToPath(import.meta.url));
const specFiles = readdirSync(e2eDir).filter((f) => f.endsWith(".spec.ts")).sort();

const classified: [string, string][] = [
  ...EXCLUSIVE.map((f): [string, string] => [f, "exclusive"]),
  ...Object.entries(GROUPS).flatMap(([name, g]) => g.specs.map((f): [string, string] => [f, `group-${name}`])),
  ...PARALLEL.map((f): [string, string] => [f, "parallel"]),
];

test("every spec file is classified exactly once", () => {
  const seen = new Map<string, string[]>();
  for (const [file, cls] of classified) seen.set(file, [...(seen.get(file) ?? []), cls]);
  const twice = [...seen].filter(([, classes]) => classes.length > 1).map(([f, c]) => `${f} (${c.join(", ")})`);
  assert.deepEqual(twice, [], `classified more than once in groups.ts: ${twice.join("; ")}`);
  const missing = specFiles.filter((f) => !seen.has(f));
  assert.deepEqual(missing, [], `unclassified spec files — add each to EXCLUSIVE, a group or PARALLEL in groups.ts: ${missing.join(", ")}`);
});

test("every manifest entry names an existing spec file", () => {
  const stale = classified.map(([f]) => f).filter((f) => !specFiles.includes(f));
  assert.deepEqual(stale, [], `groups.ts names spec files that do not exist: ${stale.join(", ")}`);
});

test("every spec that signs in as the dev admin is in the dev-admin group", () => {
  const devAdminGroup = new Set(GROUPS["dev-admin"]?.specs ?? []);
  const asDevAdmin = /as:\s*["'`]dev-admin["'`]/;
  const stray = specFiles.filter((f) => asDevAdmin.test(readFileSync(join(e2eDir, f), "utf-8")) && !devAdminGroup.has(f));
  assert.deepEqual(stray, [], `sign in as the dev admin but are not in GROUPS["dev-admin"]: ${stray.join(", ")}`);
});

test("each group lists its files alphabetically (the order Playwright runs them in)", () => {
  for (const [name, g] of Object.entries(GROUPS)) {
    assert.deepEqual([...g.specs], [...g.specs].sort(), `GROUPS["${name}"] is not in alphabetical order`);
    assert.ok(g.specs.length > 0, `GROUPS["${name}"] is empty`);
    assert.match(name, /^[a-z][a-z0-9-]*$/, `group name "${name}" must be lowercase kebab-case`);
  }
});
