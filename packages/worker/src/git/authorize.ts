// Git smart-HTTP authorization — the decision core, dependency-injected so it can be
// unit-tested without git or a DB. SKILLY_SPEC.md §9.
//
// skilly is a READ-ONLY registry to consumers: only `git-upload-pack` (clone/fetch) is
// allowed; `git-receive-pack` (push) is always denied — publishing happens internally.
//
// Visibility: EVERY clone (org and namespace) requires a valid skill-scoped `install` token-in-URL
// (git basic-auth password); namespace skills additionally require the token's user to have access
// to that namespace. Anonymous/tokenless clones are not allowed. SKILLY_SPEC.md §9, §23.
import { isSkillVisible, type EffectiveAccess } from "@skilly/shared";

export type GitOperation = "upload-pack" | "receive-pack";

export interface ParsedGitRequest {
  namespaceSlug: string;
  skillSlug: string;
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

export interface TokenPrincipal {
  /** null for SYSTEM installations (platform-owned, no user; SKILLY_SPEC.md §23). */
  userId: string | null;
  tokenId: string;
  type: "install";
  /** The skill id this install token is scoped to — always set; presenting it against another skill is rejected. */
  scopedSkillId: string;
  /** System installation: platform-admin-minted, no owning user, no clone-time namespace re-check. */
  isSystem: boolean;
}

export interface GitAuthDeps {
  findSkill(namespaceSlug: string, skillSlug: string): Promise<SkillRef | null>;
  /** Validate a raw token (git basic-auth password). Returns null if invalid/expired. */
  validateToken(rawToken: string): Promise<TokenPrincipal | null>;
  resolveAccess(userId: string): Promise<EffectiveAccess>;
}

export type GitDecision =
  | { allow: true; skill: SkillRef; principal: TokenPrincipal | null }
  | { allow: false; status: 401 | 403 | 404; reason: string };

/** Parse a smart-HTTP path like `/team-a/pdf-tools.git/info/refs` or `/ns/s.git/git-upload-pack`.
 *  Also handles `/ns/s.git/HEAD` (dumb-HTTP default-branch lookup): git ≥2.28 on Windows
 *  requests HEAD after info/refs to resolve the default branch name; a 404 aborts the clone. */
export function parseGitPath(pathname: string, query: URLSearchParams): ParsedGitRequest | null {
  // HEAD — treat as a read-only (upload-pack) non-RPC request so auth + gitHttpBackend handle it.
  const headMatch = /^\/([^/]+)\/([^/]+)\.git\/HEAD$/.exec(pathname);
  if (headMatch) {
    return {
      namespaceSlug: headMatch[1]!,
      skillSlug: headMatch[2]!,
      operation: "upload-pack",
      isServiceRpc: false,
      isHead: true,
    };
  }

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
  return { namespaceSlug, skillSlug, operation, isServiceRpc };
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

export async function authorizeGitRequest(
  parsed: ParsedGitRequest,
  rawToken: string | undefined,
  deps: GitAuthDeps,
): Promise<GitDecision> {
  // Read-only: never allow push.
  if (parsed.operation === "receive-pack") {
    return { allow: false, status: 403, reason: "registry is read-only (push denied)" };
  }

  const skill = await deps.findSkill(parsed.namespaceSlug, parsed.skillSlug);
  if (!skill || skill.status === "archived") {
    return { allow: false, status: 404, reason: "skill not found" };
  }

  // Every clone — org or namespace — requires a valid install token (no anonymous access).
  if (!rawToken) return { allow: false, status: 401, reason: "authentication required" };
  const principal = await deps.validateToken(rawToken);
  if (!principal) return { allow: false, status: 401, reason: "invalid or expired token" };

  // The install token is bound to the skill it was minted for — reject it against any other
  // skill, even an org-wide one (a leaked token must not become a general org-read key).
  if (principal.scopedSkillId !== skill.id) {
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
  return { allow: true, skill, principal };
}
