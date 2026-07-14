// Unit tests for the skills-hub ref pre-check SSRF hardening (SKILLY_SPEC.md §6). Pure — no
// network: global fetch is stubbed. Run via `pnpm --filter @skilly/web test:unit`.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { listRemoteRefs } from "./pointerRefs";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub fetch that records the URL it was called with and returns a minimal skills-hub payload. */
function stubFetch(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(typeof input === "string" ? input : input.toString());
    return new Response(JSON.stringify({ versions: [{ version: "1.0.0" }], latestVersion: "1.0.0" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

test("skills-hub refs: fetches the canonical API URL for a clean origin", async () => {
  const { calls } = stubFetch();
  const res = await listRemoteRefs("https://skills-hub.ai/api/v1/skills/acme-pdf");
  assert.deepEqual(res, { ok: true, branches: [], tags: ["1.0.0"], latest: "1.0.0" });
  assert.deepEqual(calls, ["https://skills-hub.ai/api/v1/skills/acme-pdf"]);
});

test("skills-hub refs: rebuilds the URL from the slug — trailing query/path noise is dropped", async () => {
  const { calls } = stubFetch();
  // A URL that passes isSkillsHubUrl (exact host + prefix) but carries a query string. The
  // hardening must fetch the rebuilt canonical URL, NOT the raw input.
  await listRemoteRefs("https://skills-hub.ai/api/v1/skills/acme-pdf?redirect=http://169.254.169.254/");
  assert.deepEqual(calls, ["https://skills-hub.ai/api/v1/skills/acme-pdf"]);
});

test("skills-hub refs: a look-alike host is not treated as skills-hub (no hub fetch)", async () => {
  const { calls } = stubFetch();
  // Not a hub URL → falls through to the git ls-remote path, which validatePointerUrl rejects
  // for a non-git/again-untrusted host; either way the hub fetch above is never called.
  const res = await listRemoteRefs("https://skills-hub.ai.evil.test/api/v1/skills/acme-pdf");
  assert.equal(calls.length, 0);
  assert.equal(res.ok, false);
});
