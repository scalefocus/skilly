// The marketplace freshness stamp (SKILLY_SPEC.md §30.5): which row each scope writes, and that
// the public stamp is an ISO string the web tier can parse back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_SYNCED_AT_KEY, stampMarketplaceSynced, type StampDb } from "./syncStamp.js";

function recorder(): StampDb & { calls: { text: string; params: unknown[] | undefined }[] } {
  const calls: { text: string; params: unknown[] | undefined }[] = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rowCount: 1 };
    },
  };
}

test("a namespace marketplace stamps namespaces.marketplace_synced_at for that namespace", async () => {
  const db = recorder();
  const at = new Date("2026-09-03T10:00:00.000Z");
  await stampMarketplaceSynced(db, { kind: "namespace", namespaceSlug: "team-a" }, "ns-1", at);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0]!.text, /update namespaces set marketplace_synced_at/);
  assert.deepEqual(db.calls[0]!.params, ["ns-1", at]);
});

test("the public marketplace upserts an ISO string under marketplace_public_synced_at", async () => {
  const db = recorder();
  const at = new Date("2026-09-03T10:00:00.000Z");
  await stampMarketplaceSynced(db, { kind: "public" }, null, at);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0]!.text, /insert into platform_settings/);
  assert.match(db.calls[0]!.text, /on conflict \(key\) do update/);
  assert.deepEqual(db.calls[0]!.params, [PUBLIC_SYNCED_AT_KEY, "2026-09-03T10:00:00.000Z"]);
  // The web tier does `new Date(value)` on the stored string — it must round-trip exactly.
  assert.equal(new Date(db.calls[0]!.params![1] as string).getTime(), at.getTime());
});

test("a namespace scope without a namespace id is a programming error, not a silent no-op", async () => {
  const db = recorder();
  await assert.rejects(() => stampMarketplaceSynced(db, { kind: "namespace", namespaceSlug: "x" }, null));
  assert.equal(db.calls.length, 0);
});
