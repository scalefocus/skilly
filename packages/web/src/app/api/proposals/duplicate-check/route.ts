// Live duplicate pre-check for the propose form (SKILLY_SPEC.md §8). Given a proposed pointer
// (url + subdir + slug) or a hosted content digest, returns the existing skill it would duplicate
// — scoped to what the CALLER can see — plus the platform enforcement mode, so the form can block
// (and offer "propose a new version") or warn before submit. Read-only; the proposals/publish
// endpoints re-check authoritatively. Pointer fields are checked here; hosted matches come back
// from /api/uploads (which already has the digest).
import { getServerSession } from "next-auth";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { findDuplicateSkill } from "../../../../lib/duplicate";
import { getDuplicateEnforcement } from "../../../../lib/settings";

export const dynamic = "force-dynamic";

interface Body {
  slug?: string;
  pointer?: { url?: string; subdir?: string | null };
  contentSha256?: string;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const oid = (session as { oid?: string } | null)?.oid;
  if (!oid) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const access = await resolveUserAccess(oid);
  if (!access.userId) return Response.json({ error: "unknown user" }, { status: 403 });

  const b = (await req.json().catch(() => ({}))) as Body;
  const duplicate = await findDuplicateSkill(access, {
    slug: b.slug,
    pointer: b.pointer?.url ? { url: b.pointer.url, subdir: b.pointer.subdir ?? null } : null,
    contentSha256: b.contentSha256,
  });
  return Response.json({ duplicate, enforcement: await getDuplicateEnforcement() });
}
