// e2e: replies to skill-discussion comments (SKILLY_SPEC.md §24 "Replies to discussion comments").
// Reply to a comment from its thread's inline composer; a thread with more than 3 replies collapses
// behind "Show N more replies"; the reply notification's `#discussion-<rootId>` deep link lands on
// the thread with every reply shown; a moderator deleting a comment that has replies leaves a
// tombstone, and deleting its last reply sweeps it away. Runs against the dev stack
// (SKILLY_DEV_AUTH=1) on the seeded `global/pdf-tools` skill as the dev user (a platform admin, so
// also a moderator). Threads are seeded through the API and removed at the end of each test.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { acceptNextDialog, clickAndAwait, gotoLoaded, probe } from "./helpers/ready";

const SKILL = "/skills/global/pdf-tools";
const API = "/api/skills/global/pdf-tools/discussion";
const THREAD = /\/api\/skills\/global\/pdf-tools\/discussion\?offset=0/;
const POST = /\/api\/skills\/global\/pdf-tools\/discussion$/;
const DELETE = /\/api\/skills\/global\/pdf-tools\/discussion\/[^/?]+$/;

const header = (page: Page) => page.getByRole("button", { name: /^Discussion/ });
const threadOf = (page: Page, rootId: string) => page.locator(`[data-thread-root="${rootId}"]`);

/** Post through the API with the signed-in session; returns the new message id. */
async function apiPost(page: Page, body: string, parentId: string | null = null): Promise<string> {
  const res = await page.request.post(API, { data: parentId ? { body, parentId } : { body } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { message: { id: string } }).message.id;
}

/** Seed a root with `n` replies; returns their ids and bodies. */
async function seedThread(page: Page, label: string, n: number) {
  const rootBody = probe(`${label} root`);
  const rootId = await apiPost(page, rootBody);
  const replies: { id: string; body: string }[] = [];
  for (let i = 1; i <= n; i++) {
    const body = probe(`${label} reply ${i}`);
    replies.push({ id: await apiPost(page, body, rootId), body });
  }
  return { rootId, rootBody, replies };
}

/** Remove a seeded thread: replies first (newest last), so the root is childless and hard-deleted. */
async function cleanup(page: Page, ids: { rootId: string; replyIds: string[] }) {
  for (const id of [...ids.replyIds].reverse()) await page.request.delete(`${API}/${id}`).catch(() => {});
  await page.request.delete(`${API}/${ids.rootId}`).catch(() => {});
}

test.describe.configure({ mode: "serial" });

test.describe("discussion replies (@global/pdf-tools)", () => {
  test("reply to a comment from its thread's inline composer; Escape closes it", async ({ page }) => {
    await devSignIn(page);
    const seeded = await seedThread(page, "reply-flow", 0);
    const replyIds: string[] = [];
    try {
      await gotoLoaded(page, `${SKILL}#discussion`, THREAD);
      const t = threadOf(page, seeded.rootId);
      await expect(t.getByText(seeded.rootBody)).toBeVisible();

      // Reply opens ONE inline composer at the foot of this thread — no version picker.
      await t.getByTestId("discussion-reply").first().click();
      const composer = t.getByRole("textbox", { name: "Write a reply" });
      await expect(composer).toBeVisible();
      const body = probe("reply-flow answer");
      await composer.fill(body);
      const res = await clickAndAwait(page, () => t.getByRole("button", { name: /^Reply$/ }).click(), POST, { method: "POST" });
      replyIds.push(((await res.json()) as { message: { id: string } }).message.id);

      // The reply renders inside the thread, without a version pill (the root's covers it).
      const replyRow = page.locator(`#discussion-msg-${replyIds[0]}`);
      await expect(replyRow.getByText(body)).toBeVisible();
      await expect(replyRow.locator(".version-pill-btn")).toHaveCount(0);
      await expect(t.getByRole("textbox", { name: "Write a reply" })).toHaveCount(0);

      // Replying to the reply opens the composer again; Escape closes it.
      await replyRow.getByTestId("discussion-reply").click();
      const again = t.getByRole("textbox", { name: "Write a reply" });
      await expect(again).toBeVisible();
      await again.press("Escape");
      await expect(t.getByRole("textbox", { name: "Write a reply" })).toHaveCount(0);
    } finally {
      await cleanup(page, { rootId: seeded.rootId, replyIds });
    }
  });

  test("more than 3 replies collapse behind \"Show N more replies\"", async ({ page }) => {
    await devSignIn(page);
    const seeded = await seedThread(page, "collapse", 4);
    try {
      await gotoLoaded(page, `${SKILL}#discussion`, THREAD);
      const t = threadOf(page, seeded.rootId);
      for (const r of seeded.replies.slice(0, 3)) await expect(t.getByText(r.body)).toBeVisible();
      await expect(t.getByText(seeded.replies[3]!.body)).toHaveCount(0);
      await t.getByRole("button", { name: "Show 1 more reply" }).click();
      await expect(t.getByText(seeded.replies[3]!.body)).toBeVisible();
    } finally {
      await cleanup(page, { rootId: seeded.rootId, replyIds: seeded.replies.map((r) => r.id) });
    }
  });

  test("the #discussion-<rootId> deep link lands on the thread with every reply shown", async ({ page }) => {
    await devSignIn(page);
    const seeded = await seedThread(page, "deeplink", 4);
    try {
      // Over a stored collapse, in one fresh document load (as the notification CTA arrives).
      await page.addInitScript(() => localStorage.setItem("skilly.discussionCollapsed", "1"));
      await gotoLoaded(page, `${SKILL}#discussion-${seeded.rootId}`, THREAD);
      await expect(header(page)).toHaveAttribute("aria-expanded", "true");
      const t = threadOf(page, seeded.rootId);
      // The thread's replies expand fully — no "Show more" click needed — and it is in view.
      await expect(t.getByText(seeded.replies[3]!.body)).toBeVisible();
      await expect(t.getByRole("button", { name: /more repl/ })).toHaveCount(0);
      await expect(t).toBeInViewport();
      // The stored collapse preference is untouched.
      expect(await page.evaluate(() => localStorage.getItem("skilly.discussionCollapsed"))).toBe("1");
    } finally {
      await cleanup(page, { rootId: seeded.rootId, replyIds: seeded.replies.map((r) => r.id) });
    }
  });

  test("a moderator deleting a comment with replies leaves a tombstone; the last reply sweeps it", async ({ page }) => {
    await devSignIn(page);
    const seeded = await seedThread(page, "tombstone", 2);
    try {
      await gotoLoaded(page, `${SKILL}#discussion`, THREAD);
      const t = threadOf(page, seeded.rootId);
      await expect(t.getByText(seeded.rootBody)).toBeVisible();

      // Delete the root (its row renders first in the thread): it becomes a tombstone.
      let accepted = acceptNextDialog(page);
      await clickAndAwait(page, () => t.getByRole("button", { name: "delete" }).first().click(), DELETE, { method: "DELETE" });
      await accepted;
      await expect(t.getByTestId("discussion-tombstone")).toHaveText("Comment removed by a moderator");
      await expect(t.getByText(seeded.rootBody)).toHaveCount(0);
      for (const r of seeded.replies) await expect(t.getByText(r.body)).toBeVisible();
      // No replying into a tombstoned thread.
      await expect(t.getByTestId("discussion-reply")).toHaveCount(0);

      // Delete both replies: the last one takes the emptied tombstone with it.
      for (let i = 0; i < seeded.replies.length; i++) {
        accepted = acceptNextDialog(page);
        await clickAndAwait(page, () => t.getByRole("button", { name: "delete" }).first().click(), DELETE, { method: "DELETE" });
        await accepted;
      }
      await expect(t).toHaveCount(0);
    } finally {
      await cleanup(page, { rootId: seeded.rootId, replyIds: seeded.replies.map((r) => r.id) });
    }
  });
});
