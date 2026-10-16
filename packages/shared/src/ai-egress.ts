// AI provider egress guard (§49.11) — server-only subpath `@skilly/shared/ai-egress`.
//
// `normalizeAiBaseUrl` refuses literal private hosts at save time; this guard re-resolves the
// provider's host before EVERY call and refuses when any A/AAAA record is private, loopback or
// link-local — the same DNS-rebinding defence the pointer mirror applies (§22). Operators whose
// Open WebUI lives on the private network opt out with AI_ALLOW_PRIVATE_BASE_URL=1.
import { lookup } from "node:dns/promises";
import { isBlockedIp, isLocalHostname } from "./net.js";
import { AiError } from "./ai.js";

export const AI_ALLOW_PRIVATE_BASE_URL_ENV = "AI_ALLOW_PRIVATE_BASE_URL";

/** True when the operator has allowed on-network AI providers. */
export function aiAllowPrivateBaseUrl(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AI_ALLOW_PRIVATE_BASE_URL_ENV] === "1";
}

/**
 * Build the per-call host guard the shared AI helper runs before each provider request.
 * Resolves the hostname (all addresses) and throws `ai_base_url_private` when any is blocked.
 * `resolve` is injectable for tests.
 */
export function aiHostGuard(opts: {
  allowPrivate?: boolean;
  resolve?: (host: string) => Promise<Array<{ address: string }>>;
} = {}): (hostname: string) => Promise<void> {
  const allowPrivate = opts.allowPrivate ?? aiAllowPrivateBaseUrl();
  const resolve = opts.resolve ?? ((host: string) => lookup(host, { all: true }));
  return async (hostname: string) => {
    if (allowPrivate) return;
    const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
    if (isLocalHostname(host) || isBlockedIp(host)) {
      throw new AiError("ai_base_url_private", "the AI base URL points at a private or local host, which is not allowed (set AI_ALLOW_PRIVATE_BASE_URL=1 to permit on-network providers)");
    }
    let addrs: Array<{ address: string }>;
    try {
      addrs = await resolve(host);
    } catch {
      return; // unresolvable: let the fetch fail with the provider's own error
    }
    for (const a of addrs) {
      if (isBlockedIp(a.address)) {
        throw new AiError("ai_base_url_private", `the AI base URL's host resolves to a private address (${a.address}), which is not allowed`);
      }
    }
  };
}
