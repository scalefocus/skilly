// Shared plumbing for the /api/collections routes (SKILLY_SPEC.md §38.11): the signed-in caller,
// the per-user write budget, and the result → Response mapping.
import { getServerSession } from "next-auth";
import type { EffectiveAccess } from "@skilly/shared";
import { COLLECTION_WRITE_RATE_LIMIT_PER_MIN } from "@skilly/shared/collections";
import { authOptions } from "./auth";
import { resolveUserAccess } from "./access";
import { enforceRateLimit } from "./ratelimit";
import type { CollectionResult } from "./collections";

export type Caller = { access: EffectiveAccess; userId: string };

/** The signed-in caller, or the Response to return instead (401 / 403 unknown user / 429). */
export async function collectionCaller(opts: { write?: boolean } = {}): Promise<Caller | Response> {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });
  if (opts.write) {
    const limited = enforceRateLimit("collections", access.userId, COLLECTION_WRITE_RATE_LIMIT_PER_MIN);
    if (limited) return limited;
  }
  return { access, userId: access.userId };
}

export function collectionResponse<T>(r: CollectionResult<T>, okStatus = 200, body?: (v: T) => unknown): Response {
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json(body ? body(r.value) : { ok: true }, { status: okStatus });
}

/** Parse a JSON body, tolerating an empty or malformed one as `{}`. */
export async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
