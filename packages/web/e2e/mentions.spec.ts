// e2e: mentions (SKILLY_SPEC.md §24 "Mentions", §10 people mode). Drives the composer's `@`/`#`
// pickers with real keystrokes on the seeded skill discussion — Enter SELECTS while the picker is
// open (never sends), the picked mention lands as an atomic chip, the posted message renders
// linked chips — and the header search's leading-`@` people mode. Runs against the dev stack
// (SKILLY_DEV_AUTH=1) with db/seed.dev.sql (Alice Chen / Bob Ng / global/pdf-tools). Self-cleaning.
//
// Hardening (helpers/ready.ts): the composer is a client-only contentEditable inside the
// discussion thread (rendered after `GET …/discussion`), and the picker opens on a debounced
// typeahead request — so each test starts with the thread loaded and pairs the trigger keystrokes
// with the `/api/*/suggest` round-trip they cause, the Post with its POST, and the moderator
// delete with its confirm() AND its DELETE. No assertion waits on a timer.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { NAV_TIMEOUT, acceptNextDialog, clickAndAwait, gotoLoaded, gotoReady, probe } from "./helpers/ready";

const SKILL = "/skills/global/lint-fixer";
const THREAD = /\/api\/skills\/global\/lint-fixer\/discussion\?offset=0/;
// The page's secondary panels (readme, related, usage, maintainers) render ABOVE the discussion
// and arrive after it. A late one shifts the layout, the shift fires a scroll event, and the
// caret-anchored picker dismisses on any scroll above it (MentionComposer.tsx) - so the composer
// tests wait for all of them before the first keystroke.
const SKILL_PANELS = [
  THREAD,
  /\/api\/skills\/global\/lint-fixer\/readme$/,
  /\/api\/skills\/global\/lint-fixer\/related$/,
  /\/api\/skills\/global\/lint-fixer\/usage-series\?/,
  /\/api\/skills\/global\/lint-fixer\/maintainers$/,
];
const POST = /\/api\/skills\/global\/lint-fixer\/discussion$/;
const DELETE = /\/api\/skills\/global\/lint-fixer\/discussion\/[^/?]+$/;
const PEOPLE = /\/api\/users\/suggest\?q=alice/;
const SKILLS = /\/api\/skills\/suggest\?q=pdf/;

const composerOf = (page: Page) => page.getByRole("textbox", { name: "Add to the discussion" });

/** Moderator delete of the newest comment: confirm() accepted, DELETE observed. */
async function deleteNewest(page: Page, card: ReturnType<Page["locator"]>): Promise<void> {
  const accepted = acceptNextDialog(page);
  await clickAndAwait(page, () => card.getByRole("button", { name: "delete" }).first().click(), DELETE, { method: "DELETE" });
  await accepted;
}

// All three tests post into / read from the same seeded thread — keep them sequential.
test.describe.configure({ mode: "serial" });

test.describe("mentions (§24)", () => {
  test("composer: @ picker → Enter selects an atomic chip → post renders linked chips", async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, SKILL, SKILL_PANELS);

    const card = page.locator("section#discussion");
    const composer = composerOf(page);
    await expect(composer).toBeVisible();
    await composer.click();

    // Type a message with an @-trigger; the caret-anchored people picker opens once the typeahead
    // (2-char floor, ~180 ms debounce) answers — wait for that answer, not for time to pass.
    await page.keyboard.type(`${probe("mention probe")} for `, { delay: 15 });
    await clickAndAwait(page, () => page.keyboard.type("@alice ch", { delay: 15 }), PEOPLE);
    const picker = page.locator("#mention-picker");
    await expect(picker).toBeVisible();
    await expect(picker.getByText("Alice Chen")).toBeVisible();

    // Enter SELECTS (never sends): the run becomes one atomic chip; nothing was posted.
    await page.keyboard.press("Enter");
    await expect(picker).toHaveCount(0);
    const chip = composer.locator("[data-mention]");
    await expect(chip).toHaveText("@Alice Chen");
    await expect(card.getByText("No comments yet", { exact: false })).toBeVisible(); // not sent

    // Backspace after the trailing space removes the WHOLE chip (atomic), then undo by re-picking.
    await page.keyboard.press("Backspace"); // the trailing space
    await page.keyboard.press("Backspace"); // the chip, as one unit
    await expect(composer.locator("[data-mention]")).toHaveCount(0);
    await clickAndAwait(page, () => page.keyboard.type("@alice ch", { delay: 15 }), PEOPLE);
    await expect(picker).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(composer.locator("[data-mention]")).toHaveCount(1);

    // Add a # skill mention the same way.
    await clickAndAwait(page, () => page.keyboard.type("see #pdf to", { delay: 15 }), SKILLS);
    await expect(picker).toBeVisible();
    await expect(picker.getByText("PDF Tools")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(composer.locator("[data-mention]")).toHaveCount(2);

    // Post → the message renders BOTH chips, linked (§24 rendering).
    await clickAndAwait(page, () => card.getByRole("button", { name: /^Post/ }).click(), POST, { method: "POST" });
    const userChip = card.locator(".md a.mention-chip-user");
    const skillChip = card.locator(".md a.mention-chip-skill");
    await expect(userChip).toBeVisible();
    await expect(userChip).toHaveText("@Alice Chen");
    await expect(userChip).toHaveAttribute("href", /\/catalog\?maintainer=.+&by=Alice(%20| )Chen/);
    await expect(skillChip).toHaveText("PDF Tools");
    await expect(skillChip).toHaveAttribute("href", "/skills/global/pdf-tools");

    // The reminder line sits under the composer (§24, all four composers).
    await expect(card.getByText("# to mention a skill · @ to mention someone")).toBeVisible();

    // Clean up (dev user is a platform admin → moderator delete).
    await deleteNewest(page, card);
    await expect(card.locator(".md a.mention-chip-user")).toHaveCount(0);
  });

  test("escape dismisses the picker and Enter then sends normally", async ({ page }) => {
    await devSignIn(page);
    await gotoLoaded(page, SKILL, SKILL_PANELS);
    const card = page.locator("section#discussion");
    const composer = composerOf(page);
    await expect(composer).toBeVisible();
    await composer.click();

    const lead = probe("esc probe");
    const body = `${lead} @alice ch`;
    await page.keyboard.type(`${lead} `, { delay: 15 });
    await clickAndAwait(page, () => page.keyboard.type("@alice ch", { delay: 15 }), PEOPLE);
    const picker = page.locator("#mention-picker");
    await expect(picker).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);

    // With the picker dismissed, Enter posts the literal text (no chip).
    await clickAndAwait(page, () => page.keyboard.press("Enter"), POST, { method: "POST" });
    const posted = card.getByText(body, { exact: false });
    await expect(posted).toBeVisible();
    await expect(card.locator(".md [data-mention], .md .mention-chip")).toHaveCount(0);

    await deleteNewest(page, card);
    await expect(card.getByText(body, { exact: false })).toHaveCount(0);
  });

  test("header search people mode: leading @ lists people; picking opens their skills (§10)", async ({ page }) => {
    await devSignIn(page);
    await gotoReady(page, "/");
    // The box itself renders only in the authenticated shell — it is part of the readiness gate.
    const box = page.getByRole("textbox", { name: "Search skills" });
    await expect(box).toBeVisible();
    await box.click();
    await clickAndAwait(page, () => box.fill("@alice ch"), PEOPLE);

    const row = page.locator(".search-ac-item").filter({ hasText: "Alice Chen" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("alice@org"); // avatar row carries the email

    await Promise.all([
      page.waitForURL(/\/catalog\?maintainer=.+&by=Alice(%20| )Chen/, { timeout: NAV_TIMEOUT }),
      row.click(),
    ]);
    await expect(page.getByText("Skills maintained by Alice Chen", { exact: false })).toBeVisible({ timeout: 20_000 });
  });
});
