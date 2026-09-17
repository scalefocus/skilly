// Signed share link → per-skill Open Graph metadata (§33.6). A valid, unexpired token whose
// skill matches the URL unlocks the skill's title/description/image; anything else — no token,
// expired, unknown, or a token minted for a DIFFERENT skill — falls through to the parent's
// static app-wide metadata (returning {} here does exactly that), so a restricted skill and an
// unknown slug stay indistinguishable to an unauthenticated unfurl crawler (invariant #3).
import type { Metadata } from "next";
import { pool } from "./db";
import { hashToken } from "@skilly/shared";
import { plainText } from "./cardText";

export async function buildShareMetadata(ns: string, slug: string, token: string | undefined): Promise<Metadata> {
  if (!token) return {};
  const hashed = hashToken(token);
  const { rows } = await pool.query<{ title: string; description: string }>(
    `select s.title, s.description
       from skill_share_links l
       join skills s on s.id = l.skill_id
       join namespaces n on n.id = s.namespace_id
      where l.hashed_token = $1 and l.expires_at > now() and n.slug = $2 and s.slug = $3`,
    [hashed, ns, slug],
  );
  const row = rows[0];
  if (!row) return {};
  // Best-effort provenance stamp — never blocks the metadata response.
  pool.query(`update skill_share_links set last_used_at = now() where hashed_token = $1`, [hashed]).catch(() => {});
  const description = plainText(row.description).slice(0, 300);
  const imageUrl = `/share-card/${token}.png`;
  return {
    openGraph: {
      title: row.title,
      description,
      images: [{ url: imageUrl, width: 1200, height: 630 }],
    },
    twitter: {
      card: "summary_large_image",
      title: row.title,
      description,
      images: [imageUrl],
    },
  };
}
