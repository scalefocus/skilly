// Skill CONTENT for the §29 MCP server: the SKILL.md and bundle files an agent reads live, and the
// adoption recording that keeps §21 honest about it.
//
// This is the governed byte path that is an explicit carve-out from invariant #4 ("the fetch gateway
// is the only path to bytes"). What makes it governed rather than a bypass:
//   - the caller is authenticated and their visibility is checked BEFORE anything is fetched;
//   - archived skills are owner-only and yanked versions are readable only by exact pin (§7/§9);
//   - a pointer skill is read from its skilly-stored MIRROR — this path never contacts upstream;
//   - reads are capped, rate-limited, and land in `access_log`;
//   - the reader's FIRST SKILL.md read counts as adoption, so agent consumption is measurable
//     rather than invisible (§21).
import type { Pool } from "pg";
import { bundleContentCap } from "@skilly/shared";
import { s3ArtifactStore } from "../storage/objectStore.js";
import { extractBundle } from "../git/bundle.js";
import type { SkillFile } from "../git/synth.js";
import { getMaxBundleBytesSetting } from "./settings.js";
import { M } from "../metrics.js";

/** Extracted bundles are cached by ARTIFACT KEY — versions are immutable (invariant #2), so a
 *  cached entry can never go stale; the TTL is a memory bound, not a correctness one. */
const CACHE_TTL_MS = Number(process.env.MCP_CONTENT_CACHE_TTL_MS ?? 600_000);
const CACHE_MAX_ENTRIES = Number(process.env.MCP_CONTENT_CACHE_MAX ?? 32);
const cache = new Map<string, { at: number; files: SkillFile[] }>();

export function clearMcpContentCache(): void {
  cache.clear();
}

async function loadBundle(pool: Pool, artifactObjectKey: string): Promise<SkillFile[] | null> {
  const hit = cache.get(artifactObjectKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.files;

  let bytes: Buffer;
  try {
    bytes = await s3ArtifactStore().get(artifactObjectKey);
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "mcp artifact fetch failed", key: artifactObjectKey, err: String(e instanceof Error ? e.message : e) }));
    return null;
  }
  let files: SkillFile[];
  try {
    files = await extractBundle(bytes, bundleContentCap(await getMaxBundleBytesSetting(pool)));
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "mcp artifact extract failed", key: artifactObjectKey, err: String(e instanceof Error ? e.message : e) }));
    return null;
  }
  // Crude LRU-ish bound: drop the oldest entry when full. A few bundles in memory is fine; a
  // catalog's worth is not.
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(artifactObjectKey, { at: Date.now(), files });
  return files;
}

export interface BundleFileInfo {
  path: string;
  bytes: number;
  sha256: string;
  executable: boolean;
}

/** Paths + sizes + per-file sha256 for a version's bundle (the §8 bundle-browser data). */
export async function listBundleFiles(pool: Pool, artifactObjectKey: string): Promise<BundleFileInfo[] | null> {
  const files = await loadBundle(pool, artifactObjectKey);
  if (!files) return null;
  const { createHash } = await import("node:crypto");
  return files
    .map((f) => ({
      path: f.path,
      bytes: f.bytes.byteLength,
      sha256: createHash("sha256").update(f.bytes).digest("hex"),
      executable: f.mode === "100755",
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The SKILL.md text of a version, or null when the artifact is missing/unreadable. */
export async function readSkillMd(pool: Pool, artifactObjectKey: string, capBytes: number): Promise<string | null> {
  const files = await loadBundle(pool, artifactObjectKey);
  if (!files) return null;
  const md =
    files.find((f) => /^skill\.md$/i.test(f.path)) ?? files.find((f) => /(^|\/)skill\.md$/i.test(f.path));
  if (!md) return null;
  return Buffer.from(md.bytes).toString("utf8").slice(0, capBytes);
}

export type FileReadResult =
  | { kind: "text"; text: string; path: string }
  | { kind: "binary"; base64: string; path: string; mimeType: string }
  | { kind: "too_large"; bytes: number }
  | { kind: "missing" };

// Extensions we hand back as text; everything else goes as a base64 blob per the MCP spec.
const TEXT_EXT =
  /\.(md|markdown|txt|json|jsonc|ya?ml|toml|ini|cfg|conf|csv|tsv|sh|bash|zsh|fish|ps1|py|rb|js|mjs|cjs|ts|tsx|jsx|go|rs|java|kt|cs|php|pl|lua|sql|html|htm|css|scss|xml|svg|env|gitignore|dockerfile|makefile)$/i;

function looksTextual(path: string, bytes: Uint8Array): boolean {
  if (TEXT_EXT.test(path) || /(^|\/)(dockerfile|makefile|license|readme|changelog)$/i.test(path)) return true;
  // Sniff: a NUL byte in the first 8 KiB means binary.
  const n = Math.min(bytes.byteLength, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}

function mimeFor(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "pdf": return "application/pdf";
    case "zip": return "application/zip";
    case "gz": return "application/gzip";
    default: return "application/octet-stream";
  }
}

/** Read one file out of a version's bundle. `path` must already be validated (isSafeBundlePath). */
export async function readBundleFile(
  pool: Pool,
  artifactObjectKey: string,
  path: string,
  capBytes: number,
): Promise<FileReadResult> {
  const files = await loadBundle(pool, artifactObjectKey);
  if (!files) return { kind: "missing" };
  const lower = path.toLowerCase();
  const f = files.find((x) => x.path === path) ?? files.find((x) => x.path.toLowerCase() === lower);
  if (!f) return { kind: "missing" };
  if (f.bytes.byteLength > capBytes) return { kind: "too_large", bytes: f.bytes.byteLength };
  const buf = Buffer.from(f.bytes);
  return looksTextual(f.path, f.bytes)
    ? { kind: "text", text: buf.toString("utf8"), path: f.path }
    : { kind: "binary", base64: buf.toString("base64"), path: f.path, mimeType: mimeFor(f.path) };
}

/**
 * Record a SKILL.md read as adoption (§21/§29). Gated by the SHARED `skill_installs` ledger inside
 * `record_mcp_read()`, so a user who already cloned or downloaded this skill is not counted again —
 * clone / download / MCP read are three doors to one adoption. Bundle-file reads do NOT call this:
 * reading six files is one adoption, not six.
 *
 * Fire-and-forget by design — an analytics write must never fail a content read.
 */
export function recordMcpAdoption(pool: Pool, skillId: string, userId: string): void {
  void pool
    .query<{ record_mcp_read: boolean }>(`select record_mcp_read($1, $2)`, [skillId, userId])
    .then((r) => {
      M.mcpResourceReads.inc();
      if (r.rows[0]?.record_mcp_read) M.mcpAdoptions.inc();
    })
    .catch((e) => {
      console.error(JSON.stringify({ level: "warn", msg: "record_mcp_read failed", err: String(e instanceof Error ? e.message : e) }));
    });
}
