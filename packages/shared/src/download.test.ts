import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadExtFromFilename, fallbackDownloadExt, resolveDownloadExt, downloadContentType } from "./download.js";

test("extracts the original extension from a filename", () => {
  assert.equal(downloadExtFromFilename("my-skill.skill"), "skill");
  assert.equal(downloadExtFromFilename("Bundle.ZIP"), "zip");
  assert.equal(downloadExtFromFilename("archive.tar.gz"), "tar.gz"); // compound ext wins over last-dot
  assert.equal(downloadExtFromFilename("archive.tgz"), "tgz");
  assert.equal(downloadExtFromFilename("plain.tar"), "tar");
});

test("returns null for missing or unrecognized filenames", () => {
  assert.equal(downloadExtFromFilename(undefined), null);
  assert.equal(downloadExtFromFilename(null), null);
  assert.equal(downloadExtFromFilename(""), null);
  assert.equal(downloadExtFromFilename("noextension"), null);
  assert.equal(downloadExtFromFilename("report.pdf"), null); // not a bundle extension
});

test("fallback prefers tar.gz for pointers, else the harness", () => {
  assert.equal(fallbackDownloadExt({ isPointer: true, toolHarness: "claude-code" }), "tar.gz");
  assert.equal(fallbackDownloadExt({ toolHarness: "claude-code" }), "skill");
  assert.equal(fallbackDownloadExt({ toolHarness: "cursor" }), "zip");
  assert.equal(fallbackDownloadExt({}), "zip");
});

test("resolveDownloadExt prefers the recorded filename over the fallback", () => {
  // A .skill upload on a non-claude-code skill must still download as .skill (the bug being fixed).
  assert.equal(resolveDownloadExt({ artifactFilename: "x.skill", toolHarness: "cursor" }), "skill");
  // No filename → fallback applies.
  assert.equal(resolveDownloadExt({ artifactFilename: null, toolHarness: "claude-code" }), "skill");
  assert.equal(resolveDownloadExt({ isPointer: true }), "tar.gz");
});

test("maps extensions to MIME types", () => {
  assert.equal(downloadContentType("zip"), "application/zip");
  assert.equal(downloadContentType("tar.gz"), "application/gzip");
  assert.equal(downloadContentType("tgz"), "application/gzip");
  assert.equal(downloadContentType("tar"), "application/x-tar");
  assert.equal(downloadContentType("skill"), "application/octet-stream");
});
