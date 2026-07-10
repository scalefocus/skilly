import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBundle, parseFrontmatter, type BundleEntry } from "./validate.js";

const enc = (s: string) => new TextEncoder().encode(s);
const skillMd = (name: string, desc = "d") => enc(`---\nname: ${name}\ndescription: ${desc}\n---\n# x\n`);

test("parses frontmatter name/description", () => {
  const fm = parseFrontmatter("---\nname: pdf-tools\ndescription: \"work with pdfs\"\n---\nbody");
  assert.equal(fm.name, "pdf-tools");
  assert.equal(fm.description, "work with pdfs");
});

test("valid bundle passes", () => {
  const files: BundleEntry[] = [
    { path: "SKILL.md", bytes: skillMd("pdf") },
    { path: "scripts/run.sh", bytes: enc("echo hi\n") },
  ];
  assert.deepEqual(validateBundle(files, { skillSlug: "pdf" }), { ok: true, errors: [] });
});

test("missing SKILL.md fails", () => {
  const r = validateBundle([{ path: "readme.txt", bytes: enc("x") }], { skillSlug: "pdf" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /SKILL\.md/.test(e)));
});

test("name must match slug", () => {
  const r = validateBundle([{ path: "SKILL.md", bytes: skillMd("other") }], { skillSlug: "pdf" });
  assert.ok(r.errors.some((e) => /must match the skill slug/.test(e)));
});

test("missing required frontmatter fields", () => {
  const r = validateBundle([{ path: "SKILL.md", bytes: enc("---\nname: pdf\n---\n") }], { skillSlug: "pdf" });
  assert.ok(r.errors.some((e) => /description/.test(e)));
});

test("disallowed binary + traversal + size", () => {
  const big = new Uint8Array(11 * 1024 * 1024);
  const r = validateBundle(
    [
      { path: "SKILL.md", bytes: skillMd("pdf") },
      { path: "evil.exe", bytes: enc("MZ") },
      { path: "../escape.txt", bytes: enc("x") },
      { path: "big.dat", bytes: big },
    ],
    { skillSlug: "pdf" },
  );
  assert.ok(r.errors.some((e) => /disallowed file type/.test(e)));
  assert.ok(r.errors.some((e) => /unsafe path/.test(e)));
  assert.ok(r.errors.some((e) => /size limit/.test(e)));
});
