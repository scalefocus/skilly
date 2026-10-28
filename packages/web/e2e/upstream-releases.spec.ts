// e2e: upstream release alerts (SKILLY_SPEC.md §63.7–§63.9). The dev-server suite runs no worker, so
// the sweep's result — upstream v1.3.0 is out for the seeded pointer skill `global/web-scraper`
// (pinned to v1.2.0) — is seeded straight into the database (DATABASE_URL in the launching shell;
// skipped otherwise). As a platform admin (an owner, so the notice shows):
//   the skill page shows "Upstream v1.3.0 is out" → Propose the update opens the new-version form
//   pre-filled with the new ref (Keep current files off), the suggested 1.3.0 and the note →
//   back on the skill page, Skip this release turns the notice into the muted skipped line →
//   un-skip brings it back.
// WRITE-FREE apart from the seeded row (deleted in `finally`): the form is never submitted.
//
// EXCLUSIVE (groups.ts): the notice shows to every platform admin viewing the seeded web-scraper.
import { Pool } from "pg";
import { test, expect, devSignIn } from "./fixtures";
import { clickAndAwait, gotoLoaded } from "./helpers/ready";

const dbUrl = process.env.DATABASE_URL;
const PAGE = "/skills/global/web-scraper";
const DETAIL = /\/api\/skills\/global\/web-scraper$/;

test.describe.configure({ mode: "serial" });

test("upstream release: notice → pre-filled propose form → skip → un-skip", async ({ page }) => {
  test.skip(!dbUrl, "DATABASE_URL not set — cannot seed the worker's result");
  const pool = new Pool({ connectionString: dbUrl });
  const { rows } = await pool.query<{ skill_id: string; version_id: string; origin: string }>(
    `select s.id as skill_id, sv.id as version_id, sv.external_origin_url as origin
       from skills s join namespaces n on n.id = s.namespace_id
       join skill_versions sv on sv.skill_id = s.id and sv.semver = '1.2.0'
      where n.slug = 'global' and s.slug = 'web-scraper'`,
  );
  const seed = rows[0]!;
  try {
    await pool.query(`delete from platform_settings where key = 'upstream_releases_enabled'`);
    await pool.query(
      `insert into skill_upstream_releases (skill_id, baseline_version_id, origin_url, subdir, pin_kind, release_ref, release_semver,
                                            release_commit, release_bump, files_changed, detected_at, checked_at, notified_ref)
       values ($1, $2, $3, null, 'semver_tag', 'v1.3.0', '1.3.0', $4, 'minor', true, now(), now(), 'v1.3.0')
       on conflict (skill_id) do update set baseline_version_id = excluded.baseline_version_id, origin_url = excluded.origin_url,
         subdir = null, pin_kind = 'semver_tag', release_ref = 'v1.3.0', release_semver = '1.3.0', release_bump = 'minor',
         files_changed = true, skipped_ref = null, skipped_by = null, skipped_at = null`,
      [seed.skill_id, seed.version_id, seed.origin, "b".repeat(40)],
    );

    await devSignIn(page);
    await gotoLoaded(page, PAGE, DETAIL);
    const notice = page.getByTestId("upstream-notice");
    await expect(notice).toContainText("Upstream v1.3.0 is out.");
    await expect(notice).toContainText("This skill pins v1.2.0 (minor update).");

    // Propose the update → the new-version form, pre-filled; nothing is submitted.
    await page.getByTestId("upstream-propose").click();
    await expect(page).toHaveURL(/\/propose\?newVersion=1&ns=global&slug=web-scraper&upstreamRef=v1\.3\.0&upstreamKind=release&bump=minor$/);
    await expect(page.getByRole("heading", { name: "Propose a new version." })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /point at a new ref/i })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByPlaceholder("https://github.com/anthropics/skills.git")).toHaveValue(seed.origin);
    await expect(page.locator("input[list='ref-options']")).toHaveValue("v1.3.0");
    await expect(page.getByPlaceholder("1.0.0")).toHaveValue("1.3.0");
    await expect(page.getByTestId("what-changed")).toHaveValue("Updates upstream from v1.2.0 to v1.3.0.");

    // Skip this release → the muted skipped line; un-skip → the notice is back.
    await gotoLoaded(page, PAGE, DETAIL);
    await clickAndAwait(page, () => page.getByTestId("upstream-skip").click(), DETAIL);
    await expect(page.getByTestId("upstream-notice")).toHaveCount(0);
    await expect(page.getByTestId("upstream-skipped")).toContainText("Skipped upstream v1.3.0");
    await clickAndAwait(page, () => page.getByTestId("upstream-unskip").click(), DETAIL);
    await expect(page.getByTestId("upstream-notice")).toBeVisible();
    await expect(page.getByTestId("upstream-skipped")).toHaveCount(0);
  } finally {
    await pool.query(`delete from skill_upstream_releases where skill_id = $1`, [seed.skill_id]);
    await pool.end();
  }
});
