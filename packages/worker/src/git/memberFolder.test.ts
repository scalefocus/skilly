// SKILLY_SPEC.md §73.5 / §30.3: what a marketplace member folder holds, and which rewrites make it
// differ from its version — the input the marketplace sync signs as a variant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeFiles, skillsLockComputedHash } from "@skilly/shared";
import { memberFolder } from "./marketplaceSync.js";
import type { SkillFile } from "./synth.js";

const f = (path: string, body = path): SkillFile => ({ path, bytes: new TextEncoder().encode(body) });

test("memberFolder: a plain bundle is the version itself — no rewrite, nothing to sign", () => {
  const files = [f("SKILL.md"), f("scripts/run.sh"), f("references/a.md")];
  const { rewrites, member } = memberFolder(files, false);
  assert.deepEqual(rewrites, []);
  assert.deepEqual(member.map((m) => m.path), ["SKILL.md", "scripts/run.sh", "references/a.md"]);
});

test("memberFolder: hoisted plugin components leave the folder (marketplace_hoist)", () => {
  const files = [f("SKILL.md"), f("hooks.json"), f("mcp.json"), f("commands/x.md"), f("agents/y.md"), f("scripts/run.sh")];
  const { rewrites, member } = memberFolder(files, false);
  assert.deepEqual(rewrites, ["marketplace_hoist"]);
  assert.deepEqual(member.map((m) => m.path).sort(), ["SKILL.md", "scripts/run.sh"]);
});

test("memberFolder: a deprecated member with components carries both rewrites, sorted", () => {
  const { rewrites } = memberFolder([f("SKILL.md"), f("lsp.json")], true);
  assert.deepEqual(rewrites, ["deprecation", "marketplace_hoist"]);
  assert.deepEqual(memberFolder([f("SKILL.md")], true).rewrites, ["deprecation"]);
});

test("memberFolder: a nested hooks.json is ordinary content, not a component", () => {
  const { rewrites, member } = memberFolder([f("SKILL.md"), f("docs/hooks.json")], false);
  assert.deepEqual(rewrites, []);
  assert.equal(member.length, 2);
});

test("memberFolder: the member's computedHash is what an installed member folder hashes to", async () => {
  const files = [f("SKILL.md", "# x\n"), f("hooks.json", "{}"), f("scripts/run.sh", "echo\n")];
  const { member } = memberFolder(files, false);
  const signed = await describeFiles(member);
  assert.deepEqual(signed.map((s) => s.path), ["SKILL.md", "scripts/run.sh"]);
  assert.equal(await skillsLockComputedHash(member), await skillsLockComputedHash([f("SKILL.md", "# x\n"), f("scripts/run.sh", "echo\n")]));
});
