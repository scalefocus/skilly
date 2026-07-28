// Entra directory profile — job title / office / department (SKILLY_SPEC.md §5, §28).
//
// Two things live here: the READ side that backs the hover card (`getUserCard`), and the web-tier
// WRITE side that refreshes the signing-in user's own three fields from Graph `/me` with their
// delegated User.Read token (the same token the provider already uses for the profile photo).
// The other writer is Graph reconciliation in the worker; both overwrite unconditionally.
import { pool } from "./db";
import { userLabel } from "./userLabel";
import { ONLINE_WINDOW_MINUTES } from "./presence";

/** What `GET /api/users/:id/card` returns. Badges are deliberately NOT here — the bubble already
 *  holds the whole `/api/leaders` map for the page (§21) and reads them from memory. */
export interface UserCard {
  userId: string;
  displayName: string;
  email: string;
  jobTitle: string | null;
  officeLocation: string | null;
  department: string | null;
  /** UTC ISO of the user's last authenticated activity, or null if never seen. */
  lastSeen: string | null;
  /** `last_seen` within the FIXED 5-minute window — never the admin-selected one (§4). */
  online: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The hover card's data for one user. Any signed-in user may read any user's card — skilly has no
 * per-user visibility model (invariant #7 governs skills). Returns null for an unknown id (→ 404).
 *
 * The three directory fields come back **null** when the user opted out (`directory_hidden`) or has
 * been erased — they are never serialized to another person's browser in that case. Name, email and
 * presence are unaffected by the opt-out; they are already visible across the app.
 */
export async function getUserCard(userId: string): Promise<UserCard | null> {
  if (!UUID_RE.test(userId)) return null; // malformed id → 404, not a Postgres cast error
  const { rows } = await pool.query<{
    id: string;
    display_name: string;
    email: string;
    job_title: string | null;
    office_location: string | null;
    department: string | null;
    directory_hidden: boolean;
    erased_at: Date | null;
    last_seen: Date | null;
    online: boolean;
  }>(
    `select id, display_name, email, job_title, office_location, department, directory_hidden,
            erased_at, last_seen,
            (last_seen is not null and last_seen > now() - make_interval(mins => $2::int)) as online
       from users where id = $1`,
    [userId, ONLINE_WINDOW_MINUTES],
  );
  const r = rows[0];
  if (!r) return null;

  // Opted out, or a GDPR tombstone (whose columns are already scrubbed — belt and braces): the
  // card falls back to its "No directory information" state.
  const hidden = r.directory_hidden || r.erased_at !== null;
  return {
    userId: r.id,
    displayName: userLabel(r.display_name, r.email),
    email: r.email ?? "",
    jobTitle: hidden ? null : r.job_title,
    officeLocation: hidden ? null : r.office_location,
    department: hidden ? null : r.department,
    lastSeen: r.last_seen ? new Date(r.last_seen).toISOString() : null,
    online: r.online === true,
  };
}

export interface EntraDirectoryProfile {
  jobTitle: string | null;
  officeLocation: string | null;
  department: string | null;
}

/** Absent/blank → null, so clearing an attribute in Entra clears it here too (§5). */
function dirValue(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : null;
}

/**
 * Read the signing-in user's own directory profile from Graph with their delegated token.
 * `User.Read` (already requested at sign-in for the photo) covers all three properties, so this
 * needs no new consent. Returns null on any non-2xx / network / parse failure — sign-in must never
 * depend on Graph being reachable, and a failed read must not clear stored values.
 */
export async function fetchEntraDirectoryProfile(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<EntraDirectoryProfile | null> {
  const base = process.env.GRAPH_BASE_URL ?? "https://graph.microsoft.com/v1.0";
  try {
    const res = await fetchImpl(`${base}/me?$select=jobTitle,officeLocation,department`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    return {
      jobTitle: dirValue(j.jobTitle),
      officeLocation: dirValue(j.officeLocation),
      department: dirValue(j.department),
    };
  } catch {
    return null;
  }
}

/** Persist a freshly-read profile onto the user's row. Unconditional overwrite (§5) — a title the
 *  person no longer holds must not survive their next sign-in. */
export async function saveDirectoryProfile(oid: string, p: EntraDirectoryProfile): Promise<void> {
  await pool.query(
    `update users set job_title = $2, office_location = $3, department = $4, updated_at = now()
      where entra_object_id = $1`,
    [oid, p.jobTitle, p.officeLocation, p.department],
  );
}
