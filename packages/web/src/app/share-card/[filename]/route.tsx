// Per-skill Open Graph image for a signed share link (§33.6). A valid, unexpired token whose
// skill matches renders the skill's own card; anything else — missing/expired/unknown/wrong-skill
// — renders the IDENTICAL static app-wide card the rest of the site uses (§14), at 200, so a
// crawler can never distinguish "restricted skill" from "bad token" (invariant #3, no oracle).
import { ImageResponse } from "next/og";
import { pool } from "../../../lib/db";
import { getIconBytes } from "../../../lib/icons";
import { hashToken } from "@skilly/shared";
import { plainText } from "../../../lib/cardText";
import { renderSocialCard, SOCIAL_CARD_SIZE } from "../../social-card";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NAVY = "#082773";
const CYAN = "#14ABE3";
const WHITE = "#FFFFFF";

export async function GET(_req: Request, ctx: { params: Promise<{ filename: string }> }) {
  const { filename } = await ctx.params;
  const token = filename.endsWith(".png") ? filename.slice(0, -4) : filename;
  const { rows } = await pool.query<{
    title: string; description: string; ns_slug: string; slug: string;
    icon_sha256: string | null; icon_emoji: string | null;
  }>(
    `select s.title, s.description, n.slug as ns_slug, s.slug, s.icon_sha256, s.icon_emoji
       from skill_share_links l
       join skills s on s.id = l.skill_id
       join namespaces n on n.id = s.namespace_id
      where l.hashed_token = $1 and l.expires_at > now()`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) return renderSocialCard();

  const iconBytes = row.icon_sha256 ? await getIconBytes(row.icon_sha256) : null;
  const iconDataUri = iconBytes ? `data:image/png;base64,${iconBytes.toString("base64")}` : null;
  const description = plainText(row.description).slice(0, 220);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%", height: "100%", display: "flex", alignItems: "center",
          backgroundColor: NAVY, padding: 80, color: WHITE, gap: 48,
        }}
      >
        <div
          style={{
            width: 220, height: 220, borderRadius: 28, flexShrink: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            backgroundColor: "rgba(255,255,255,0.08)", border: "2px solid rgba(255,255,255,0.18)",
            overflow: "hidden",
          }}
        >
          {iconDataUri ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={iconDataUri} width={220} height={220} style={{ objectFit: "cover" }} />
          ) : row.icon_emoji ? (
            <div style={{ display: "flex", fontSize: 120 }}>{row.icon_emoji}</div>
          ) : (
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <div style={{ fontSize: 56, letterSpacing: -2, lineHeight: 1 }}>skilly</div>
              <div style={{ width: 16, height: 16, marginLeft: 8, marginBottom: 10, backgroundColor: CYAN, borderRadius: 3, transform: "rotate(45deg)" }} />
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", fontSize: 26, color: CYAN, marginBottom: 10 }}>
            @{row.ns_slug}/{row.slug}
          </div>
          <div style={{ display: "flex", fontSize: 60, fontWeight: 600, lineHeight: 1.1, marginBottom: 20 }}>
            {row.title}
          </div>
          <div style={{ display: "flex", fontSize: 28, lineHeight: 1.4, color: "rgba(255,255,255,0.72)" }}>
            {description}
          </div>
        </div>
      </div>
    ),
    { ...SOCIAL_CARD_SIZE },
  );
}
