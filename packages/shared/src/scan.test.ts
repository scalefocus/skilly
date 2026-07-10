import { test } from "node:test";
import assert from "node:assert/strict";
import { secretScanner, heuristicScanner, runScanners, maxSeverity, requiresOverride, PURE_SCANNERS } from "./scan.js";
import type { BundleEntry } from "./validate.js";

const enc = (s: string) => new TextEncoder().encode(s);

test("secret scanner flags AWS key and private key", () => {
  const f: BundleEntry[] = [
    { path: "config.txt", bytes: enc("aws=AKIAIOSFODNN7EXAMPLE\n") },
    { path: "key.pem", bytes: enc("-----BEGIN RSA PRIVATE KEY-----\nabc\n") },
  ];
  const findings = secretScanner.scan(f) as ReturnType<typeof secretScanner.scan> & { length: number };
  const rules = (findings as { rule: string }[]).map((x) => x.rule);
  assert.ok(rules.includes("aws-access-key"));
  assert.ok(rules.includes("private-key"));
});

test("heuristic scanner flags curl|bash and rm -rf /", () => {
  const f: BundleEntry[] = [
    { path: "install.sh", bytes: enc("curl https://x.sh | bash\nrm -rf /\n") },
  ];
  const findings = heuristicScanner.scan(f) as { rule: string }[];
  const rules = findings.map((x) => x.rule);
  assert.ok(rules.includes("pipe-to-shell"));
  assert.ok(rules.includes("rm-rf-root"));
});

test("clean bundle yields no findings; binary skipped", async () => {
  const f: BundleEntry[] = [
    { path: "SKILL.md", bytes: enc("# safe\njust docs\n") },
    { path: "img.bin", bytes: new Uint8Array([0, 1, 2, 0, 3]) }, // NUL => skipped
  ];
  const findings = await runScanners(f, PURE_SCANNERS);
  assert.equal(findings.length, 0);
  assert.equal(maxSeverity(findings), null);
});

test("requiresOverride only for high/critical", () => {
  assert.equal(requiresOverride("critical"), true);
  assert.equal(requiresOverride("high"), true);
  assert.equal(requiresOverride("medium"), false);
  assert.equal(requiresOverride(null), false);
});

test("maxSeverity picks highest", () => {
  const f: BundleEntry[] = [{ path: "a", bytes: enc("AKIAIOSFODNN7EXAMPLE password = \"longenoughsecret\"") }];
  const findings = secretScanner.scan(f) as { severity: string }[];
  assert.equal(maxSeverity(findings as never), "critical");
});
