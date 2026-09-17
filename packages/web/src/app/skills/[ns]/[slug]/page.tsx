// Server wrapper for the skill detail page. Only reason this file exists apart from the client
// component: `generateMetadata` must run on the server, and it reads the §33.6 signed share
// link (`?s=`) to decide between the static app-wide social card and this skill's own — a client
// component can't export generateMetadata at all.
import type { Metadata } from "next";
import SkillDetailClient from "./SkillDetailClient";
import { buildShareMetadata } from "../../../../lib/shareMetadata";

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

export default function Page() {
  return <SkillDetailClient />;
}
