// The header system banner (§27): any authenticated user reads the current active banner (or
// null). Lazily expired — no worker sweep; a past expiresAt just reads as "no active banner".
import { getServerSession } from "next-auth";
import { authOptions } from "../../../lib/auth";
import { getSystemBanner } from "../../../lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  return Response.json(await getSystemBanner());
}
