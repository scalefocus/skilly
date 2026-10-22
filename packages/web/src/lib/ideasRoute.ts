// Shared guards for the feature-ideas routes (SKILLY_SPEC.md §60.11): who the caller is, and how a
// refusal from lib/ideas.ts becomes a response. The feature-ideas switch gates only suggesting by
// users who are not platform admins (§60.4), which lib/ideas.ts `submitIdea` enforces itself.
import { currentAccess } from "./guard";
import type { AdminIdeaResult, IdeaViewer, OwnIdeaResult } from "./ideas";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isIdeaId(id: string): boolean {
  return UUID_RE.test(id);
}

export const notFound = (): Response => Response.json({ error: "not found" }, { status: 404 });

/** A signed-in caller of the user routes. The list and votes are open to everyone, always (§60.1). */
export async function ideasCaller(): Promise<{ ok: true; viewer: IdeaViewer } | { ok: false; res: Response }> {
  const access = await currentAccess();
  if (!access) return { ok: false, res: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  if (!access.userId) return { ok: false, res: Response.json({ error: "unknown user" }, { status: 403 }) };
  return { ok: true, viewer: { userId: access.userId, isPlatformAdmin: access.isPlatformAdmin } };
}

/** A platform admin on the admin routes (403 otherwise). Every action works whatever the switch says (§60.5). */
export async function ideasAdminCaller(): Promise<{ ok: true; userId: string } | { ok: false; res: Response }> {
  const access = await currentAccess();
  if (!access) return { ok: false, res: Response.json({ error: "unauthenticated" }, { status: 401 }) };
  if (!access.userId || !access.isPlatformAdmin) return { ok: false, res: Response.json({ error: "platform admin required" }, { status: 403 }) };
  return { ok: true, userId: access.userId };
}

/** A lib/ideas.ts result as a response: 204 on success, the refusal's status and error otherwise. */
export function ideaResultResponse(r: AdminIdeaResult | OwnIdeaResult): Response {
  if (r.ok) return new Response(null, { status: 204 });
  return Response.json({ error: r.error }, { status: r.status });
}

/** The request's JSON object body, or {} for anything else. */
export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch(() => ({}));
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
