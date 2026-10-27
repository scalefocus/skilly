// e2e: feature ideas (SKILLY_SPEC.md §60). The signed-in dev user is a platform admin, so one user
// plays both parts: they suggest an idea from What's new, edit it while it's pending, publish it from
// the Feature ideas page, find it in Coming soon with their own vote, un-vote and re-vote, then close
// it as Shipped (Planned is no longer offered) — which leaves both badges (Bright Idea, Made It Real)
// in their hall. With suggestions switched off for everyone else, the admin still sees the list and
// the Suggest button, and the Feature ideas page says who can suggest. Last, a second idea is
// published and then deleted from the Published tab, leaving Coming soon and Your ideas. (Every e2e
// user is a platform admin, so the plain-user side — no button, 403 — is covered by
// lib/ideas.dbtest.ts.)
//
// A second test (v2.45.0) watches the open list follow the votes live: an upvote moves an item at
// once, another user's vote arrives through the 15 s poll, the strip opens its "Upvoted by" list,
// and the Profile toggle marks the caller's own bubble "only you".
//
// EXCLUSIVE (groups.ts): a published idea changes Coming soon for every user, and the spec flips the
// feature switch. One idea is closed and the other deleted by the end, so nothing is left in the
// list, and the switch is turned back on. With DATABASE_URL set, the user's own ideas are cleared
// first, so a re-run never trips the 5-a-day cap; a fresh CI stack starts clean anyway.
import { Pool } from "pg";
import { test, expect, devSignIn, signedInOid } from "./fixtures";
import { clickAndAwait, gotoLoaded, probe } from "./helpers/ready";

const dbUrl = process.env.DATABASE_URL;

test.describe.configure({ mode: "serial" });

test("feature ideas: suggest → edit → publish → vote → close as Shipped; the switch spares admins", async ({ page }) => {
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
  await expect(row.getByTestId("suggested-by")).toBeVisible();
  const vote = row.getByTestId("vote-button");
  await expect(vote).toHaveAttribute("aria-pressed", "true");
  await expect(vote).toContainText("1");
  await clickAndAwait(page, () => vote.click(), /\/api\/coming-soon\/ideas\/[^/]+\/vote$/, { method: "DELETE" });
  await expect(vote).toHaveAttribute("aria-pressed", "false");
  await expect(vote).toContainText("0");
  await clickAndAwait(page, () => vote.click(), /\/api\/coming-soon\/ideas\/[^/]+\/vote$/, { method: "PUT" });
  await expect(vote).toHaveAttribute("aria-pressed", "true");

  // ── Close as Shipped (Planned is no longer an outcome) ─────────────────────────────────────────
  await gotoLoaded(page, "/admin/ideas", "/api/admin/ideas?status=pending");
  await clickAndAwait(page, () => page.getByTestId("ideas-tab-published").click(), "/api/admin/ideas?status=published");
  const published = page.getByTestId("admin-idea").filter({ hasText: title });
  await expect(published.getByTestId("admin-idea-votes")).toContainText("1");
  await published.getByTestId("idea-close").click();
  const close = page.getByRole("dialog", { name: "Close idea" });
  await expect(close.getByTestId("idea-outcome-planned")).toHaveCount(0);
  await close.getByTestId("idea-outcome-shipped").check();
  await close.getByTestId("idea-note").fill("Out in this release.");
  await clickAndAwait(page, () => close.getByTestId("idea-dialog-submit").click(), /\/api\/admin\/ideas\/[^/]+\/close$/, { method: "POST" });

  await clickAndAwait(page, () => page.getByTestId("ideas-tab-closed").click(), "/api/admin/ideas?status=closed");
  const closed = page.getByTestId("admin-idea").filter({ hasText: title });
  await expect(closed).toContainText("Shipped");
  await expect(closed.getByTestId("idea-ship")).toHaveCount(0);

  // ── The proposer's view and the two badges ────────────────────────────────────────────────────
  await gotoLoaded(page, "/whats-new#your-ideas", "/api/coming-soon");
  await expect(page.getByTestId("coming-soon-row").filter({ hasText: title })).toHaveCount(0);
  await expect(page.getByTestId("your-idea").filter({ hasText: title })).toContainText("Shipped");

  const me = (await (await page.request.get("/api/me")).json()) as { userId: string };
  const hall = (await (await page.request.get(`/api/users/${me.userId}/achievements`)).json()) as { earned: { key: string }[] };
  const keys = hall.earned.map((e) => e.key);
  expect(keys).toContain("idea_published");
  expect(keys).toContain("idea_shipped");

  // ── Suggestions off for everyone else: a platform admin still sees the list and may suggest ────
  const off = await page.request.patch("/api/admin/settings", { data: { featureIdeasEnabled: false } });
  expect(off.ok()).toBeTruthy();
  try {
    const listOff = (await (await page.request.get("/api/coming-soon")).json()) as { canSuggest: boolean };
    expect(listOff.canSuggest).toBe(true);
    await gotoLoaded(page, "/whats-new", "/api/coming-soon");
    await expect(page.getByTestId("coming-soon").getByTestId("suggest-feature")).toBeVisible();
    await gotoLoaded(page, "/admin/ideas", "/api/admin/ideas?status=pending");
    await expect(page.getByTestId("ideas-off")).toContainText("Only platform admins can suggest features right now.");
  } finally {
    await page.request.patch("/api/admin/settings", { data: { featureIdeasEnabled: true } });
  }

  // ── Delete a published item: gone from Coming soon, the Published tab and Your ideas ──────────
  const doomedText = `${probe("idea-delete")} — a second idea, published only to be deleted.`;
  const doomedTitle = `Doomed idea ${Date.now()}`;
  const submitted = await page.request.post("/api/coming-soon/ideas", { data: { description: doomedText } });
  expect(submitted.status()).toBe(201);
  const doomedId = ((await submitted.json()) as { idea: { id: string } }).idea.id;
  const queue = (await (await page.request.get("/api/admin/ideas?status=pending")).json()) as { ideas: { id: string; version: string }[] };
  const doomedVersion = queue.ideas.find((i) => i.id === doomedId)!.version;
  const published2 = await page.request.post(`/api/admin/ideas/${doomedId}/publish`, { data: { title: doomedTitle, description: doomedText, expectedUpdatedAt: doomedVersion } });
  expect(published2.status()).toBe(204);

  await gotoLoaded(page, "/admin/ideas", "/api/admin/ideas?status=pending");
  await clickAndAwait(page, () => page.getByTestId("ideas-tab-published").click(), "/api/admin/ideas?status=published");
  const doomed = page.getByTestId("admin-idea").filter({ hasText: doomedTitle });
  await doomed.getByTestId("idea-delete").click();
  const del = page.getByRole("dialog", { name: "Delete this idea?" });
  await expect(del.getByTestId("idea-delete-warning")).toContainText("its 1 vote for good");
  await del.getByTestId("idea-note").fill("Test data.");
  await clickAndAwait(page, () => del.getByTestId("idea-dialog-submit").click(), /\/api\/admin\/ideas\/[^/]+\/delete$/, { method: "POST" });
  await expect(page.getByText("Idea deleted")).toBeVisible();
  await expect(page.getByTestId("admin-idea").filter({ hasText: doomedTitle })).toHaveCount(0);
  const after = (await (await page.request.get("/api/coming-soon")).json()) as { items: { id: string }[]; mine: { id: string }[] };
  expect(after.items.some((i) => i.id === doomedId)).toBe(false);
  expect(after.mine.some((i) => i.id === doomedId)).toBe(false);
});

// ── v2.45.0: the list follows the votes live, and shows who upvoted (§60.3 decisions 18 and 19) ──
// Outside Jenkins every e2e page is the same dev admin, so "someone else" is a fixed user row that
// never signs in: its votes and its opt-out are written straight to the database (DATABASE_URL is
// set on every CI stack), and the open page must pick them up through its 15 s poll.
test("Coming soon re-sorts live and shows who upvoted; the Profile toggle hides your bubble", async ({ page }) => {
  test.skip(!dbUrl, "needs DATABASE_URL to cast another user's vote");
  test.setTimeout(180_000);
  await devSignIn(page);
  const pool = new Pool({ connectionString: dbUrl });
  const published: string[] = [];
  let otherId = "";
  try {
    await pool.query(`delete from feature_ideas where author_id = (select id from users where entra_object_id = $1)`, [signedInOid()]);
    otherId = (
      await pool.query<{ id: string }>(
        `insert into users (entra_object_id, email, display_name, status) values ('e2e-live-voter-oid', 'e2e-live-voter@skilly.local', 'Live Voter', 'active')
         on conflict (entra_object_id) do update set status = 'active', idea_votes_hidden = false returning id`,
      )
    ).rows[0]!.id;
    expect((await page.request.patch("/api/me", { data: { ideaVotesHidden: false } })).ok()).toBeTruthy();
    const me = ((await (await page.request.get("/api/me")).json()) as { userId: string }).userId;

    // Publish B, then A, and take back the proposer's own votes: at 0 each, the newer A sits above B.
    const publish = async (label: string) => {
      const description = `${probe(`idea-live-${label}`)} — an idea that watches the list re-sort.`;
      const submitted = await page.request.post("/api/coming-soon/ideas", { data: { description } });
      expect(submitted.status()).toBe(201);
      const id = ((await submitted.json()) as { idea: { id: string } }).idea.id;
      const queue = (await (await page.request.get("/api/admin/ideas?status=pending")).json()) as { ideas: { id: string; version: string }[] };
      const title = `Live ${label} ${Date.now()}`;
      const r = await page.request.post(`/api/admin/ideas/${id}/publish`, { data: { title, description, expectedUpdatedAt: queue.ideas.find((i) => i.id === id)!.version } });
      expect(r.status()).toBe(204);
      published.push(id);
      expect((await page.request.delete(`/api/coming-soon/ideas/${id}/vote`)).ok()).toBeTruthy();
      return { id, title };
    };
    const b = await publish("B");
    const a = await publish("A");

    await gotoLoaded(page, "/whats-new#coming-soon", "/api/coming-soon");
    const rows = page.getByTestId("coming-soon-row");
    const order = async () => {
      const texts = await rows.allTextContents();
      return [a.title, b.title].sort((x, y) => texts.findIndex((t) => t.includes(x)) - texts.findIndex((t) => t.includes(y)));
    };
    const rowA = rows.filter({ hasText: a.title });
    const rowB = rows.filter({ hasText: b.title });
    await expect.poll(order).toEqual([a.title, b.title]);
    await expect(rowB.getByTestId("upvoted-by")).toHaveCount(0);

    // The caller's upvote moves B above A at once, with their bubble first in B's strip.
    await clickAndAwait(page, () => rowB.getByTestId("vote-button").click(), /\/api\/coming-soon\/ideas\/[^/]+\/vote$/, { method: "PUT" });
    await expect.poll(order).toEqual([b.title, a.title]);
    await expect(rowB.getByTestId("voter-face").first()).toHaveAttribute("data-voter", me);
    await expect(rowB.getByTestId("voter-face").first()).not.toHaveAttribute("data-only-you", "true");
    await expect(page.getByTestId("vote-announcement")).toContainText(`Upvoted ${b.title}: 1 vote`);

    // Someone else's vote on A: 1 – 1, so the newer A leads again, after one poll and without a reload.
    await pool.query(`insert into feature_idea_votes (idea_id, user_id) values ($1, $2) on conflict do nothing`, [a.id, otherId]);
    await expect.poll(order, { timeout: 20_000 }).toEqual([a.title, b.title]);
    await expect(rowA.getByTestId("voter-face").first()).toHaveAttribute("data-voter", otherId);
    await expect(rowA.getByTestId("vote-button")).toContainText("1");

    // The strip opens the full list.
    await clickAndAwait(page, () => rowA.getByTestId("voter-strip").click(), /\/api\/coming-soon\/ideas\/[^/]+\/voters$/);
    const list = page.getByTestId("voters-list");
    await expect(list).toContainText("Live Voter");
    await page.keyboard.press("Escape");
    await expect(list).toHaveCount(0);

    // Hide my votes on Profile: my bubble on B is now marked only you.
    await gotoLoaded(page, "/profile", "/api/me");
    const toggle = page.getByTestId("idea-votes-toggle");
    await clickAndAwait(page, () => toggle.getByRole("button", { name: /^Hidden/ }).click(), "/api/me", { method: "PATCH" });
    await expect(toggle.getByRole("button", { name: /^Hidden/ })).toHaveAttribute("aria-pressed", "true");
    await gotoLoaded(page, "/whats-new#coming-soon", "/api/coming-soon");
    await expect(rowB.getByTestId("voter-face").first()).toHaveAttribute("data-only-you", "true");

    // The other voter hides theirs: after the next poll A shows no strip, and its count stays.
    await pool.query(`update users set idea_votes_hidden = true where id = $1`, [otherId]);
    await expect(rowA.getByTestId("upvoted-by")).toHaveCount(0, { timeout: 20_000 });
    await expect(rowA.getByTestId("vote-button")).toContainText("1");
  } finally {
    await page.request.patch("/api/me", { data: { ideaVotesHidden: false } });
    if (otherId) await pool.query(`update users set idea_votes_hidden = false where id = $1`, [otherId]);
    // Leave nothing on Coming soon; the votes go with the ideas.
    for (const id of published) await page.request.post(`/api/admin/ideas/${id}/delete`, { data: { reason: "e2e cleanup" } });
    await pool.end();
  }
});
