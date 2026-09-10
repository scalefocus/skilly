// e2e: the once-per-release "What's new in X" update notice (SKILLY_SPEC.md §23, "What's new").
// Seeds the dev user's marker one MINOR below the running APP_VERSION straight in Postgres (the
// stamp endpoint is forward-only, so there is no API way to lower it), signs in WITHOUT the
// fixtures' pre-stamp, and asserts the acknowledgement semantics: the notice appears with the
// heading + excerpt, is NOT stamped on appearance (a reload shows it again, clicking its body does
// nothing), ✕ stamps and closes it for good; the link opens /whats-new?since=<seeded> with the
// "New since your last visit" divider under exactly the newer entries and closes the notice; and
// opening /whats-new from the account menu is a read receipt (divider from the marker fallback,
// notice gone, marker stamped). Needs DATABASE_URL in the launching shell (the Playwright config
// already requires it for the dev server); skipped otherwise. Opt-in like the rest of the suite.
import { Pool } from "pg";
import { APP_VERSION } from "@skilly/shared/version";
import { test, expect, devSignIn } from "./fixtures";

const DEV_OID = process.env.SKILLY_DEV_OID ?? "dev-admin-oid";
const dbUrl = process.env.DATABASE_URL;

function oneMinorBelow(v: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (minor > 0) return `${major}.${minor - 1}.0`;
  return major > 0 ? `${major - 1}.0.0` : null;
}

const cmp = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
};

test.describe("What's new update notice (§23)", () => {
  // Every test mutates the SAME dev user's marker (and devSignIn's default pre-stamp advances it),
  // so they must not overlap.
  test.describe.configure({ mode: "serial" });
  test.skip(!dbUrl, "DATABASE_URL not set — cannot seed the marker");
  let pool: Pool;
  const setMarker = (v: string | null) =>
    pool.query(`update users set whats_new_seen_version = $2 where entra_object_id = $1`, [DEV_OID, v]);
  const readMarker = async () =>
    (await pool.query(`select whats_new_seen_version v from users where entra_object_id = $1`, [DEV_OID])).rows[0]?.v as string | null;

  test.beforeAll(() => {
    pool = new Pool({ connectionString: dbUrl });
  });
  test.afterAll(async () => {
    // Leave the dev user quiet for the rest of the suite.
    await setMarker(APP_VERSION).catch(() => {});
    await pool.end();
  });

  /** Verify the divider splits the timeline at `seeded`: every entry above it is newer, the first
   *  below it is not, and there is exactly one divider under the last new entry. */
  async function expectDividerAt(page: import("@playwright/test").Page, seeded: string) {
    await expect(page.getByRole("heading", { name: "What’s new." })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("whats-new-divider")).toBeVisible();
    const versions = await page.locator("ol > li").evaluateAll((lis) =>
      lis.map((li) => ({
        v: li.querySelector(".chip")!.textContent!.replace(/^v/, ""),
        isNew: li.getAttribute("data-new-since") === "true",
        hasDivider: !!li.querySelector('[data-testid="whats-new-divider"]'),
      })),
    );
    const newOnes = versions.filter((x) => x.isNew);
    expect(newOnes.length).toBeGreaterThan(0);
    for (const x of newOnes) expect(cmp(x.v, seeded)).toBeGreaterThan(0);
    for (const x of versions.filter((x) => !x.isNew)) expect(cmp(x.v, seeded)).toBeLessThanOrEqual(0);
    expect(versions.filter((x) => x.hasDivider).map((x) => x.v)).toEqual([newOnes[newOnes.length - 1]!.v]);
  }

  test("minor bump: notice persists until ✕ — not stamped on appearance, body click is inert", async ({ page }) => {
    const seeded = oneMinorBelow(APP_VERSION);
    test.skip(!seeded, `cannot derive a lower minor from ${APP_VERSION}`);
    await setMarker(seeded!);
    await devSignIn(page, { stampWhatsNew: false });

    await page.goto("/");
    const notice = page.getByTestId("whats-new-notice");
    // First hit of `/` on a cold dev server compiles the route; the notice only appears once /api/me
    // resolves after that, so give the first appearance a generous budget.
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice.getByRole("heading")).toHaveText(`What’s new in v${APP_VERSION}`);
    // The excerpt lists the changelog lines newer than the seeded marker — at least the running one.
    const excerpt = notice.getByTestId("whats-new-notice-excerpt");
    await expect(excerpt.locator("li")).not.toHaveCount(0);
    expect(await excerpt.locator("li").count()).toBeLessThanOrEqual(3);
    await expect(notice.getByRole("link", { name: /^See what’s new/ })).toBeVisible();
    await expect(notice.getByRole("button", { name: "Dismiss" })).toBeVisible();

    // NOT stamped on appearance: the marker is untouched after the notice has rendered.
    await page.waitForTimeout(500);
    expect(await readMarker()).toBe(seeded);

    // Clicking the card body does nothing — the notice stays.
    await excerpt.click();
    await page.waitForTimeout(300);
    await expect(notice).toBeVisible();

    // A reload before dismissing shows it again (nothing was acknowledged).
    await page.reload();
    await expect(page.getByTestId("whats-new-notice")).toBeVisible({ timeout: 20_000 });

    // ✕ closes it and stamps the running version.
    await page.getByTestId("whats-new-notice").getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByTestId("whats-new-notice")).toHaveCount(0);
    await expect.poll(readMarker).toBe(APP_VERSION);

    // Acknowledged: a fresh load shows no notice. Wait for the shell's /api/me round trip (what
    // would trigger it) before asserting, so the check can't pass trivially early.
    const me = page.waitForResponse((r) => r.url().endsWith("/api/me") && r.status() === 200);
    await page.goto("/");
    await me;
    await page.waitForTimeout(500);
    await expect(page.getByTestId("whats-new-notice")).toHaveCount(0);
  });

  test("the link opens /whats-new?since=, closes the notice, and the divider splits the timeline", async ({ page }) => {
    const seeded = oneMinorBelow(APP_VERSION);
    test.skip(!seeded, `cannot derive a lower minor from ${APP_VERSION}`);
    await setMarker(seeded!);
    await devSignIn(page, { stampWhatsNew: false });

    await page.goto("/");
    const notice = page.getByTestId("whats-new-notice");
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await notice.getByRole("link", { name: /^See what’s new/ }).click();
    // Structural URL check (path + query param) rather than a regex built from the version string.
    await page.waitForURL((u) => u.pathname === "/whats-new" && u.searchParams.get("since") === seeded);
    await expectDividerAt(page, seeded!);
    // Following the link dismissed the notice; the page's mount stamped the marker.
    await expect(page.getByTestId("whats-new-notice")).toHaveCount(0);
    await expect.poll(readMarker).toBe(APP_VERSION);
  });

  test("opening /whats-new from the account menu is the read receipt — divider from the marker, notice gone", async ({ page }) => {
    const seeded = oneMinorBelow(APP_VERSION);
    test.skip(!seeded, `cannot derive a lower minor from ${APP_VERSION}`);
    await setMarker(seeded!);
    await devSignIn(page, { stampWhatsNew: false });

    await page.goto("/");
    await expect(page.getByTestId("whats-new-notice")).toBeVisible({ timeout: 20_000 });
    await page.locator(".user-trigger").click();
    await page.getByRole("menuitem", { name: "What’s new" }).click();
    await page.waitForURL((u) => u.pathname === "/whats-new" && !u.searchParams.has("since"));
    // No ?since= — the divider comes from the marker as read before the page's stamp.
    await expectDividerAt(page, seeded!);
    await expect(page.getByTestId("whats-new-notice")).toHaveCount(0);
    await expect.poll(readMarker).toBe(APP_VERSION);
  });

  test("patch-only bump advances the marker silently — no notice", async ({ page }) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(APP_VERSION)!;
    test.skip(Number(m[3]) === 0, `APP_VERSION ${APP_VERSION} has no lower patch`);
    const seeded = `${m[1]}.${m[2]}.${Number(m[3]) - 1}`;
    await setMarker(seeded);
    await devSignIn(page, { stampWhatsNew: false });
    const me = page.waitForResponse((r) => r.url().endsWith("/api/me") && r.status() === 200);
    await page.goto("/");
    await me;
    await expect.poll(readMarker, { timeout: 20_000 }).toBe(APP_VERSION);
    await page.waitForTimeout(500);
    await expect(page.getByTestId("whats-new-notice")).toHaveCount(0);
  });

  test("plain /whats-new with the marker already current has no divider", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/whats-new");
    await expect(page.getByRole("heading", { name: "What’s new." })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(500);
    await expect(page.getByTestId("whats-new-divider")).toHaveCount(0);
  });
});
