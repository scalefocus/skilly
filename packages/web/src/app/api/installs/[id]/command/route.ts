// Re-show an install's command (SKILLY_SPEC.md §23 "Show install URL"). Decrypts the row's
// recoverable copy (tokens.token_enc, AES-256-GCM under INSTALL_TOKEN_ENC_KEY) and rebuilds the
// `npx skills add …` command through the pinned adapter — the wire format is unchanged.
//   Personal rows: owner-only; anyone else gets the same 404 as a missing row (no existence oracle).
//   System rows:   any platform admin; every reveal is audited (install.system_url_revealed —
//                  never the token or the command).
// Personal reveals are unaudited. The command is never logged; the response is no-store.
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../lib/access";
import { getInstallRevealSource } from "../../../../../lib/installs";
import { enforceRateLimit } from "../../../../../lib/ratelimit";
import { withSystemLog } from "../../../../../lib/apiLog";
import { appendAudit } from "../../../../../lib/audit";
import { pool } from "../../../../../lib/db";
import { openInstallToken } from "@skilly/shared/install-crypto";
import { buildInstallCommand } from "@skilly/shared";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = withSystemLog("/api/installs/[id]/command", async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const limited = enforceRateLimit("install-reveal", oid, 30);
  if (limited) return limited;
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const id = (await ctx.params).id;
  // Not a uuid → can't be a row (and would otherwise fail the query as a 500).
  if (!UUID.test(id)) return Response.json({ error: "not found" }, { status: 404 });
  const src = await getInstallRevealSource(id);
  const allowed = src && (src.isSystem ? access.isPlatformAdmin : src.userId === access.userId);
  if (!src || !allowed) return Response.json({ error: "not found" }, { status: 404 });

  const raw = openInstallToken(src.tokenEnc);
  if (!raw) {
    // No stored copy (pre-0095 / minted without the key), no key now, or a rotated key. The UI only
    // offers the button on revealable rows, so this is the rotated-key (or raced) case.
    return Response.json(
      { error: "This install's URL can't be recovered — generate a new one from the skill page." },
      { status: 409, headers: NO_STORE },
    );
  }

  if (src.isSystem) {
    // The compensating control for revealing a shared, visibility-bypassing credential (§11/§23).
    await appendAudit(pool, {
      actorUserId: access.userId,
      action: "install.system_url_revealed",
      targetType: "skill",
      targetId: src.skillId,
      namespaceId: src.namespaceId,
      after: { skill: `${src.namespaceSlug}/${src.skillSlug}`, semver: src.pinnedSemver ?? "latest", expiresAt: src.expiresAt ?? "never" },
    });
  }

  const command = buildInstallCommand({
    registryBaseUrl: process.env.SKILLY_REGISTRY_URL ?? "",
    namespaceSlug: src.namespaceSlug,
    skillSlug: src.skillSlug,
    semver: src.pinnedSemver, // null => latest => no #ref
    token: raw,
    agent: src.toolHarness ?? undefined, // the skill's CURRENT harness (§23)
  });
  return Response.json({ command }, { headers: NO_STORE });
});
