// e2e: the already-installed prompt, Show install URL, the Installed-page sort toggle, and the
// per-skill install cards (SKILLY_SPEC.md §23). Runs against the dev stack (SKILLY_DEV_AUTH=1) on the seeded, git-published
// `global/web-scraper` skill. A fresh mint only becomes an *install* when `npx skills` first clones
// it (the gateway stamps used_at) — this dev-server suite has no git gateway, so the spec plays that
// part with one SQL update (`claim()`), which needs DATABASE_URL in the launching shell; skipped
// otherwise. It only ever touches the dev user's own web-scraper tokens and deletes them afterwards.
//
// Show install URL needs INSTALL_TOKEN_ENC_KEY on the dev server (playwright.config.ts sets a
// test-only key); against a reused server started without it, that one step is skipped.
import { Pool } from "pg";
import { test, expect, devSignIn } from "./fixtures";
import { gotoLoaded } from "./helpers/ready";

const dbUrl = process.env.DATABASE_URL;
const DEV_OID = "dev-admin-oid";
const SKILL_PAGE = "/skills/global/web-scraper";
const MINE = `t.user_id = (select id from users where entra_object_id = $1) and t.type = 'install' and not t.is_system
  and t.skill_id = (select s.id from skills s join namespaces n on n.id = s.namespace_id where n.slug = 'global' and s.slug = 'web-scraper')`;

test.describe("already-installed prompt, show install URL, sort (§23)", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!dbUrl, "DATABASE_URL not set — cannot play the gateway's first-clone claim");
  let pool: Pool;

  const clear = () => pool.query(`delete from tokens t where ${MINE}`, [DEV_OID]);
  /** What the git gateway does on the first `npx skills add` clone: the unclaimed command becomes an install. */
  const claim = () => pool.query(`update tokens t set used_at = now() where ${MINE} and t.used_at is null`, [DEV_OID]);
  const counts = async () => {
    const r = (await pool.query<{ claimed: number; unclaimed: number }>(
      `select count(*) filter (where t.used_at is not null)::int as claimed, count(*) filter (where t.used_at is null)::int as unclaimed
         from tokens t where ${MINE}`,
      [DEV_OID],
    )).rows[0]!;
    return { claimed: r.claimed, unclaimed: r.unclaimed };
  };

  test.beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl });
    await clear();
  });
  test.afterAll(async () => {
    await clear().catch(() => {});
    await pool.end();
  });

  test("the detail page asks before a second install: cancel, install anyway, override, go to skill, show URL", async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, SKILL_PAGE, /\/api\/skills\/global\/web-scraper$/);
    const installBtn = page.getByRole("button", { name: "Install latest" });
    const card = page.locator(".card", { has: page.getByRole("heading", { name: "Install", exact: true }) });
    const cmd = card.locator(".code-cmd");
    const dialog = page.getByTestId("already-installed-dialog");

    // Nothing installed yet → a plain mint, no prompt. Then `npx skills` claims it.
    await installBtn.click();
    await expect(cmd).toContainText("web-scraper.git");
    await expect(dialog).toHaveCount(0);
    await claim();

    // A second mint asks first and mints nothing; Escape cancels.
    await installBtn.click();
    await expect(page.getByRole("dialog", { name: /^You already have .+ installed$/ })).toBeVisible();
    await expect(dialog.locator("li")).toHaveText([/^latest · installed .+ · active$/]);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await counts()).toEqual({ claimed: 1, unclaimed: 0 });

    // Install anyway → a new command alongside the existing install.
    const before = await cmd.textContent();
    await installBtn.click();
    await page.getByTestId("already-installed-anyway").click();
    await expect(dialog).toHaveCount(0);
    await expect(cmd).not.toHaveText(before ?? "");
    expect(await counts()).toEqual({ claimed: 1, unclaimed: 1 });
    await claim(); // now two installs of the skill

    // Override → every existing install is uninstalled and one new command minted.
    await installBtn.click();
    await expect(dialog.locator("li")).toHaveCount(2);
    const beforeOverride = await cmd.textContent();
    await page.getByTestId("already-installed-override").click();
    await expect(dialog).toHaveCount(0);
    await expect(cmd).not.toHaveText(beforeOverride ?? "");
    const overrideCmd = (await cmd.textContent()) ?? "";
    expect(overrideCmd).toMatch(/^npx skills add https?:\/\/x-access-token:[^@]+@.+\/global\/web-scraper\.git/);
    expect(await counts()).toEqual({ claimed: 0, unclaimed: 1 });
    await claim();

    // Go to skill → Installed skills with that skill's row highlighted (the param is dropped), and
    // nothing minted.
    await installBtn.click();
    await page.getByTestId("already-installed-goto").click();
    await expect(page).toHaveURL(/\/installed$/, { timeout: 20_000 });
    const row = page.locator('.installed-row[data-install-ref="global/web-scraper"]');
    await expect(row).toHaveClass(/install-flash/, { timeout: 20_000 });
    await expect(row).not.toHaveClass(/install-flash/, { timeout: 10_000 }); // the ring fades after ~3 s
    expect(await counts()).toEqual({ claimed: 1, unclaimed: 0 });

    // Show install URL → exactly the command Override minted (it IS that install), not auto-copied.
    const listed = (await (await page.request.get("/api/installs")).json()) as { installs: Array<{ skillSlug: string; revealable: boolean }> };
    test.skip(!listed.installs.find((i) => i.skillSlug === "web-scraper")?.revealable, "INSTALL_TOKEN_ENC_KEY not set on this dev server");
    const show = row.getByTestId("show-install-url");
    await show.click();
    const panel = row.getByTestId("install-url-panel");
    await expect(panel.locator(".code-cmd")).toHaveText(overrideCmd);
    await expect(panel).toContainText("latest · never expires · anyone with this URL can install as you");
    await expect(page.getByText("✓ Copied")).toHaveCount(0);
    await show.click();
    await expect(panel).toHaveCount(0);
    // Hash-only seeded installs (no stored copy) have no button at all.
    await expect(page.locator('.installed-row[data-install-ref="global/pdf-tools"]').getByTestId("show-install-url")).toHaveCount(0);
  });

  test("sort toggle: A–Z by default, Recently installed remembered across reloads", async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, "/installed", /\/api\/installs$/);
    const az = page.getByRole("button", { name: "A–Z", exact: true });
    const recent = page.getByRole("button", { name: "Recently installed", exact: true });
    await expect(az).toHaveAttribute("aria-pressed", "true");
    const order = async () => {
      // One entry per skill — a plain row or a card, both carry data-install-ref.
      const refs = await page.locator(".rows [data-install-ref]").evaluateAll((els) => els.map((e) => e.getAttribute("data-install-ref")));
      return (ref: string) => refs.indexOf(ref);
    };

    // Seeded: Lint Fixer (10 days ago), PDF Tools (3 days), Secret Helper (20 days); Web Scraper was
    // claimed just now by the previous test.
    let at = await order();
    expect(at("global/web-scraper")).toBeGreaterThanOrEqual(0);
    expect(at("global/lint-fixer")).toBeLessThan(at("global/pdf-tools"));
    expect(at("global/pdf-tools")).toBeLessThan(at("team-a/secret-helper"));
    expect(at("team-a/secret-helper")).toBeLessThan(at("global/web-scraper"));

    await recent.click();
    await expect(recent).toHaveAttribute("aria-pressed", "true");
    at = await order();
    expect(at("global/web-scraper")).toBeLessThan(at("global/pdf-tools"));
    expect(at("global/pdf-tools")).toBeLessThan(at("global/lint-fixer"));
    expect(at("global/lint-fixer")).toBeLessThan(at("team-a/secret-helper"));
    expect(await page.evaluate(() => localStorage.getItem("skilly.installedSort"))).toBe("recent");

    // Remembered: a reload comes back sorted by install date.
    await page.reload();
    await expect(recent).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
    await expect(page.locator(".rows [data-install-ref]").first()).toHaveAttribute("data-install-ref", "global/web-scraper");

    await az.click();
    await expect(az).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => localStorage.getItem("skilly.installedSort"))).toBe("alpha");
  });

  test("several installs of one skill share one collapsible card (summary, children, Behind chip, highlight)", async ({ page }) => {
    await devSignIn(page);
    // Web Scraper holds one latest install from the first test. Add a pinned one, then make the
    // latest-tracking install BEHIND (last served 1.0.0 < latest 1.2.0) and the pinned one current.
    const mint = async (semver: string | null) => {
      const r = await page.request.post("/api/skills/global/web-scraper/install", { data: { semver, expiresAt: null, onExisting: "keep" } });
      expect(r.ok(), await r.text()).toBeTruthy();
      await claim();
    };
    await mint("1.2.0");
    const stamp = () => pool.query(
      `update tokens t set last_served_semver = case when t.pinned_semver is null then '1.0.0' else t.pinned_semver end where ${MINE}`,
      [DEV_OID],
    );
    await stamp();

    await gotoLoaded(page, "/installed", /\/api\/installs$/);
    const card = page.locator('[data-testid="install-card"][data-install-ref="global/web-scraper"]');
    const toggle = card.getByRole("button", { name: /installations$/ });
    const children = card.locator(".installed-child");

    // Collapsed, with the summary: count, de-duplicated versions, worst freshness, active count.
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(card.getByTestId("install-card-count")).toHaveText("2 installations");
    await expect(card.getByTestId("install-card-versions")).toHaveText("latest · pinned v1.2.0");
    await expect(card.locator(".installed-card-head").getByText("Behind", { exact: true })).toBeVisible();
    await expect(card.locator(".installed-card-head").getByText("2 active", { exact: true })).toBeVisible();
    await expect(card.locator(".installed-card-head")).toContainText("last installed");
    await expect(children).toHaveCount(0);
    // A single-install skill stays a plain row.
    await expect(page.locator('.installed-row[data-install-ref="global/pdf-tools"]')).toBeVisible();

    // Clicking the header opens it: one child per install, newest first, with per-install actions.
    await card.getByTestId("install-card-count").click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const newestFirst = (await pool.query<{ id: string }>(`select t.id from tokens t where ${MINE} order by t.used_at desc`, [DEV_OID])).rows.map((r) => r.id);
    await expect(children).toHaveCount(2);
    expect(await children.evaluateAll((els) => els.map((e) => e.getAttribute("data-install-id")))).toEqual(newestFirst);
    await expect(children.first().getByRole("button", { name: "uninstall" })).toBeVisible();
    await toggle.click();
    await expect(children).toHaveCount(0);

    // Behind chip: filter first, then group — with one behind install the skill is a plain row ...
    const chip = page.getByRole("button", { name: "Behind latest" });
    await chip.click();
    await expect(page.locator('.installed-row[data-install-ref="global/web-scraper"]')).toBeVisible({ timeout: 10_000 });
    await expect(card).toHaveCount(0);
    await chip.click();

    // ... and with two of three behind it is an EXPANDED card reading "2 of 3 installations".
    await mint(null);
    await stamp();
    await page.reload();
    await expect(card.getByTestId("install-card-count")).toHaveText("3 installations", { timeout: 20_000 });
    await chip.click();
    await expect(card.getByTestId("install-card-count")).toHaveText("2 of 3 installations", { timeout: 10_000 });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(children).toHaveCount(2);
    // Chip off → back to collapsed.
    await chip.click();
    await expect(card.getByTestId("install-card-count")).toHaveText("3 installations", { timeout: 10_000 });
    await expect(children).toHaveCount(0);

    // "Go to skill" lands here: the card opens and carries the highlight ring; the param is dropped.
    await page.goto("/installed?highlight=global/web-scraper");
    await expect(card).toHaveClass(/install-flash/, { timeout: 20_000 });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(children).toHaveCount(3);
    await expect(page).toHaveURL(/\/installed$/);
  });
});
