// SSRF / git-transport hardening for user-supplied pointer (external git) URLs and refs.
// Pointer skills are cloned by the worker, which holds DB + object-store credentials and may
// reach cloud metadata endpoints — so an unvalidated URL is an SSRF/RCE vector. We allow only
// https:// to a public, fully-qualified host, and a conservative ref charset. SKILLY_SPEC.md §6.

// IPv4 private / loopback / link-local / CGNAT / special ranges (dotted-decimal — the WHATWG
// URL parser already normalizes decimal/octal/hex IPv4 to this form).
const PRIVATE_V4 =
  /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|192\.0\.2\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/**
 * Classify a resolved/literal IP as non-public (private/loopback/link-local/ULA/etc.).
 * Returns true if the address must NOT be reached. Handles IPv4, IPv6, and IPv4-mapped/compat
 * IPv6 (`::ffff:a.b.c.d`, `::ffff:7f00:1`) by extracting the embedded IPv4. Exported so the
 * worker can re-check every DNS-resolved address (DNS-rebinding defense), not just the literal.
 */
export function isBlockedIp(ipRaw: string): boolean {
  let ip = ipRaw.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, ""); // strip brackets
  // Strip a zone id ("fe80::1%eth0") via indexOf rather than a /%.*$/ regex — on a long,
  // '%'-heavy resolved-address string an unanchored `.*$` after a literal can be walked from
  // every position, an O(n^2) DoS surface for attacker-influenced DNS results (js/polynomial-redos).
  const zoneIdx = ip.indexOf("%");
  if (zoneIdx >= 0) ip = ip.slice(0, zoneIdx);
  if (!ip) return true;

  // Pure dotted-decimal IPv4.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return PRIVATE_V4.test(ip);

  if (ip.includes(":")) {
    // IPv4-mapped / -compatible IPv6: trailing "a.b.c.d" or hex-packed "xxxx:xxxx" of the v4.
    const mapped = /^::(ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
    if (mapped) return PRIVATE_V4.test(mapped[2]!);
    const hexMapped = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
    if (hexMapped) {
      const a = parseInt(hexMapped[1]!, 16), b = parseInt(hexMapped[2]!, 16);
      const v4 = `${a >> 8}.${a & 0xff}.${b >> 8}.${b & 0xff}`;
      return PRIVATE_V4.test(v4);
    }
    // IPv6 loopback (::1), unspecified (::), link-local fe80::/10 (fe8/fe9/fea/feb),
    // unique-local fc00::/7 (fc/fd). Anything else (global unicast) is allowed.
    if (ip === "::1" || ip === "::") return true;
    if (/^fe[89ab]/.test(ip)) return true;
    if (/^f[cd]/.test(ip)) return true;
    return false;
  }
  return false; // not an IP literal → a hostname; resolution-time check happens in the worker
}

/**
 * A hostname that names the local machine or an internal zone (`localhost`, `*.localhost`,
 * `*.local`, `*.internal`). Shared by the pointer URL validator and the AI base-URL check
 * (§49.11). Expects a lower-cased host with brackets and the FQDN-root dot already stripped.
 */
export function isLocalHostname(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal");
}

/** Returns an error string if the pointer URL is unsafe, or null if it's acceptable. */
export function validatePointerUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "pointer URL is not a valid URL";
  }
  if (u.protocol !== "https:") return "pointer URL must use https:// (no file:, git:, ssh:, ext: or plain http)";
  if (u.username || u.password) return "pointer URL must not embed credentials";

  // Strip brackets and a single trailing FQDN-root dot (so "localhost." / "x.internal." can't
  // evade the suffix checks below).
  const host = u.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
  if (isLocalHostname(host)) {
    return "pointer URL must not target a local/internal host";
  }
  // Require a fully-qualified host (a dot for IPv4/DNS, or a colon for IPv6) — blocks bare
  // single-label intranet names like "git" or "metadata".
  if (!host.includes(".") && !host.includes(":")) return "pointer URL host must be fully qualified";
  // Literal IPs (any encoding the URL parser normalized) must not be private/loopback/etc.
  // NOTE: this only covers IP LITERALS. A hostname that *resolves* to a private IP is caught
  // at clone time by the worker re-checking each resolved address (see git/mirror.ts).
  if (isBlockedIp(host)) return "pointer URL must not target a private, loopback, or link-local address";
  return null;
}

/**
 * Conservative ref validator. The ref is passed to `git clone --branch <ref>`; a value
 * starting with "-" could be parsed as a flag, and shell/path metacharacters have no place in
 * a tag/branch/commit. Must start alphanumeric (so never a leading dash).
 */
export function validateGitRef(ref: string): string | null {
  if (!ref || ref.length > 200) return "ref is required (max 200 chars)";
  if (!/^[A-Za-z0-9][A-Za-z0-9._/+-]*$/.test(ref)) return "ref must start alphanumeric and contain only letters, digits, and . _ / + -";
  if (ref.includes("..")) return "ref must not contain '..'";
  return null;
}

/**
 * Validate an optional pointer source SUBDIR — the folder *inside* the upstream repo where the
 * skill's `SKILL.md` lives (e.g. `frontend-design` in a multi-skill repo). It is appended to
 * the clone path before walking, so it MUST be a safe relative path: no absolute/drive paths,
 * no `..`, no backslashes, bounded charset. Returns an error string, or null if acceptable.
 * Empty/undefined is handled by the caller (= repo root) and must NOT be passed here.
 * SKILLY_SPEC.md §6.
 */
export function validateSubdir(raw: string): string | null {
  if (raw.length > 256) return "skill folder path is too long (max 256 chars)";
  if (raw.startsWith("/")) return "skill folder must be a relative path (no leading slash)";
  if (raw.includes("\\")) return "skill folder must use '/' as the path separator";
  if (/^[A-Za-z]:/.test(raw)) return "skill folder must be a relative path (no drive letter)";
  for (const seg of raw.split("/")) {
    if (seg === "") return "skill folder must not contain empty path segments";
    if (seg === "." || seg === "..") return "skill folder must not contain '.' or '..' segments";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(seg)) {
      return "skill folder segments must start alphanumeric and contain only letters, digits, and . _ -";
    }
  }
  return null;
}

/** The skilly slug derived from a pointer subdir = its last path segment ("web/frontend-design" -> "frontend-design"). */
export function slugFromSubdir(subdir: string): string {
  const segs = subdir.split("/").filter(Boolean);
  return segs[segs.length - 1] ?? "";
}

/**
 * The client address a rate limiter may key on, derived from `X-Forwarded-For` the way Express's
 * `trust proxy = <n>` does (§22 *Rate limiting*, §49.9): with `n` trusted hops the client is the
 * n-th address from the RIGHT; with none trusted (unset / 0) every client shares one bucket, so the
 * header is ignored. The FIRST entry is never used — it is whatever the client chose to send.
 */
export function clientIpFromForwarded(xff: string | null | undefined, trustProxyHops: number): string | null {
  const hops = Number.isFinite(trustProxyHops) ? Math.floor(trustProxyHops) : 0;
  if (hops <= 0 || !xff) return null;
  const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const idx = parts.length - hops;
  return parts[idx < 0 ? 0 : idx] ?? null;
}

/** Parse a `TRUST_PROXY`-style value into a hop count (`true` = 1, a number = itself, else 0). */
export function trustProxyHops(raw: string | undefined): number {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v || v === "false" || v === "0") return 0;
  if (v === "true") return 1;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Whether a request is a same-site one for the purpose of a state-changing GET (§49.9): the
 * `Sec-Fetch-Site` header is absent (old client), `same-origin`, `same-site` or `none` (typed URL /
 * bookmark). A `cross-site` navigation is served but must not trigger side effects.
 */
export function isSameSiteFetch(secFetchSite: string | null | undefined): boolean {
  const v = (secFetchSite ?? "").trim().toLowerCase();
  return v === "" || v === "same-origin" || v === "same-site" || v === "none";
}
