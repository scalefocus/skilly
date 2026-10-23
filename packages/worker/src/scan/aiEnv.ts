// The worker's env for the shared AI helper (§40.7): the parsed AI_TOKEN_ENC_KEY, `source:
// "worker"`, and the §49.11 per-call egress guard — which the worker's calls skipped until §40.16.
// The guard reads the operator's AI_ALLOW_PRIVATE_BASE_URL here; the platform-admin private-network
// switch reaches it with each call's config read (no cache). Shared by the §41 quality sweep and the
// §46 pre-review sweep.
import { parseAiTokenKey, type AiEnv } from "@skilly/shared/ai";
import { aiHostGuard } from "@skilly/shared/ai-egress";

/** Override point for tests (a stub DNS answer for the egress guard); production uses dns.lookup. */
let resolveImpl: ((host: string) => Promise<Array<{ address: string }>>) | undefined;
export function __setAiResolveForTests(r: typeof resolveImpl): void {
  resolveImpl = r;
}

export function workerAiEnv(): AiEnv {
  return { key: parseAiTokenKey(process.env.AI_TOKEN_ENC_KEY), source: "worker", hostGuard: aiHostGuard({ resolve: resolveImpl }) };
}
