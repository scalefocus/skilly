// Authenticated git smart-HTTP server (read-only). The single gateway for `npx skills add`
// (§9) AND for Claude Code plugin marketplaces (§30) — both are git clones, both are gated here.
// Auth/visibility decided in authorize.ts; protocol delegated to git http-backend.
import { Router } from "express";
import {
  parseGitPath,
  tokenFromAuthHeader,
  authorizeGitRequest,
  type GitAuthDeps,
  type ParsedGitRequest,
  type TokenPrincipal,
} from "./authorize.js";
import type { Request } from "express";
import type { MarketplaceScope } from "@skilly/shared";
import { repoProvisioned, defaultRepoRoot } from "./repoStore.js";
import { marketplaceRepoDir, marketplaceHead, changedSlugsSince } from "./marketplace.js";
import { gitHttpBackend } from "./httpBackend.js";

/**
 * The originating client IP of a clone (the consumer running `npx skills add`), for the owner's
 * Installed page. `req.ip` honors `X-Forwarded-For` only when the Express app's `trust proxy` is
 * configured (TRUST_PROXY env) — otherwise it's the socket peer (the reverse proxy). IPv4-mapped
 * IPv6 (`::ffff:1.2.3.4`) is normalized to bare IPv4. Never logged with the request. §9/§23.
 */
function clientIp(req: Request): string | null {
  const ip = req.ip;
  if (!ip) return null;
  return ip.startsWith("::ffff:") ? ip.slice("::ffff:".length) : ip;
}

export interface MarketplaceCredit {
  tokenId: string;
  userId: string;
  scope: MarketplaceScope;
  /** Namespace id for a namespace marketplace; null for the public one. */
  namespaceId: string | null;
  /** Skill slugs added or version-changed since this token's last fetch (§30.7). */
  slugs: string[];
  /** The commit the token has now been served — becomes its new cursor. */
  newCommit: string;
}

export interface GitServerDeps extends GitAuthDeps {
  /**
   * Record an install token's FIRST use: stamp used_at + the client User-Agent + the originating
   * client IP, and purge the other unused install tokens for the same skill on the same side of
   * the system boundary (personal ↔ personal, system ↔ system; §23). Idempotent (no-op on later
   * clones — the IP therefore reflects where the install was FIRST made from). Returns true on
   * the first use.
   */
  markInstallUsed(tokenId: string, userAgent: string | null, clientIp: string | null): Promise<boolean>;
  /** The marketplace analogue of markInstallUsed (§30.4/§30.6): same first-use stamp and purge. */
  markMarketplaceUsed(tokenId: string, userAgent: string | null, clientIp: string | null): Promise<boolean>;
  /**
   * Credit a marketplace fetch as installs of the individual skills, and advance the token's
   * attribution cursor — in one transaction, so a crash can never advance the cursor without
   * having credited (which would lose those installs forever). Returns how many were credited.
   * SKILLY_SPEC.md §30.7.
   */
  creditMarketplaceFetch(input: MarketplaceCredit): Promise<number>;
  /**
   * Record a fetch of a (restricted) skill for the access log. Never logs credentials.
   * `isSystem` flags a system-installation clone; `countInstall` is true only on a system
   * token's first clone (bumps install_count once per system installation, §21/§23).
   */
  logAccess(skillId: string, userId: string | null, isSystem: boolean, countInstall: boolean): Promise<void>;
  /**
   * Record a clone refused because the install token's owning user is not status='active'
   * (SKILLY_SPEC.md §23/§25): a system_event row — source='worker', status 401,
   * error_code 'install_token_owner_inactive' — whose actor is the TOKEN OWNER (the requester is
   * an anonymous machine). Fire-and-forget at the call site; a failure never changes the response.
   */
  recordOwnerInactiveRefusal(e: OwnerInactiveRefusal): Promise<void>;
  repoRoot?: string;
}

export interface OwnerInactiveRefusal {
  method: string;
  /** The matched git endpoint template, e.g. `/[ns]/[slug].git/info/refs` — never the query string. */
  route: string;
  /** Concrete path hit — never the query string. */
  path: string;
  ownerUserId: string;
  namespaceSlug: string;
  skillSlug: string;
}

/** The matched-template form of a git smart-HTTP request, for system_event.route (§25). */
function gitRouteTemplate(parsed: ParsedGitRequest): string {
  const endpoint = parsed.isHead ? "HEAD" : parsed.isServiceRpc ? `git-${parsed.operation}` : "info/refs";
  return parsed.marketplace
    ? `/_marketplace/[key].git/${endpoint}`
    : `/[ns]/[slug].git/${endpoint}`;
}

export function gitServer(deps: GitServerDeps): Router {
  const r = Router();
  const root = deps.repoRoot ?? defaultRepoRoot();

  r.use(async (req, res, next) => {
    const url = new URL(req.url, "http://internal");
    const parsed = parseGitPath(url.pathname, url.searchParams);
    if (!parsed) return next(); // not a git smart-HTTP route

    try {
      const token = tokenFromAuthHeader(req.header("authorization"));
      const decision = await authorizeGitRequest(parsed, token, deps);

      if (!decision.allow) {
        if (decision.ownerInactive) {
          void deps
            .recordOwnerInactiveRefusal({
              method: req.method,
              route: gitRouteTemplate(parsed),
              path: url.pathname,
              ownerUserId: decision.ownerInactive.ownerUserId,
              namespaceSlug: parsed.namespaceSlug,
              skillSlug: parsed.skillSlug,
            })
            .catch(() => {});
        }
        if (decision.status === 401) {
          res.setHeader("WWW-Authenticate", 'Basic realm="skilly"');
        }
        return res.status(decision.status).type("text/plain").send(decision.reason);
      }

      // "Provisioned" requires ≥1 ref, not just a HEAD file — an empty repo (init'd but never
      // synthesized, e.g. a crash mid-sweep) would otherwise serve a successful but empty clone,
      // surfacing to `npx skills add` as a misleading "No skills found". §6. The self-heal sweep
      // re-synthesizes such repos. A marketplace repo's equivalent is a born `main`.
      if (decision.kind === "skill") {
        if (!(await repoProvisioned(root, parsed.namespaceSlug, parsed.skillSlug))) {
          return res.status(404).type("text/plain").send("repository not provisioned");
        }
      }

      const marketplaceDir = decision.kind === "marketplace" ? marketplaceRepoDir(root, decision.marketplace.scope) : null;
      const head = marketplaceDir ? await marketplaceHead(marketplaceDir) : null;
      if (decision.kind === "marketplace" && !head) {
        return res.status(404).type("text/plain").send("marketplace not provisioned");
      }

      const ok = await gitHttpBackend(req, res, {
        projectRoot: root,
        pathInfo: url.pathname,
        queryString: url.searchParams.toString(),
      });

      // The /info/refs advertisement happens EXACTLY ONCE per clone (protocol v1 and v2), so we
      // record access there. Tokens are reusable, so this is safe to call every clone.
      // HEAD requests (dumb-HTTP branch lookup) are excluded — info/refs already covers the clone.
      if (!ok || parsed.isServiceRpc || parsed.isHead) return;

      if (decision.kind === "skill") {
        const principal: TokenPrincipal | null = decision.principal;
        // markInstallUsed runs BEFORE logAccess because a system installation bumps install_count
        // exactly once — on its first clone — and only markInstallUsed knows whether this was it.
        const firstUse = principal
          ? await deps.markInstallUsed(principal.tokenId, req.header("user-agent") ?? null, clientIp(req))
          : false;
        const isSystem = principal?.isSystem ?? false;
        await deps.logAccess(decision.skill.id, principal?.userId ?? null, isSystem, isSystem && firstUse);
        return;
      }

      // Marketplace fetch (§30.7): a single clone delivers every listed skill, and the protocol
      // gives no per-plugin signal — so credit the skills this fetch actually advanced the
      // consumer onto, read from the sync commits between their cursor and the current head.
      const principal = decision.principal;
      await deps.markMarketplaceUsed(principal.tokenId, req.header("user-agent") ?? null, clientIp(req));
      if (!principal.userId || !head || !marketplaceDir) return;
      const slugs = await changedSlugsSince(marketplaceDir, principal.lastServedCommit ?? null);
      await deps.creditMarketplaceFetch({
        tokenId: principal.tokenId,
        userId: principal.userId,
        scope: decision.marketplace.scope,
        namespaceId: decision.marketplace.namespaceId,
        slugs,
        newCommit: head,
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
