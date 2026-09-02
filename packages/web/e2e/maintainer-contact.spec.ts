// e2e: the namespace maintainer-contact editor on /namespaces (SKILLY_SPEC.md §30.6).
//
// Covers the user-facing contract of the shared field: the input is themed (it used to carry a
// `className="input"` with no rule behind it, so it rendered as a native browser box), the
// typeahead fills a picked user's email, a malformed value blocks Save and is refused by the API,
// and a good value round-trips and can be cleared again.
//
// Self-cleaning: whatever the namespace's contact was on entry is restored at the end.
import { test, expect, devSignIn } from "./fixtures";

interface NsRow { id: string; slug: string; maintainerContact: string | null }

test.describe.serial("maintainer contact editor (§30.6)", () => {
  test("the field is themed by the canonical .input class", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/namespaces");

    const input = page.getByPlaceholder("search a user, or type a team email…").first();
    await expect(input).toBeVisible({ timeout: 20_000 });

    // The regression this guards: an unstyled input inherits the native box, which paints an
    // opaque white background in dark mode and has no token border. `.input` sets both.
    const box = await input.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { border: cs.borderTopWidth, radius: cs.borderTopLeftRadius, padding: cs.paddingLeft, font: cs.fontFamily };
    });
    expect(box.border).toBe("1px");
    expect(parseFloat(box.radius)).toBeGreaterThan(0);
    expect(parseFloat(box.padding)).toBeGreaterThan(0);
    expect(box.font).not.toBe("");

    // The help line tells the editor the value is outward-facing (§30.3).
    await expect(page.getByText(/Published as the marketplace owner/i).first()).toBeVisible();
  });

  test("a malformed address blocks Save and is refused by the API", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/namespaces");

    const input = page.getByPlaceholder("search a user, or type a team email…").first();
    await expect(input).toBeVisible({ timeout: 20_000 });
    const save = page.getByRole("button", { name: "Save" }).first();

    await input.fill("ask the team");
    await expect(page.getByText(/must be an email address/i).first()).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(input).toHaveAttribute("aria-invalid", "true");

    // The server is the authority, not the disabled button: post the same value directly.
    const list = await (await page.request.get("/api/namespaces/administered")).json();
    const ns: NsRow = list.namespaces[0];
    const res = await page.request.patch(`/api/namespaces/${ns.id}/settings`, {
      data: { maintainerContact: "ask the team" },
    });
    expect(res.status(), await res.text()).toBe(422);
    expect((await res.json()).error).toMatch(/email address/);
  });

  test("the typeahead fills a picked user's email", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/namespaces");

    const input = page.getByPlaceholder("search a user, or type a team email…").first();
    await expect(input).toBeVisible({ timeout: 20_000 });

    // Type enough to clear the endpoint's 2-char floor, using a fragment of the seeded dev user.
    await input.fill("dev");
    const option = page.getByRole("option").first();
    await expect(option).toBeVisible({ timeout: 10_000 });
    await option.click();

    // Picking a user fills a real address, so the field is valid and Save is live.
    await expect(input).toHaveValue(/@/);
    await expect(page.getByRole("button", { name: "Save" }).first()).toBeEnabled();
  });

  test("a good address saves, and can be cleared again", async ({ page }) => {
    await devSignIn(page);

    const before: NsRow = (await (await page.request.get("/api/namespaces/administered")).json()).namespaces[0];
    try {
      await page.goto("/namespaces");
      const input = page.getByPlaceholder("search a user, or type a team email…").first();
      await expect(input).toBeVisible({ timeout: 20_000 });

      // Assert the PERSISTED value, not the "✓ Saved" tick. The tick lingers ~2s, so after the
      // second save it can still be on screen from the first — the assertion would pass instantly
      // and race the PATCH it was meant to wait for.
      const storedContact = () =>
        page.request
          .get(`/api/namespaces/${before.id}/settings`)
          .then((r) => r.json())
          .then((j) => j.namespace.maintainerContact as string | null);

      await input.fill("e2e-contact@example.com");
      await page.getByRole("button", { name: "Save" }).first().click();
      await expect(page.getByText("✓ Saved").first()).toBeVisible({ timeout: 10_000 });
      await expect.poll(storedContact, { timeout: 10_000 }).toBe("e2e-contact@example.com");

      // Clearing is always allowed and must reach the column as NULL.
      await input.fill("");
      await page.getByRole("button", { name: "Save" }).first().click();
      await expect.poll(storedContact, { timeout: 10_000 }).toBeNull();
    } finally {
      // Restore whatever the namespace had before this spec ran.
      await page.request.patch(`/api/namespaces/${before.id}/settings`, {
        data: { maintainerContact: before.maintainerContact ?? "" },
      });
    }
  });
});
