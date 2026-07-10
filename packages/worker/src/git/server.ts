// Authenticated git smart-HTTP server (read-only). The single gateway for `npx skills add`.
// Auth/visibility decided in authorize.ts; protocol delegated to git http-backend.
// SKILLY_SPEC.md §9.
import { Router } from "express";
import {
  parseGitPath,
  tokenFromAuthHeader,
  authorizeGitRequest,
  type GitAuthDeps,
  type TokenPrincipal,
} from "./authorize.js";
import type { Request } from "express";
import { repoProvisioned, defaultRepoRoot } from "./repoStore.js";
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

export interface GitServerDeps extends GitAuthDeps {
  /**
   * Record an install token's FIRST use: stamp used_at + the client User-Agent + the originating
   * client IP, and purge the other unused install tokens for the same skill on the same side of
   * the system boundary (personal ↔ personal, system ↔ system; §23). Idempotent (no-op on later
   * clones — the IP therefore reflects where the install was FIRST made from). Returns true on
   * the first use.
   */
  markInstallUsed(tokenId: string, userAgent: string | null, clientIp: string | null): Promise<boolean>;
  /**
   * Record a fetch of a (restricted) skill for the access log. Never logs credentials.
   * `isSystem` flags a system-installation clone; `countInstall` is true only on a system
   * token's first clone (bumps install_count once per system installation, §21/§23).
   */
  logAccess(skillId: string, userId: string | null, isSystem: boolean, countInstall: boolean): Promise<void>;
  repoRoot?: string;
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
        if (decision.status === 401) {
          res.setHeader("WWW-Authenticate", 'Basic realm="skilly"');
        }
        return res.status(decision.status).type("text/plain").send(decision.reason);
      }

      // "Provisioned" requires ≥1 ref, not just a HEAD file — an empty repo (init'd but never
      // synthesized, e.g. a crash mid-sweep) would otherwise serve a successful but empty clone,
      // surfacing to `npx skills add` as a misleading "No skills found". §6. The self-heal sweep
      // re-synthesizes such repos.
      if (!(await repoProvisioned(root, parsed.namespaceSlug, parsed.skillSlug))) {
        return res.status(404).type("text/plain").send("repository not provisioned");
      }

      const principal: TokenPrincipal | null = decision.principal;

      const ok = await gitHttpBackend(req, res, {
        projectRoot: root,
        pathInfo: url.pathname,
        queryString: url.searchParams.toString(),
      });

      // The /info/refs advertisement happens EXACTLY ONCE per clone (protocol v1 and v2), so we
      // record access there. Install tokens are reusable, so this is safe to call every clone:
      // markInstallUsed only stamps used_at + UA + purges on the FIRST use, and is a no-op after.
      // It runs BEFORE logAccess because a system installation bumps install_count exactly once —
      // on its first clone — and only markInstallUsed knows whether this was it. §23.
      // HEAD requests (dumb-HTTP branch lookup) are excluded — info/refs already covers the clone.
      if (ok && !parsed.isServiceRpc && !parsed.isHead) {
        const firstUse = principal
          ? await deps.markInstallUsed(principal.tokenId, req.header("user-agent") ?? null, clientIp(req))
          : false;
        const isSystem = principal?.isSystem ?? false;
        await deps.logAccess(decision.skill.id, principal?.userId ?? null, isSystem, isSystem && firstUse);
      }
    } catch (err) {
      next(err);
    }
  });

  return r;
}
