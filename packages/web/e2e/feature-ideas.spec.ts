// e2e: feature ideas (SKILLY_SPEC.md §60). The signed-in dev user is a platform admin, so one user
// plays both parts: they suggest an idea from What's new, edit it while it's pending, publish it from
// the Feature ideas page, find it in Coming soon with their own vote, un-vote and re-vote, close it as
// Planned, then mark it shipped — which leaves both badges (Bright Idea, Made It Real) in their hall.
//
// EXCLUSIVE (groups.ts): a published idea changes Coming soon for every user. The idea is closed by
// the end, so nothing is left in the list. With DATABASE_URL set, the user's own ideas are cleared
// first, so a re-run never trips the 5-a-day cap; a fresh CI stack starts clean anyway.
import { Pool } from "pg";
import { test, expect, devSignIn, signedInOid } from "./fixtures";
import { acceptNextDialog, awaitApi, clickAndAwait, gotoLoaded, probe } from "./helpers/ready";

const dbUrl = process.env.DATABASE_URL;

test.describe.configure({ mode: "serial" });

test("feature ideas: suggest → edit → publish → vote → close as Planned → mark shipped", async ({ page }) => {
  await devSignIn(page);
  if (dbUrl) {
    const pool = new Pool({ connectionString: dbUrl });
    try {
      await pool.query(`delete from feature_ideas where author_id = (select id from users where entra_object_id = $1)`, [signedInOid()]);
    } finally {
      await pool.end();
    }
  }
  const settings = await page.request.patch("/api/admin/settings", { data: { featureIdeasEnabled: true } });
  expect(settings.ok()).toBeTruthy();

  const text = `${probe("idea")} — let me export my installed skills as a CSV file.`;
  const edited = `${text} Edited.`;
  const title = `CSV export ${Date.now()}`;

  // ── Suggest from What's new ───────────────────────────────────────────────────────────────────
  await gotoLoaded(page, "/whats-new", "/api/coming-soon");
  const section = page.getByTestId("coming-soon");
  const head = section.getByRole("button", { name: /^Coming soon · \d+/ });
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await section.getByTestId("suggest-feature").click();
  const dialog = page.getByRole("dialog", { name: "Suggest a feature" });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("idea-text").fill("too short");
  await expect(dialog.getByTestId("idea-submit")).toBeDisabled();
  await dialog.getByTestId("idea-text").fill(text);
  await clickAndAwait(page, () => dialog.getByTestId("idea-submit").click(), "/api/coming-soon/ideas", { method: "POST" });
  await expect(dialog).toHaveCount(0);
  await expect(head).toHaveAttribute("aria-expanded", "true");
  const myIdea = section.getByTestId("your-idea").filter({ hasText: text });
  await expect(myIdea).toHaveAttribute("data-status", "pending");
  await expect(myIdea).toContainText("Pending review");

  // ── Edit while pending ────────────────────────────────────────────────────────────────────────
  await myIdea.getByTestId("idea-edit").click();
  const editDialog = page.getByRole("dialog", { name: "Edit your idea" });
  await editDialog.getByTestId("idea-text").fill(edited);
  await clickAndAwait(page, () => editDialog.getByTestId("idea-submit").click(), "/api/coming-soon/ideas/", { method: "PATCH" });
  await expect(section.getByTestId("your-idea").filter({ hasText: edited })).toBeVisible();

  // ── Publish from the Feature ideas page ───────────────────────────────────────────────────────
  await gotoLoaded(page, "/admin/ideas", "/api/admin/ideas?status=pending");
  const pending = page.getByTestId("admin-idea").filter({ hasText: edited });
  await expect(pending).toHaveAttribute("data-status", "pending");
  await pending.getByTestId("idea-publish").click();
  const publish = page.getByRole("dialog", { name: "Publish idea" });
  await publish.getByTestId("idea-title").fill(title);
  await clickAndAwait(page, () => publish.getByTestId("idea-dialog-submit").click(), /\/api\/admin\/ideas\/[^/]+\/publish$/, { method: "POST" });
  await expect(page.getByTestId("admin-idea").filter({ hasText: edited })).toHaveCount(0);

  // ── Vote on it in Coming soon (it starts with the proposer's own vote) ────────────────────────
  await gotoLoaded(page, "/whats-new#coming-soon", "/api/coming-soon");
  const row = page.getByTestId("coming-soon-row").filter({ hasText: title });
  await expect(row).toHaveAttribute("data-kind", "idea");
  await expect(row.getByTestId("suggested-by")).toBeVisible();
  const vote = row.getByTestId("vote-button");
  await expect(vote).toHaveAttribute("aria-pressed", "true");
  await expect(vote).toContainText("1");
  await clickAndAwait(page, () => vote.click(), /\/api\/coming-soon\/ideas\/[^/]+\/vote$/, { method: "DELETE" });
  await expect(vote).toHaveAttribute("aria-pressed", "false");
  await expect(vote).toContainText("0");
  await clickAndAwait(page, () => vote.click(), /\/api\/coming-soon\/ideas\/[^/]+\/vote$/, { method: "PUT" });
  await expect(vote).toHaveAttribute("aria-pressed", "true");

  // ── Close as Planned, then mark shipped ───────────────────────────────────────────────────────
  await gotoLoaded(page, "/admin/ideas", "/api/admin/ideas?status=pending");
  await clickAndAwait(page, () => page.getByTestId("ideas-tab-published").click(), "/api/admin/ideas?status=published");
  const published = page.getByTestId("admin-idea").filter({ hasText: title });
  await expect(published.getByTestId("admin-idea-votes")).toContainText("1");
  await published.getByTestId("idea-close").click();
  const close = page.getByRole("dialog", { name: "Close idea" });
  await close.getByTestId("idea-outcome-planned").check();
  await close.getByTestId("idea-note").fill("Next quarter.");
  await clickAndAwait(page, () => close.getByTestId("idea-dialog-submit").click(), /\/api\/admin\/ideas\/[^/]+\/close$/, { method: "POST" });

  await clickAndAwait(page, () => page.getByTestId("ideas-tab-closed").click(), "/api/admin/ideas?status=closed");
  const closed = page.getByTestId("admin-idea").filter({ hasText: title });
  await expect(closed).toContainText("Planned");
  const confirmed = acceptNextDialog(page);
  const reloaded = awaitApi(page, "/api/admin/ideas?status=closed");
  await clickAndAwait(page, () => closed.getByTestId("idea-ship").click(), /\/api\/admin\/ideas\/[^/]+\/ship$/, { method: "POST" });
  await confirmed;
  await reloaded;
  await expect(page.getByTestId("admin-idea").filter({ hasText: title })).toContainText("Shipped");

  // ── The proposer's view and the two badges ────────────────────────────────────────────────────
  await gotoLoaded(page, "/whats-new#your-ideas", "/api/coming-soon");
  await expect(page.getByTestId("coming-soon-row").filter({ hasText: title })).toHaveCount(0);
  await expect(page.getByTestId("your-idea").filter({ hasText: title })).toContainText("Shipped");

  const me = (await (await page.request.get("/api/me")).json()) as { userId: string };
  const hall = (await (await page.request.get(`/api/users/${me.userId}/achievements`)).json()) as { earned: { key: string }[] };
  const keys = hall.earned.map((e) => e.key);
  expect(keys).toContain("idea_published");
  expect(keys).toContain("idea_shipped");
});
