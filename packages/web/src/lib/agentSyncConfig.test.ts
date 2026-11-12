// Agent sync API configuration (SKILLY_SPEC.md §69.10).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAgentApiConfig } from "./agentSyncConfig";

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const on = { SKILLY_AGENT_API_ENABLED: "true", ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT };

test("off unless the flag is exactly true (any case)", () => {
  for (const flag of [undefined, "", "false", "1", "yes", "on"]) {
    const c = resolveAgentApiConfig({ ...on, SKILLY_AGENT_API_ENABLED: flag });
    assert.equal(c.enabled, false, String(flag));
    assert.deepEqual(c.problems, [], "a switched-off API reports nothing");
  }
  assert.equal(resolveAgentApiConfig({ ...on, SKILLY_AGENT_API_ENABLED: " TRUE " }).enabled, true);
});

test("the audience defaults to the OIDC client id; an explicit one wins", () => {
  assert.equal(resolveAgentApiConfig(on).audience, CLIENT);
  assert.equal(resolveAgentApiConfig({ ...on, SKILLY_AGENT_API_AUDIENCE: "  " }).audience, CLIENT);
  assert.equal(resolveAgentApiConfig({ ...on, SKILLY_AGENT_API_AUDIENCE: "other-id" }).audience, "other-id");
});

test("the tenant is ENTRA_TENANT_ID and must be a GUID", () => {
  const ok = resolveAgentApiConfig(on);
  assert.equal(ok.enabled, true);
  assert.equal(ok.tenantId, TENANT);
  for (const t of ["", "common", "organizations", "contoso.onmicrosoft.com"]) {
    const c = resolveAgentApiConfig({ ...on, ENTRA_TENANT_ID: t });
    assert.equal(c.enabled, false, t);
    assert.match(c.problems.join(), /ENTRA_TENANT_ID/);
  }
});

test("no audience at all disables it with a named problem", () => {
  const c = resolveAgentApiConfig({ ...on, ENTRA_CLIENT_ID: "" });
  assert.equal(c.enabled, false);
  assert.match(c.problems.join(), /SKILLY_AGENT_API_AUDIENCE/);
});

test("the key TTL: default 12, clamped to 24 with a warning", () => {
  assert.equal(resolveAgentApiConfig(on).ttlHours, 12);
  assert.equal(resolveAgentApiConfig({ ...on, SKILLY_AGENT_KEY_TTL_HOURS: "6" }).ttlHours, 6);
  const big = resolveAgentApiConfig({ ...on, SKILLY_AGENT_KEY_TTL_HOURS: "48" });
  assert.equal(big.ttlHours, 24);
  assert.equal(big.enabled, true, "a corrected TTL does not disable the API");
  assert.match(big.warnings.join(), /SKILLY_AGENT_KEY_TTL_HOURS/);
});
