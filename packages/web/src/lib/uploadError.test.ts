// Tests for the bundle-upload error mapping (SKILLY_SPEC.md §6 "Oversize rejection UX").
// Pure functions — no Next runtime needed. Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtSize, bundleUploadError } from "./uploadError";

const MB = 1024 * 1024;

test("fmtSize: KB / MB / GB tiers", () => {
  assert.equal(fmtSize(100 * 1024), "100 KB");
  assert.equal(fmtSize(50 * MB), "50 MB");
  assert.equal(fmtSize(1024 * MB), "1 GB");
});

test("bundleUploadError: a server-provided error string always wins", () => {
  const serverMsg = "the bundle is bigger than the allowed size of 50 MB";
  assert.equal(bundleUploadError(413, serverMsg, 60 * MB), serverMsg);
  assert.equal(bundleUploadError(422, "invalid bundle", 1 * MB), "invalid bundle");
});

test("bundleUploadError: body-less 413 (proxy-origin) quotes the attempted size, not a cap", () => {
  const msg = bundleUploadError(413, undefined, 34 * MB);
  assert.equal(msg, "This bundle (34 MB) is too large for the server to accept. Reduce its size and try again — or contact an administrator.");
  assert.ok(!/HTTP 413/.test(msg), "raw status-code copy must never surface for a 413");
});

test("bundleUploadError: non-string / empty server errors fall through", () => {
  // An HTML error page parsed to {} yields undefined; a malformed body could yield objects.
  assert.match(bundleUploadError(413, { odd: true }, 2 * MB), /This bundle \(2 MB\) is too large/);
  assert.match(bundleUploadError(413, "", 512 * 1024), /This bundle \(512 KB\) is too large/);
});

test("bundleUploadError: other status without a message keeps the generic fallback", () => {
  assert.equal(bundleUploadError(502, undefined, 5 * MB), "Upload failed (HTTP 502).");
});
