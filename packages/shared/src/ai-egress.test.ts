// Unit tests for the AI egress guard (SKILLY_SPEC.md §49.11, §40.16): the per-call DNS re-check
// in its three modes (default, the platform-admin private-network switch, the operator's env var),
// mixed DNS answers, and the messages that name what would lift a refusal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aiAllowPrivateBaseUrl, aiHostGuard } from "./ai-egress.js";
import { AiError } from "./ai.js";

const DNS: Record<string, string[]> = {
  "owui.corp.example": ["10.0.30.3"],
  "ula.corp.example": ["fd00::7"],
  "public.example": ["140.82.112.3"],
  "loop.example": ["127.0.0.1"],
  "metadata.example": ["169.254.169.254"],
  "mixed.example": ["10.0.30.3", "127.0.0.1"],
  "split.example": ["140.82.112.3", "192.168.4.4"],
  "evil.internal": ["127.0.0.1"],
  "owui.internal": ["10.9.9.9"],
};
const resolve = async (host: string) => {
  const a = DNS[host];
  if (!a) throw new Error(`ENOTFOUND ${host}`);
  return a.map((address) => ({ address }));
};

async function refusal(guard: ReturnType<typeof aiHostGuard>, host: string, allowPrivateNetwork: boolean): Promise<string | null> {
  try {
    await guard(host, allowPrivateNetwork);
    return null;
  } catch (err) {
    assert.ok(err instanceof AiError);
    assert.equal(err.code, "ai_base_url_private");
    return err.message;
  }
}

test("aiHostGuard default: refuses every private-network and local answer", async () => {
  const g = aiHostGuard({ allowAll: false, resolve });
  for (const h of ["owui.corp.example", "ula.corp.example", "loop.example", "metadata.example", "mixed.example", "split.example", "10.0.30.3", "localhost", "owui.internal"]) {
    assert.notEqual(await refusal(g, h, false), null, h);
  }
  assert.equal(await refusal(g, "public.example", false), null);
  assert.equal(await refusal(g, "unknown.example", false), null, "unresolvable: the fetch reports it");
});

test("aiHostGuard with the private-network switch: private answers pass, local ones never do", async () => {
  const g = aiHostGuard({ allowAll: false, resolve });
  for (const h of ["owui.corp.example", "ula.corp.example", "split.example", "10.0.30.3", "[fd00::1]", "owui.internal", "public.example"]) {
    assert.equal(await refusal(g, h, true), null, h);
  }
  for (const h of ["loop.example", "metadata.example", "mixed.example", "127.0.0.1", "[::1]", "169.254.169.254", "localhost", "a.localhost", "evil.internal"]) {
    assert.notEqual(await refusal(g, h, true), null, h);
  }
});

test("aiHostGuard with the operator's env var: everything passes, without a DNS lookup", async () => {
  let lookups = 0;
  const g = aiHostGuard({ allowAll: true, resolve: async (h) => { lookups++; return resolve(h); } });
  for (const h of ["loop.example", "metadata.example", "mixed.example", "127.0.0.1", "localhost", "owui.corp.example"]) {
    assert.equal(await refusal(g, h, false), null, h);
  }
  assert.equal(lookups, 0);
});

test("aiHostGuard messages name the switch for a private answer and the env var for a local one (§40.16)", async () => {
  const g = aiHostGuard({ allowAll: false, resolve });
  assert.equal(
    await refusal(g, "owui.corp.example", false),
    "the AI base URL's host resolves to a private address (10.0.30.3), which is not allowed. A platform admin can allow private-network providers on the AI integration card.",
  );
  const local = "the AI base URL's host resolves to a loopback or link-local address (127.0.0.1), which is not allowed. An operator can permit it with AI_ALLOW_PRIVATE_BASE_URL=1.";
  assert.equal(await refusal(g, "loop.example", true), local);
  // One private and one loopback answer: only the operator can lift it, so the local message wins.
  assert.equal(await refusal(g, "mixed.example", false), local);
  assert.equal(await refusal(g, "mixed.example", true), local);
  // A literal host is refused before any lookup.
  assert.match(String(await refusal(g, "10.0.30.3", false)), /points at a private-network host, which is not allowed\. A platform admin/);
  assert.match(String(await refusal(g, "localhost", true)), /points at a loopback, link-local or local host, which is not allowed\. An operator can permit it with AI_ALLOW_PRIVATE_BASE_URL=1\.$/);
});

test("aiAllowPrivateBaseUrl reads the operator's env var", () => {
  assert.equal(aiAllowPrivateBaseUrl({ AI_ALLOW_PRIVATE_BASE_URL: "1" }), true);
  assert.equal(aiAllowPrivateBaseUrl({ AI_ALLOW_PRIVATE_BASE_URL: "true" }), false);
  assert.equal(aiAllowPrivateBaseUrl({}), false);
});
