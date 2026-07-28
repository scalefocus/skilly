// Unit tests for the sign-in half of the directory profile (SKILLY_SPEC.md §5, §28): reading the
// signing-in user's own jobTitle / officeLocation / department from Graph `/me` with their
// delegated token. The DB half (getUserCard) is covered by directory.dbtest.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchEntraDirectoryProfile } from "./directory";

/** A `fetch` stand-in that records the call and replays a canned response. */
function fakeFetch(res: { ok: boolean; body?: unknown; throws?: boolean }) {
  const calls: { url: string; auth: string | undefined }[] = [];
  const impl = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), auth: init?.headers?.authorization });
    if (res.throws) throw new Error("network down");
    return { ok: res.ok, json: async () => res.body ?? {} };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("reads and trims the three directory attributes", async () => {
  const { impl, calls } = fakeFetch({
    ok: true,
    body: { jobTitle: "  Delivery Lead  ", officeLocation: "Sofia", department: "Engineering" },
  });

  const p = await fetchEntraDirectoryProfile("tok-123", impl);

  assert.deepEqual(p, { jobTitle: "Delivery Lead", officeLocation: "Sofia", department: "Engineering" });
  // Only the three properties are requested, on /me, with the delegated token.
  assert.match(calls[0]!.url, /\/me\?\$select=jobTitle,officeLocation,department$/);
  assert.equal(calls[0]!.auth, "Bearer tok-123");
});

test("absent or blank attributes become null (so clearing one upstream clears it here)", async () => {
  const { impl } = fakeFetch({ ok: true, body: { jobTitle: "   ", department: null } });

  assert.deepEqual(await fetchEntraDirectoryProfile("tok", impl), {
    jobTitle: null,
    officeLocation: null,
    department: null,
  });
});

test("a non-2xx response yields null — nothing is written, stored values survive", async () => {
  const { impl } = fakeFetch({ ok: false, body: { error: "forbidden" } });
  assert.equal(await fetchEntraDirectoryProfile("tok", impl), null);
});

test("a network failure yields null rather than throwing — sign-in must not depend on Graph", async () => {
  const { impl } = fakeFetch({ ok: true, throws: true });
  assert.equal(await fetchEntraDirectoryProfile("tok", impl), null);
});
