// Model Context Protocol wire helpers for the §29 integrated MCP server — the PURE half: the
// resource-URI scheme, the tool inventory, JSON-RPC shapes and the inline-upload decoder.
//
// SKILLY_SPEC.md §29. Two rules this file exists to keep honest:
//   1. `resources/list` advertises TEMPLATES ONLY and never enumerates the catalog — clients pull
//      listed resources straight into context, so a few-hundred-skill registry would flood the
//      agent and turn every list call into a filtered catalog scan. Discovery is `search_skills`.
//   2. The tool inventory is a CEILING of 24. A 25th tool is a spec change, not an implementation
//      detail; the first response to pressure for more surface is to fold, not add.

/** Protocol revision we implement (Streamable HTTP; the deprecated HTTP+SSE transport is not). */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Older revision we still accept in `initialize` (clients negotiate down gracefully). */
export const MCP_PROTOCOL_VERSIONS_SUPPORTED = ["2025-06-18", "2025-03-26"] as const;

export const MCP_SERVER_NAME = "skilly";

// ── Tool inventory (the §29 ceiling) ────────────────────────────────────────────────────────────

/** Core read (6). */
export const MCP_TOOLS_READ = [
  "search_skills",
  "get_skill",
  "get_skill_content",
  "list_skill_files",
  "get_skill_file",
  "get_registry_metadata",
] as const;

/** Install (4) — mints ordinary §23 install tokens; the `system` flag is refused. */
export const MCP_TOOLS_INSTALL = [
  "install_skill",
  "list_installed_skills",
  "uninstall_skill",
  "reactivate_install",
] as const;

/** Propose (9) — proposer-side only; accept/reject are deliberately unreachable (§29). */
export const MCP_TOOLS_PROPOSE = [
  "check_duplicate",
  "list_upstream_refs",
  "propose_pointer_skill",
  "propose_hosted_skill",
  "list_my_proposals",
  "get_proposal",
  "revise_proposal",
  "resubmit_proposal",
  "post_proposal_message",
] as const;

/** Social (5). */
export const MCP_TOOLS_SOCIAL = [
  "rate_skill",
  "get_skill_discussion",
  "post_skill_comment",
  "list_skill_requests",
  "request_skill",
] as const;

export const MCP_TOOL_NAMES = [
  ...MCP_TOOLS_READ,
  ...MCP_TOOLS_INSTALL,
  ...MCP_TOOLS_PROPOSE,
  ...MCP_TOOLS_SOCIAL,
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

/** The §29 ceiling, asserted in a test so growth has to go through the spec. */
export const MCP_TOOL_CEILING = 24;

/** Tools that mutate state — used to pick the write rate-limit bucket and the audit path. */
export const MCP_WRITE_TOOLS: ReadonlySet<string> = new Set<string>([
  "install_skill",
  "uninstall_skill",
  "reactivate_install",
  "propose_pointer_skill",
  "propose_hosted_skill",
  "revise_proposal",
  "resubmit_proposal",
  "post_proposal_message",
  "rate_skill",
  "post_skill_comment",
  "request_skill",
]);

// ── Resource URIs ───────────────────────────────────────────────────────────────────────────────

export const MCP_RESOURCE_SCHEME = "skilly";

/** The literal a caller may use in place of a semver to mean "latest stable". */
export const LATEST_REF = "latest";

export interface SkillResourceRef {
  namespaceSlug: string;
  skillSlug: string;
  /** null = latest stable. */
  semver: string | null;
  /** null = the skill's SKILL.md (the adoption-counting read); otherwise a bundle path. */
  path: string | null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Build a resource URI. Forms (§29):
 *   skilly://skill/<ns>/<slug>                      → latest stable SKILL.md
 *   skilly://skill/<ns>/<slug>@<semver>             → that version's SKILL.md
 *   skilly://skill/<ns>/<slug>@<semver|latest>/<p>  → one file from that version's bundle
 */
export function buildSkillResourceUri(
  namespaceSlug: string,
  skillSlug: string,
  semver?: string | null,
  path?: string | null,
): string {
  let uri = `${MCP_RESOURCE_SCHEME}://skill/${namespaceSlug}/${skillSlug}`;
  if (path) uri += `@${semver ?? LATEST_REF}/${path.replace(/^\/+/, "")}`;
  else if (semver) uri += `@${semver}`;
  return uri;
}

/**
 * Parse a resource URI back into its parts, or null when it isn't one of ours. Strict on shape:
 * a caller that guesses a URI gets a clean "unknown resource", never a partial match that could
 * be coerced into reading something else. Path traversal (`..`) is rejected here, not downstream.
 */
export function parseSkillResourceUri(uri: string): SkillResourceRef | null {
  if (typeof uri !== "string") return null;
  const prefix = `${MCP_RESOURCE_SCHEME}://skill/`;
  if (!uri.startsWith(prefix)) return null;
  const rest = uri.slice(prefix.length);
  if (rest === "" || rest.includes("\\")) return null;

  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const namespaceSlug = rest.slice(0, slash);
  let tail = rest.slice(slash + 1);
  if (tail === "") return null;

  // Everything after the FIRST `@` is the version (+ optional /path).
  let semver: string | null = null;
  let path: string | null = null;
  const at = tail.indexOf("@");
  if (at >= 0) {
    const verAndPath = tail.slice(at + 1);
    tail = tail.slice(0, at);
    const vslash = verAndPath.indexOf("/");
    if (vslash >= 0) {
      const ver = verAndPath.slice(0, vslash);
      path = verAndPath.slice(vslash + 1);
      semver = ver === LATEST_REF ? null : ver;
      if (path === "") return null;
    } else {
      semver = verAndPath === LATEST_REF ? null : verAndPath;
    }
    if (semver !== null && semver === "") return null;
  }
  const skillSlug = tail;
  if (!SLUG_RE.test(namespaceSlug) || !SLUG_RE.test(skillSlug)) return null;
  if (semver !== null && !/^[0-9A-Za-z.\-+]{1,64}$/.test(semver)) return null;
  if (path !== null && !isSafeBundlePath(path)) return null;
  return { namespaceSlug, skillSlug, semver, path };
}

/**
 * A bundle-relative path we're willing to read: no absolute paths, no `..` segment, no NUL, no
 * backslash, bounded length. Traversal is refused at the edge so no reader has to be careful.
 */
export function isSafeBundlePath(path: string): boolean {
  if (typeof path !== "string" || path === "" || path.length > 512) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return !path.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}

/** The templates advertised by `resources/list`. Nothing is ever enumerated. */
export function resourceTemplates(): Array<{
  uriTemplate: string;
  name: string;
  description: string;
  mimeType?: string;
}> {
  return [
    {
      uriTemplate: `${MCP_RESOURCE_SCHEME}://skill/{namespace}/{slug}`,
      name: "Skill (latest stable)",
      description:
        "The SKILL.md of a skill's latest stable version. Find namespace/slug with the search_skills tool — the catalog is deliberately not enumerated here.",
      mimeType: "text/markdown",
    },
    {
      uriTemplate: `${MCP_RESOURCE_SCHEME}://skill/{namespace}/{slug}@{semver}`,
      name: "Skill (pinned version)",
      description: "The SKILL.md of one specific published version. Yanked versions are readable only by exact pin.",
      mimeType: "text/markdown",
    },
    {
      uriTemplate: `${MCP_RESOURCE_SCHEME}://skill/{namespace}/{slug}@{semver}/{path}`,
      name: "Skill bundle file",
      description:
        "One file from a version's bundle (scripts, references, assets). Use `latest` as the semver for the latest stable version; list the available paths with the list_skill_files tool.",
    },
  ];
}

// ── Inline (base64) bundle upload ───────────────────────────────────────────────────────────────

export type InlineBundleResult = { ok: true; bytes: Buffer } | { ok: false; error: string };

/**
 * Decode a base64 hosted bundle from tool arguments, enforcing the decoded-byte cap BEFORE
 * allocating the full buffer where possible. Over the cap fails loudly, naming the browser path —
 * never silently truncated, and never handed onward unscanned (§22/§29).
 */
export function decodeInlineBundle(base64: unknown, capBytes: number): InlineBundleResult {
  if (typeof base64 !== "string" || base64.trim() === "") {
    return { ok: false, error: "bundleBase64 is required (base64-encoded .skill/.zip/.tar.gz bytes)" };
  }
  const cleaned = base64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    return { ok: false, error: "bundleBase64 is not valid base64" };
  }
  // Cheap upper bound on the decoded size from the encoded length — refuse before decoding.
  const approxBytes = Math.floor((cleaned.length * 3) / 4);
  if (approxBytes > capBytes) {
    return { ok: false, error: inlineTooLargeMessage(capBytes) };
  }
  const bytes = Buffer.from(cleaned, "base64");
  if (bytes.length === 0) return { ok: false, error: "bundleBase64 decoded to zero bytes" };
  if (bytes.length > capBytes) return { ok: false, error: inlineTooLargeMessage(capBytes) };
  return { ok: true, bytes };
}

export function inlineTooLargeMessage(capBytes: number): string {
  const mib = Math.round((capBytes / (1024 * 1024)) * 10) / 10;
  return `bundle exceeds the ${mib} MiB inline limit for MCP proposals — upload it in the browser instead (the propose page supports chunked uploads for large bundles)`;
}

// ── JSON-RPC 2.0 ────────────────────────────────────────────────────────────────────────────────

export const JSONRPC_VERSION = "2.0";

/** Standard JSON-RPC error codes we use. */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

export interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function rpcError(id: string | number | null, code: number, message: string, data?: unknown): Record<string, unknown> {
  return { jsonrpc: JSONRPC_VERSION, id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** Is this a well-formed JSON-RPC request object (notification or call)? */
export function isJsonRpcRequest(v: unknown): v is JsonRpcRequest {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.jsonrpc === JSONRPC_VERSION && typeof o.method === "string";
}

/**
 * A tool result carrying an error the MODEL should see and can act on (a 403, a 409, a validation
 * message) — as opposed to a protocol error. MCP models handle `isError` results far better than
 * transport failures, so every expected failure comes back this way.
 */
export function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** A successful tool result: JSON for machines, pretty-printed so it reads well in a transcript. */
export function toolJson(value: unknown): Record<string, unknown> {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

export function toolText(text: string): Record<string, unknown> {
  return { content: [{ type: "text", text }] };
}
