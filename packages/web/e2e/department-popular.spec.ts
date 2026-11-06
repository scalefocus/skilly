// e2e: Popular in your department (SKILLY_SPEC.md §66). The dev-server suite has no Entra, so the
// department and the colleagues' adoptions are seeded straight into the database (DATABASE_URL in
// the launching shell; skipped otherwise). The signed-in user and two colleague users get a
// department unique to this run (the dev server caches each department's counts for 10 minutes,
// §66.4, so a reused name could serve an earlier run's counts), and both colleagues have adopted one
// eligible seeded skill the signed-in user hasn't. Then:
//   the home page shows "Popular in <department>" after Featured and before the install explainer,
//   with that skill and its "👥 2 colleagues" chip →
//   a platform admin turns the switch off on Administration → the row is gone.
// `finally` restores the switch and the user's department and removes the seeded adoptions.
//
// EXCLUSIVE (groups.ts): the platform switch hides the row for every user.
import { Pool } from "pg";
import { test, expect, devSignIn, type Page } from "./fixtures";
import { clickAndAwait, gotoLoaded } from "./helpers/ready";

const dbUrl = process.env.DATABASE_URL;
const FEED = "/api/skills/department-popular";
const setSwitch = (page: Page, on: boolean) => page.request.patch("/api/admin/settings", { data: { departmentPopularEnabled: on } });

test.describe.configure({ mode: "serial" });

test("popular in your department: the home row and its colleague count → switched off on Administration", async ({ page }) => {
  test.skip(!dbUrl, "DATABASE_URL not set — cannot seed departments and adoptions");
  test.setTimeout(180_000); // the first hit compiles the new feed route
  const pool = new Pool({ connectionString: dbUrl });
  const dept = `E2E DeptPop ${Date.now()}`;
  // Signed out, the feed refuses (§66.7) — this test's context has no session yet.
  expect((await page.request.get(FEED)).status()).toBe(401);
  await devSignIn(page);
  const me = (await (await page.request.get("/api/me")).json()) as { userId: string };
  const before = (await pool.query<{ department: string | null }>(`select department from users where id = $1`, [me.userId])).rows[0]?.department ?? null;
  const colleagues: string[] = [];
  let skill: { id: string; ns: string; slug: string } | undefined;
  try {
    await pool.query(`update users set department = $2 where id = $1`, [me.userId, dept]);
    for (const oid of ["e2e-deptpop-c1", "e2e-deptpop-c2"]) {
      const { rows } = await pool.query<{ id: string }>(
        `insert into users (entra_object_id, email, display_name, status, department, directory_hidden)
         values ($1, $1 || '@e2e.test', $1, 'active', $2, false)
         on conflict (entra_object_id) do update set status = 'active', department = excluded.department,
           directory_hidden = false, erased_at = null returning id`,
        [oid, dept],
      );
      colleagues.push(rows[0]!.id);
    }
    // An eligible seeded skill (§66.2): org-visible, active, installable, not deprecated, and not
    // adopted by the signed-in user.
    skill = (await pool.query<{ id: string; ns: string; slug: string }>(
      `select s.id, n.slug as ns, s.slug
         from skills s join namespaces n on n.id = s.namespace_id
        where s.status = 'active' and s.visibility = 'org' and s.deprecated_at is null
          and exists (select 1 from skill_versions sv where sv.skill_id = s.id and sv.status = 'active' and sv.git_published)
          and not exists (select 1 from skill_installs si where si.skill_id = s.id and si.user_id = $1)
        order by n.slug, s.slug limit 1`,
      [me.userId],
    )).rows[0];
    test.skip(!skill, "no eligible seeded skill the signed-in user hasn't adopted");
    const target = skill!;
    for (const c of colleagues) {
      await pool.query(
        `insert into skill_installs (skill_id, user_id, first_at) values ($1, $2, now())
         on conflict (skill_id, user_id) do update set first_at = now()`,
        [target.id, c],
      );
    }
    expect((await setSwitch(page, true)).ok()).toBeTruthy();

    // — The home row —
    await gotoLoaded(page, "/", FEED);
    const section = page.getByTestId("department-popular-section");
    const heading = section.getByRole("heading", { name: `Popular in ${dept}` });
    await expect(heading).toBeVisible();
    await expect(section).toContainText("What your colleagues adopted in the last 90 days.");
    const card = section.locator(`a[href="/skills/${target.ns}/${target.slug}"]`);
    await expect(card).toBeVisible();
    await expect(card.getByTestId("colleagues-chip")).toContainText("2 colleagues");
    await expect(section).not.toContainText("e2e-deptpop-c1"); // a count, never who

    // Placement (§66.5): after Featured (when it renders) and before the install explainer.
    const rowY = (await heading.boundingBox())!.y;
    const installY = (await page.getByRole("heading", { name: "Installing is one command." }).boundingBox())!.y;
    expect(rowY).toBeLessThan(installY);
    const featured = page.getByRole("heading", { name: "Featured skills" });
    if (await featured.count()) expect((await featured.boundingBox())!.y).toBeLessThan(rowY);

    // — Administration: switch it off → the row is gone —
    await gotoLoaded(page, "/admin", "/api/admin/namespaces");
    await page.getByRole("button", { name: /^Popular in your department\b/ }).click();
    const sw = page.getByRole("switch", { name: "Show each person the skills popular in their department" });
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await clickAndAwait(page, () => sw.click(), "/api/admin/settings", { method: "PATCH" });
    await expect(sw).toHaveAttribute("aria-checked", "false");

    await gotoLoaded(page, "/", FEED);
    await expect(page.getByRole("heading", { name: "Installing is one command." })).toBeVisible();
    await expect(page.getByTestId("department-popular-section")).toHaveCount(0);
  } finally {
    await setSwitch(page, true);
    if (skill) await pool.query(`delete from skill_installs where skill_id = $1 and user_id = any($2::uuid[])`, [skill.id, colleagues]);
    if (colleagues.length) await pool.query(`update users set department = null where id = any($1::uuid[])`, [colleagues]);
    await pool.query(`update users set department = $2 where id = $1`, [me.userId, before]);
    await pool.end();
  }
});
