// The §12 Graph email transport for the delivery sweep. Resolved fresh each sweep: the
// account row + token refresh + saved wrapper together decide whether Graph is operational;
// when it isn't, the sweep falls back to env SMTP (channels.ts) — exactly one transport
// fires per email. Resolution doubles as the keep-alive: the refresh runs on the sweep
// cadence even when no email is pending, keeping the admin pill current and the rotating
// refresh token alive through quiet periods. SKILLY_SPEC.md §12.
import type { Pool } from "pg";
import {
  ensureFreshAccessToken,
  getEmailAccount,
  getEmailWrapperHtml,
  parseEmailTokenKey,
  sendGraphMail,
  type GraphMailEnv,
} from "@skilly/shared/email";
import { renderEmailText, renderWrappedEmailHtml } from "@skilly/shared";
import type { EmailTransport } from "./deliver.js";

const BASE_URL = process.env.PUBLIC_BASE_URL ?? process.env.SKILLY_REGISTRY_URL ?? "";

/** Env for the Graph transport, or null when the enc key / Entra creds are absent. */
export function graphMailEnvFromProcess(): GraphMailEnv | null {
  const key = parseEmailTokenKey(process.env.EMAIL_TOKEN_ENC_KEY);
  const tenantId = process.env.ENTRA_TENANT_ID;
  const clientId = process.env.EMAIL_CLIENT_ID ?? process.env.ENTRA_CLIENT_ID;
  const clientSecret = process.env.EMAIL_CLIENT_SECRET ?? process.env.ENTRA_CLIENT_SECRET;
  if (!key || !tenantId || !clientId || !clientSecret) return null;
  return { tenantId, clientId, clientSecret, key };
}

/**
 * Resolve the Graph transport for this sweep, or undefined when non-operational
 * (not connected / key missing / refresh failing / no wrapper saved — §12). Failure
 * detail lands in email_service_account.last_refresh_error for the admin pill; this
 * function never throws on an expected outage.
 */
export async function resolveGraphTransport(pool: Pool, env: GraphMailEnv | null = graphMailEnvFromProcess()): Promise<EmailTransport | undefined> {
  if (!env) return undefined;
  const account = await getEmailAccount(pool);
  if (!account) return undefined;
  const token = await ensureFreshAccessToken(pool, env); // keep-alive refresh, serialized (FOR UPDATE)
  if (!token.ok) return undefined;
  const wrapper = await getEmailWrapperHtml(pool);
  if (!wrapper) return undefined; // no wrapper = no Graph emails (deliberate, §12)
  return {
    kind: "graph",
    send: async (to, msg) => {
      await sendGraphMail(env, token.accessToken, {
        to,
        subject: msg.subject,
        text: renderEmailText(msg.text, BASE_URL),
        html: renderWrappedEmailHtml(wrapper, msg.text, BASE_URL),
      });
    },
  };
}
