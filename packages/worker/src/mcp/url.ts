// The one place the MCP server decides what its public identity is. Both the OAuth metadata
// documents and the RFC 8707 resource check depend on it, and they must agree.
const DEFAULT_BASE = "http://localhost:3000";

/** The registry's public base URL (no trailing slash). Mirrors the web tier's resolution order. */
export function publicBaseUrl(): string {
  const raw = process.env.PUBLIC_BASE_URL ?? process.env.SKILLY_REGISTRY_URL ?? process.env.NEXTAUTH_URL ?? DEFAULT_BASE;
  return raw.replace(/\/+$/, "");
}

/** The canonical resource identifier tokens are bound to (RFC 8707). */
export function canonicalResource(): string {
  return `${publicBaseUrl()}/mcp`;
}
