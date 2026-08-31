// Upstream ref discovery for a pointer proposal. The implementation (and, importantly, its
// SSRF guards) now lives in @skilly/shared/remote-refs so the web propose form and the worker's
// §29 `list_upstream_refs` MCP tool share exactly one copy. This module remains the web tier's
// import path.
export { listRemoteRefs, type PointerRefsResult } from "@skilly/shared";
