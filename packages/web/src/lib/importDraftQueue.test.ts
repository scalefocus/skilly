// Unit tests for the repository import's AI draft queue (SKILLY_SPEC.md §64.5, §64.12).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftQueue, draftReplyFromResponse, type DraftEvent, type DraftReply } from "./importDraftQueue";

/** A fake clock + timer, and a send() whose replies the test settles by hand. */
function harness(maxInFlight = 3, perMinute = 10) {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const sent: string[] = [];
  const resolvers = new Map<string, (r: DraftReply<string>) => void>();
  const events: DraftEvent<string>[] = [];
  const q = new DraftQueue<string>({
    send: (key) => {
      sent.push(key);
      return new Promise((res) => resolvers.set(key, res));
    },
    onEvent: (e) => events.push(e),
    now: () => now,
    schedule: (fn, ms) => timers.push({ at: now + ms, fn }),
    maxInFlight,
    perMinute,
    minuteRetryMs: 15_000,
  });
  const settle = async (key: string, r: DraftReply<string>) => {
    resolvers.get(key)!(r);
    resolvers.delete(key);
    await new Promise((r2) => setImmediate(r2));
  };
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) {
      if (t.at <= now) t.fn();
      else timers.push(t);
    }
  };
  return { q, sent, events, settle, advance };
}

test("draft queue: step order, at most 3 in flight, the next one starts as one finishes", async () => {
  const h = harness();
  h.q.enqueue(["a", "b", "c", "d", "e"]);
  assert.deepEqual(h.sent, ["a", "b", "c"]);
  await h.settle("b", { kind: "ok", draft: "B" });
  assert.deepEqual(h.sent, ["a", "b", "c", "d"]);
  assert.deepEqual(h.events.filter((e) => e.kind === "ok"), [{ key: "b", kind: "ok", draft: "B" }]);
});

test("draft queue: at most 10 started per rolling minute; the rest wait for the window", async () => {
  const h = harness(20, 10);
  h.q.enqueue(Array.from({ length: 12 }, (_, i) => `k${i}`));
  assert.equal(h.sent.length, 10);
  for (let i = 0; i < 10; i++) await h.settle(`k${i}`, { kind: "ok", draft: "x" });
  assert.equal(h.sent.length, 10, "still inside the minute");
  h.advance(60_000);
  assert.equal(h.sent.length, 12);
});

test("draft queue: a per-minute 429 retries the same draft later and is not counted", async () => {
  const h = harness(1, 10);
  h.q.enqueue(["a", "b"]);
  await h.settle("a", { kind: "minute" });
  assert.deepEqual(h.sent, ["a"]);
  h.advance(15_000);
  assert.deepEqual(h.sent, ["a", "a"], "retried first, before b");
  await h.settle("a", { kind: "ok", draft: "A" });
  assert.deepEqual(h.sent, ["a", "a", "b"]);
});

test("draft queue: the daily cap stops the queue; this and every queued draft are capped", async () => {
  const h = harness(1, 10);
  h.q.enqueue(["a", "b", "c"]);
  await h.settle("a", { kind: "day", retryAt: "2026-10-30T10:00:00Z" });
  assert.deepEqual(h.events.filter((e) => e.kind === "capped").map((e) => e.key), ["a", "b", "c"]);
  h.q.enqueue(["d"]);
  assert.deepEqual(h.sent, ["a"], "nothing more is sent");
  assert.ok(h.events.some((e) => e.key === "d" && e.kind === "capped"));
});

test("draft queue: dropping an unsent draft never sends it; one in flight can't be dropped", async () => {
  const h = harness(1, 10);
  h.q.enqueue(["a", "b", "c"]);
  assert.equal(h.q.drop("b"), true);
  assert.equal(h.q.drop("a"), false);
  await h.settle("a", { kind: "failed", message: "nope" });
  assert.deepEqual(h.sent, ["a", "c"]);
  assert.ok(h.events.some((e) => e.key === "a" && e.kind === "failed"));
});

test("draft queue: prioritize moves the step being viewed to the front", () => {
  const h = harness(1, 10);
  h.q.enqueue(["a", "b", "c", "d"]);
  h.q.prioritize("d");
  assert.deepEqual([...h.q.pendingKeys], ["d", "b", "c"]);
});

test("draft queue: a step's own click goes to the front of the queue", () => {
  const h = harness(1, 10);
  h.q.enqueue(["a", "b", "c"]);
  h.q.enqueueFirst("x");
  assert.deepEqual([...h.q.pendingKeys], ["x", "b", "c"]);
  h.q.enqueueFirst("c");
  assert.deepEqual([...h.q.pendingKeys], ["c", "x", "b"], "a queued key moves up, not twice");
  h.q.enqueueFirst("a");
  assert.deepEqual([...h.q.pendingKeys], ["c", "x", "b"], "one in flight isn't queued again");
});

test("draft queue: a click with a free slot starts at once; dropping an unsent click never sends it", async () => {
  const h = harness(2, 10);
  h.q.enqueue(["a", "b", "c"]);
  h.q.enqueueFirst("x");
  assert.deepEqual(h.sent, ["a", "b"]);
  assert.equal(h.q.drop("x"), true);
  await h.settle("a", { kind: "ok", draft: "A" });
  assert.deepEqual(h.sent, ["a", "b", "c"], "the dropped click was never sent");
});

test("draft queue: after the daily cap, resume lets a click through and the server decides again", async () => {
  const h = harness(1, 10);
  h.q.enqueue(["a"]);
  await h.settle("a", { kind: "day", retryAt: "2026-10-30T10:00:00Z" });
  h.q.enqueueFirst("x");
  assert.ok(h.events.some((e) => e.key === "x" && e.kind === "capped"), "still stopped before resume");
  assert.deepEqual(h.sent, ["a"]);
  h.q.resume();
  h.q.enqueueFirst("y");
  assert.deepEqual(h.sent, ["a", "y"]);
  await h.settle("y", { kind: "ok", draft: "Y" });
  assert.ok(h.events.some((e) => e.key === "y" && e.kind === "ok"));
});

test("draft queue: ai_unavailable stops the queue for good; resume doesn't lift it", async () => {
  const h = harness(1, 10);
  h.q.enqueue(["a", "b"]);
  await h.settle("a", { kind: "unavailable" });
  assert.deepEqual(h.events.filter((e) => e.kind === "unavailable").map((e) => e.key), ["a", "b"]);
  h.q.resume();
  h.q.enqueueFirst("x");
  assert.deepEqual(h.sent, ["a"]);
  assert.ok(h.events.some((e) => e.key === "x" && e.kind === "unavailable"));
});

test("draftReplyFromResponse maps the §43.5 statuses", () => {
  const to = (b: Record<string, unknown>) => String(b.description);
  assert.deepEqual(draftReplyFromResponse(200, { description: "x" }, to), { kind: "ok", draft: "x" });
  assert.deepEqual(draftReplyFromResponse(429, { scope: "minute" }, to), { kind: "minute" });
  assert.deepEqual(draftReplyFromResponse(429, { scope: "day", retryAt: "t" }, to), { kind: "day", retryAt: "t" });
  assert.deepEqual(draftReplyFromResponse(502, { message: "boom" }, to), { kind: "failed", message: "boom" });
  assert.deepEqual(draftReplyFromResponse(409, { error: "ai_unavailable" }, to), { kind: "unavailable" });
  assert.deepEqual(draftReplyFromResponse(422, null, to), { kind: "failed", message: "Couldn't draft this one." });
});
