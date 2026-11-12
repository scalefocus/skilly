// Configuration of the agent sync API (SKILLY_SPEC.md §69.10). Pure — no DB, no network — so it is
// unit-tested on its own.
import { parseAgentKeyTtlHours } from "@skilly/shared";

type Env = Record<string, string | undefined>;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AgentApiConfig {
  /** The flag is `true` AND the tenant is a GUID AND an audience resolves. Otherwise the route is a 404. */
  enabled: boolean;
  tenantId: string;
  audience: string;
  ttlHours: number;
  /** Why the API is off although the flag is on — one entry per missing setting. */
  problems: string[];
  /** Settings that were corrected (an out-of-range TTL). */
  warnings: string[];
}

export function resolveAgentApiConfig(env: Env = process.env): AgentApiConfig {
  const flag = (env.SKILLY_AGENT_API_ENABLED ?? "").trim().toLowerCase() === "true";
  // The tenant is the setting the web sign-in already reads — never a second one.
  const tenantId = (env.ENTRA_TENANT_ID ?? "").trim();
  // The audience is the application (client) ID of skilly's app registration, which the web sign-in
  // already has as ENTRA_CLIENT_ID — so that is the default.
  const audience = (env.SKILLY_AGENT_API_AUDIENCE ?? "").trim() || (env.ENTRA_CLIENT_ID ?? "").trim();
  const ttl = parseAgentKeyTtlHours(env.SKILLY_AGENT_KEY_TTL_HOURS);
  const problems: string[] = [];
  if (flag && !GUID.test(tenantId)) problems.push("ENTRA_TENANT_ID must be a tenant GUID (not `common` or `organizations`)");
  if (flag && !audience) problems.push("SKILLY_AGENT_API_AUDIENCE (or ENTRA_CLIENT_ID) is not set");
  return {
    enabled: flag && problems.length === 0,
    tenantId,
    audience,
    ttlHours: ttl.hours,
    problems,
    warnings: flag && ttl.warning ? [ttl.warning] : [],
  };
}
