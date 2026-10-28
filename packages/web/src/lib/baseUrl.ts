// The web tier's external base URL and absolute-link resolution (SKILLY_SPEC.md §14, §33.6).
// No imports, so client components may use `toAbsoluteUrl` too.

/**
 * The first non-blank of PUBLIC_BASE_URL → SKILLY_REGISTRY_URL → NEXTAUTH_URL, trailing slashes
 * stripped; "" when none is set. The stock compose and Helm web containers receive only the latter
 * two (both set from PUBLIC_BASE_URL), so reading PUBLIC_BASE_URL alone yields nothing there.
 */
export function webBaseUrl(env: Record<string, string | undefined> = process.env): string {
  for (const raw of [env.PUBLIC_BASE_URL, env.SKILLY_REGISTRY_URL, env.NEXTAUTH_URL]) {
    const value = raw?.trim();
    if (value) return value.replace(/\/+$/, "");
  }
  return "";
}

/**
 * Resolve `url` against `base` (the page's own location) so a copied link always carries a host:
 * an absolute URL passes through unchanged, a bare path picks up the page's origin (§33.6).
 * Unparseable input comes back as-is rather than throwing.
 */
export function toAbsoluteUrl(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}
