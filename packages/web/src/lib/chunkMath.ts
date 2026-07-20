// Chunked-upload part arithmetic (§6) — pure and environment-free so the browser slicer and the
// server's part-size enforcement can never disagree. A bundle of `totalBytes` splits into
// ceil(total/chunk) parts: every part is exactly `chunkBytes` except the last, which is the
// remainder (and never zero — a total that divides evenly makes a full-size final part).

/** Number of parts a bundle of `totalBytes` splits into at `chunkBytes` per part. */
export function partCount(totalBytes: number, chunkBytes: number): number {
  if (!Number.isInteger(totalBytes) || totalBytes <= 0) throw new Error("totalBytes must be a positive integer");
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) throw new Error("chunkBytes must be a positive integer");
  return Math.ceil(totalBytes / chunkBytes);
}

/** Exact expected byte length of part `index` (0-based). Throws on an out-of-range index. */
export function partSize(totalBytes: number, chunkBytes: number, index: number): number {
  const count = partCount(totalBytes, chunkBytes);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`part index must be an integer in [0, ${count - 1}]`);
  }
  if (index < count - 1) return chunkBytes;
  const rem = totalBytes % chunkBytes;
  return rem === 0 ? chunkBytes : rem;
}

/** [start, end) byte range of part `index` within the bundle — what the client slices. */
export function partRange(totalBytes: number, chunkBytes: number, index: number): { start: number; end: number } {
  const size = partSize(totalBytes, chunkBytes, index); // validates index
  const start = index * chunkBytes;
  return { start, end: start + size };
}
