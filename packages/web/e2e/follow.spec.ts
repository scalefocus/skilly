// Following people (SKILLY_SPEC.md §35): the Follow ↔ Unfollow button (hall + leaderboard), the
// profile's "Allow others to follow me" toggle and the collapsible "People I follow (N)" pane, and
// the API's self-follow / unknown-target rules.
//
// Runs as the single seeded dev admin following the seeded colleague Alice Chen. The follower
// notification fan-out needs a SECOND actor publishing / requesting, so it is covered by the
// live-DB tests (src/lib/follows.dbtest.ts, worker integration/publishFlow.test.ts).
import { authedTest as test, expect } from "./fixtures";

test.describe.configure({ mode: "serial" });

const NIL = "00000000-0000-0000-0000-000000000000";

async function aliceId(page: import("@playwright/test").Page): Promise<string> {
  const r = await page.request.get("/api/users/suggest?q=alice");
  const { users } = (await r.json()) as { users: { id: string; name: string }[] };
  const alice = users.find((u) => u.name === "Alice Chen");
  expect(alice, "the seeded colleague Alice Chen").toBeTruthy();
  return alice!.id;
}

test("API: self-follow is 400, an unknown target 404, unfollow is always idempotent", async ({ page }) => {
  const me = await (await page.request.get("/api/me")).json();
  expect((await page.request.put(`/api/users/${me.userId}/follow`)).status()).toBe(400);
  expect((await page.request.put(`/api/users/${NIL}/follow`)).status()).toBe(404);
  const del = await page.request.delete(`/api/users/${NIL}/follow`);
  expect(del.status()).toBe(200);
  expect(await del.json()).toEqual({ following: false });
  expect(me.allowFollows).toBe(true);
});

test("hall: Follow flips to Unfollow, the profile pane lists them, and Unfollow there removes the row", async ({ page }) => {
  const alice = await aliceId(page);
  await page.request.delete(`/api/users/${alice}/follow`); // clean slate between runs

  await page.goto(`/achievements/${alice}`, { timeout: 20_000 });
  const follow = page.getByRole("button", { name: "Follow", exact: true });
  await expect(follow).toBeVisible({ timeout: 20_000 });
  // The label flips optimistically; wait for the PUT itself before reading the server's list.
  const [put] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/users/${alice}/follow`) && r.request().method() === "PUT"),
    follow.click(),
  ]);
  expect(put.status()).toBe(200);
  await expect(page.getByRole("button", { name: "Unfollow", exact: true })).toBeVisible();
  const list = (await (await page.request.get("/api/me/following")).json()) as { following: { userId: string; state: string }[] };
  expect(list.following.find((f) => f.userId === alice)?.state).toBe("active");

  // Profile: the pane is collapsed by default; its header carries the count.
  await page.goto("/profile", { timeout: 20_000 });
  const header = page.getByRole("button", { name: /People I follow \(\d+\)/ });
  await expect(header).toBeVisible({ timeout: 20_000 });
  const before = Number(/\((\d+)\)/.exec((await header.textContent()) ?? "")![1]);
  expect(before).toBeGreaterThanOrEqual(1);
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "true");
  const row = page.getByTestId("following-row").filter({ hasText: "Alice Chen" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Following since");
  const [del] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/api/users/${alice}/follow`) && r.request().method() === "DELETE"),
    row.getByRole("button", { name: "Unfollow" }).click(),
  ]);
  expect(del.status()).toBe(200);
  await expect(row).toHaveCount(0);
  await expect(page.getByRole("button", { name: `People I follow (${before - 1})` })).toBeVisible();

  // The open state is remembered per browser.
  await page.reload();
  await expect(page.getByRole("button", { name: /People I follow \(\d+\)/ })).toHaveAttribute("aria-expanded", "true", { timeout: 20_000 });
});

test("leaderboard: the Followed sort exists and a row's Follow button sits after Reach out", async ({ page }) => {
  await page.goto("/leaderboard", { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Leaderboard." })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Followed", exact: true }).click();
  await expect(page.getByRole("button", { name: "Followed", exact: true })).toHaveClass(/sort-on/);
  const other = page.locator(".lb-row").filter({ has: page.getByRole("button", { name: "Reach out" }) }).first();
  if ((await other.count()) > 0) {
    const labels = await other.locator(".lb-actions button").allTextContents();
    const reach = labels.indexOf("Reach out");
    const fol = labels.findIndex((t) => t === "Follow" || t === "Unfollow");
    if (fol >= 0) expect(fol).toBeGreaterThan(reach);
  }
});

test("profile: 'Allow others to follow me' toggles off and back on", async ({ page }) => {
  await page.goto("/profile", { timeout: 20_000 });
  const group = page.getByRole("group", { name: "Allow others to follow me" });
  await expect(group).toBeVisible({ timeout: 20_000 });
  try {
    await group.getByRole("button", { name: "Off" }).click();
    await expect(group.getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/Your Follow button is hidden/)).toBeVisible();
    expect((await (await page.request.get("/api/me")).json()).allowFollows).toBe(false);
  } finally {
    await page.request.patch("/api/me", { data: { allowFollows: true } });
  }
  await page.reload();
  await expect(page.getByRole("group", { name: "Allow others to follow me" }).getByRole("button", { name: "On" })).toHaveAttribute("aria-pressed", "true", { timeout: 20_000 });
});
