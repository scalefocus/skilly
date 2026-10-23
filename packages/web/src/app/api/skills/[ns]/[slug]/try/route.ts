// Try a skill before installing (SKILLY_SPEC.md §61.6). Any authenticated user who can see the
// skill, while the Try switch is on and the AI integration is Operational.
// GET ?semver= → { semver, model, usage, contentCheck, files } — resolves the version and fills the
// panel header; no provider call. POST { semver, messages } → { reply, model } — one message.
// The conversation is never stored and request bodies are never logged (§61.5).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../../../lib/auth";
import { resolveUserAccess } from "../../../../../../lib/access";
import { withSystemLog } from "../../../../../../lib/apiLog";
import { enforceRateLimit } from "../../../../../../lib/ratelimit";
import { tryContext, trySend } from "../../../../../../lib/aiTry";
import type { EffectiveAccess } from "@skilly/shared";

export const dynamic = "force-dynamic";

/** A full 200,000-character transcript fits with room for JSON escaping; anything larger is refused unread. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

async function authenticate(): Promise<{ error: Response } | { access: EffectiveAccess & { userId: string } }> {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return { error: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  const access = await resolveUserAccess(oid);
  if (!access.userId) return { error: Response.json({ error: "unknown user" }, { status: 403 }) };
  return { access: { ...access, userId: access.userId } };
}

export const GET = withSystemLog("/api/skills/[ns]/[slug]/try", async function GET(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const a = await authenticate();
  if ("error" in a) return a.error;
  // Reads and extracts the artifact — rate-limited like the readme and download paths.
  const limited = enforceRateLimit("try-context", a.access.userId, 60);
  if (limited) return limited;
  const { ns, slug } = await ctx.params;
  const semver = new URL(req.url).searchParams.get("semver")?.trim() || null;
  const r = await tryContext(a.access, ns, slug, semver);
  return Response.json(r.body, { status: r.status });
});

export const POST = withSystemLog("/api/skills/[ns]/[slug]/try", async function POST(req: Request, ctx: { params: Promise<{ ns: string; slug: string }> }) {
  const a = await authenticate();
  if ("error" in a) return a.error;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return Response.json({ error: "conversation_full", message: "This conversation is full. Start over to keep trying." }, { status: 413 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "send JSON { semver, messages }" }, { status: 400 });
  const { ns, slug } = await ctx.params;
  const r = await trySend(a.access, ns, slug, body);
  return Response.json(r.body, { status: r.status });
});
