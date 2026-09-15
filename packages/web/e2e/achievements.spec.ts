// Achievements (SKILLY_SPEC.md §31): the profile card, the shareable hall, the opt-out and the API.
//
// Runs as the single seeded dev admin, so it cannot exercise a genuinely second viewer; the
// other-person shapes (hidden / earned-only) are covered by the live-DB test
// (src/lib/achievements.dbtest.ts). One-time badges are, by nature, not re-earnable between runs,
// so the spec triggers an idempotent event (the Quick start stamp) and asserts the badge is held
// afterwards rather than that it was earned "just now".
import { authedTest as test, expect } from "./fixtures";

test.describe.configure({ mode: "serial" });

const NIL = "00000000-0000-0000-0000-000000000000";

test("profile: the Achievements card — progress, every badge, locked hints, Share copies the hall URL", async ({ page }) => {
  await page.request.post("/api/me/onboarded"); // "Read the Manual" (idempotent — never moves the date)
  const me = await (await page.request.get("/api/me")).json();

  await page.goto("/profile", { timeout: 20_000 });
  const card = page.getByTestId("achievements-card");
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("achievements-progress")).toContainText(/\d+ of 20 earned/);
  await expect(card.locator("[data-badge]")).toHaveCount(20);
  await expect(card.locator('[data-badge="onboarded"]')).toHaveAttribute("data-earned", "1");
  await expect(card.locator('[data-badge="onboarded"]')).toContainText("Read the Manual");
  // Catalog groups render as headings in order.
  await expect(card.getByRole("heading", { name: "Consume" })).toBeVisible();
  await expect(card.getByRole("heading", { name: "Habits" })).toBeVisible();
  // A locked tile (if any) carries its how-to-earn hint and the dashed/greyed treatment.
  const locked = card.locator('[data-earned="0"]');
  if ((await locked.count()) > 0) {
    await expect(locked.first()).toHaveClass(/ach-tile-locked/);
  }

  // Share → "✓ Link copied" and the clipboard holds this user's hall URL.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await card.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByText("✓ Link copied")).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain(`/achievements/${me.userId}`);

  // The link to the hall as others see it.
  await expect(card.getByRole("link", { name: /View as others see it/ })).toHaveAttribute("href", `/achievements/${me.userId}`);
});

test("hall: own view with ?badge= spotlight and the count line; an unknown id is an empty state", async ({ page }) => {
  const me = await (await page.request.get("/api/me")).json();
  await page.goto(`/achievements/${me.userId}?badge=onboarded`, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Your hall." })).toBeVisible({ timeout: 20_000 });
  const tile = page.locator('[data-badge="onboarded"]');
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute("data-earned", "1");
  await expect(page.getByTestId("hall-count")).toContainText(/\d+ of 20/);
  // The owner sees locked badges here too (same content as the profile card).
  await expect(page.locator("[data-badge]")).toHaveCount(20);
  await expect(page.getByRole("button", { name: "Share", exact: true })).toBeVisible();

  await page.goto(`/achievements/${NIL}`, { timeout: 20_000 });
  await expect(page.getByText("No such hall")).toBeVisible({ timeout: 20_000 });
});

test("opt-out round-trips through /api/me and never hides the owner's own view", async ({ page }) => {
  const me = await (await page.request.get("/api/me")).json();
  expect(me.achievementsHidden).toBe(false);
  try {
    const r = await page.request.patch("/api/me", { data: { achievementsHidden: true } });
    expect(r.ok()).toBeTruthy();
    expect((await (await page.request.get("/api/me")).json()).achievementsHidden).toBe(true);
    // Self still gets the full list (hidden applies to OTHER viewers only).
    const own = await (await page.request.get(`/api/users/${me.userId}/achievements`)).json();
    expect(own.hidden).toBe(false);
    expect(own.total).toBe(20);
    expect(own.earned.map((e: { key: string }) => e.key)).toContain("onboarded");
    await page.goto("/profile", { timeout: 20_000 });
    const group = page.getByRole("group", { name: "Achievements visibility" });
    await expect(group.getByRole("button", { name: /^Hidden/ })).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
  } finally {
    await page.request.patch("/api/me", { data: { achievementsHidden: false } });
  }
  expect((await (await page.request.get("/api/me")).json()).achievementsHidden).toBe(false);
});

test("API: the hall payload shape, 404s, and a rejected timezone is ignored not errored", async ({ page }) => {
  const me = await (await page.request.get("/api/me")).json();
  const view = await (await page.request.get(`/api/users/${me.userId}/achievements`)).json();
  expect(view.userId).toBe(me.userId);
  expect(typeof view.displayName).toBe("string");
  expect(Array.isArray(view.earned)).toBe(true);
  for (const e of view.earned) {
    expect(typeof e.key).toBe("string");
    expect(() => new Date(e.earnedAt).toISOString()).not.toThrow();
  }
  expect((await page.request.get(`/api/users/${NIL}/achievements`)).status()).toBe(404);
  expect((await page.request.get(`/api/users/not-a-uuid/achievements`)).status()).toBe(404);

  // Timezone capture (§31.3): a valid zone sticks; junk is ignored (200) and leaves the stored zone alone.
  expect((await page.request.patch("/api/me", { data: { timeZone: "Europe/Sofia" } })).ok()).toBeTruthy();
  expect((await (await page.request.get("/api/me")).json()).timeZone).toBe("Europe/Sofia");
  expect((await page.request.patch("/api/me", { data: { timeZone: "Mars/Olympus_Mons" } })).ok()).toBeTruthy();
  expect((await (await page.request.get("/api/me")).json()).timeZone).toBe("Europe/Sofia");

  // The hover card payload carries the count (or null), never an error.
  const cardRes = await page.request.get(`/api/users/${me.userId}/card`);
  expect(cardRes.ok()).toBeTruthy();
  const cardJson = await cardRes.json();
  expect("achievementCount" in cardJson).toBe(true);
});

test("notifications inbox: badge rows (when any exist) link to the profile card", async ({ page }) => {
  const j = await (await page.request.get("/api/notifications?types=achievement.earned")).json();
  test.skip(!Array.isArray(j.items) || j.items.length === 0, "this user has no badge notifications yet");
  await page.goto("/notifications", { timeout: 20_000 });
  const link = page.getByRole("link", { name: /view badges/ }).first();
  await expect(link).toBeVisible({ timeout: 20_000 });
  await expect(link).toHaveAttribute("href", "/profile#achievements");
});
