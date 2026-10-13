// e2e: a taken slug becomes a new version of the existing skill (SKILLY_SPEC.md §8 slug match). A
// NEW-skill proposal can't reuse the slug of a visible active skill in any namespace: the form
// switches in place to the new-version flow (skill-level fields from the existing skill), "Use a
// different slug" restores the draft, and a supplied source of the other delivery type is blocked
// with guidance until discarded. Runs against the dev stack (SKILLY_DEV_AUTH=1) using the seeded
// hosted `global/pdf-tools`. Deliberately WRITE-FREE: nothing is ever submitted.
import { test, expect, devSignIn } from "./fixtures";
import { gotoReady, NAV_TIMEOUT } from "./helpers/ready";

test.describe("slug match → new version (@global/pdf-tools)", () => {
  test.beforeEach(async ({ page }) => {
    await devSignIn(page);
    await gotoReady(page, "/propose");
    await expect(page.getByRole("heading", { name: "Propose a skill." })).toBeVisible({ timeout: NAV_TIMEOUT });
  });

  test("the lookup is case-insensitive and exposes no internal ids", async ({ page }) => {
    const res = await page.request.get("/api/skills/slug-matches?slug=PDF-Tools");
    expect(res.ok()).toBeTruthy();
    const { matches } = (await res.json()) as { matches: Record<string, unknown>[] };
    const hit = matches.find((m) => m.namespaceSlug === "global" && m.slug === "pdf-tools");
    expect(hit, JSON.stringify(matches)).toBeTruthy();
    expect(hit!.type).toBe("hosted");
    expect(hit!.skillId).toBeUndefined();
  });

  test("leaving a taken slug switches to the new-version flow; Use a different slug restores the draft", async ({ page }) => {
    const title = page.getByPlaceholder("PDF Tools");
    const slug = page.getByPlaceholder("pdf-tools");
    await title.fill("My PDF thing");
    await slug.fill("pdf-tools");
    // While the slug field still has focus, the match is shown but typing isn't interrupted.
    await expect(page.getByTestId("slug-match-panel")).toBeVisible({ timeout: NAV_TIMEOUT });
    await expect(page.getByRole("button", { name: "Submit for review →" })).toBeDisabled();

    await slug.blur();
    await expect(page.getByTestId("slug-redirect-banner")).toContainText("global/pdf-tools already exists", { timeout: NAV_TIMEOUT });
    await expect(page.getByRole("heading", { name: "Propose a new version." })).toBeVisible();
    await expect(page.getByText("Skill slug · locked")).toBeVisible();
    // Skill-level fields come from the existing skill — the typed title is not carried over.
    await expect(title).toHaveValue("PDF Tools");

    await page.getByRole("button", { name: "Use a different slug" }).click();
    await expect(page.getByRole("heading", { name: "Propose a skill." })).toBeVisible();
    await expect(slug).toHaveValue("");
    await expect(slug).toBeFocused();
    await expect(title).toHaveValue("My PDF thing");
  });

  test("a pointer source clashing with the hosted skill is blocked; discarding it continues", async ({ page }) => {
    // A NEW proposal opens on the Pointer tab; supplying a URL makes the source a pointer.
    await page.getByPlaceholder("https://github.com/anthropics/skills.git").fill("https://github.com/example/skills.git");
    const slug = page.getByPlaceholder("pdf-tools");
    await slug.fill("pdf-tools");
    await slug.blur();

    const panel = page.getByTestId("slug-match-panel");
    await expect(panel).toContainText("global/pdf-tools exists as a hosted skill", { timeout: NAV_TIMEOUT });
    await expect(panel.getByRole("button", { name: "Propose a new version →" })).toBeDisabled();
    await expect(page.getByTestId("slug-redirect-banner")).toHaveCount(0);

    await panel.getByRole("button", { name: "Discard my files and continue" }).click();
    await expect(page.getByTestId("slug-redirect-banner")).toBeVisible({ timeout: NAV_TIMEOUT });
    // No source rides along, so the new-version default applies: Keep current files.
    await expect(page.getByRole("button", { name: /keep current files \(v/i })).toHaveAttribute("aria-pressed", "true");
  });
});
