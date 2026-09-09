// e2e: the once-per-release "Version X updated — see what's new" toast (SKILLY_SPEC.md §23,
// "What's new"). Seeds the dev user's marker one MINOR below the running APP_VERSION straight in
// Postgres (the stamp endpoint is forward-only, so there is no API way to lower it), signs in
// WITHOUT the fixtures' pre-stamp, and asserts: the toast appears with the expected text, its link
// opens /whats-new?since=<seeded>, the "New since your last visit" divider sits under exactly the
// entries newer than the seeded version, and a reload shows no second toast (seen on appearance).
// Needs DATABASE_URL in the launching shell (the Playwright config already requires it for the dev
// server); skipped otherwise. Opt-in like the rest of the suite.
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

test.describe("What's new toast (§23)", () => {
  // Every test mutates the SAME dev user's marker (and devSignIn's default pre-stamp advances it),
  // so they must not overlap.
  test.describe.configure({ mode: "serial" });
  test.skip(!dbUrl, "DATABASE_URL not set — cannot seed the marker");
  let pool: Pool;
  const setMarker = (v: string | null) =>
    pool.query(`update users set whats_new_seen_version = $2 where entra_object_id = $1`, [DEV_OID, v]);

  test.beforeAll(() => {
    pool = new Pool({ connectionString: dbUrl });
  });
  test.afterAll(async () => {
    // Leave the dev user quiet for the rest of the suite.
    await setMarker(APP_VERSION).catch(() => {});
    await pool.end();
  });

  test("minor bump: toast once, link carries ?since=, divider splits the timeline", async ({ page }) => {
    const seeded = oneMinorBelow(APP_VERSION);
    test.skip(!seeded, `cannot derive a lower minor from ${APP_VERSION}`);
    await setMarker(seeded!);
    await devSignIn(page, { stampWhatsNew: false });

    await page.goto("/");
    const toast = page.getByTestId("whats-new-toast");
    // First hit of `/` on a cold dev server compiles the route; the toast only appears once /api/me
    // resolves after that, so give the first appearance a generous budget (it then lasts 7s).
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await expect(toast).toHaveText(`Version ${APP_VERSION} updated — see what’s new`);

    // Shown-on-appearance: the marker is already advanced before any click.
    await expect
      .poll(async () => (await pool.query(`select whats_new_seen_version v from users where entra_object_id = $1`, [DEV_OID])).rows[0]?.v)
      .toBe(APP_VERSION);

    await toast.getByRole("link", { name: "see what’s new" }).click();
    // Structural URL check (path + query param) rather than a regex built from the version string.
    await page.waitForURL((u) => u.pathname === "/whats-new" && u.searchParams.get("since") === seeded);
    await expect(page.getByRole("heading", { name: "What’s new." })).toBeVisible({ timeout: 20_000 });

    // The divider is present, and every entry above it is newer than the seeded version while the
    // first entry below it is not.
    const divider = page.getByTestId("whats-new-divider");
    await expect(divider).toBeVisible();
    const versions = await page.locator("ol > li").evaluateAll((lis) =>
      lis.map((li) => ({
        v: li.querySelector(".chip")!.textContent!.replace(/^v/, ""),
        isNew: li.getAttribute("data-new-since") === "true",
        hasDivider: !!li.querySelector('[data-testid="whats-new-divider"]'),
      })),
    );
    const cmp = (a: string, b: string) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
      return 0;
    };
    const newOnes = versions.filter((x) => x.isNew);
    expect(newOnes.length).toBeGreaterThan(0);
    for (const x of newOnes) expect(cmp(x.v, seeded!)).toBeGreaterThan(0);
    for (const x of versions.filter((x) => !x.isNew)) expect(cmp(x.v, seeded!)).toBeLessThanOrEqual(0);
    // Exactly one divider, under the last new entry.
    expect(versions.filter((x) => x.hasDivider).map((x) => x.v)).toEqual([newOnes[newOnes.length - 1]!.v]);

    // Once only: a fresh load after the stamp shows no toast. Wait for the shell's /api/me round
    // trip (what would trigger it) before asserting, so the check can't pass trivially early.
    const me = page.waitForResponse((r) => r.url().endsWith("/api/me") && r.status() === 200);
    await page.goto("/");
    await me;
    await page.waitForTimeout(500);
    await expect(page.getByTestId("whats-new-toast")).toHaveCount(0);
  });

  test("patch-only bump advances the marker silently — no toast", async ({ page }) => {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(APP_VERSION)!;
    test.skip(Number(m[3]) === 0, `APP_VERSION ${APP_VERSION} has no lower patch`);
    const seeded = `${m[1]}.${m[2]}.${Number(m[3]) - 1}`;
    await setMarker(seeded);
    await devSignIn(page, { stampWhatsNew: false });
    const me = page.waitForResponse((r) => r.url().endsWith("/api/me") && r.status() === 200);
    await page.goto("/");
    await me;
    await expect
      .poll(async () => (await pool.query(`select whats_new_seen_version v from users where entra_object_id = $1`, [DEV_OID])).rows[0]?.v, { timeout: 20_000 })
      .toBe(APP_VERSION);
    await page.waitForTimeout(500);
    await expect(page.getByTestId("whats-new-toast")).toHaveCount(0);
  });

  test("plain /whats-new without ?since= has no divider", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/whats-new");
    await expect(page.getByRole("heading", { name: "What’s new." })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("whats-new-divider")).toHaveCount(0);
  });
});
