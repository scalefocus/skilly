// e2e: chunked hosted-bundle upload (SKILLY_SPEC.md §6). Drives the REAL server flow end-to-end
// — start (orphan sweep + session), exact-size part PUTs, complete (assemble → the identical
// validate/scan/store pipeline against live Postgres + MinIO) — plus the single-shot path's
// clear 400 for a truncated multipart body. Runs against the dev stack (SKILLY_DEV_AUTH=1);
// opt-in, not part of the default `pnpm -r test`.
//
// Deliberately API-driven (page.request shares the signed-in cookie jar): completing an upload
// creates only an artifact object + a scan report — no proposal/skill rows — so the dev catalog
// stays clean. The admin chunk-size setting is flipped to 1 MB for the test and restored after.
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import AdmZip from "adm-zip";
import { test, expect, type Page } from "@playwright/test";

const MB = 1024 * 1024;

// Dev sign-in via the next-auth credentials callback (no form fields) — same handshake as
// e2e/shots.mjs. page.request shares the page's cookie jar, so later API calls are authed.
async function devSignIn(page: Page) {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  const res = await page.request.post("/api/auth/callback/dev", {
    form: { csrfToken: csrf.csrfToken, json: "true" },
  });
  expect(res.ok()).toBeTruthy();
}

/** A valid .skill (zip) bundle whose SKILL.md name matches `slug`, padded with incompressible
 *  bytes so the archive itself exceeds `minBytes` on the wire. */
function buildSkillBundle(slug: string, minBytes: number): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    "SKILL.md",
    Buffer.from(`---\nname: ${slug}\ndescription: chunked-upload e2e fixture (safe to delete)\n---\n\n# ${slug}\n\nFixture bundle for the §6 chunked-upload e2e.\n`),
  );
  // Random bytes don't deflate, so the zipped size stays ≥ the padding size (.dat: not on the
  // §6 binary-extension denylist; secret/AV findings are advisory and never block an upload).
  zip.addFile("assets/padding.dat", randomBytes(minBytes));
  return zip.toBuffer();
}

test.describe.serial("chunked upload (§6) against the live dev stack", () => {
  test("start → parts → complete runs the full pipeline; guards hold", async ({ page }) => {
    await devSignIn(page);

    // Flip the chunk size to the 1 MB floor so a small fixture exercises real chunking; restore
    // whatever the admin had afterwards.
    const before = await (await page.request.get("/api/admin/settings")).json();
    expect(typeof before.uploadChunkBytes).toBe("number");
    const restoreMb = Math.round(before.uploadChunkBytes / MB);
    const patched = await page.request.patch("/api/admin/settings", { data: { uploadChunkMb: 1 } });
    expect(patched.ok()).toBeTruthy();

    try {
      const slug = "chunked-e2e-fixture";
      const bundle = buildSkillBundle(slug, Math.floor(2.5 * MB)); // → 3 parts at 1 MB

      // /api/me surfaces the chunk size the propose form slices by.
      const me = await (await page.request.get("/api/me")).json();
      expect(me.uploadChunkBytes).toBe(MB);

      // START: session opens with the server-authoritative chunk size.
      const start = await page.request.post("/api/uploads/chunked", {
        data: { skillSlug: slug, filename: `${slug}.skill`, totalBytes: bundle.length },
      });
      expect(start.status()).toBe(201);
      const { uploadId, chunkBytes } = await start.json();
      expect(chunkBytes).toBe(MB);

      // Guard: a mis-sized part is rejected with the expected byte count (nothing staged).
      const wrong = await page.request.put(`/api/uploads/chunked/${uploadId}/parts/0`, {
        headers: { "content-type": "application/octet-stream" },
        data: bundle.subarray(0, MB - 1),
      });
      expect(wrong.status()).toBe(422);
      expect((await wrong.json()).error).toContain(`exactly ${MB} bytes`);

      // Guard: completing with parts missing is a 409 (client keeps the session and retries).
      const early = await page.request.post(`/api/uploads/chunked/${uploadId}/complete`);
      expect(early.status()).toBe(409);

      // PARTS: exact slices, in order (a real client also sends sequentially).
      const count = Math.ceil(bundle.length / chunkBytes);
      for (let i = 0; i < count; i++) {
        const part = bundle.subarray(i * chunkBytes, Math.min((i + 1) * chunkBytes, bundle.length));
        const put = await page.request.put(`/api/uploads/chunked/${uploadId}/parts/${i}`, {
          headers: { "content-type": "application/octet-stream" },
          data: part,
        });
        expect(put.ok(), `part ${i}`).toBeTruthy();
      }

      // COMPLETE: the identical single-shot pipeline answers with the upload contract, and the
      // stored artifact hash proves the reassembly was byte-exact.
      const complete = await page.request.post(`/api/uploads/chunked/${uploadId}/complete`);
      expect(complete.status()).toBe(201);
      const done = await complete.json();
      expect(done.artifactObjectKey).toMatch(/^uploads\//);
      expect(done.artifactSha256).toBe(createHash("sha256").update(bundle).digest("hex"));
      expect(done.artifactFilename).toBe(`${slug}.skill`);
      expect(done.scan?.severity).toBeTruthy();

      // The session is spent — the same complete again is a 404.
      const replay = await page.request.post(`/api/uploads/chunked/${uploadId}/complete`);
      expect(replay.status()).toBe(404);
    } finally {
      const restored = await page.request.patch("/api/admin/settings", { data: { uploadChunkMb: restoreMb } });
      expect(restored.ok()).toBeTruthy();
    }
  });

  test("single-shot: a truncated multipart body is a clear 400, not an opaque 500", async ({ page }) => {
    await devSignIn(page);
    // A multipart body whose closing boundary never arrives — what a proxy-cut upload looks like.
    const boundary = "----e2eTruncatedBoundary";
    const truncated = `--${boundary}\r\ncontent-disposition: form-data; name="bundle"; filename="x.skill"\r\ncontent-type: application/octet-stream\r\n\r\nPK partial bytes`;
    const res = await page.request.post("/api/uploads", {
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      data: truncated,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("didn’t arrive intact");
  });
});
