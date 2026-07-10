// Channel factories built from env. Returns `undefined` for any channel that isn't
// configured, so deliverPendingNotifications transparently falls back to in-app only.
// SMTP (nodemailer) is the FALLBACK email transport — the admin-connected Graph service
// account takes precedence when operational (graphChannel.ts). Both transports append the
// §12 "Manage email notifications" pointer; SMTP mail stays plain-text (no wrapper).
// The webhook uses the built-in fetch (Node 20+). SKILLY_SPEC.md §12.
import { renderEmailText } from "@skilly/shared";
import type { DeliveryChannels, EmailTransport } from "./deliver.js";

const BASE_URL = process.env.PUBLIC_BASE_URL ?? process.env.SKILLY_REGISTRY_URL ?? "";

function emailChannel(): EmailTransport | undefined {
  const host = process.env.SMTP_HOST;
  if (!host) return undefined;
  const from = process.env.SMTP_FROM ?? "skilly@localhost";
  const port = Number(process.env.SMTP_PORT ?? 587);
  // Lazy import so the dependency is only loaded when SMTP is actually configured.
  let transportPromise: Promise<import("nodemailer").Transporter> | null = null;
  const getTransport = async () => {
    if (!transportPromise) {
      transportPromise = import("nodemailer").then((nm) =>
        nm.createTransport({
          host,
          port,
          secure: process.env.SMTP_SECURE === "1" || port === 465,
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
          // Bound how long a stuck SMTP server can block the (sequential) delivery sweep.
          connectionTimeout: 10_000,
          greetingTimeout: 10_000,
          socketTimeout: 15_000,
        }),
      );
    }
    return transportPromise;
  };
  return {
    kind: "smtp",
    send: async (to, msg) => {
      const t = await getTransport();
      await t.sendMail({ from, to, subject: msg.subject, text: renderEmailText(msg.text, BASE_URL) });
    },
  };
}

function webhookChannel(): DeliveryChannels["webhook"] | undefined {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return undefined;
  return async (body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // Don't let a hung webhook endpoint stall the delivery sweep indefinitely.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  };
}

export function channelsFromEnv(): DeliveryChannels {
  return { email: emailChannel(), webhook: webhookChannel() };
}
