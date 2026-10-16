// §49 worker units that need no database: the AV-sweep candidate rule, the malware finding
// extraction, the refusal throttle, the pre-scan cache key and the integrity hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { ScanFinding } from "@skilly/shared";
import { needsAvPass } from "./avSweep.js";
import { malwareFindings } from "./malware.js";
import { makeRefusalThrottle } from "../git/pgDeps.js";
import { preScanCacheKey } from "../git/proposalPreScan.js";
import { sha256Hex, verifyArtifactIntegrity } from "../git/integrity.js";

const clean: ScanFinding = { scanner: "clamav", severity: "info", rule: "av-clean", message: "stream: OK", path: "SKILL.md" };
const malware: ScanFinding = { scanner: "clamav", severity: "critical", rule: "malware", message: "Eicar-Test-Signature", path: "bin/x.sh" };
const down: ScanFinding = { scanner: "clamav", severity: "high", rule: "scanner-unavailable", message: "clamav scan unavailable: ECONNREFUSED" };
const secret: ScanFinding = { scanner: "secret", severity: "high", rule: "slack-token", message: "possible Slack token", path: "a" };

test("needsAvPass: no engine result, or only the unavailable marker, needs a pass (§49.2)", () => {
  assert.equal(needsAvPass(null), true);
  assert.equal(needsAvPass([]), true);
  assert.equal(needsAvPass([secret]), true);
  assert.equal(needsAvPass([down]), true);
  assert.equal(needsAvPass([secret, down]), true);
  assert.equal(needsAvPass([clean]), false);
  assert.equal(needsAvPass([malware]), false);
  assert.equal(needsAvPass([down, clean]), false);
});

test("malwareFindings extracts signature + path from clamav malware hits only", () => {
  assert.deepEqual(malwareFindings([clean, secret, malware, down]), [{ path: "bin/x.sh", signature: "Eicar-Test-Signature" }]);
  assert.deepEqual(malwareFindings([clean]), []);
});

test("refusal throttle: one record per (key, minute), suppressed hits counted (§49.8)", () => {
  let now = 1_000_000;
  const t = makeRefusalThrottle(60_000, () => now);
  assert.equal(t.hit("install_token_invalid|1.2.3.4"), 0, "first hit opens a window and records");
  assert.equal(t.hit("install_token_invalid|1.2.3.4"), null, "inside the window: counted, not recorded");
  assert.equal(t.hit("install_token_invalid|1.2.3.4"), null);
  assert.equal(t.hit("install_token_invalid|9.9.9.9"), 0, "another client has its own window");
  now += 60_001;
  assert.equal(t.hit("install_token_invalid|1.2.3.4"), 2, "a new window reports how many the last one suppressed");
  assert.equal(t.hit("install_token_invalid|1.2.3.4"), null);
});

test("preScanCacheKey pins the commit when known (§49.3)", () => {
  assert.equal(preScanCacheKey("v1.0.0", null), "v1.0.0");
  assert.equal(preScanCacheKey("v1.0.0", "a".repeat(40)), `v1.0.0@${"a".repeat(40)}`);
});

test("verifyArtifactIntegrity: matching or unrecorded hash passes; a mismatch records once and refuses (§49.12)", async () => {
  const bytes = new TextEncoder().encode("hello");
  const sha = sha256Hex(bytes);
  const calls: string[] = [];
  const pool = { async query(sql: string) { calls.push(sql); return { rows: [], rowCount: 0 }; } } as unknown as Pool;
  const subject = { versionId: "v-ok", skillId: "s1", semver: "1.0.0", artifactKey: "uploads/u/x.bundle", expectedSha256: sha, nsSlug: "ns", skillSlug: "sk" };
  assert.equal(await verifyArtifactIntegrity(pool, subject, bytes), true);
  assert.equal(await verifyArtifactIntegrity(pool, { ...subject, expectedSha256: sha.toUpperCase() }, bytes), true, "case-insensitive compare");
  assert.equal(await verifyArtifactIntegrity(pool, { ...subject, expectedSha256: null }, bytes), true, "legacy rows without a hash are not checked");
  assert.equal(calls.length, 0, "nothing recorded on a pass");

  const bad = { ...subject, versionId: "v-bad", expectedSha256: "0".repeat(64) };
  assert.equal(await verifyArtifactIntegrity(pool, bad, bytes), false);
  assert.equal(calls.filter((q) => /insert into system_event/.test(q)).length, 1);
  assert.equal(calls.filter((q) => /skill\.artifact_integrity_failed/.test(q)).length, 1);
  assert.equal(await verifyArtifactIntegrity(pool, bad, bytes), false, "still refused on the next sweep");
  assert.equal(calls.filter((q) => /insert into system_event/.test(q)).length, 1, "but recorded only once per process");
});
