// Skill collections (SKILLY_SPEC.md §37): Add to collection on an org-visible skill (create → toast →
// ticked on reopen; absent on a restricted skill), the profile's "Skill collections" card (inline
// rename, View skills → the catalog's collection banner), the header dropdown's Collections group,
// Mixtape, and delete → the old link's "no longer exists" banner.
//
// Runs as the single seeded dev admin on the seeded org-visible `global/pdf-tools`. The second-viewer
// view and the follower fan-out need another signed-in actor, so they are covered by the live-DB
// tests (src/lib/collections.dbtest.ts). Self-cleaning: every collection it creates carries the
// `e2e ` probe prefix and is deleted through the API at the start and end of the run.
import { authedTest as test, expect, type Page } from "./fixtures";
import { acceptNextDialog, awaitApi, clickAndAwait, gotoLoaded, gotoReady, probe } from "./helpers/ready";

test.describe.configure({ mode: "serial" });

const SKILL = "/skills/global/pdf-tools";
const DETAIL = /\/api\/skills\/global\/pdf-tools$/;

async function cleanup(page: Page) {
  const r = await page.request.get("/api/collections/mine");
  const { collections } = (await r.json()) as { collections: { id: string; name: string }[] };
  for (const c of collections.filter((x) => x.name.startsWith("e2e "))) {
    await page.request.delete(`/api/collections/${c.id}`);
  }
}

const NAME = probe("coll");
const RENAMED = `${NAME} v2`;

/** The probe collection's id — rows are addressed by id, since an open inline editor holds the
 *  name in an input value, which a text filter can't see. */
async function probeId(page: Page, name: string): Promise<string> {
  const { collections } = (await (await page.request.get("/api/collections/mine")).json()) as { collections: { id: string; name: string }[] };
  const c = collections.find((x) => x.name === name);
  expect(c, `the probe collection "${name}"`).toBeTruthy();
  return c!.id;
}
const rowOf = (page: Page, id: string) => page.locator(`[data-testid="collection-row"][data-collection-id="${id}"]`);

test("detail: Add to collection creates a collection, toasts, and shows it ticked on reopen", async ({ page }) => {
  await cleanup(page);
  await gotoLoaded(page, SKILL, DETAIL);
  const open = page.getByTestId("add-to-collection");
  await expect(open).toBeVisible();
  await clickAndAwait(page, () => open.click(), "/api/collections/mine");
  const popup = page.getByTestId("collection-popup");
  await expect(popup).toBeVisible();
  await popup.getByTestId("collection-name-input").fill(NAME);
  const create = popup.getByTestId("collection-create");
  await expect(create).toContainText(NAME);
  const res = await clickAndAwait(page, () => create.click(), /\/api\/collections$/, { method: "POST" });
  expect(res.status()).toBe(201);
  await expect(page.getByRole("status").filter({ hasText: `Added to ${NAME}` })).toBeVisible();
  await expect(popup.getByTestId("collection-option").filter({ hasText: NAME }).getByRole("checkbox")).toBeChecked();

  // Escape dismisses; reopening re-reads the ticks from the server.
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await clickAndAwait(page, () => open.click(), "/api/collections/mine");
  await page.getByTestId("collection-name-input").fill(NAME.slice(4, 14));
  await expect(page.getByTestId("collection-option").filter({ hasText: NAME }).getByRole("checkbox")).toBeChecked();
  // An exact existing name offers no Create row (no duplicates).
  await page.getByTestId("collection-name-input").fill(NAME.toUpperCase());
  await expect(page.getByTestId("collection-create")).toHaveCount(0);
});

test("detail: a namespace-restricted skill has no Add to collection button", async ({ page }) => {
  await gotoLoaded(page, "/skills/team-a/secret-helper", /\/api\/skills\/team-a\/secret-helper$/);
  await expect(page.getByRole("button", { name: /Watch/ })).toBeVisible();
  await expect(page.getByTestId("add-to-collection")).toHaveCount(0);
});

test("profile: the card lists it, renames inline, and View skills opens the collection banner", async ({ page }) => {
  await gotoLoaded(page, "/profile", "/api/collections/mine");
  const header = page.getByRole("button", { name: /Skill collections \(\d+\)/ });
  await expect(header).toBeVisible();
  if ((await header.getAttribute("aria-expanded")) === "false") await header.click();
  const row = rowOf(page, await probeId(page, NAME));
  await expect(row).toBeVisible();
  await expect(row).toContainText("1 skill");

  await row.getByRole("button", { name: `Edit the collection name: ${NAME}` }).click();
  const input = row.getByRole("textbox", { name: "collection name" });
  await input.fill(RENAMED);
  await clickAndAwait(page, () => input.press("Enter"), /\/api\/collections\/[0-9a-f-]+$/, { method: "PATCH" });
  await expect(row.getByRole("button", { name: `Edit the collection name: ${RENAMED}` })).toBeVisible();

  await clickAndAwait(page, () => row.getByTestId("collection-view").click(), /\/api\/skills\?.*collection=/);
  await expect(page).toHaveURL(/\/catalog\?collection=[0-9a-f-]+/);
  const banner = page.getByTestId("collection-banner");
  await expect(banner).toContainText(`Collection: ${RENAMED}`);
  await expect(page.locator(".skill-card")).toHaveCount(1);
  await expect(page.locator(".skill-card").first()).toContainText("PDF Tools");
  // The owner gets a remove control on each card.
  await expect(page.getByTestId("collection-remove")).toHaveCount(1);
});

test("header: the dropdown's Collections group finds it and opens the collection view", async ({ page }) => {
  await gotoReady(page, "/leaderboard");
  const box = page.getByRole("textbox", { name: "Search skills" });
  const term = RENAMED.slice(RENAMED.indexOf(" ", 4) + 1); // the unique timestamp tail
  const suggest = awaitApi(page, "/api/collections/suggest");
  await box.fill(term);
  await suggest;
  const hit = page.getByTestId("search-collection-hit").filter({ hasText: RENAMED });
  await expect(page.getByTestId("search-collections-group")).toBeVisible();
  await expect(hit).toBeVisible();
  await expect(page.getByText(/Nothing found for/)).toHaveCount(0);
  await clickAndAwait(page, () => hit.click(), /\/api\/collections\/[0-9a-f-]+$/);
  await expect(page.getByTestId("collection-banner")).toContainText(RENAMED);
});

test("badge + delete: Mixtape is held; deleting from the card leaves the old link on 'no longer exists'", async ({ page }) => {
  const me = (await (await page.request.get("/api/me")).json()) as { userId: string };
  const hall = (await (await page.request.get(`/api/users/${me.userId}/achievements`)).json()) as { earned: { key: string }[] };
  expect(hall.earned.map((e) => e.key)).toContain("first_collection");

  const mine = { id: await probeId(page, RENAMED) };

  await gotoLoaded(page, "/profile", "/api/collections/mine");
  const header = page.getByRole("button", { name: /Skill collections \(\d+\)/ });
  if ((await header.getAttribute("aria-expanded")) === "false") await header.click();
  const row = rowOf(page, mine.id);
  const dialog = acceptNextDialog(page);
  await clickAndAwait(page, () => row.getByTestId("collection-delete").click(), `/api/collections/${mine.id}`, { method: "DELETE" });
  await dialog;
  await expect(row).toHaveCount(0);

  await gotoReady(page, `/catalog?collection=${mine.id}`);
  await expect(page.getByTestId("collection-banner")).toContainText("This collection no longer exists.");
  await cleanup(page);
});
