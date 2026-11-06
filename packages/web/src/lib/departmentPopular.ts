// Popular in your department (SKILLY_SPEC.md §66): up to six skills that people in the viewer's
// Entra department first adopted in the last 90 days, ranked by how many of them did. A discovery
// row, so skills the viewer already has are left out, and a skill needs at least two colleague
// adopters before it can appear. Only the count ever leaves the server — never who.
//
// Two steps (§66.4):
//   1. per DEPARTMENT, cached in this process for 10 minutes: every skill with ≥ 2 adopters in the
//      window, with the adopter count and the latest of those adoptions. Never sent to a browser
//      as is — it is not visibility-filtered.
//   2. per VIEWER, live on every request: keep the eligible skills the viewer can see and hasn't
//      adopted, order them, take six, and build the cards with the shared catalog builder (which
//      re-applies the visibility predicate — invariant #3, belt and braces).
// Department is never used to decide access (invariant #1): it only groups adoption counts.
import { skillVisibilityWhere, type EffectiveAccess } from "@skilly/shared";
import {
  DEPARTMENT_POPULAR_CACHE_MS,
  DEPARTMENT_POPULAR_LIMIT,
  DEPARTMENT_POPULAR_MIN_COLLEAGUES,
  DEPARTMENT_POPULAR_WINDOW_DAYS,
  departmentKey,
  departmentLabel,
} from "@skilly/shared/department-popular";
import { pool } from "./db";
import { searchSkills, type CatalogEntry } from "./catalog";
import { getPlatformSettings } from "./settings";
import { createTtlCache } from "./ttlCache";

/** One skill's standing in one department (step 1). */
export interface DepartmentAdoption {
  skillId: string;
  /** Distinct active, opted-in colleagues whose first adoption falls in the window. */
  colleagues: number;
  /** The latest of those first adoptions (UTC ISO) — the first tie-break. */
  lastAdoptedAt: string;
}

/** A home-page card plus its "👥 N colleagues" count. */
export type DepartmentPopularEntry = CatalogEntry & { colleagues: number };

export interface DepartmentPopularResult {
  /** The viewer's trimmed department, or null (no department, or the switch is off). */
  department: string | null;
  windowDays: number;
  skills: DepartmentPopularEntry[];
}

const departmentCache = createTtlCache<DepartmentAdoption[]>(DEPARTMENT_POPULAR_CACHE_MS);

/** Drop every cached department (tests; the cache is otherwise only ever aged out). */
export function resetDepartmentPopularCache(): void {
  departmentCache.clear();
}

/**
 * Step 1 (§66.2): every skill with at least {@link DEPARTMENT_POPULAR_MIN_COLLEAGUES} adopters in
 * the department `rawDepartment` belongs to. An adopter is active, not erased, has not hidden their
 * directory details (the §66.1 #11 opt-out), is in the same department today (trimmed,
 * case-insensitive — both sides normalized by the same SQL, which the migration 0107 index serves),
 * and first adopted the skill (skill_installs, §21) within the window. System installations have no
 * user and so never count. NOT visibility-filtered — callers must apply step 2.
 */
export async function departmentAdoptions(rawDepartment: string, now: Date = new Date()): Promise<DepartmentAdoption[]> {
  const { rows } = await pool.query<{ skill_id: string; colleagues: number; last_at: Date }>(
    `select si.skill_id, count(*)::int as colleagues, max(si.first_at) as last_at
       from users u
       join skill_installs si on si.user_id = u.id
      where u.department is not null
        and lower(btrim(u.department)) = lower(btrim($1))
        and u.status = 'active'
        and u.erased_at is null
        and not u.directory_hidden
        and si.first_at >= $2::timestamptz - make_interval(days => $3)
      group by si.skill_id
     having count(*) >= $4`,
    [rawDepartment, now, DEPARTMENT_POPULAR_WINDOW_DAYS, DEPARTMENT_POPULAR_MIN_COLLEAGUES],
  );
  return rows.map((r) => ({ skillId: r.skill_id, colleagues: r.colleagues, lastAdoptedAt: new Date(r.last_at).toISOString() }));
}

/**
 * Step 2's filter and order (§66.2, §66.3): of the department's skills, the ones that are active,
 * have a live published version (the Featured predicate, §7), are not deprecated (§45), are visible
 * to the viewer (the ONE shared predicate, invariant #3 incl. §42 grants) and that the viewer has
 * not adopted (uninstall-agnostic, like *Skills you might like*) — ordered by colleagues, then the
 * latest adoption, then the global install count, then title, then id; capped at six.
 */
async function rankForViewer(
  access: EffectiveAccess,
  viewerUserId: string,
  adoptions: DepartmentAdoption[],
): Promise<{ skillId: string; colleagues: number }[]> {
  if (adoptions.length === 0) return [];
  const params: unknown[] = [
    adoptions.map((a) => a.skillId),
    adoptions.map((a) => a.colleagues),
    adoptions.map((a) => a.lastAdoptedAt),
    viewerUserId,
    DEPARTMENT_POPULAR_LIMIT,
  ];
  const where = [
    "s.status = 'active'",
    "s.deprecated_at is null",
    "exists (select 1 from skill_versions sv where sv.skill_id = s.id and sv.status = 'active' and sv.git_published)",
    "not exists (select 1 from skill_installs mine where mine.skill_id = s.id and mine.user_id = $4)",
  ];
  {
    // Invariant #3 via the ONE shared predicate — never inline it.
    const vis = skillVisibilityWhere(access, params);
    if (vis) where.push(vis);
  }
  const { rows } = await pool.query<{ skill_id: string; colleagues: number }>(
    `select s.id as skill_id, c.colleagues
       from unnest($1::uuid[], $2::int[], $3::timestamptz[]) as c(skill_id, colleagues, last_at)
       join skills s on s.id = c.skill_id
      where ${where.join(" and ")}
      order by c.colleagues desc, c.last_at desc, s.install_count desc, s.title asc, s.id asc
      limit $5`,
    params,
  );
  return rows.map((r) => ({ skillId: r.skill_id, colleagues: r.colleagues }));
}

/**
 * The whole row for one viewer (`GET /api/skills/department-popular`, §66.7). Empty — with
 * `department: null` — when the switch is off or the viewer has no department; empty with the
 * department named when nothing qualifies. The home page omits the section either way (§66.1 #9).
 */
export async function departmentPopular(
  access: EffectiveAccess & { userId: string | null },
  now: Date = new Date(),
): Promise<DepartmentPopularResult> {
  const none: DepartmentPopularResult = { department: null, windowDays: DEPARTMENT_POPULAR_WINDOW_DAYS, skills: [] };
  if (!access.userId) return none;
  if (!(await getPlatformSettings()).departmentPopularEnabled) return none;

  const { rows } = await pool.query<{ department: string | null }>(`select department from users where id = $1`, [access.userId]);
  const raw = rows[0]?.department ?? null;
  const key = departmentKey(raw);
  const label = departmentLabel(raw);
  if (raw === null || key === null || label === null) return none;

  const adoptions = await departmentCache.get(key, () => departmentAdoptions(raw, now));
  const ranked = await rankForViewer(access, access.userId, adoptions);
  if (ranked.length === 0) return { department: label, windowDays: DEPARTMENT_POPULAR_WINDOW_DAYS, skills: [] };

  // The cards: the shared catalog builder (hype, upstream pill, grants marker …), visibility
  // re-applied inside it. Re-ordered to the rank, with the count attached.
  const cards = await searchSkills(access, { skillIds: ranked.map((r) => r.skillId), limit: DEPARTMENT_POPULAR_LIMIT });
  const byId = new Map(cards.map((c) => [c.skillId!, c]));
  const skills = ranked.flatMap((r) => {
    const card = byId.get(r.skillId);
    return card ? [{ ...card, colleagues: r.colleagues }] : [];
  });
  return { department: label, windowDays: DEPARTMENT_POPULAR_WINDOW_DAYS, skills };
}
