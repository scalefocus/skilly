// Records the app version whose release notes the signed-in user has been shown — the marker behind
// the once-per-release "Version X updated — see what's new" toast. Called by the app shell the
// moment the toast appears (or silently for a patch-only advance) and by the Quick start page on
// mount, so a brand-new user's baseline is the version they onboarded on. Forward-only and
// idempotent; not audited (a display preference, like onboarded_at). SKILLY_SPEC.md §23.
import { getServerSession } from "next-auth";
import { APP_VERSION } from "@skilly/shared/version";
import { validateSeenVersion } from "@skilly/shared/whats-new";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { stampWhatsNewSeen } from "../../../../lib/whatsNew";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { version?: unknown };
  // Valid semver, and not greater than the server's running version — a client can't claim the future.
  const version = validateSeenVersion(body.version, APP_VERSION);
  if (!version) return Response.json({ error: "version must be a valid semver no newer than the running app" }, { status: 400 });

  const { previous, current } = await stampWhatsNewSeen(access.userId, version);
  return Response.json({ ok: true, previous, current });
}
