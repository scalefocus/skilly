// The usage hook's endpoint (SKILLY_SPEC.md §68.5). A machine endpoint: bearer USAGE KEY only, no
// session, no CSRF. The reporter runs on a consumer's machine and sends four fields — skill id,
// semver, trigger, an opaque event id — nothing from the conversation.
//
// Responses are deliberately uninformative: an unknown, deleted, inactive-owner or malformed key is
// the same 401; once the key is valid, every outcome (recorded / duplicate / dropped / switch off)
// is 204, so the endpoint is no oracle for a skill's existence, visibility or versions. 400 only for
// a malformed body, 429 past the per-key limit. Not wrapped in withSystemLog: 401s and 429s here are
// machine noise (§25). Nothing about the request — not the key, not the body — is ever logged.
import { findUsageKeyOwner, isSkillVisible, parseUsageReport, recordUsageHit, touchUsageKey } from "@skilly/shared";
import { pool } from "../../../../lib/db";
import { M } from "../../../../lib/metrics";
import { resolveUserAccessById } from "../../../../lib/access";
import { enforceRateLimit } from "../../../../lib/ratelimit";
import { getUsageInsightsEnabled } from "../../../../lib/settings";
import { sharedNamespaceIdsSql } from "@skilly/shared";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Reports per minute per key (§68.5). */
export const USAGE_REPORT_RATE_LIMIT_PER_MINUTE = 120;
const MAX_BODY_BYTES = 1024;

function bearer(req: Request): string {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m?.[1] ?? "";
}

export async function POST(req: Request): Promise<Response> {
  const owner = await findUsageKeyOwner(pool, bearer(req));
  if (!owner) {
    M.usageReports.inc({ outcome: "invalid_key" });
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }

  const limited = enforceRateLimit("usage-reports", owner.userId, USAGE_REPORT_RATE_LIMIT_PER_MINUTE);
  if (limited) {
    M.usageReports.inc({ outcome: "rate_limited" });
    return limited;
  }

  if (Number(req.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return Response.json({ error: "body too large" }, { status: 400 });
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return Response.json({ error: "body too large" }, { status: 400 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const report = parseUsageReport(body);
  if (!report) return Response.json({ error: "invalid report" }, { status: 400 });

  // Switch off → accept-and-discard (the §32.5 RUM precedent): a plugin that still carries the hook
  // never errors.
  if (!(await getUsageInsightsEnabled())) {
    M.usageReports.inc({ outcome: "disabled" });
    return new Response(null, { status: 204 });
  }

  void touchUsageKey(pool, owner.userId).catch(() => {});

  // Invariant #3: the owner must be able to see the skill NOW — a lost namespace membership closes
  // the door on its own (§68.4). A skill that does not exist is the same silent drop.
  const { rows } = await pool.query<{ namespace_id: string; visibility: "org" | "namespace"; shared_namespace_ids: string[] | null }>(
    `select s.namespace_id, s.visibility, ${sharedNamespaceIdsSql("s")} as shared_namespace_ids from skills s where s.id = $1`,
    [report.skillId],
  );
  const skill = rows[0];
  if (!skill) {
    M.usageReports.inc({ outcome: "dropped" });
    return new Response(null, { status: 204 });
  }
  const access = await resolveUserAccessById(owner.userId);
  if (!isSkillVisible(access, { namespaceId: skill.namespace_id, visibility: skill.visibility, sharedNamespaceIds: skill.shared_namespace_ids ?? [] })) {
    M.usageReports.inc({ outcome: "dropped" });
    return new Response(null, { status: 204 });
  }

  const outcome = await recordUsageHit(pool, { ...report, userId: owner.userId });
  M.usageReports.inc({ outcome });
  return new Response(null, { status: 204 });
}
