// Git smart-HTTP authorization — the decision core, dependency-injected so it can be
// unit-tested without git or a DB. SKILLY_SPEC.md §9 (skills) and §30 (plugin marketplaces).
//
// skilly is a READ-ONLY registry to consumers: only `git-upload-pack` (clone/fetch) is
// allowed; `git-receive-pack` (push) is always denied — publishing happens internally.
//
// Two kinds of repo are served from this one gateway:
//   • SKILL repos      `/<ns>/<slug>.git`             — one skill, versions as tags (§9)
//   • MARKETPLACE repos `/_marketplace/<key>.git`     — a Claude Code plugin marketplace (§30)
// `_marketplace` and `_public` start with `_`, which no namespace or skill slug may, so the two
// path spaces cannot collide.
//
// Visibility: EVERY clone requires a token-in-URL (git basic-auth password) scoped to exactly the
// thing being cloned. A skill token is bound to one skill; a marketplace token to one marketplace.
// Namespace-scoped resources additionally require the token's user to still have namespace access
// at clone time. Anonymous/tokenless clones are not allowed. SKILLY_SPEC.md §9, §23, §30.4.
import {
  isSkillVisible,
  parseMarketplaceRepoKey,
  type EffectiveAccess,
  type MarketplaceScope,
} from "@skilly/shared";

export type GitOperation = "upload-pack" | "receive-pack";

export interface ParsedGitRequest {
  /** First path segment: a namespace slug, or the `_marketplace` prefix. */
  namespaceSlug: string;
  /** Repo basename without `.git`: a skill slug, or a marketplace key. */
  skillSlug: string;
  /** Non-null when this path addresses a MARKETPLACE repo rather than a skill repo (§30). */
  marketplace: MarketplaceScope | null;
  operation: GitOperation;
  /** true for the POST RPC (the terminal step of a clone) vs the GET /info/refs advert */
  isServiceRpc: boolean;
  /** true for the dumb-HTTP HEAD file request — skip access logging (info/refs already covers it) */
  isHead?: boolean;
}

export interface SkillRef {
  id: string;
  namespaceId: string;
  visibility: "org" | "namespace";
  status: "active" | "archived";
}

/** A servable marketplace, as resolved from the DB. */
export interface MarketplaceRef {
  scope: MarketplaceScope;
  /** The owning namespace's id for a namespace marketplace; null for the public one. */
  namespaceId: string | null;
  /** False => the toggle is off, so the repo must not be served (§30.6). */
  enabled: boolean;
}

export interface TokenPrincipal {
  /** null for SYSTEM installations (platform-owned, no user; SKILLY_SPEC.md §23). */
  userId: string | null;
  tokenId: string;
  type: "install" | "marketplace";
  /** `install` only — the skill id this token is scoped to; presenting it against another skill is rejected. */
  scopedSkillId?: string;
  /** `marketplace` only — the marketplace this token is scoped to (§30.4). */
  scopedMarketplace?: MarketplaceScope;
  /** `marketplace` only — the namespace id behind a namespace-scoped token, for the access re-check. */
  scopedNamespaceId?: string | null;
  /** `marketplace` only — the §30.7 attribution cursor: the commit this token last received. */
  lastServedCommit?: string | null;
  /** System installation: platform-admin-minted, no owning user, no clone-time namespace re-check.
   *  Never true for `marketplace` tokens — system marketplaces are deferred (§30.4). */
  isSystem: boolean;
  /** The token row matched but its owning user is not status='active' (deprovisioned/disabled —
   *  SKILLY_SPEC.md §5/§23): the token is refused with the SAME generic 401 as an invalid token
   *  (no account-state oracle for a leaked URL), and the refusal is recorded to system_event.
   *  Never set on system tokens (no owner). */
  ownerInactive?: boolean;
}

export interface GitAuthDeps {
  findSkill(namespaceSlug: string, skillSlug: string): Promise<SkillRef | null>;
  /** Resolve a marketplace and whether its toggle is on (§30.6). Null = no such marketplace. */
  findMarketplace(scope: MarketplaceScope): Promise<MarketplaceRef | null>;
  /** Validate a raw token (git basic-auth password). Returns null if invalid/expired. */
  validateToken(rawToken: string): Promise<TokenPrincipal | null>;
  resolveAccess(userId: string): Promise<EffectiveAccess>;
}

export type GitDecision =
  | { allow: true; kind: "skill"; skill: SkillRef; principal: TokenPrincipal | null }
  | { allow: true; kind: "marketplace"; marketplace: MarketplaceRef; principal: TokenPrincipal }
  | {
      allow: false;
      status: 401 | 403 | 404;
      reason: string;
      /** Present only on the owner-inactive refusal: lets the server record the system_event
       *  (§23/§25) while the HTTP response stays indistinguishable from any invalid token. */
      ownerInactive?: { ownerUserId: string };
    };

/** Parse a smart-HTTP path like `/team-a/pdf-tools.git/info/refs`, `/ns/s.git/git-upload-pack`,
 *  or a marketplace path `/_marketplace/team-a.git/info/refs` (§30).
 *  Also handles `/…/HEAD` (dumb-HTTP default-branch lookup): git ≥2.28 on Windows requests HEAD
 *  after info/refs to resolve the default branch name; a 404 aborts the clone. */
export function parseGitPath(pathname: string, query: URLSearchParams): ParsedGitRequest | null {
  const build = (ns: string, slug: string, operation: GitOperation, isServiceRpc: boolean, isHead?: boolean): ParsedGitRequest | null => {
    const marketplace = parseMarketplaceRepoKey(ns, slug);
    // A `_marketplace/…` path that doesn't resolve to a real marketplace key is not a route at
    // all (falls through to a 404) rather than being treated as a skill repo.
    if (marketplace === null && ns.startsWith("_")) return null;
    const req: ParsedGitRequest = { namespaceSlug: ns, skillSlug: slug, marketplace, operation, isServiceRpc };
    if (isHead) req.isHead = true;
    return req;
  };

  // HEAD — treat as a read-only (upload-pack) non-RPC request so auth + gitHttpBackend handle it.
  const headMatch = /^\/([^/]+)\/([^/]+)\.git\/HEAD$/.exec(pathname);
  if (headMatch) return build(headMatch[1]!, headMatch[2]!, "upload-pack", false, true);

  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
  if (!m) return null;
  const [, namespaceSlug, skillSlug, endpoint] = m as unknown as [string, string, string, string];

  let operation: GitOperation;
  let isServiceRpc: boolean;
  if (endpoint === "info/refs") {
    const svc = query.get("service");
    if (svc === "git-upload-pack") operation = "upload-pack";
    else if (svc === "git-receive-pack") operation = "receive-pack";
    else return null; // dumb-http or unknown service: unsupported
    isServiceRpc = false;
  } else if (endpoint === "git-upload-pack") {
    operation = "upload-pack";
    isServiceRpc = true;
  } else {
    operation = "receive-pack";
    isServiceRpc = true;
  }
  return build(namespaceSlug, skillSlug, operation, isServiceRpc);
}

/** Extract the token (password) from an HTTP Basic `Authorization` header. */
export function tokenFromAuthHeader(header: string | undefined): string | undefined {
  if (!header?.startsWith("Basic ")) return undefined;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const password = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    return password || undefined;
  } catch {
    return undefined;
  }
}

/** Same-shape 401 for every token failure — never an oracle for why (§23). */
const INVALID_TOKEN = "invalid or expired token";

export async function authorizeGitRequest(
  parsed: ParsedGitRequest,
  rawToken: string | undefined,
  deps: GitAuthDeps,
): Promise<GitDecision> {
  // Read-only: never allow push.
  if (parsed.operation === "receive-pack") {
    return { allow: false, status: 403, reason: "registry is read-only (push denied)" };
  }
  return parsed.marketplace
    ? authorizeMarketplace(parsed.marketplace, rawToken, deps)
    : authorizeSkill(parsed, rawToken, deps);
}

async function authorizeSkill(
  parsed: ParsedGitRequest,
  rawToken: string | undefined,
  deps: GitAuthDeps,
): Promise<GitDecision> {
  const skill = await deps.findSkill(parsed.namespaceSlug, parsed.skillSlug);
  if (!skill || skill.status === "archived") {
    return { allow: false, status: 404, reason: "skill not found" };
  }

  // Every clone — org or namespace — requires a valid install token (no anonymous access).
  if (!rawToken) return { allow: false, status: 401, reason: "authentication required" };
  const principal = await deps.validateToken(rawToken);
  if (!principal) return { allow: false, status: 401, reason: INVALID_TOKEN };

  const inactive = ownerInactiveRefusal(principal);
  if (inactive) return inactive;

  // A marketplace token is not a skill credential, and vice versa.
  if (principal.type !== "install" || principal.scopedSkillId !== skill.id) {
    return { allow: false, status: 403, reason: "token is scoped to a different skill" };
  }

  // Namespace-scoped skills additionally require the token's user to still have access.
  // SYSTEM installations are exempt (no user to check): the mint itself is a platform admin
  // deliberately granting machine access to this one skill, and the grant survives later
  // visibility changes. Compensated by admin-only minting + audit. SKILLY_SPEC.md §23.
  if (skill.visibility === "namespace" && !principal.isSystem) {
    if (!principal.userId) return { allow: false, status: 403, reason: "not authorized for this namespace" };
    const access = await deps.resolveAccess(principal.userId);
    if (!isSkillVisible(access, { namespaceId: skill.namespaceId, visibility: skill.visibility })) {
      return { allow: false, status: 403, reason: "not authorized for this namespace" };
    }
  }
  return { allow: true, kind: "skill", skill, principal };
}

async function authorizeMarketplace(
  scope: MarketplaceScope,
  rawToken: string | undefined,
  deps: GitAuthDeps,
): Promise<GitDecision> {
  const marketplace = await deps.findMarketplace(scope);
  // A disabled marketplace is indistinguishable from one that never existed: disable means the
  // repo is gone (§30.6), so 404 is the honest answer and it leaks no namespace names.
  if (!marketplace || !marketplace.enabled) {
    return { allow: false, status: 404, reason: "marketplace not found" };
  }

  if (!rawToken) return { allow: false, status: 401, reason: "authentication required" };
  const principal = await deps.validateToken(rawToken);
  if (!principal) return { allow: false, status: 401, reason: INVALID_TOKEN };

  const inactive = ownerInactiveRefusal(principal);
  if (inactive) return inactive;

  if (principal.type !== "marketplace" || !sameScope(principal.scopedMarketplace, scope)) {
    return { allow: false, status: 403, reason: "token is scoped to a different marketplace" };
  }

  // The PUBLIC marketplace carries only org-visible skills, so any authenticated owner may clone
  // it. A NAMESPACE marketplace carries restricted skills: re-resolve the owner's access on every
  // clone, so a mover/leaver loses it exactly as they lose a restricted skill (§30.4).
  if (scope.kind === "namespace") {
    if (!principal.userId || !marketplace.namespaceId) {
      return { allow: false, status: 403, reason: "not authorized for this namespace" };
    }
    const access = await deps.resolveAccess(principal.userId);
    if (!isSkillVisible(access, { namespaceId: marketplace.namespaceId, visibility: "namespace" })) {
      return { allow: false, status: 403, reason: "not authorized for this namespace" };
    }
  }
  return { allow: true, kind: "marketplace", marketplace, principal };
}

/** A personal token whose owning user is not active is refused with the SAME 401 as an invalid
 *  token — only the internal decision carries the distinction, for the system_event record. */
function ownerInactiveRefusal(principal: TokenPrincipal): GitDecision | null {
  if (principal.ownerInactive && principal.userId) {
    return { allow: false, status: 401, reason: INVALID_TOKEN, ownerInactive: { ownerUserId: principal.userId } };
  }
  return null;
}

function sameScope(a: MarketplaceScope | undefined, b: MarketplaceScope): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  return a.kind === "public" || a.namespaceSlug === (b as { namespaceSlug: string }).namespaceSlug;
}
