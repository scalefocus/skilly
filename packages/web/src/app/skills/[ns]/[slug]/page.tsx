// Server wrapper for the skill detail page. Only reason this file exists apart from the client
// component: `generateMetadata` must run on the server, and it reads the §33.6 signed share
// link (`?s=`) to decide between the static app-wide social card and this skill's own — a client
// component can't export generateMetadata at all. It also answers an OLD address of a moved skill
// (§70.6) with a 308 to the canonical one — for a viewer who can see the skill only; anyone else
// gets the page as for a skill that doesn't exist (invariant #3).
import type { Metadata } from "next";
import { permanentRedirect } from "next/navigation";
import { getServerSession } from "next-auth";
import { isSkillVisible, sharedNamespaceIdsSql } from "@skilly/shared";
import SkillDetailClient from "./SkillDetailClient";
import { buildShareMetadata } from "../../../../lib/shareMetadata";
import { authOptions } from "../../../../lib/auth";
import { resolveUserAccess } from "../../../../lib/access";
import { pool } from "../../../../lib/db";
import { resolveSkillAlias } from "../../../../lib/skillMoves";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ ns: string; slug: string }>;
  searchParams: Promise<{ s?: string }>;
}): Promise<Metadata> {
  const { ns, slug } = await params;
  const { s } = await searchParams;
  return buildShareMetadata(ns, slug, s);
}

/** The canonical path for an old address the viewer may follow, or null (§70.6). */
async function canonicalRedirect(ns: string, slug: string): Promise<string | null> {
  const hit = await resolveSkillAlias(ns, slug).catch(() => null);
  if (!hit) return null;
  const oid = ((await getServerSession(authOptions)) as { oid?: string } | null)?.oid;
  if (!oid) return null;
  const access = await resolveUserAccess(oid);
  const { rows } = await pool.query<{ namespace_id: string; visibility: "org" | "namespace"; shared_namespace_ids: string[] }>(
    `select s.namespace_id, s.visibility, ${sharedNamespaceIdsSql("s")} as shared_namespace_ids from skills s where s.id = $1`,
    [hit.skillId],
  );
  const s = rows[0];
  if (!s || !isSkillVisible(access, { namespaceId: s.namespace_id, visibility: s.visibility, sharedNamespaceIds: s.shared_namespace_ids ?? [] })) return null;
  return `/skills/${encodeURIComponent(hit.namespaceSlug)}/${encodeURIComponent(hit.slug)}`;
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ ns: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ns, slug } = await params;
  const target = await canonicalRedirect(ns, slug);
  if (target) {
    // Keep the query string (the fragment survives a redirect in the browser on its own).
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(await searchParams)) {
      if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
      else if (v !== undefined) q.append(k, v);
    }
    const qs = q.toString();
    permanentRedirect(qs ? `${target}?${qs}` : target);
  }
  return <SkillDetailClient />;
}
