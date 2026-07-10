// Notification delivery (leader-only). The web app writes rows into `notifications` on
// governance events; this sweep fans each undelivered row out over the configured channels
// (email — Graph service account preferred, env SMTP fallback — + outbound webhook), then
// marks it delivered exactly once. SKILLY_SPEC.md §12.
//
// If NO external channel is configured, in-app is the delivery — rows are marked delivered
// immediately so the queue drains. Transient failures increment delivery_attempts and are
// retried until MAX_ATTEMPTS, after which the row is parked (delivered_at stays NULL but it
// is skipped) — its delivery_error is preserved for the operator. A Graph 429 is special:
// it consumes NO attempt, stops the current batch, and returns Retry-After so the caller
// pauses delivery sweeps until the throttle window elapses (§12).
//
// Per-recipient email gating (§12): users with email_notifications=false — and users without
// an email address — get no email over EITHER transport; their rows still deliver on schedule
// (in-app/webhook), never queuing up to burst-send later.
import type { Pool } from "pg";
import { GraphSendError } from "@skilly/shared/email";
import { notificationTitle } from "@skilly/shared";

const MAX_ATTEMPTS = Number(process.env.NOTIFY_MAX_ATTEMPTS ?? 5);
const BATCH = Number(process.env.NOTIFY_BATCH ?? 50);

export interface NotificationRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  email: string;
  displayName: string;
  emailNotifications: boolean;
}

export interface RenderedNotification {
  subject: string;
  text: string;
  /** Structured body for outbound webhooks (Teams/Slack accept arbitrary JSON). */
  webhook: Record<string, unknown>;
}

/** The body sentence for each proposal state-change notification (§12 Notification content). */
const PROPOSAL_BODY: Record<string, string> = {
  "proposal.accept": "Your skill proposal was accepted.",
  "proposal.reject": "Your skill proposal was rejected.",
  "proposal.request_changes": "Your skill proposal needs changes.",
  "proposal.start_review": "Your skill proposal is now under review.",
  "proposal.resubmit": "Your skill proposal was resubmitted.",
};

/**
 * Pure: turn a notification row into channel-ready content — a **human** subject and body for
 * every type (never a raw event key, never a JSON dump), with a `[label](url)` call-to-action the
 * §12 email transports render as a clickable link (bare label when PUBLIC_BASE_URL is unset). The
 * subject title is shared with the in-app center's pill label (`@skilly/shared`). Unit-tested
 * without a DB. SKILLY_SPEC.md §12 (Notification content).
 */
export function renderNotification(n: Pick<NotificationRow, "type" | "payload">): RenderedNotification {
  const p = n.payload ?? {};
  const BASE_URL = process.env.PUBLIC_BASE_URL ?? process.env.SKILLY_REGISTRY_URL ?? "";
  const abs = (path: string): string | null => (BASE_URL ? `${BASE_URL}${path}` : null);
  // A call-to-action: a `[label](url)` link when we have an absolute URL, else the bare label
  // (the sentence still stands on its own when PUBLIC_BASE_URL is unset — §12).
  const cta = (label: string, path: string): string => {
    const u = abs(path);
    return u ? `[${label}](${u})` : label;
  };
  const subj = (title: string) => `Skilly - ${title}`;
  const title = notificationTitle(n.type);

  // message.new — a direct message, or a message on a proposal/request thread (told apart by
  // whether the payload carries a proposalId/requestId). A DM has no page of its own, so it
  // deep-links to the topbar Messages panel via ?conversation=<id> (§24).
  if (n.type === "message.new") {
    const conversationId = typeof p.conversationId === "string" ? p.conversationId : null;
    const proposalId = typeof p.proposalId === "string" ? p.proposalId : null;
    const requestId = typeof p.requestId === "string" ? p.requestId : null;
    const fromName = typeof p.fromName === "string" && p.fromName ? p.fromName : "Someone";
    if (proposalId || requestId) {
      const ctxTitle = typeof p.title === "string" && p.title ? p.title : "a discussion";
      const path = proposalId ? `/proposals/${proposalId}` : `/requests/${requestId}`;
      const s = subj("New message");
      return {
        subject: s,
        text: `${fromName} posted a new message in "${ctxTitle}". ${cta("View the discussion", path)}`,
        webhook: { event: n.type, title: s, conversationId, proposalId, requestId, from: fromName, url: abs(path) },
      };
    }
    const path = `/?conversation=${conversationId ?? ""}`;
    const s = subj("Direct message");
    return {
      subject: s,
      text: `You have a new direct message from ${fromName}. ${cta("See the message", path)}`,
      webhook: { event: n.type, title: s, conversationId, from: fromName, url: abs(path) },
    };
  }

  // Skill events — all three link to the skill page; only the sentence + CTA verb differ.
  if ((n.type === "skill.new_version" || n.type === "skill.drift" || n.type === "skill.marked_official") && typeof p.skillSlug === "string") {
    const slug = `${p.namespaceSlug ?? ""}/${p.skillSlug}`;
    const path = `/skills/${p.namespaceSlug}/${p.skillSlug}`;
    let sentence: string;
    let label: string;
    if (n.type === "skill.new_version") {
      sentence = `${slug} published version ${p.semver ?? ""}.`;
      label = "View the skill";
    } else if (n.type === "skill.drift") {
      sentence = `${slug} has drifted from its pinned upstream ref (${p.ref ?? ""}).`;
      label = "Review it";
    } else {
      sentence = `${slug} was marked official.`;
      label = "View the skill";
    }
    const s = subj(title);
    return {
      subject: s,
      text: `${sentence} ${cta(label, path)}`,
      webhook: { event: n.type, title: s, skill: slug, semver: p.semver ?? null, ref: p.ref ?? null, url: abs(path) },
    };
  }

  if (n.type === "request.fulfilled") {
    const reqTitle = typeof p.requestTitle === "string" && p.requestTitle ? p.requestTitle : "your request";
    const byName = typeof p.byName === "string" && p.byName ? p.byName : "a contributor";
    const hasSkill = typeof p.namespaceSlug === "string" && typeof p.skillSlug === "string";
    const slug = hasSkill ? `${p.namespaceSlug}/${p.skillSlug}` : "";
    const path = hasSkill ? `/skills/${p.namespaceSlug}/${p.skillSlug}` : null;
    const s = subj(title);
    return {
      subject: s,
      text: `Your skill request "${reqTitle}" was fulfilled by ${byName}${slug ? ` with ${slug}` : ""}.${path ? ` ${cta("View the skill", path)}` : ""}`,
      webhook: { event: n.type, title: s, requestId: p.requestId ?? null, skill: slug || null, url: path ? abs(path) : null },
    };
  }

  if ((n.type === "proposal.needs_review" || n.type === "proposal.submitted") && typeof p.proposalId === "string") {
    const path = `/proposals/${p.proposalId}`;
    const reviewer = n.type === "proposal.needs_review";
    const s = subj(title);
    const sentence = reviewer
      ? "A new skill proposal is awaiting your review."
      : "Your skill proposal was submitted and is awaiting review.";
    return {
      subject: s,
      text: `${sentence} ${cta(reviewer ? "Review it" : "View it", path)}`,
      webhook: { event: n.type, title: s, proposalId: p.proposalId, url: abs(path) },
    };
  }

  const proposalBody = PROPOSAL_BODY[n.type];
  if (proposalBody && typeof p.proposalId === "string") {
    const path = `/proposals/${p.proposalId}`;
    const note = typeof p.note === "string" && p.note ? ` Reviewer note: "${p.note}"` : "";
    const s = subj(title);
    return {
      subject: s,
      text: `${proposalBody}${note} ${cta("View it", path)}`,
      webhook: { event: n.type, title: s, proposalId: p.proposalId, state: p.state ?? null, note: p.note ?? null, url: abs(path) },
    };
  }

  if (n.type === "system.error") {
    const count = typeof p.count === "number" ? p.count : 0;
    const path = "/system-log";
    const s = subj(title);
    return {
      subject: s,
      text: `There ${count === 1 ? "is" : "are"} ${count} new system log event${count === 1 ? "" : "s"}. ${cta("View the system log", path)}`,
      webhook: { event: n.type, title: s, count, url: abs(path) },
    };
  }

  // Generic fallback — ALWAYS human, NEVER JSON (§12): any unknown/new type gets a sane email
  // instead of leaking its payload to the recipient.
  const s = subj("Notification");
  return {
    subject: s,
    text: `You have a new notification in skilly.${abs("/") ? ` ${cta("Open skilly", "/")}` : ""}`,
    webhook: { event: n.type, title: s, payload: p },
  };
}

/** One of the two §12 email transports — exactly one is active per sweep. */
export interface EmailTransport {
  kind: "graph" | "smtp";
  /** Send one email (the transport does its own §12 formatting). Throws on failure. */
  send(to: string, msg: RenderedNotification): Promise<void>;
}

export interface DeliveryChannels {
  /** The active email transport. Undefined when neither Graph nor SMTP is operational. */
  email?: EmailTransport;
  /** POST a JSON body to the org webhook. Throws on failure. Undefined when not configured. */
  webhook?: (body: Record<string, unknown>) => Promise<void>;
}

export interface DeliveryResult {
  delivered: number;
  failed: number;
  /** Set when Graph throttled the batch (429): the caller pauses delivery sweeps until
   *  Retry-After elapses. Nothing is marked delivered meanwhile, so no email is lost (§12). */
  retryAfterSeconds?: number;
}

/**
 * Drain a batch of undelivered notifications across the configured channels. Idempotent and
 * safe to run on a timer; only the leader runs it (advisory lock in index.ts).
 */
export async function deliverPendingNotifications(pool: Pool, channels: DeliveryChannels): Promise<DeliveryResult> {
  const { rows } = await pool.query<NotificationRow>(
    `select n.id, n.type, n.payload, u.email, u.display_name as "displayName",
            u.email_notifications as "emailNotifications"
       from notifications n
       join users u on u.id = n.user_id
      where n.delivered_at is null and n.delivery_attempts < $1
      order by n.created_at asc
      limit $2`,
    [MAX_ATTEMPTS, BATCH],
  );

  const hasExternal = Boolean(channels.email || channels.webhook);
  let delivered = 0;
  let failed = 0;

  for (const row of rows) {
    if (!hasExternal) {
      // In-app only: nothing to send, just record that the queue handled it.
      await pool.query(`update notifications set delivered_at = now() where id = $1`, [row.id]);
      delivered++;
      continue;
    }
    try {
      const msg = renderNotification(row);
      // Per-user email opt-out + missing-address skip (§12): the row still delivers on schedule.
      if (channels.email && row.email && row.emailNotifications) await channels.email.send(row.email, msg);
      if (channels.webhook) await channels.webhook(msg.webhook);
      await pool.query(`update notifications set delivered_at = now() where id = $1`, [row.id]);
      delivered++;
    } catch (err) {
      const errText = String((err as Error).message ?? err).slice(0, 500);
      if (err instanceof GraphSendError && err.status === 429) {
        // Graph throttling is not the row's fault: record the error WITHOUT consuming an
        // attempt (sustained throttling must never park rows and drop their email), stop
        // the batch, and tell the caller to pause until Retry-After elapses (§12).
        await pool.query(`update notifications set delivery_error = $2 where id = $1`, [row.id, errText]);
        failed++;
        return { delivered, failed, retryAfterSeconds: err.retryAfterSeconds ?? 30 };
      }
      await pool.query(
        `update notifications set delivery_attempts = delivery_attempts + 1, delivery_error = $2 where id = $1`,
        [row.id, errText],
      );
      failed++;
    }
  }

  return { delivered, failed };
}
