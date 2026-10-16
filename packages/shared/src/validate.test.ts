import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBundle, parseFrontmatter, isSafeRelativePath, type BundleEntry } from "./validate.js";

const enc = (s: string) => new TextEncoder().encode(s);
const skillMd = (name: string, desc = "d") => enc(`---\nname: ${name}\ndescription: ${desc}\n---\n# x\n`);

test("parses frontmatter name/description", () => {
  const fm = parseFrontmatter("---\nname: pdf-tools\ndescription: \"work with pdfs\"\n---\nbody");
  assert.equal(fm.name, "pdf-tools");
  assert.equal(fm.description, "work with pdfs");
});

test("parseFrontmatter resists ReDoS on adversarial lines (js/polynomial-redos)", () => {
  const evilLine = "-:" + " ".repeat(200_000);
  const md = `---\n${evilLine}\nname: ok\n---\nbody`;
  const start = Date.now();
  const fm = parseFrontmatter(md);
  assert.ok(Date.now() - start < 1000, "parseFrontmatter must run in linear time on adversarial input");
  assert.equal(fm.name, "ok");
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

test("entry names that could inject git tree records are unsafe paths (§6 safe entry paths, §22)", () => {
  // The exact V2 shape: a newline ends the `git mktree` record and the rest reads as a 120000
  // symlink entry — refused at ingest, long before the worker ever writes a tree.
  const injected = "notes.md\n120000 blob e69de29bb2d1d6434b8b29ae775ad8c2e48c5391\tscripts";
  const r = validateBundle(
    [
      { path: "SKILL.md", bytes: skillMd("pdf") },
      { path: injected, bytes: enc("x") },
      { path: "docs\\notes.md", bytes: enc("x") },
      { path: "a\tb.md", bytes: enc("x") },
      { path: "/abs.md", bytes: enc("x") },
      { path: "./rel.md", bytes: enc("x") },
      { path: "a//b.md", bytes: enc("x") },
    ],
    { skillSlug: "pdf" },
  );
  assert.equal(r.ok, false);
  const unsafe = r.errors.filter((e) => /^unsafe path/.test(e));
  assert.equal(unsafe.length, 6, unsafe.join(" | "));
  assert.ok(unsafe.some((e) => e.includes("\\n120000")), "the control character is shown escaped, not raw");
});

test("isSafeRelativePath: plain nested names pass; control bytes, backslash, leading slash and dot segments fail", () => {
  for (const ok of ["SKILL.md", "scripts/run.sh", "docs/read me.md", "a.b/c-d_e.txt", "ünïcödé/файл.md"]) {
    assert.equal(isSafeRelativePath(ok), true, ok);
  }
  for (const bad of ["", "/x", "a\\b", "a\nb", "a\rb", "a\tb", "a\0b", "a\x7fb", ".", "..", "a/..", "a/./b", "a//b", "a/"]) {
    assert.equal(isSafeRelativePath(bad), false, JSON.stringify(bad));
  }
});
