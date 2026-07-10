// Semver validation + channel/latest resolution. Proposer-supplied versions are
// validated well-formed and strictly increasing; published versions are immutable.
// beta/stable derive from the prerelease tag. latest = highest stable active version.
// See SKILLY_SPEC.md §7.

import type { Channel } from "./types.js";

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[]; // empty => stable
}

export function parseSemver(v: string): ParsedSemver | null {
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

export function isValidSemver(v: string): boolean {
  return parseSemver(v) !== null;
}

export function channelOf(v: string): Channel {
  const p = parseSemver(v);
  return p && p.prerelease.length === 0 ? "stable" : "beta";
}

/** -1 if a<b, 0 if equal, 1 if a>b. Implements semver precedence incl. prerelease. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) throw new Error("compareSemver: invalid input");
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;

  // A version with a prerelease has LOWER precedence than the same without one.
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;

  const n = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers are lower than alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Validate a proposed version is well-formed and strictly greater than all existing. */
export function assertStrictlyIncreasing(proposed: string, existing: readonly string[]): void {
  if (!isValidSemver(proposed)) throw new Error(`invalid semver: ${proposed}`);
  for (const e of existing) {
    if (compareSemver(proposed, e) <= 0) {
      throw new Error(`version ${proposed} must be strictly greater than existing ${e}`);
    }
  }
}

/** latest = highest STABLE among active versions; null if none stable. */
export function resolveLatest(activeVersions: readonly string[]): string | null {
  const stable = activeVersions.filter((v) => channelOf(v) === "stable");
  if (stable.length === 0) return null;
  return stable.reduce((a, b) => (compareSemver(a, b) >= 0 ? a : b));
}
