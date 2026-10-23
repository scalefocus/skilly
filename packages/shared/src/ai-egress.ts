// AI provider egress guard (§49.11, §40.16) — server-only subpath `@skilly/shared/ai-egress`.
//
// `normalizeAiBaseUrl` refuses literal private hosts at save time; this guard re-resolves the
// provider's host before EVERY call and refuses when any A/AAAA record falls in a class that is
// not allowed — the same DNS-rebinding defence the pointer mirror applies (§22). A platform admin
// may allow private-network hosts with the §40.16 switch (passed per call, read with the config);
// operators whose provider lives on loopback or link-local opt out entirely with
// AI_ALLOW_PRIVATE_BASE_URL=1.
import { lookup } from "node:dns/promises";
import { blockedIpClass, type BlockedClass } from "./net.js";
import { AiError, aiHostClassAllowed, aiLiteralHostClass, aiPrivateHostMessage, aiPrivateHostPolicy, type AiHostGuard } from "./ai.js";

export const AI_ALLOW_PRIVATE_BASE_URL_ENV = "AI_ALLOW_PRIVATE_BASE_URL";

/** True when the operator has allowed every non-public AI provider host. */
export function aiAllowPrivateBaseUrl(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AI_ALLOW_PRIVATE_BASE_URL_ENV] === "1";
}

/**
 * Build the per-call host guard the shared AI helper runs before each provider request.
 * Resolves the hostname (all addresses) and throws `ai_base_url_private` when any address is in a
 * class the policy refuses; a loopback/link-local answer wins over a private one, since only the
 * operator can lift it. `allowAll` defaults to the env var; `resolve` is injectable for tests.
 */
export function aiHostGuard(opts: {
  allowAll?: boolean;
  resolve?: (host: string) => Promise<Array<{ address: string }>>;
} = {}): AiHostGuard {
  const allowAll = opts.allowAll ?? aiAllowPrivateBaseUrl();
  const resolve = opts.resolve ?? ((host: string) => lookup(host, { all: true }));
  return async (hostname: string, allowPrivateNetwork: boolean) => {
    const policy = aiPrivateHostPolicy({ operatorAllowsAll: allowAll, allowPrivateNetwork });
    if (policy === "all") return;
    const literal = aiLiteralHostClass(hostname);
    if (literal && !aiHostClassAllowed(literal, policy)) {
      throw new AiError("ai_base_url_private", aiPrivateHostMessage("call", literal));
    }
    const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
    let addrs: Array<{ address: string }>;
    try {
      addrs = await resolve(host);
    } catch {
      return; // unresolvable: let the fetch fail with the provider's own error
    }
    let refused: { cls: BlockedClass; address: string } | null = null;
    for (const a of addrs) {
      const cls = blockedIpClass(a.address);
      if (!cls || aiHostClassAllowed(cls, policy)) continue;
      if (cls === "local") {
        refused = { cls, address: a.address };
        break;
      }
      refused ??= { cls, address: a.address };
    }
    if (refused) throw new AiError("ai_base_url_private", aiPrivateHostMessage("resolved", refused.cls, refused.address));
  };
}
