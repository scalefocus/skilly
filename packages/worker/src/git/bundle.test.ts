// Verifies a tar.gz artifact extracts into the file list synthesizeVersion expects.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "tar";
import AdmZip from "adm-zip";
import { extractBundle } from "./bundle.js";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "skilly-bundletest-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("extracts a tar.gz bundle into SkillFiles with paths and exec bits", async () => {
  const src = join(dir, "src");
  await mkdir(join(src, "scripts"), { recursive: true });
  await writeFile(join(src, "SKILL.md"), "---\nname: demo\ndescription: x\n---\n");
  await writeFile(join(src, "scripts", "run.sh"), "echo hi\n");

  const archive = join(dir, "bundle.tgz");
  await create({ gzip: true, file: archive, cwd: src }, ["."]);
  const buf = await (await import("node:fs/promises")).readFile(archive);

  const files = await extractBundle(buf);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));

  assert.ok(byPath["SKILL.md"], "SKILL.md present");
  assert.ok(byPath["scripts/run.sh"], "nested script present");
  assert.equal(byPath["scripts/run.sh"]!.mode, "100755", "script marked executable");
  assert.equal(Buffer.from(byPath["SKILL.md"]!.bytes).toString("utf8").includes("name: demo"), true);
});

test("extracts a .zip/.skill bundle and strips the wrapper directory", async () => {
  const zip = new AdmZip();
  zip.addFile("pdf-tools/SKILL.md", Buffer.from("---\nname: pdf-tools\ndescription: x\n---\n"));
  zip.addFile("pdf-tools/scripts/run.sh", Buffer.from("echo hi\n"));
  zip.addFile("__MACOSX/junk", Buffer.from("x")); // junk entry should be dropped
  const buf = zip.toBuffer();

  const files = await extractBundle(buf);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["SKILL.md", "scripts/run.sh"]); // wrapper stripped, junk dropped
  assert.equal(files.find((f) => f.path === "scripts/run.sh")!.mode, "100755");
});
