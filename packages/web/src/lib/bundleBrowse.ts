// Browse an uploaded proposal bundle for review (SKILLY_SPEC.md §8): list its files and read one
// at a time, so a reviewer can inspect the contents before approving. Reuses the same extractor +
// decompression-bomb guards as upload validation (lib/bundle.ts).
//
// The artifactObjectKey is immutable (one key per uploaded revision), so the extracted entries are
// safe to cache by key — repeated tree/file requests during a review don't re-download + re-extract.
import { extractBundle } from "./bundle";
import { s3ArtifactStore } from "./objectStore";
import { getMaxBundleBytes } from "./settings";
import { createTtlCache } from "./ttlCache";
import { bundleContentCap, type BundleEntry } from "@skilly/shared";

const CACHE_TTL_MS = Number(process.env.BUNDLE_BROWSE_CACHE_TTL_MS ?? 300_000);
const cache = createTtlCache<BundleEntry[]>(CACHE_TTL_MS);

export function loadBundleEntries(key: string): Promise<BundleEntry[]> {
  // Extract up to the configured upload cap so a large-but-allowed bundle is browsable (§6).
  return cache.get(key, async () => extractBundle(await s3ArtifactStore().get(key), undefined, bundleContentCap(await getMaxBundleBytes())));
}

// Files above this are always treated as binary (offered for download, never inlined) — a guard on
// both memory and the reviewer's browser, and it sidesteps decoding very large blobs as text.
const MAX_TEXT_BYTES = 1024 * 1024;

/** True if the bytes are safe to show as UTF-8 text: no NUL bytes and a clean strict decode. */
export function isTextFile(bytes: Uint8Array): boolean {
  if (bytes.length > MAX_TEXT_BYTES) return false;
  const sniff = Math.min(bytes.length, 8192);
  for (let i = 0; i < sniff; i++) if (bytes[i] === 0) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export interface BundleFileMeta {
  path: string;
  size: number;
  isText: boolean;
}

/** Flat, path-sorted listing of the bundle's files (the UI builds the tree client-side). */
export function listBundleFiles(entries: BundleEntry[]): BundleFileMeta[] {
  return entries
    .map((e) => ({ path: e.path, size: e.bytes.length, isText: isTextFile(e.bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
