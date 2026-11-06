// e2e: Visits, New user and the new-user hat (SKILLY_SPEC.md §67). A person in their first 30 days
// wears a propeller beanie above their avatar; their hover card shows a Visits row and a New user
// row; the profile's Directory details opt-out and the admin Visits & new users switch both hide all
// three; and the newcomer map refuses an anonymous caller.
//
// Needs DATABASE_URL: the signed-in user's first visit and visit days are seeded straight into the
// database (there is no UI that writes them), and `visits_since` is pinned to a date long ago so the
// Visits window is not still in its first week on a freshly migrated CI database. Both are restored.
// EXCLUSIVE in groups.ts: it changes platform settings every other spec's cards read.
import { Pool } from "pg";
import { test, expect, devSignIn, signedInOid, signedInDisplayName, type Page } from "./fixtures";
import { clickAndAwait, gotoReady, reloadReady } from "./helpers/ready";

const dbUrl = process.env.DATABASE_URL;
const CARD_API = /\/api\/users\/[^/]+\/card/;

test.describe.configure({ mode: "serial" });

test("the newcomer map refuses an anonymous caller", async ({ page }) => {
  const res = await page.request.get("/api/newcomers");
  expect(res.status()).toBe(401);
});

test("a newcomer wears the hat; the card shows Visits and New user; the opt-out and the switch hide them", async ({ page }) => {
  test.skip(!dbUrl, "needs DATABASE_URL to seed the user's first visit and visit days");
  await devSignIn(page);
  const name = signedInDisplayName();
  const pool = new Pool({ connectionString: dbUrl });

  const userId = (await pool.query<{ id: string }>(`select id from users where entra_object_id = $1`, [signedInOid()])).rows[0]!.id;
  const saved = (await pool.query<{ first_seen: Date | null }>(`select first_seen from users where id = $1`, [userId])).rows[0]!.first_seen;
  const savedSince = (await pool.query<{ value: unknown }>(`select value from platform_settings where key = 'visits_since'`)).rows[0]?.value;
  const putSince = (value: unknown) =>
    pool.query(
      `insert into platform_settings (key, value) values ('visits_since', $1::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [JSON.stringify(value)],
    );

  const hat = (p: Page) => p.getByRole("main").getByRole("img", { name: "New user" });
  const bubble = (p: Page) => p.getByRole("main").getByRole("button", { name: `${name} — profile` });
  const card = (p: Page) => p.getByRole("dialog", { name: new RegExp(`${name} — profile`) });
  const openCard = async (p: Page) => {
    await expect(bubble(p)).toBeVisible();
    await clickAndAwait(p, () => bubble(p).hover(), CARD_API);
    await expect(card(p)).toBeVisible();
  };
  const patchMe = (directoryHidden: boolean) => page.request.patch("/api/me", { data: { directoryHidden } });

  try {
    // First visit 20 days ago and visits on the last 5 days: "Once a week" (5 of 21) and New user.
    await pool.query(`update users set first_seen = now() - interval '20 days' where id = $1`, [userId]);
    await pool.query(`delete from user_visit_days where user_id = $1`, [userId]);
    await pool.query(
      `insert into user_visit_days (user_id, day)
       select $1, (now() at time zone 'utc')::date - g from generate_series(0, 4) g`,
      [userId],
    );
    await putSince("2020-01-01");
    // Not opted out — and the PATCH drops the server's cached newcomer map, so the hat shows now.
    expect((await patchMe(false)).ok()).toBeTruthy();
    expect((await page.request.patch("/api/admin/settings", { data: { visitsEnabled: true } })).ok()).toBeTruthy();

    await gotoReady(page, "/profile");
    await expect(hat(page).first()).toBeVisible();
    await openCard(page);
    await expect(card(page).getByTestId("dircard-visits")).toContainText("Once a week");
    await expect(card(page).getByTestId("dircard-newuser")).toContainText("New user");

    // The opt-out hides all three.
    expect((await patchMe(true)).ok()).toBeTruthy();
    await reloadReady(page);
    await expect(bubble(page)).toBeVisible();
    await expect(hat(page)).toHaveCount(0);
    await openCard(page);
    await expect(card(page).getByTestId("dircard-visits")).toHaveCount(0);
    await expect(card(page).getByTestId("dircard-newuser")).toHaveCount(0);
    expect((await patchMe(false)).ok()).toBeTruthy();

    // The admin switch hides them for everyone.
    expect((await page.request.patch("/api/admin/settings", { data: { visitsEnabled: false } })).ok()).toBeTruthy();
    await reloadReady(page);
    await expect(bubble(page)).toBeVisible();
    await expect(hat(page)).toHaveCount(0);
    await openCard(page);
    await expect(card(page).getByTestId("dircard-visits")).toHaveCount(0);
    await expect(card(page).getByTestId("dircard-newuser")).toHaveCount(0);
  } finally {
    await page.request.patch("/api/admin/settings", { data: { visitsEnabled: true } });
    await patchMe(false);
    await pool.query(`update users set first_seen = $2 where id = $1`, [userId, saved]);
    if (savedSince !== undefined) await putSince(savedSince);
    await pool.end();
  }
});
