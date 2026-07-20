// DB-free unit tests for the chunked-upload staging layer (§6): exact part-size enforcement,
// ordered reassembly, and the admin chunk-size parser. (Session CRUD + the 2 h sweep live in
// chunkedUploads.dbtest.ts — they need a live DB.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { putPart, assembleParts, stagingKey, STAGING_PREFIX, type UploadSession } from "./chunkedUploads";
import { parseUploadChunkMb, UPLOAD_CHUNK_MB_MIN, UPLOAD_CHUNK_MB_MAX, DEFAULT_UPLOAD_CHUNK_BYTES } from "./settings";
import type { ArtifactStore, ObjectListing } from "./objectStore";

const MB = 1024 * 1024;

/** In-memory ArtifactStore standing in for MinIO/S3. */
function memStore(): ArtifactStore & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async get(key) {
      const v = objects.get(key);
      if (!v) throw new Error(`NoSuchKey: ${key}`);
      return v;
    },
    async put(key, body) {
      objects.set(key, Buffer.from(body));
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix): Promise<ObjectListing[]> {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, lastModified: new Date() }));
    },
  };
}

function session(totalBytes: number, chunkBytes: number): UploadSession {
  return { id: "11111111-1111-4111-8111-111111111111", userId: "u1", skillSlug: "demo", filename: "demo.skill", totalBytes, chunkBytes, createdAt: new Date() };
}

test("putPart: exact-size enforcement, index bounds, overwrite on re-PUT", async () => {
  const store = memStore();
  const s = session(2 * MB + 100, MB);

  // Wrong sizes are rejected with the expected byte count in the message.
  const short = await putPart(s, 0, Buffer.alloc(MB - 1), store);
  assert.ok("error" in short && short.status === 422 && /exactly 1048576 bytes/.test(short.error));
  const longFinal = await putPart(s, 2, Buffer.alloc(101), store);
  assert.ok("error" in longFinal && /exactly 100 bytes/.test(longFinal.error));

  // Out-of-range / non-integer indexes are rejected.
  for (const idx of [-1, 3, 1.5]) {
    const r = await putPart(s, idx, Buffer.alloc(MB), store);
    assert.ok("error" in r, `index ${idx} rejected`);
  }

  // Correct sizes land at the staging key; a re-PUT overwrites (retry-safe).
  assert.deepEqual(await putPart(s, 0, Buffer.alloc(MB, 1), store), { ok: true });
  assert.deepEqual(await putPart(s, 0, Buffer.alloc(MB, 9), store), { ok: true });
  assert.equal(store.objects.get(stagingKey(s.id, 0))![0], 9, "re-PUT replaced the bytes");
  assert.ok(stagingKey(s.id, 0).startsWith(STAGING_PREFIX), "parts live under the staging prefix");
});

test("assembleParts: byte-exact reassembly in order; missing/mis-sized parts are 409", async () => {
  const store = memStore();
  const total = 2 * MB + 100;
  const s = session(total, MB);

  // Nothing uploaded yet → part 0 missing.
  const empty = await assembleParts(s, store);
  assert.ok("error" in empty && empty.status === 409 && /part 0 of 3/.test(empty.error));

  // Upload parts out of order; the original must reassemble byte-for-byte.
  const original = Buffer.alloc(total);
  for (let i = 0; i < total; i++) original[i] = i % 251;
  assert.deepEqual(await putPart(s, 2, original.subarray(2 * MB), store), { ok: true });
  assert.deepEqual(await putPart(s, 0, original.subarray(0, MB), store), { ok: true });

  const missingMiddle = await assembleParts(s, store);
  assert.ok("error" in missingMiddle && /part 1 of 3/.test(missingMiddle.error), "gap detected");

  assert.deepEqual(await putPart(s, 1, original.subarray(MB, 2 * MB), store), { ok: true });
  const done = await assembleParts(s, store);
  assert.ok("bytes" in done);
  assert.equal(done.bytes.length, total);
  assert.ok(done.bytes.equals(original), "reassembled bundle is byte-identical");

  // A part that changed size underneath (corruption) is caught at assembly.
  store.objects.set(stagingKey(s.id, 1), Buffer.alloc(5));
  const corrupted = await assembleParts(s, store);
  assert.ok("error" in corrupted && /part 1 is 5 bytes/.test(corrupted.error));
});

test("parseUploadChunkMb: whole MB within 1–50; strings from the admin form accepted; junk rejected", () => {
  assert.equal(parseUploadChunkMb(5), 5 * MB);
  assert.equal(parseUploadChunkMb("5"), 5 * MB);
  assert.equal(parseUploadChunkMb(UPLOAD_CHUNK_MB_MIN), UPLOAD_CHUNK_MB_MIN * MB);
  assert.equal(parseUploadChunkMb(UPLOAD_CHUNK_MB_MAX), UPLOAD_CHUNK_MB_MAX * MB);
  assert.equal(DEFAULT_UPLOAD_CHUNK_BYTES, 5 * MB, "default is 5 MB");
  for (const bad of [0, 51, -5, 2.5, "abc", "", null, undefined, NaN]) {
    assert.throws(() => parseUploadChunkMb(bad), /whole number of MB between 1 and 50/, `rejects ${String(bad)}`);
  }
});
