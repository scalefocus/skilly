import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { GraphSendError } from "@skilly/shared/email";
import { renderNotification, deliverPendingNotifications, type NotificationRow, type EmailTransport } from "./deliver.js";

const BASE = "https://skilly.test";

test("renderNotification: proposal accepted — human subject + [View it] link, no JSON", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({ type: "proposal.accept", payload: { proposalId: "p1", state: "accepted" } });
  assert.equal(r.subject, "Skilly - Proposal accepted");
  assert.match(r.text, /was accepted/);
  assert.match(r.text, /\[View it\]\(https:\/\/skilly\.test\/proposals\/p1\)/);
  assert.equal(r.webhook.event, "proposal.accept");
  assert.equal(r.webhook.proposalId, "p1");
});

test("renderNotification: changes-requested includes the reviewer note", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({ type: "proposal.request_changes", payload: { proposalId: "p2", note: "tighten the description" } });
  assert.equal(r.subject, "Skilly - Changes requested");
  assert.match(r.text, /Reviewer note: "tighten the description"/);
  assert.equal(r.webhook.note, "tighten the description");
});

test("renderNotification: direct message — friendly subject/body + ?conversation deep link", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({
    type: "message.new",
    payload: { conversationId: "c1", proposalId: null, requestId: null, title: "Direct message", fromName: "Nedjalko Milenkov" },
  });
  assert.equal(r.subject, "Skilly - Direct message");
  assert.match(r.text, /You have a new direct message from Nedjalko Milenkov\./);
  assert.match(r.text, /\[See the message\]\(https:\/\/skilly\.test\/\?conversation=c1\)/);
});

test("renderNotification: a message on a proposal thread links to the proposal", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({
    type: "message.new",
    payload: { conversationId: "c2", proposalId: "p9", requestId: null, title: "pdf 1.2.0", fromName: "Ada" },
  });
  assert.equal(r.subject, "Skilly - New message");
  assert.match(r.text, /Ada posted a new message in "pdf 1\.2\.0"\./);
  assert.match(r.text, /\/proposals\/p9/);
});

test("renderNotification: skill.new_version renders slug + version + skill link", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({ type: "skill.new_version", payload: { namespaceSlug: "team-a", skillSlug: "pdf", semver: "1.2.0" } });
  assert.equal(r.subject, "Skilly - New version published");
  assert.match(r.text, /team-a\/pdf published version 1\.2\.0\./);
  assert.match(r.text, /\[View the skill\]\(https:\/\/skilly\.test\/skills\/team-a\/pdf\)/);
});

test("renderNotification: request.fulfilled names the request, fulfiller, and skill", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({
    type: "request.fulfilled",
    payload: { requestId: "r1", requestTitle: "A PDF tool", byName: "Bob", namespaceSlug: "team-a", skillSlug: "pdf" },
  });
  assert.equal(r.subject, "Skilly - Skill request fulfilled");
  assert.match(r.text, /Your skill request "A PDF tool" was fulfilled by Bob with team-a\/pdf\./);
  assert.match(r.text, /\/skills\/team-a\/pdf/);
});

test("renderNotification: skill.marked_official is human", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({ type: "skill.marked_official", payload: { namespaceSlug: "team-a", skillSlug: "pdf" } });
  assert.equal(r.subject, "Skilly - Skill marked official");
  assert.match(r.text, /team-a\/pdf was marked official\./);
});

test("renderNotification: unknown type falls back to a human sentence — never JSON", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const r = renderNotification({ type: "something.else", payload: { a: 1, secret: "x" } });
  assert.equal(r.subject, "Skilly - Notification");
  assert.match(r.text, /You have a new notification in skilly\./);
  assert.ok(!r.text.includes("{"), "fallback body must not contain JSON");
  assert.ok(!r.text.includes("secret"), "fallback body must not leak the payload");
  assert.equal(r.webhook.event, "something.else");
});

test("renderNotification: every subject carries the 'Skilly - ' prefix", () => {
  process.env.PUBLIC_BASE_URL = BASE;
  for (const type of ["proposal.accept", "message.new", "skill.new_version", "request.fulfilled", "system.error", "whatever.new"]) {
    const r = renderNotification({ type, payload: { proposalId: "p", conversationId: "c", skillSlug: "s", namespaceSlug: "n", count: 1 } });
    assert.ok(r.subject.startsWith("Skilly - "), `${type}: ${r.subject}`);
  }
});

test("renderNotification: no PUBLIC_BASE_URL → CTA degrades to a bare label (no markdown link)", () => {
  delete process.env.PUBLIC_BASE_URL;
  delete process.env.SKILLY_REGISTRY_URL;
  const r = renderNotification({ type: "message.new", payload: { conversationId: "c1", fromName: "Ned" } });
  assert.equal(r.subject, "Skilly - Direct message");
  assert.ok(!r.text.includes("["), r.text); // no markdown link syntax without a base URL
  assert.match(r.text, /See the message$/);
});

// ── sweep-level behavior (fake pool; SKILLY_SPEC.md §12) ─────────────────────────────────

function row(overrides: Partial<NotificationRow>): NotificationRow {
  return {
    id: "n1",
    type: "proposal.accept",
    payload: { proposalId: "p1" },
    email: "user@corp.com",
    displayName: "User",
    emailNotifications: true,
    ...overrides,
  };
}

/** Minimal pool: serves the batch select once, records delivered/failed/throttled updates. */
function fakePool(rows: NotificationRow[]) {
  const delivered: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const throttled: { id: string; error: string }[] = [];
  const pool = {
    query: async (text: string, params: unknown[] = []) => {
      const t = text.trim().toLowerCase();
      if (t.startsWith("select")) return { rows, rowCount: rows.length };
      if (t.includes("set delivered_at")) {
        delivered.push(params[0] as string);
        return { rows: [], rowCount: 1 };
      }
      if (t.includes("delivery_attempts + 1")) {
        failed.push({ id: params[0] as string, error: params[1] as string });
        return { rows: [], rowCount: 1 };
      }
      if (t.includes("set delivery_error")) {
        // The 429 path: error recorded WITHOUT an attempts increment.
        throttled.push({ id: params[0] as string, error: params[1] as string });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  } as unknown as Pool;
  return { pool, delivered, failed, throttled };
}

function captureEmail(kind: "graph" | "smtp" = "graph"): EmailTransport & { sent: string[] } {
  const sent: string[] = [];
  return {
    kind,
    sent,
    send: async (to) => {
      sent.push(to);
    },
  };
}

test("sweep: opted-out and address-less recipients get no email but the row still delivers", async () => {
  const rows = [
    row({ id: "n1", emailNotifications: false }),
    row({ id: "n2", email: "" }),
    row({ id: "n3" }),
  ];
  const { pool, delivered } = fakePool(rows);
  const email = captureEmail();
  const r = await deliverPendingNotifications(pool, { email });
  assert.deepEqual(email.sent, ["user@corp.com"]); // only n3
  assert.deepEqual(delivered.sort(), ["n1", "n2", "n3"]); // all marked delivered on schedule
  assert.equal(r.delivered, 3);
  assert.equal(r.failed, 0);
});

test("sweep: no external channel → rows marked delivered immediately (in-app is the delivery)", async () => {
  const { pool, delivered } = fakePool([row({ id: "n1" })]);
  const r = await deliverPendingNotifications(pool, {});
  assert.deepEqual(delivered, ["n1"]);
  assert.equal(r.delivered, 1);
});

test("sweep: a Graph 429 consumes NO attempt, stops the batch, and returns Retry-After", async () => {
  const rows = [row({ id: "n1" }), row({ id: "n2" }), row({ id: "n3" })];
  const { pool, delivered, failed, throttled } = fakePool(rows);
  const email: EmailTransport = {
    kind: "graph",
    send: async () => {
      throw new GraphSendError(429, "graph sendMail failed: 429", 30);
    },
  };
  const r = await deliverPendingNotifications(pool, { email });
  assert.equal(failed.length, 0); // sustained throttling must never park rows (§12)
  assert.equal(throttled.length, 1); // error recorded on n1, without an attempts increment
  assert.equal(throttled[0]!.id, "n1");
  assert.deepEqual(delivered, []); // batch stopped — n2/n3 untouched this sweep
  assert.equal(r.failed, 1);
  assert.equal(r.retryAfterSeconds, 30); // caller pauses sweeps until the window elapses
});

test("sweep: a non-429 send failure retries per-row without stopping the batch", async () => {
  const rows = [row({ id: "n1" }), row({ id: "n2" })];
  const { pool, delivered, failed } = fakePool(rows);
  let first = true;
  const email: EmailTransport = {
    kind: "smtp",
    send: async () => {
      if (first) {
        first = false;
        throw new Error("connection refused");
      }
    },
  };
  const r = await deliverPendingNotifications(pool, { email });
  assert.equal(failed.length, 1);
  assert.deepEqual(delivered, ["n2"]);
  assert.equal(r.delivered, 1);
  assert.equal(r.failed, 1);
});
