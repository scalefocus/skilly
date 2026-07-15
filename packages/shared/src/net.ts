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
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
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
