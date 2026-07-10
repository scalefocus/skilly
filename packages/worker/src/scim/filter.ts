// Minimal SCIM filter parser. Entra provisioning predominantly issues simple equality
// filters — userName eq "x", externalId eq "x", displayName eq "x". We support exactly
// `<attr> eq "<value>"` (quoted or bare). SKILLY_SPEC.md §5, §14 (SCIM conformance).

export interface ScimEqFilter {
  attr: string;
  value: string;
}

export function parseScimFilter(filter: string | undefined | null): ScimEqFilter | null {
  if (!filter) return null;
  const m = /^\s*([\w.:-]+)\s+eq\s+"?([^"]*)"?\s*$/i.exec(filter);
  if (!m) return null;
  return { attr: m[1]!, value: m[2]! };
}

/** SCIM 1-based startIndex + count, clamped to sane bounds. */
export function parsePaging(startIndex: unknown, count: unknown): { startIndex: number; count: number } {
  const si = Math.max(1, Math.floor(Number(startIndex) || 1));
  const c = Math.min(1000, Math.max(0, Math.floor(Number(count) || 100)));
  return { startIndex: si, count: c };
}
