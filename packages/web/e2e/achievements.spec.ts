// Achievements (SKILLY_SPEC.md §31): the profile card, the shareable hall, the opt-out, the level
// (§31.10 — the bar, the bubble ring and the /api/levels map) and the API.
//
// Runs as the single seeded dev admin, so it cannot exercise a genuinely second viewer; the
// other-person shapes (hidden / earned-only) are covered by the live-DB test
// (src/lib/achievements.dbtest.ts). One-time badges are, by nature, not re-earnable between runs,
// so the spec triggers an idempotent event (the Quick start stamp) and asserts the badge is held
// afterwards rather than that it was earned "just now".
import { ACHIEVEMENT_TOTAL } from "@skilly/shared/achievements";
import type { Page } from "@playwright/test";
import { API_TTL_MS } from "../src/components/apiCache";
import { authedTest as test, expect } from "./fixtures";
import { gotoReady } from "./helpers/ready";

test.describe.configure({ mode: "serial" });

const NIL = "00000000-0000-0000-0000-000000000000";

test("profile: the Achievements card — the level bar, every badge, locked hints, Share copies the hall URL", async ({ page }) => {
  await page.request.post("/api/me/onboarded"); // "Read the Manual" (idempotent — never moves the date)
  const me = await (await page.request.get("/api/me")).json();

  await page.goto("/profile", { timeout: 20_000 });
  const card = page.getByTestId("achievements-card");
  await expect(card).toBeVisible({ timeout: 20_000 });
  // §31.10: the level bar replaced the old "N of M earned" text line and reports the same fact.
  const bar = page.getByTestId("level-bar");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(/(Level \d+|Hero) — \d+ of 33/);
  const level = Number(await bar.getAttribute("data-level"));
  expect(level).toBeGreaterThanOrEqual(1); // "Read the Manual" was just stamped above
  await expect(bar.getByRole("progressbar")).toHaveAttribute("aria-valuemax", String(ACHIEVEMENT_TOTAL));
  await expect(bar.getByRole("progressbar")).toHaveAttribute("aria-valuenow", String(level));
  await expect(card.locator("[data-badge]")).toHaveCount(ACHIEVEMENT_TOTAL);
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

test("hall: own view with ?badge= spotlight and the level bar; an unknown id is an empty state", async ({ page }) => {
  const me = await (await page.request.get("/api/me")).json();
  await page.goto(`/achievements/${me.userId}?badge=onboarded`, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Your hall." })).toBeVisible({ timeout: 20_000 });
  const tile = page.locator('[data-badge="onboarded"]');
  await expect(tile).toBeVisible();
  await expect(tile).toHaveAttribute("data-earned", "1");
  // The header's level bar carries the N-of-M count — the body no longer repeats a total (§31.5).
  await expect(page.getByTestId("level-bar")).toContainText(/(Level \d+|Hero) — \d+ of 33/);
  await expect(page.getByTestId("hall-count")).toHaveCount(0);
  // The owner sees locked badges here too (same content as the profile card).
  await expect(page.locator("[data-badge]")).toHaveCount(ACHIEVEMENT_TOTAL);
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
    expect(own.total).toBe(ACHIEVEMENT_TOTAL);
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

  // The hover card payload carries the level (or null) and the Hero flag, never an error.
  const cardRes = await page.request.get(`/api/users/${me.userId}/card`);
  expect(cardRes.ok()).toBeTruthy();
  const cardJson = await cardRes.json();
  expect("achievementCount" in cardJson).toBe(true);
  expect(typeof cardJson.achievementHero).toBe("boolean");

  // §31.10 — the hall payload's Hero stamp: null or a real date, never anything else.
  expect(view.heroAt === null || !Number.isNaN(Date.parse(view.heroAt))).toBe(true);
});

test("levels: the bulk map drives the bubble ring, and the opt-out removes the caller from nobody", async ({ page }) => {
  const me = await (await page.request.get("/api/me")).json();
  const res = await page.request.get("/api/levels");
  expect(res.ok()).toBeTruthy();
  const map = await res.json();
  expect(typeof map.levels).toBe("object");
  expect(Array.isArray(map.heroes)).toBe(true);
  // This user has at least "Read the Manual" by now, so they are in the map — and every entry in
  // it is level ≥ 1, because level 0 draws no ring (§31.10).
  expect(map.levels[me.userId]).toBeGreaterThanOrEqual(1);
  for (const n of Object.values(map.levels)) expect(n).toBeGreaterThanOrEqual(1);

  // Opting out removes you from OTHER people's view but never from your own.
  try {
    expect((await page.request.patch("/api/me", { data: { achievementsHidden: true } })).ok()).toBeTruthy();
    const own = await (await page.request.get("/api/levels")).json();
    expect(own.levels[me.userId]).toBeGreaterThanOrEqual(1);
  } finally {
    await page.request.patch("/api/me", { data: { achievementsHidden: false } });
  }

  // The ring itself: the profile page's own bubble is labelled with the level.
  await page.goto("/profile", { timeout: 20_000 });
  await expect(page.getByRole("img", { name: /^(Level \d+ of 33|Hero — \d+ of 33)$/ }).first()).toBeVisible({ timeout: 20_000 });
});

test("levels: the ring never appears on a bubble whose owner has no badges", async ({ page }) => {
  // Rings are keyed off /api/levels, which omits level-0 users entirely. Assert that contract
  // directly: nobody absent from the map can produce a ring, because there is nothing to read.
  const map = await (await page.request.get("/api/levels")).json();
  for (const [userId, n] of Object.entries(map.levels)) {
    expect(n, `user ${userId} is in the level map at level ${n}`).not.toBe(0);
  }
});

// Regression (two rings of one person, two different arcs): the sidebar's account bubble is mounted
// once for the whole visit, so it kept the level it fetched on first load while each page's own
// bubble fetched the current one. /api/levels is mocked so the level can move mid-visit without
// earning — and permanently spending — a real one-time badge.
async function mockLevels(page: Page, userId: string, start: number): Promise<(level: number) => void> {
  let level = start;
  await page.route("**/api/levels", (route) => route.fulfill({ json: { levels: { [userId]: level }, heroes: [] } }));
  return (next) => {
    level = next;
  };
}
const ringLabel = (level: number) => `Level ${level} of ${ACHIEVEMENT_TOTAL}`;

test("levels: the sidebar's account bubble shows the same ring as the page's own bubble after navigating", async ({ page }) => {
  const me = await (await page.request.get("/api/me")).json();
  const setLevel = await mockLevels(page, me.userId, 3);
  const sidebar = page.locator(".user-trigger");

  await gotoReady(page, "/catalog");
  await expect(sidebar.getByRole("img", { name: ringLabel(3) })).toBeVisible({ timeout: 20_000 });

  // Badges are earned. Let the client cache's TTL lapse so the next page's bubble really refetches —
  // otherwise both bubbles would read the cached 3 and this test would prove nothing.
  setLevel(10);
  await page.waitForTimeout(API_TTL_MS + 500);

  // Client-side navigation through the account menu: the shell, and its bubble, stay mounted.
  await sidebar.click();
  await page.getByRole("menuitem", { name: "Profile" }).click();
  await expect(page).toHaveURL(/\/profile$/, { timeout: 20_000 });
  await expect(page.locator("main").getByRole("img", { name: ringLabel(10) }).first()).toBeVisible({ timeout: 20_000 });
  await expect(sidebar.getByRole("img", { name: ringLabel(10) })).toBeVisible();
  await expect(sidebar.getByRole("img", { name: ringLabel(3) })).toHaveCount(0);
});

test("levels: a badge toast moves the sidebar ring at once, with no navigation", async ({ page }) => {
  const me = await (await page.request.get("/api/me")).json();
  const setLevel = await mockLevels(page, me.userId, 3);
  let items: unknown[] = [];
  // Only the shell's poller reads the bare URL; the inbox's filtered reads are left alone.
  await page.route(/\/api\/notifications$/, (route) => route.fulfill({ json: { unread: items.length, items } }));
  const sidebar = page.locator(".user-trigger");

  await gotoReady(page, "/catalog");
  await expect(sidebar.getByRole("img", { name: ringLabel(3) })).toBeVisible({ timeout: 20_000 });

  setLevel(4);
  items = [{
    id: `e2e-ring-${Date.now()}`,
    type: "achievement.earned",
    readAt: null,
    createdAt: new Date().toISOString(),
    payload: { key: "onboarded", name: "Read the Manual", level: 4, hero: false },
  }];
  // The shell polls every 60s and again whenever the tab regains focus — take the focus path.
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByTestId("badge-toast")).toBeVisible({ timeout: 20_000 });
  await expect(sidebar.getByRole("img", { name: ringLabel(4) })).toBeVisible();
});

test("notifications inbox: badge rows (when any exist) link to the profile card", async ({ page }) => {
  const j = await (await page.request.get("/api/notifications?types=achievement.earned")).json();
  test.skip(!Array.isArray(j.items) || j.items.length === 0, "this user has no badge notifications yet");
  await page.goto("/notifications", { timeout: 20_000 });
  const link = page.getByRole("link", { name: /view badges/ }).first();
  await expect(link).toBeVisible({ timeout: 20_000 });
  await expect(link).toHaveAttribute("href", "/profile#achievements");
});
