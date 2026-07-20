// Live-DB integration test for chunked-upload sessions (§6): create-session validation (size cap,
// per-user open-session ceiling), ownership, the 2 h orphan sweep (rows + staged objects), and
// destroy-on-complete/abort semantics. Object storage is an in-memory fake — MinIO isn't needed.
// Gated behind SKILLY_DB_E2E=1:
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, getOwnSession, destroySession, sweepStaleSessions, stagingKey, putPart, MAX_OPEN_SESSIONS_PER_USER, STAGING_PREFIX } from "./chunkedUploads";
import type { ArtifactStore, ObjectListing } from "./objectStore";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";
const MB = 1024 * 1024;

function memStore(): ArtifactStore & { objects: Map<string, { body: Buffer; lastModified: Date }> } {
  const objects = new Map<string, { body: Buffer; lastModified: Date }>();
  return {
    objects,
    async get(key) {
      const v = objects.get(key);
      if (!v) throw new Error(`NoSuchKey: ${key}`);
      return v.body;
    },
    async put(key, body) {
      objects.set(key, { body: Buffer.from(body), lastModified: new Date() });
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix): Promise<ObjectListing[]> {
      return [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, lastModified: v.lastModified }));
    },
  };
}

test("chunked-upload sessions: validation, per-user cap, ownership, sweep, destroy", { skip: !enabled }, async () => {
  try {
    const owner = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ('chunked-owner-oid','chunked-owner@t','ChunkOwner')
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
    )).rows[0]!.id;
    const other = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ('chunked-other-oid','chunked-other@t','ChunkOther')
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
    )).rows[0]!.id;
    // Clean slate for local re-runs.
    await pool.query(`delete from upload_sessions where user_id in ($1, $2)`, [owner, other]);

    const limits = { maxBundleBytes: 200 * MB, chunkBytes: 5 * MB };

    // Validation: required fields, positive integral total, size cap (413 wording matches §6).
    for (const bad of [
      { skillSlug: "", filename: "a.skill", totalBytes: 10 },
      { skillSlug: "demo", filename: "", totalBytes: 10 },
      { skillSlug: "demo", filename: "a.skill", totalBytes: 0 },
      { skillSlug: "demo", filename: "a.skill", totalBytes: 1.5 },
    ]) {
      const r = await createSession(owner, bad, limits);
      assert.ok("error" in r && r.status === 422, `422 for ${JSON.stringify(bad)}`);
    }
    const tooBig = await createSession(owner, { skillSlug: "demo", filename: "a.skill", totalBytes: 200 * MB + 1 }, limits);
    assert.ok("error" in tooBig && tooBig.status === 413 && /bigger than the allowed size of 200 MB/.test(tooBig.error));

    // Create + ownership: the owner sees it, another user doesn't (indistinguishable from absent).
    const created = await createSession(owner, { skillSlug: "demo", filename: "deck.skill", totalBytes: 12 * MB + 100 }, limits);
    assert.ok("session" in created);
    const s = created.session;
    assert.equal(s.chunkBytes, 5 * MB, "session freezes the chunk size at start");
    assert.equal(s.totalBytes, 12 * MB + 100);
    assert.ok(await getOwnSession(s.id, owner), "owner resolves their session");
    assert.equal(await getOwnSession(s.id, other), null, "someone else's session reads as absent");

    // Per-user ceiling: sessions beyond MAX_OPEN_SESSIONS_PER_USER are refused with 409.
    for (let i = 1; i < MAX_OPEN_SESSIONS_PER_USER; i++) {
      const extra = await createSession(owner, { skillSlug: `demo-${i}`, filename: "x.skill", totalBytes: 6 * MB }, limits);
      assert.ok("session" in extra, `session ${i + 1} within the cap opens`);
    }
    const overCap = await createSession(owner, { skillSlug: "demo-over", filename: "x.skill", totalBytes: 6 * MB }, limits);
    assert.ok("error" in overCap && overCap.status === 409 && /too many uploads in progress/.test(overCap.error));
    // …while a different user is unaffected by the owner's cap.
    const otherOk = await createSession(other, { skillSlug: "demo-other", filename: "x.skill", totalBytes: 6 * MB }, limits);
    assert.ok("session" in otherOk, "the cap is per-user");

    // Sweep: an aged session row goes; its staged objects (aged too) go; fresh state survives.
    const store = memStore();
    await putPart(otherOk.session, 0, Buffer.alloc(5 * MB), store); // fresh part of a fresh session
    await pool.query(`update upload_sessions set created_at = now() - interval '3 hours' where id = $1`, [s.id]);
    store.objects.set(stagingKey(s.id, 0), { body: Buffer.alloc(5 * MB), lastModified: new Date(Date.now() - 3 * 3_600_000) });
    await sweepStaleSessions(pool, store);
    assert.equal(await getOwnSession(s.id, owner), null, "aged session row swept");
    assert.equal(store.objects.has(stagingKey(s.id, 0)), false, "aged staged object swept");
    assert.ok(await getOwnSession(otherOk.session.id, other), "fresh session survives the sweep");
    assert.equal(store.objects.has(stagingKey(otherOk.session.id, 0)), true, "fresh staged part survives");
    assert.ok(stagingKey(otherOk.session.id, 0).startsWith(STAGING_PREFIX));

    // Destroy (complete/abort): row + parts gone; destroying again is a no-op.
    await destroySession(otherOk.session, pool, store);
    assert.equal(await getOwnSession(otherOk.session.id, other), null, "destroyed session row gone");
    assert.equal(store.objects.size, 0, "destroyed session's parts gone");
    await destroySession(otherOk.session, pool, store); // idempotent

    // Cleanup the remaining cap-filler sessions.
    await pool.query(`delete from upload_sessions where user_id in ($1, $2)`, [owner, other]);
  } finally {
    await pool.end();
  }
});
