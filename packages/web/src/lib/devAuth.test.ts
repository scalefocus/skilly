import { test } from "node:test";
import assert from "node:assert/strict";
import { e2eWorkerOid, resolveDevSignInOid } from "./devAuth";

test("no oid signs in the configured dev admin", () => {
  assert.equal(resolveDevSignInOid(undefined, "dev-admin-oid"), "dev-admin-oid");
  assert.equal(resolveDevSignInOid("", "dev-admin-oid"), "dev-admin-oid");
  assert.equal(resolveDevSignInOid(null, "dev-admin-oid"), "dev-admin-oid");
});

test("no oid and no SKILLY_DEV_OID falls back to dev-oid", () => {
  assert.equal(resolveDevSignInOid(undefined, undefined), "dev-oid");
  assert.equal(resolveDevSignInOid(undefined, ""), "dev-oid");
});

test("the dev admin's own oid is accepted", () => {
  assert.equal(resolveDevSignInOid("dev-admin-oid", "dev-admin-oid"), "dev-admin-oid");
});

test("every e2e worker oid 01-16 is accepted", () => {
  for (let n = 1; n <= 16; n++) {
    const oid = e2eWorkerOid(n);
    assert.equal(resolveDevSignInOid(oid, "dev-admin-oid"), oid);
  }
});

test("anything else is refused", () => {
  for (const oid of [
    "alice-oid",
    "bob-oid",
    "e2e-worker-00-oid",
    "e2e-worker-17-oid",
    "e2e-worker-1-oid",
    "e2e-worker-01-oid ",
    "xe2e-worker-01-oid",
    "dev-oid", // not the configured admin here
  ]) {
    assert.equal(resolveDevSignInOid(oid, "dev-admin-oid"), null, oid);
  }
  assert.equal(resolveDevSignInOid(42, "dev-admin-oid"), null);
  assert.equal(resolveDevSignInOid(["dev-admin-oid"], "dev-admin-oid"), null);
});

test("e2eWorkerOid pads to two digits and rejects out-of-range numbers", () => {
  assert.equal(e2eWorkerOid(1), "e2e-worker-01-oid");
  assert.equal(e2eWorkerOid(16), "e2e-worker-16-oid");
  assert.throws(() => e2eWorkerOid(0), RangeError);
  assert.throws(() => e2eWorkerOid(17), RangeError);
  assert.throws(() => e2eWorkerOid(1.5), RangeError);
});
