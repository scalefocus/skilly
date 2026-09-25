// e2e: the feedback survey (SKILLY_SPEC.md §36.14). Seeds the dev user straight in Postgres as an
// eligible respondent (onboarded 30 days ago, never surveyed, opted in, no first-use history) and
// forces the 1-in-3 roll to win through the dev-only `x-skilly-test-survey-roll` header, injected
// with page.route (the server honours it only under SKILLY_DEV_AUTH=1). Covers: a first use opening
// the card; ✕ leaving "Take the survey" in the account menu; reopening and submitting (stars + text);
// the admin results section; "Don't ask me again" flipping the profile toggle; What's new winning a
// collision; and the mobile bottom sheet. Needs DATABASE_URL in the launching shell; skipped otherwise.
import { Pool } from "pg";
import { APP_VERSION } from "@skilly/shared/version";
import { test, expect, devSignIn, type Page } from "./fixtures";
import { gotoReady } from "./helpers/ready";

const DEV_OID = process.env.SKILLY_DEV_OID ?? "dev-admin-oid";
const dbUrl = process.env.DATABASE_URL;

function oneMinorBelow(v: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return null;
  const minor = Number(m[2]);
  if (minor > 0) return `${m[1]}.${minor - 1}.0`;
  return Number(m[1]) > 0 ? `${Number(m[1]) - 1}.0.0` : null;
}

/** Every first-use report from this page wins the roll. */
async function forceWin(page: Page) {
  await page.route("**/api/me/features/used", (route) =>
    route.continue({ headers: { ...route.request().headers(), "x-skilly-test-survey-roll": "win" } }),
  );
}

test.describe("Feedback survey (§36)", () => {
  // Every test mutates the SAME dev user's survey state.
  test.describe.configure({ mode: "serial" });
  test.skip(!dbUrl, "DATABASE_URL not set — cannot seed the survey state");
  let pool: Pool;
  const MARK = `e2e-survey-${Date.now()}`;

  /** Make the dev user an eligible, never-surveyed respondent with no first-use history. */
  async function resetDevUser() {
    await pool.query(
      `update users set onboarded_at = now() - interval '30 days', surveys_enabled = true, survey_last_shown_at = null, survey_offer = null
        where entra_object_id = $1`,
      [DEV_OID],
    );
    await pool.query(`delete from user_feature_uses where user_id = (select id from users where entra_object_id = $1)`, [DEV_OID]);
  }

  test.beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl });
    await pool.query(
      `insert into platform_settings (key, value) values ('survey_enabled', 'true'::jsonb)
       on conflict (key) do update set value = 'true'::jsonb`,
    );
  });
  test.afterAll(async () => {
    // Leave the dev user quiet for the rest of the suite, and the table free of this run's rows.
    await pool.query(`update users set surveys_enabled = false, survey_offer = null where entra_object_id = $1`, [DEV_OID]).catch(() => {});
    await pool.query(`update users set whats_new_seen_version = $2 where entra_object_id = $1`, [DEV_OID, APP_VERSION]).catch(() => {});
    await pool.query(`delete from survey_responses where free_text like $1`, [`${MARK}%`]).catch(() => {});
    await pool.end();
  });

  test("a first use opens the card; ✕ leaves it in the menu; reopening and submitting stores it", async ({ page }) => {
    await resetDevUser();
    await devSignIn(page, { surveys: true });
    await forceWin(page);

    await gotoReady(page, "/leaderboard");
    const card = page.getByTestId("survey-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByRole("heading", { name: "How are we doing?" })).toBeVisible();
    await expect(card.getByText("About the leaderboard")).toBeVisible();
    await expect(card.getByRole("radiogroup")).toHaveCount(7);
    // Submit stays disabled until something is answered.
    await expect(card.getByRole("button", { name: "Submit" })).toBeDisabled();

    // ✕ = not now: the card closes, the offer stays behind the account menu.
    await card.getByRole("button", { name: "Close survey" }).click();
    await expect(card).toHaveCount(0);
    await page.locator(".user-trigger").click();
    const take = page.getByTestId("take-survey");
    await expect(take).toBeVisible();
    await take.click();
    await expect(card).toBeVisible();

    // Two stars on the overall question, plus a comment.
    const overall = card.locator('[data-question="general.overall"]');
    await overall.getByRole("radio", { name: "2 stars" }).click();
    await expect(overall.getByRole("radio", { name: "2 stars" })).toHaveAttribute("aria-checked", "true");
    await card.getByRole("textbox").fill(`${MARK} menu comment`);
    await expect(card.getByText(`${MARK.length + " menu comment".length} / 2000`)).toBeVisible();
    const [submit] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/me/survey/responses")),
      card.getByRole("button", { name: "Submit" }).click(),
    ]);
    expect(submit.status()).toBe(200);
    await expect(card.getByTestId("survey-done")).toHaveText("Thanks, your feedback helps shape skilly.");
    await expect(card).toHaveCount(0, { timeout: 8_000 });

    const row = (await pool.query(`select via, feature, segment from survey_responses where free_text = $1`, [`${MARK} menu comment`])).rows[0];
    expect(row).toEqual({ via: "menu", feature: "leaderboard", segment: "admin" });
    await page.locator(".user-trigger").click();
    await expect(page.getByTestId("take-survey")).toHaveCount(0);
  });

  test("admin: Survey results on Monitoring shows the funnel and the comments", async ({ page }) => {
    // Enough same-day responses that nothing is withheld, whatever else the DB holds.
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `insert into survey_responses (answered_on, catalog_version, trigger, feature, segment, via, free_text)
         values ((now() at time zone 'utc')::date, 1, 'feature', 'search', 'consumer', 'popup', $1)`,
        [`${MARK} seeded ${i}`],
      );
    }
    await devSignIn(page);
    await gotoReady(page, "/admin/rum");
    const section = page.getByTestId("survey-results");
    const header = section.getByRole("button", { name: /Survey results/ });
    await expect(header).toBeVisible({ timeout: 20_000 });
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    await expect(section.getByTestId("survey-funnel")).toBeVisible();
    await expect(section.getByRole("switch")).toBeVisible();
    await expect(section.getByTestId("survey-comments")).toContainText(`${MARK} seeded`, { timeout: 15_000 });
    await expect(section.getByTestId("survey-questions")).toBeVisible();
  });

  test("“Don’t ask me again” flips the profile toggle to Off", async ({ page }) => {
    await resetDevUser();
    await devSignIn(page, { surveys: true });
    await forceWin(page);
    await gotoReady(page, "/leaderboard");
    const card = page.getByTestId("survey-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByRole("button", { name: "Don’t ask me again" }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId("survey-toast")).toContainText("no more surveys");
    await expect.poll(async () => (await (await page.request.get("/api/me")).json()).surveysEnabled).toBe(false);
    await gotoReady(page, "/profile");
    const pref = page.getByTestId("surveys-pref");
    await expect(pref).toBeVisible({ timeout: 20_000 });
    await expect(pref.getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");
  });

  test("What's new wins: with the notice due, a first use shows no survey", async ({ page }) => {
    const seeded = oneMinorBelow(APP_VERSION);
    test.skip(!seeded, `cannot derive a lower minor from ${APP_VERSION}`);
    await resetDevUser();
    await pool.query(`update users set whats_new_seen_version = $2 where entra_object_id = $1`, [DEV_OID, seeded]);
    await devSignIn(page, { surveys: true, stampWhatsNew: false });
    await forceWin(page);
    const [used] = await Promise.all([
      page.waitForRequest((r) => r.url().includes("/api/me/features/used"), { timeout: 30_000 }),
      gotoReady(page, "/leaderboard"),
    ]);
    expect(used.postDataJSON()).toEqual({ feature: "leaderboard", canShow: false });
    await expect(page.getByTestId("whats-new-notice")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(800);
    await expect(page.getByTestId("survey-card")).toHaveCount(0);
    await pool.query(`update users set whats_new_seen_version = $2 where entra_object_id = $1`, [DEV_OID, APP_VERSION]);
  });

  test("mobile: the card is a bottom sheet with ✕ and Submit in view", async ({ page }) => {
    await resetDevUser();
    await page.setViewportSize({ width: 375, height: 740 });
    await devSignIn(page, { surveys: true });
    await forceWin(page);
    await gotoReady(page, "/leaderboard");
    const card = page.getByTestId("survey-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    // Let the slide-up entry animation settle — mid-flight the card is translated a few px down,
    // which would misreport its resting bounding box.
    await card.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    const box = (await card.boundingBox())!;
    expect(box.x).toBeLessThanOrEqual(1);
    expect(Math.round(box.width)).toBeGreaterThanOrEqual(374);
    expect(box.y + box.height).toBeLessThanOrEqual(741);
    await expect(card.getByRole("button", { name: "Close survey" })).toBeInViewport();
    await expect(card.getByRole("button", { name: "Submit" })).toBeInViewport();
  });
});
