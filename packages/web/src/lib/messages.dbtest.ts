// Live-DB integration test for the §12/§24 message.new coalescing contract: the refresh is
// update-in-place and PRESERVES delivery bookkeeping, so the email channel sends at most one
// email per conversation until the recipient reads it. Gated behind SKILLY_DB_E2E=1:
//
//   SKILLY_DB_E2E=1 DATABASE_URL=postgres://… pnpm --filter @skilly/web test:db
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EffectiveAccess } from "@skilly/shared";

const enabled = process.env.SKILLY_DB_E2E === "1";

test("message.new coalescing: update-in-place preserves delivered_at (one email per conversation until read)", { skip: !enabled }, async () => {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { getOrCreateDirectConversation, postToConversation } = await import("./messages");
  try {
    const mkUser = async (oid: string, email: string, name: string) =>
      (await pool.query<{ id: string }>(
        `insert into users (entra_object_id, email, display_name) values ($1, $2, $3)
         on conflict (entra_object_id) do update set email = excluded.email returning id`,
        [oid, email, name],
      )).rows[0]!.id;
    const alice = await mkUser("msg-coalesce-a", "alice@t", "Alice");
    const bob = await mkUser("msg-coalesce-b", "bob@t", "Bob");
    const access = (userId: string) =>
      ({ userId, isPlatformAdmin: false, namespaceRoles: new Map() }) as unknown as EffectiveAccess & { userId: string };

    const conv = await getOrCreateDirectConversation(access(alice), bob);
    assert.ok(conv && typeof conv === "object" && "conversationId" in conv, `direct conversation: ${JSON.stringify(conv)}`);
    const conversationId = (conv as { conversationId: string }).conversationId;
    // Reset any state from a previous local run of this test.
    await pool.query(`delete from notifications where user_id = $1 and type = 'message.new' and payload->>'conversationId' = $2`, [bob, conversationId]);

    // First message → exactly one unread message.new for Bob, undelivered.
    assert.ok(await postToConversation(access(alice), conversationId, "hello"));
    const first = await pool.query(
      `select id, delivered_at from notifications where user_id = $1 and type = 'message.new' and read_at is null and payload->>'conversationId' = $2`,
      [bob, conversationId],
    );
    assert.equal(first.rowCount, 1);

    // Simulate the delivery sweep having emailed it.
    await pool.query(`update notifications set delivered_at = now() where id = $1`, [first.rows[0]!.id]);

    // Second message → SAME row refreshed (payload/recency), delivered_at PRESERVED → no re-email.
    assert.ok(await postToConversation(access(alice), conversationId, "hello again"));
    const second = await pool.query(
      `select id, delivered_at, payload from notifications where user_id = $1 and type = 'message.new' and read_at is null and payload->>'conversationId' = $2`,
      [bob, conversationId],
    );
    assert.equal(second.rowCount, 1, "still one coalesced row");
    assert.equal(second.rows[0]!.id, first.rows[0]!.id, "row updated in place, not recreated");
    assert.ok(second.rows[0]!.delivered_at, "delivery bookkeeping preserved — the email channel won't re-send");
  } finally {
    await pool.end();
  }
});
