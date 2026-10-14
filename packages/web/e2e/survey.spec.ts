// e2e: the feedback survey (SKILLY_SPEC.md §36.14). Seeds the dev user straight in Postgres as an
// eligible respondent (onboarded 30 days ago, never surveyed, opted in, no first-use history) and
// forces the 1-in-3 roll to win through the dev-only `x-skilly-test-survey-roll` header, injected
// with page.route (the server honours it only under SKILLY_DEV_AUTH=1). Covers: a first use opening
// the card; ✕ leaving "Take the survey" in the account menu; reopening and submitting (stars + text);
// the admin results section; "Don't ask me again" flipping the profile toggle; What's new winning a
// collision; and the mobile bottom sheet. Bug reports (§36.17): the sidebar's bug button, the Bug
// category, switching to an on-demand survey and the cooldown block, Give feedback → Bug ending the
// offer, and the admin feed + switch. Needs DATABASE_URL in the launching shell; skipped otherwise.
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

  /** Make the dev user an eligible, never-surveyed respondent with no first-use history. Clears the
   *  on-demand stamp too: its 7-day cooldown would otherwise carry from one on-demand test (or a
   *  retry of it) into the next and hide "Give feedback" / disable "Give feedback now". */
  async function resetDevUser() {
    await pool.query(
      `update users set onboarded_at = now() - interval '30 days', surveys_enabled = true, survey_last_shown_at = null,
              survey_self_shown_at = null, survey_offer = null
        where entra_object_id = $1`,
      [DEV_OID],
    );
    await pool.query(`delete from user_feature_uses where user_id = (select id from users where entra_object_id = $1)`, [DEV_OID]);
  }

  test.beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl });
    for (const key of ["survey_enabled", "bug_reports_enabled"]) {
      await pool.query(
        `insert into platform_settings (key, value) values ($1, 'true'::jsonb)
         on conflict (key) do update set value = 'true'::jsonb`,
        [key],
      );
    }
  });
  test.afterAll(async () => {
    // Leave the dev user quiet for the rest of the suite, and the table free of this run's rows.
    await pool.query(`update users set surveys_enabled = false, survey_self_shown_at = null, survey_offer = null where entra_object_id = $1`, [DEV_OID]).catch(() => {});
    await pool.query(`update users set whats_new_seen_version = $2 where entra_object_id = $1`, [DEV_OID, APP_VERSION]).catch(() => {});
    await pool.query(`delete from survey_responses where free_text like $1`, [`${MARK}%`]).catch(() => {});
    await pool.query(`update platform_settings set value = 'true'::jsonb where key = 'bug_reports_enabled'`).catch(() => {});
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

  test("on-demand: Give feedback now with the toggle Off, a picked feature, then the cooldown", async ({ page }) => {
    await resetDevUser();
    // The default sign-in turns the RANDOM prompts off; on-demand feedback ignores that toggle.
    await devSignIn(page);
    await gotoReady(page, "/profile");
    const pref = page.getByTestId("surveys-pref");
    await expect(pref).toBeVisible({ timeout: 20_000 });
    await expect(pref.getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");
    await pref.getByTestId("profile-give-feedback").click();

    const card = page.getByTestId("survey-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByRole("button", { name: "Don’t ask me again" })).toHaveCount(0);
    await expect(card.getByRole("radiogroup")).toHaveCount(5);
    const picker = card.getByTestId("survey-feature-picker");
    await expect(picker).toHaveValue("");
    await picker.selectOption("marketplaces");
    await expect(card.getByTestId("survey-feature-section")).toContainText("About plugin marketplaces");
    await expect(card.getByRole("radiogroup")).toHaveCount(7);
    await card.locator('[data-question="feature.useful"]').getByRole("radio", { name: "4 stars" }).click();
    await card.getByRole("textbox").fill(`${MARK} self comment`);
    const [submit] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/me/survey/responses")),
      card.getByRole("button", { name: "Submit" }).click(),
    ]);
    expect(submit.status()).toBe(200);
    await expect(card.getByTestId("survey-done")).toHaveText("Thanks, your feedback helps shape skilly.");

    const row = (await pool.query(`select trigger, feature, via from survey_responses where free_text = $1`, [`${MARK} self comment`])).rows[0];
    expect(row).toEqual({ trigger: "self", feature: "marketplaces", via: "popup" });
    const answers = (await pool.query(
      `select a.question_key, a.stars from survey_answers a join survey_responses r on r.id = a.response_id where r.free_text = $1`,
      [`${MARK} self comment`],
    )).rows;
    expect(answers).toEqual([{ question_key: "feature.useful", stars: 4 }]);

    // The cooldown: the button is disabled with the next date, and the menu entry is gone.
    await expect(card).toHaveCount(0, { timeout: 8_000 });
    await expect(pref.getByTestId("profile-give-feedback")).toBeDisabled();
    await expect(pref.getByTestId("profile-give-feedback-hint")).toContainText("You can share feedback again on");
    await page.locator(".user-trigger").click();
    await expect(page.getByRole("menuitem", { name: "Profile" })).toBeVisible();
    await expect(page.getByTestId("give-feedback")).toHaveCount(0);
  });

  test("on-demand: closing leaves Take the survey in the menu; reopening starts blank", async ({ page }) => {
    await resetDevUser();
    await devSignIn(page);
    await gotoReady(page, "/catalog");
    await page.locator(".user-trigger").click();
    await page.getByTestId("give-feedback").click();
    const card = page.getByTestId("survey-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByTestId("survey-feature-picker").selectOption("follow");
    await card.getByRole("button", { name: "Close survey" }).click();
    await expect(card).toHaveCount(0);

    await page.locator(".user-trigger").click();
    await expect(page.getByTestId("give-feedback")).toHaveCount(0);
    await page.getByTestId("take-survey").click();
    await expect(card).toBeVisible();
    await expect(card.getByTestId("survey-feature-picker")).toHaveValue("");
    await expect(card.getByTestId("survey-feature-section")).toHaveCount(0);
  });

  test("colophon: Have your say is signed-in only, opens the card, reopens it, then hides in the cooldown", async ({ browser, page }) => {
    // Signed out: the plain line, no link.
    const anon = await browser.newPage();
    await anon.goto("/catalog");
    await expect(anon.getByRole("button", { name: /sign in/i })).toBeVisible({ timeout: 20_000 });
    await expect(anon.locator(".colophon-sub")).toHaveText("powered by the community");
    await expect(anon.getByTestId("colophon-have-your-say")).toHaveCount(0);
    await anon.close();

    await resetDevUser();
    await devSignIn(page);
    await gotoReady(page, "/catalog");
    const link = page.getByTestId("colophon-have-your-say");
    await expect(page.locator(".colophon-sub")).toHaveText("powered by the community · Have your say");
    const [started] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/me/survey/start")),
      link.click(),
    ]);
    expect(started.status()).toBe(200);
    const card = page.getByTestId("survey-card");
    await expect(card).toBeVisible({ timeout: 20_000 });

    // Closed = not now: the link stays and reopens the same offer, without a new start.
    await card.getByRole("button", { name: "Close survey" }).click();
    await expect(card).toHaveCount(0);
    const starts: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/me/survey/start")) starts.push(r.url()); });
    await link.click();
    await expect(card).toBeVisible();
    expect(starts).toEqual([]);

    await card.locator('[data-question="general.overall"]').getByRole("radio", { name: "5 stars" }).click();
    await card.getByRole("textbox").fill(`${MARK} colophon comment`);
    const [submit] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/me/survey/responses")),
      card.getByRole("button", { name: "Submit" }).click(),
    ]);
    expect(submit.status()).toBe(200);
    const row = (await pool.query(`select trigger, via from survey_responses where free_text = $1`, [`${MARK} colophon comment`])).rows[0];
    expect(row).toEqual({ trigger: "self", via: "menu" });

    // The cooldown runs: back to the plain line.
    await expect(link).toHaveCount(0, { timeout: 8_000 });
    await expect(page.locator(".colophon-sub")).toHaveText("powered by the community");
  });

  test("admin: the Self-initiated funnel line and the Source filter", async ({ page }) => {
    await devSignIn(page);
    await gotoReady(page, "/admin/rum");
    const section = page.getByTestId("survey-results");
    const header = section.getByRole("button", { name: /Survey results/ });
    await expect(header).toBeVisible({ timeout: 20_000 });
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    await expect(section.getByTestId("survey-funnel-self")).toContainText(/Self-initiated: \d+ opened · \d+ submitted/);
    const source = section.getByRole("group", { name: "Source" });
    await expect(source).toBeVisible();
    const [summary] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/admin/survey/summary") && r.url().includes("source=self")),
      source.getByRole("button", { name: "Self-initiated" }).click(),
    ]);
    expect(summary.status()).toBe(200);
  });

  // ---- bug reports (§36.17) ----------------------------------------------------------------------

  test("bug button: signed-in only; opens Report a bug with no stars; Submit needs text; no cooldown after", async ({ browser, page }) => {
    const anon = await browser.newPage();
    await anon.goto("/catalog");
    await expect(anon.getByRole("button", { name: /sign in/i })).toBeVisible({ timeout: 20_000 });
    await expect(anon.getByTestId("report-bug")).toHaveCount(0);
    await anon.close();

    await resetDevUser();
    await devSignIn(page);
    await gotoReady(page, "/leaderboard");
    const bug = page.getByTestId("report-bug");
    await expect(bug).toBeVisible({ timeout: 20_000 });
    await expect(bug).toHaveAttribute("aria-label", "Report a bug");
    // An inline SVG, never an emoji character.
    await expect(bug.locator("svg")).toHaveCount(1);
    expect((await bug.textContent())?.trim()).toBe("");

    const starts: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/api/me/survey/start")) starts.push(r.url()); });
    await bug.click();
    const card = page.getByTestId("survey-card");
    await expect(card).toBeVisible();
    await expect(card.getByRole("heading", { name: "Report a bug" })).toBeVisible();
    await expect(card.getByTestId("survey-feature-picker")).toHaveValue("bug");
    await expect(card.getByRole("radiogroup")).toHaveCount(0);
    const submitBtn = card.getByRole("button", { name: "Submit" });
    await expect(submitBtn).toBeDisabled();
    await card.getByTestId("survey-free-text").fill(`${MARK} bug one`);
    await expect(submitBtn).toBeEnabled();
    const [sent] = await Promise.all([page.waitForResponse((r) => r.url().includes("/api/me/survey/bug")), submitBtn.click()]);
    expect(sent.status()).toBe(200);
    await expect(card.getByTestId("survey-done")).toHaveText("Thanks, we’ll look into it.");
    expect(starts).toEqual([]); // no on-demand survey was started

    const row = (await pool.query(`select trigger, feature, page_path, app_version from survey_responses where free_text = $1`, [`${MARK} bug one`])).rows[0];
    expect(row).toEqual({ trigger: "bug", feature: null, page_path: "/leaderboard", app_version: APP_VERSION });
    const self = (await pool.query(`select survey_self_shown_at from users where entra_object_id = $1`, [DEV_OID])).rows[0];
    expect(self.survey_self_shown_at).toBeNull();

    // No cooldown: the button is still there and still opens the card.
    await expect(card).toHaveCount(0, { timeout: 8_000 });
    await bug.click();
    await expect(card.getByRole("heading", { name: "Report a bug" })).toBeVisible();
  });

  test("bug button: picking another category starts an on-demand survey; in the cooldown it is blocked", async ({ page }) => {
    await resetDevUser();
    await devSignIn(page);
    await gotoReady(page, "/catalog");
    await page.getByTestId("report-bug").click();
    const card = page.getByTestId("survey-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    const [started] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/me/survey/start")),
      card.getByTestId("survey-feature-picker").selectOption(""),
    ]);
    expect(started.status()).toBe(200);
    await expect(card.getByRole("heading", { name: "How are we doing?" })).toBeVisible();
    await expect(card.getByRole("radiogroup")).toHaveCount(5);
    await card.locator('[data-question="general.overall"]').getByRole("radio", { name: "4 stars" }).click();
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/me/survey/responses")),
      card.getByRole("button", { name: "Submit" }).click(),
    ]);
    await expect(card).toHaveCount(0, { timeout: 8_000 });

    // The cooldown runs: a new Bug card can't switch away, and says when it can.
    await page.getByTestId("report-bug").click();
    await expect(card.getByTestId("survey-pick-hint")).toContainText("You can share other feedback again on");
    await expect(card.locator('option[value=""]')).toBeDisabled();
    await expect(card.locator('option[value="bug"]')).toBeEnabled();
  });

  test("Give feedback, then Bug: Bug mode, and a submit ends the on-demand offer", async ({ page }) => {
    await resetDevUser();
    await devSignIn(page);
    await gotoReady(page, "/catalog");
    await page.locator(".user-trigger").click();
    await page.getByTestId("give-feedback").click();
    const card = page.getByTestId("survey-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.getByTestId("survey-feature-picker").selectOption("bug");
    await expect(card.getByRole("heading", { name: "Report a bug" })).toBeVisible();
    await expect(card.getByRole("radiogroup")).toHaveCount(0);
    await card.getByTestId("survey-free-text").fill(`${MARK} bug from feedback`);
    const [sent] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/me/survey/bug")),
      card.getByRole("button", { name: "Submit" }).click(),
    ]);
    expect(sent.status()).toBe(200);
    await expect(card).toHaveCount(0, { timeout: 8_000 });
    const u = (await pool.query(`select survey_offer from users where entra_object_id = $1`, [DEV_OID])).rows[0];
    expect(u.survey_offer).toBeNull();
    await page.locator(".user-trigger").click();
    await expect(page.getByRole("menuitem", { name: "Profile" })).toBeVisible();
    await expect(page.getByTestId("take-survey")).toHaveCount(0);
  });

  test("admin: bug reports in the feed under Source = Bug reports; the switch hides the bug button", async ({ page }) => {
    await devSignIn(page);
    await gotoReady(page, "/admin/rum");
    const section = page.getByTestId("survey-results");
    const header = section.getByRole("button", { name: /Survey results/ });
    await expect(header).toBeVisible({ timeout: 20_000 });
    if ((await header.getAttribute("aria-expanded")) !== "true") await header.click();
    await expect(section.getByTestId("survey-funnel-bug")).toContainText(/Bug reports: \d+ submitted/);
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/admin/survey/comments") && r.url().includes("source=bug")),
      section.getByRole("group", { name: "Source" }).getByRole("button", { name: "Bug reports" }).click(),
    ]);
    const item = section.getByTestId("survey-comment").filter({ hasText: `${MARK} bug one` });
    await expect(item).toBeVisible();
    await expect(item.getByText("Bug", { exact: true })).toBeVisible();
    await expect(item.getByTestId("survey-comment-bug-context")).toHaveText(`/leaderboard · v${APP_VERSION}`);

    // Switch bug reports off: the bug button disappears on the next page load.
    const toggle = section.getByRole("switch", { name: "Bug reports" });
    await Promise.all([page.waitForResponse((r) => r.url().includes("/api/admin/settings") && r.request().method() === "PATCH"), toggle.click()]);
    await gotoReady(page, "/catalog");
    await expect(page.locator(".colophon")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("report-bug")).toHaveCount(0);
    await pool.query(`update platform_settings set value = 'true'::jsonb where key = 'bug_reports_enabled'`);
  });
});
