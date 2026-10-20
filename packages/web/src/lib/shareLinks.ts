// Signed share links (SKILLY_SPEC.md §33.6): the mint itself, called by
// `POST /api/skills/:ns/:slug/share` once it has checked that the caller can see the skill. The raw
// token is returned to the caller and never stored — only its hash.
import { generateToken, hashToken } from "@skilly/shared";
import { pool } from "./db";
import { appendAudit } from "./audit";
import { tryAward } from "./achievements";

export const SHARE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function mintShareLink(userId: string, skill: { id: string; namespaceId: string }): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken(24);
  const expiresAt = new Date(Date.now() + SHARE_LINK_TTL_MS);
  await pool.query(
    `insert into skill_share_links (hashed_token, skill_id, created_by, expires_at) values ($1, $2, $3, $4)`,
    [hashToken(token), skill.id, userId, expiresAt.toISOString()],
  );
  await appendAudit(pool, {
    actorUserId: userId,
    action: "skill.share_link_created",
    targetType: "skill",
    targetId: skill.id,
    namespaceId: skill.namespaceId,
    after: { expiresAt: expiresAt.toISOString() },
  });
  // §31.12 Word of Mouth — best-effort after the mint (a bare write, so never fatal to the share).
  await tryAward(pool, userId, "first_share");
  return { token, expiresAt };
}
