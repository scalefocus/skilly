// The agent sync API (SKILLY_SPEC.md §69): `POST /api/agent/v1/sync`. A desktop agent — first
// client: AION — sends its user's Entra access token and gets back every skill that user may see
// plus one short-lived agent key the git gateway accepts for cloning any of them.
//
// A machine endpoint: bearer token only, never the session. The token AUTHENTICATES; roles and
// namespace membership come from the SCIM-synced tables exactly as for a web session (invariant
// #1). The API never creates a user. Nothing about the request — not the token, not the minted
// key — is ever logged.
import {
  AGENT_INSTALL_SOURCE,
  AGENT_KEY_CAP,
  AGENT_SYNC_RATE_PER_HOUR,
  AGENT_SYNC_SCOPE,
  buildRepoUrl,
  clientIpFromForwarded,
  deprecationLite,
  generateToken,
  hashToken,
  resolveLatest,
  skillVisibilityWhere,
  successorJsonSql,
  trustProxyHops,
  versionTag,
  type DeprecationLite,
  type EffectiveAccess,
  type SuccessorJson,
} from "@skilly/shared";
import { pool } from "./db";
import { M } from "./metrics";
import { appendAudit } from "./audit";
import { rateLimit } from "./ratelimit";
import { resolveUserAccess } from "./access";
import { webBaseUrl } from "./baseUrl";
import { recordSystemEvent, sanitizeMessage } from "./systemLog";
import { syncSignInIdentity } from "./signInIdentity";
import { SigningKeysUnavailableError, createEntraTokenVerifier, type EntraTokenVerifier } from "./entraToken";
import { resolveAgentApiConfig, type AgentApiConfig } from "./agentSyncConfig";

export const AGENT_SYNC_ROUTE = "/api/agent/v1/sync";

type Env = Record<string, string | undefined>;

// ── Configuration (§69.10): lib/agentSyncConfig.ts ──────────────────────────────────────────────

/** Each configuration complaint is logged once per process, the first time the endpoint is reached. */
const reported = new Set<string>();
function reportConfig(cfg: AgentApiConfig): void {
  for (const [level, msgs] of [["error", cfg.problems], ["warn", cfg.warnings]] as const) {
    for (const msg of msgs) {
      if (reported.has(msg)) continue;
      reported.add(msg);
      const line = JSON.stringify({ level, msg: level === "error" ? `agent sync API is disabled: ${msg}` : msg });
      if (level === "error") console.error(line); else console.warn(line);
    }
  }
}

/** One verifier (and so one signing-key cache) per (tenant, audience) for the life of the process. */
const verifiers = new Map<string, EntraTokenVerifier>();
function verifierFor(cfg: AgentApiConfig): EntraTokenVerifier {
  const k = `${cfg.tenantId}|${cfg.audience}`;
  let v = verifiers.get(k);
  if (!v) {
    v = createEntraTokenVerifier({ tenantId: cfg.tenantId, audience: cfg.audience, requiredScope: AGENT_SYNC_SCOPE });
    verifiers.set(k, v);
  }
  return v;
}

// ── The skill list (§69.4) ────────────────────────────────────────────────────────────────────

export interface AgentSkill {
  namespace: string;
  slug: string;
  title: string;
  description: string;
  /** Latest stable, active, git-published version — what `main` points at. */
  version: string;
  /** That version's immutable tag: `git clone --depth 1 --branch <ref> <gitUrl>` works. */
  ref: string;
  /** Never contains credentials. */
  gitUrl: string;
  /** When `version` was published (UTC ISO). */
  updatedAt: string;
  deprecation: DeprecationLite | null;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every skill the user may see that the gateway can serve: the shared visibility predicate
 * (invariant #7), `status = 'active'`, and at least one STABLE version that is active and
 * git-published. That one rule leaves out archived skills, skills with only yanked / quarantined /
 * prerelease versions, a version the publish sweep has not tagged yet, and a pointer skill whose
 * mirror is missing. Sorted by namespace, then slug. Returns the skill ids too (for the prune).
 */
export async function listAgentSkills(access: EffectiveAccess, registryBaseUrl: string): Promise<{ skills: AgentSkill[]; skillIds: string[] }> {
  const params: unknown[] = [];
  const vis = skillVisibilityWhere(access, params);
  const { rows } = await pool.query<{
    id: string; ns_slug: string; slug: string; title: string; description: string;
    deprecated_at: string | null; deprecation_note: string | null; successor: SuccessorJson | null;
    versions: { semver: string; createdAt: string }[];
  }>(
    `select s.id, n.slug as ns_slug, s.slug, s.title, s.description,
            s.deprecated_at, s.deprecation_note, ${successorJsonSql("s")} as successor,
            v.versions
       from skills s
       join namespaces n on n.id = s.namespace_id
       join lateral (
         select jsonb_agg(jsonb_build_object('semver', sv.semver, 'createdAt', sv.created_at)) as versions
           from skill_versions sv
          where sv.skill_id = s.id and sv.status = 'active' and sv.git_published and not sv.is_prerelease
       ) v on v.versions is not null
      where s.status = 'active'${vis ? ` and ${vis}` : ""}`,
    params,
  );

  const out: (AgentSkill & { id: string })[] = [];
  for (const r of rows) {
    // The same resolution `main` uses (invariant #2): highest stable among the servable versions.
    const version = resolveLatest(r.versions.map((x) => x.semver));
    if (!version) continue;
    const published = r.versions.find((x) => x.semver === version)!.createdAt;
    out.push({
      id: r.id,
      namespace: r.ns_slug,
      slug: r.slug,
      title: r.title,
      description: r.description,
      version,
      ref: versionTag(version),
      gitUrl: buildRepoUrl({ registryBaseUrl, namespaceSlug: r.ns_slug, skillSlug: r.slug }),
      updatedAt: new Date(published).toISOString(),
      deprecation: deprecationLite(access, { deprecatedAt: r.deprecated_at, note: r.deprecation_note, successor: r.successor }),
    });
  }
  out.sort((a, b) => byCodeUnit(a.namespace, b.namespace) || byCodeUnit(a.slug, b.slug));
  return { skills: out.map(({ id: _id, ...skill }) => skill), skillIds: out.map((s) => s.id) };
}

// ── Agent install records (§69.7) ─────────────────────────────────────────────────────────────

/** Delete the user's agent install records for skills that are no longer in their sync response. */
export async function pruneAgentInstalls(userId: string, keepSkillIds: string[]): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from agent_installs where user_id = $1 and source = $2 and not (skill_id = any($3::uuid[]))`,
    [userId, AGENT_INSTALL_SOURCE, keepSkillIds],
  );
  return rowCount ?? 0;
}

// ── The agent key (§69.5) ─────────────────────────────────────────────────────────────────────

export interface MintedAgentKey {
  /** The raw key — returned once, in the sync response. Only its hash is stored. */
  raw: string;
  id: string;
  expiresAt: Date;
  /** How many older keys the 5-key cap removed. */
  revoked: number;
}

/**
 * Mint one agent key: insert the row (hash only, no recoverable copy), delete that user's oldest
 * unexpired agent keys beyond the cap, and write the `agent_key.minted` audit entry — all in ONE
 * transaction, so a key is never handed out without its audit row.
 */
export async function mintAgentKey(
  userId: string,
  opts: { ttlHours: number; clientIp: string | null; userAgent: string | null; requestId?: string | null },
): Promise<MintedAgentKey> {
  const raw = generateToken();
  const c = await pool.connect();
  try {
    await c.query("begin");
    const ins = await c.query<{ id: string; expires_at: Date }>(
      `insert into tokens (user_id, type, hashed_token, scope, expires_at, client_user_agent, client_ip)
       values ($1, 'agent', $2, $3::jsonb, now() + make_interval(hours => $4::int), $5, $6)
       returning id, expires_at`,
      [userId, hashToken(raw), JSON.stringify({ kind: "agent", source: AGENT_INSTALL_SOURCE }), opts.ttlHours, opts.userAgent, opts.clientIp],
    );
    const { id, expires_at: expiresAt } = ins.rows[0]!;
    // The cap: keep the newest AGENT_KEY_CAP unexpired keys. The key just minted is the newest and
    // is excluded by id as well, so a clock tie can never delete it.
    const del = await c.query(
      `delete from tokens
        where type = 'agent' and user_id = $1 and id <> $2
          and id in (select id from tokens
                      where type = 'agent' and user_id = $1 and expires_at > now()
                      order by created_at desc, id desc
                      offset $3)`,
      [userId, id, AGENT_KEY_CAP],
    );
    const revoked = del.rowCount ?? 0;
    await appendAudit(c, {
      actorUserId: userId,
      action: "agent_key.minted",
      targetType: "agent_key",
      targetId: id,
      after: { expiresAt: expiresAt.toISOString(), clientIp: opts.clientIp, userAgent: opts.userAgent, revokedKeys: revoked },
      source: "api",
      requestId: opts.requestId ?? null,
    });
    await c.query("commit");
    M.tokensMinted.inc({ type: "agent" });
    return { raw, id, expiresAt, revoked };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// ── The request (§69.2 – §69.4, §69.9) ────────────────────────────────────────────────────────

export type AgentSyncErrorCode =
  | "invalid_token"
  | "insufficient_scope"
  | "user_not_provisioned"
  | "user_disabled"
  | "not_found"
  | "rate_limited"
  | "internal_error";

const NO_STORE = { "cache-control": "no-store" };

function errorResponse(status: number, error: AgentSyncErrorCode, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error, message }, { status, headers: { ...NO_STORE, ...headers } });
}

function bearerToken(req: Request): string {
  const m = /^Bearer\s+(\S+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  return m?.[1] ?? "";
}

export interface AgentSyncDeps {
  env?: Env;
  /** Injected in tests (a local RSA key + in-memory JWKS); defaults to the tenant's verifier. */
  verifier?: EntraTokenVerifier;
}

/**
 * Handle one sync request. The checks run in the order of §69.2 and the first failure answers:
 * enabled → bearer token → scope → rate limit → user → skills → prune → mint.
 */
export async function handleAgentSync(req: Request, deps: AgentSyncDeps = {}): Promise<Response> {
  const cfg = resolveAgentApiConfig(deps.env ?? process.env);
  reportConfig(cfg);
  if (!cfg.enabled) return errorResponse(404, "not_found", "Not found.");

  try {
    // Bearer token only. Cookies are never read, so a signed-in browser without a token is a 401.
    const verified = await (deps.verifier ?? verifierFor(cfg)).verify(bearerToken(req));
    if (!verified.ok) {
      M.agentSync.inc({ outcome: verified.error });
      return verified.error === "insufficient_scope"
        ? errorResponse(403, "insufficient_scope", `The access token does not carry the ${AGENT_SYNC_SCOPE} scope.`)
        : errorResponse(401, "invalid_token", "The access token is missing, invalid or expired.", { "www-authenticate": 'Bearer error="invalid_token"' });
    }
    const { oid } = verified.identity;

    // 30 per user per hour, keyed on the token's oid, before any database work.
    const limit = rateLimit(`agent-sync:${oid}`, AGENT_SYNC_RATE_PER_HOUR, 3_600_000);
    if (!limit.ok) {
      M.agentSync.inc({ outcome: "rate_limited" });
      M.rateLimited.inc({ route: "agent-sync" });
      return errorResponse(429, "rate_limited", `Too many sync requests. Try again in ${limit.retryAfterSeconds} seconds.`, {
        "retry-after": String(limit.retryAfterSeconds),
      });
    }

    // The same identity step as the web sign-in (self-heal relink, blank-name backfill), then the
    // user's row. No row is ever created here.
    await syncSignInIdentity(verified.identity);
    const { rows } = await pool.query<{ id: string; email: string | null; status: string }>(
      `select id, email, status from users where entra_object_id = $1`,
      [oid],
    );
    const user = rows[0];
    if (!user) {
      M.agentSync.inc({ outcome: "user_not_provisioned" });
      return errorResponse(403, "user_not_provisioned", "This account has not been provisioned in skilly. Ask an administrator to add it to the provisioning scope.");
    }
    // Roles and membership: the resolver a web session uses (SCIM groups × role_mappings). It
    // resolves active users only, so a null userId here is an account that just went inactive.
    const access = user.status === "active" ? await resolveUserAccess(oid) : null;
    if (!access?.userId) {
      M.agentSync.inc({ outcome: "user_disabled" });
      return errorResponse(403, "user_disabled", "This account is disabled in skilly.");
    }

    const gitBaseUrl = webBaseUrl(deps.env ?? process.env) || new URL(req.url).origin;
    const { skills, skillIds } = await listAgentSkills(access, gitBaseUrl);

    // The agent removes the skills that left this list; skilly gets no other signal, so the
    // records go now. Best-effort: a failure here must not fail the sync.
    try {
      await pruneAgentInstalls(user.id, skillIds);
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "agent sync: pruning install records failed", error: sanitizeMessage(e) }));
    }

    const key = await mintAgentKey(user.id, {
      ttlHours: cfg.ttlHours,
      clientIp: clientIpFromForwarded(req.headers.get("x-forwarded-for"), trustProxyHops((deps.env ?? process.env).TRUST_PROXY)),
      userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
      requestId: req.headers.get("x-request-id"),
    });

    M.agentSync.inc({ outcome: "ok" });
    return Response.json(
      {
        user: { id: user.id, email: user.email ?? "" },
        key: key.raw,
        keyExpiresAt: key.expiresAt.toISOString(),
        gitBaseUrl,
        skills,
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (e) {
    // Anything else — the tenant's signing keys unreachable included. Detail goes to the log and
    // the system log (§25); the response says only `internal_error`.
    M.agentSync.inc({ outcome: "error" });
    const detail = e instanceof SigningKeysUnavailableError ? e.message : sanitizeMessage(e);
    console.error(JSON.stringify({ level: "error", msg: "agent sync failed", route: AGENT_SYNC_ROUTE, error: detail }));
    void recordSystemEvent({
      status: 500,
      method: req.method,
      route: AGENT_SYNC_ROUTE,
      path: AGENT_SYNC_ROUTE,
      userId: null,
      errorCode: "internal_error",
      message: sanitizeMessage(detail),
      requestId: req.headers.get("x-request-id"),
      durationMs: null,
    }).catch(() => {});
    return errorResponse(500, "internal_error", "Something went wrong. Try again later.");
  }
}
