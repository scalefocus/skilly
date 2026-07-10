import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePointerUrl, validateGitRef, validateSubdir, slugFromSubdir, isBlockedIp } from "./net.js";

test("validatePointerUrl accepts public https hosts", () => {
  assert.equal(validatePointerUrl("https://github.com/acme/skill.git"), null);
  assert.equal(validatePointerUrl("https://gitlab.example.com/team/repo.git"), null);
});

test("validatePointerUrl rejects non-https and dangerous schemes", () => {
  for (const u of [
    "http://github.com/x.git",
    "file:///etc/passwd",
    "git://github.com/x.git",
    "ssh://git@github.com/x.git",
    "ext::sh -c whoami",
  ]) {
    assert.ok(validatePointerUrl(u), `should reject ${u}`);
  }
});

test("validatePointerUrl blocks SSRF targets", () => {
  for (const u of [
    "https://localhost/x.git",
    "https://127.0.0.1/x.git",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.5/x.git",
    "https://172.16.4.4/x.git",
    "https://192.168.1.1/x.git",
    "https://metadata/x.git", // bare single-label host
    "https://[::1]/x.git",
    "https://foo.internal/x.git",
    "https://user:pass@github.com/x.git", // embedded creds
    // bypass classes (audit P0-1):
    "https://[::ffff:169.254.169.254]/x.git", // IPv4-mapped IPv6 → metadata
    "https://[::ffff:127.0.0.1]/x.git",        // IPv4-mapped IPv6 → loopback
    "https://[::ffff:7f00:1]/x.git",           // hex-packed IPv4-mapped loopback
    "https://localhost./x.git",                // trailing FQDN-root dot
    "https://metadata.google.internal./x.git", // trailing dot + .internal
    "https://[fd00::1]/x.git",                  // ULA
    "https://[fe80::1]/x.git",                  // link-local
    "https://2130706433/x.git",                 // decimal-encoded 127.0.0.1
    "https://0x7f.0.0.1/x.git",                 // hex-octet loopback
  ]) {
    assert.ok(validatePointerUrl(u), `should reject ${u}`);
  }
});

test("isBlockedIp classifies resolved addresses (DNS-rebinding defense)", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.1", "::1", "fd12::1", "fe80::abcd", "::ffff:10.0.0.1"]) {
    assert.equal(isBlockedIp(ip), true, `block ${ip}`);
  }
  for (const ip of ["8.8.8.8", "140.82.112.3", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedIp(ip), false, `allow ${ip}`);
  }
});

test("validateGitRef accepts tags/commits, rejects flags and metachars", () => {
  assert.equal(validateGitRef("v1.2.0"), null);
  assert.equal(validateGitRef("main"), null);
  assert.equal(validateGitRef("9f1c2ab"), null);
  assert.ok(validateGitRef("--upload-pack=sh"));
  assert.ok(validateGitRef("-v1.0.0"));
  assert.ok(validateGitRef("a;b"));
  assert.ok(validateGitRef("../../etc"));
});

test("validateSubdir accepts safe relative folders", () => {
  assert.equal(validateSubdir("frontend-design"), null);
  assert.equal(validateSubdir("skills/frontend-design"), null);
  assert.equal(validateSubdir("a.b_c-1"), null);
});

test("validateSubdir rejects traversal/absolute/unsafe paths", () => {
  for (const p of [
    "../secrets",
    "a/../../b",
    "/etc/passwd",
    "C:/Windows",
    "a\\b",            // backslash separator
    "a//b",            // empty segment
    ".hidden",         // segment must start alphanumeric
    "-flag",
    "a/.",
  ]) {
    assert.ok(validateSubdir(p), `should reject ${p}`);
  }
});

test("slugFromSubdir takes the last path segment", () => {
  assert.equal(slugFromSubdir("frontend-design"), "frontend-design");
  assert.equal(slugFromSubdir("skills/web/frontend-design"), "frontend-design");
  assert.equal(slugFromSubdir("trailing/"), "trailing");
});
