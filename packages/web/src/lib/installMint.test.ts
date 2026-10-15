// Unit tests for the install-mint response interpretation (SKILLY_SPEC.md §23 "Already-installed prompt").
import { test } from "node:test";
import assert from "node:assert/strict";
import { interpretInstallResponse } from "./installMint";

test("a 2xx with a command is a mint", () => {
  const out = interpretInstallResponse(200, { command: "npx skills add https://x-access-token:t@h/g/s.git", semver: "1.2.0", expiresAt: null, system: false });
  assert.deepEqual(out, {
    kind: "minted",
    install: { command: "npx skills add https://x-access-token:t@h/g/s.git", semver: "1.2.0", expiresAt: null, system: false },
  });
  const latest = interpretInstallResponse(200, { command: "c", semver: null, expiresAt: "2027-01-01T00:00:00.000Z", system: true });
  assert.equal(latest.kind, "minted");
  if (latest.kind === "minted") {
    assert.equal(latest.install.semver, null);
    assert.equal(latest.install.expiresAt, "2027-01-01T00:00:00.000Z");
    assert.equal(latest.install.system, true);
  }
});

test("409 already_installed opens the prompt with the existing installs", () => {
  const installs = [{ id: "a", pinnedSemver: null, installedAt: "2026-10-01T00:00:00Z", expiresAt: null, inactive: false }];
  assert.deepEqual(interpretInstallResponse(409, { error: "already_installed", installs }), { kind: "already_installed", installs });
});

test("any other 409 (still publishing) and other failures surface the server's error", () => {
  assert.deepEqual(
    interpretInstallResponse(409, { error: "that version is still being published — try again in a moment" }),
    { kind: "error", message: "that version is still being published — try again in a moment" },
  );
  assert.deepEqual(interpretInstallResponse(422, { error: "expiry must be in the future" }), { kind: "error", message: "expiry must be in the future" });
  // already_installed without a list is malformed → an error, never an empty dialog.
  assert.equal(interpretInstallResponse(409, { error: "already_installed" }).kind, "error");
});

test("no usable body falls back to a generic message", () => {
  assert.deepEqual(interpretInstallResponse(500, null), { kind: "error", message: "Failed to generate the install command" });
  assert.deepEqual(interpretInstallResponse(200, {}), { kind: "error", message: "Failed to generate the install command" });
  assert.deepEqual(interpretInstallResponse(502, "oops", "custom"), { kind: "error", message: "custom" });
});
