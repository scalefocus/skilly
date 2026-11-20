// e2e: the namespace maintainer-contact editor (SKILLY_SPEC.md §30.6), driven on the
// Administration → Namespaces card. The e2e user is a platform admin, and a platform admin has no
// Namespace administration page (§75) — the card is the surface they use, and it renders the same
// shared component (`MaintainerContactField`) the namespace admins' page does.
//
// Covers the user-facing contract of the shared field: the input is themed (it used to carry a
// `className="input"` with no rule behind it, so it rendered as a native browser box), the
// typeahead fills a picked user's email, a malformed value blocks Save and is refused by the API,
// and a good value round-trips and can be cleared again.
//
// Self-cleaning: whatever team-a's contact was on entry is restored at the end.
import { test, expect, devSignIn, type Page } from "./fixtures";
import { openAdminNamespace } from "./helpers/adminNamespaces";

const NS = "team-a"; // seeded by db/seed.dev.sql

interface NsRow { id: string; slug: string; maintainerContact: string | null }

async function teamNamespace(page: Page): Promise<NsRow> {
  const list = await (await page.request.get("/api/namespaces/administered")).json();
  const ns = (list.namespaces as NsRow[]).find((n) => n.slug === NS);
  expect(ns, `seed namespace @${NS} missing`).toBeTruthy();
  return ns!;
}

/** The contact editor inside team-a's block: its input and its own Save (the block has others). */
async function contactField(page: Page) {
  const card = await openAdminNamespace(page, NS);
  const row = card.locator(".ns-contact-row");
  const input = row.getByPlaceholder("search a user, or type a team email…");
  await expect(input).toBeVisible({ timeout: 20_000 });
  return { card, input, save: row.getByRole("button", { name: "Save" }) };
}

test.describe.serial("maintainer contact editor (§30.6)", () => {
  test("the field is themed by the canonical .input class", async ({ page }) => {
    await devSignIn(page);
    const { card, input } = await contactField(page);

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
    await expect(card.getByText(/Published as the marketplace owner/i)).toBeVisible();
  });

  test("a malformed address blocks Save and is refused by the API", async ({ page }) => {
    await devSignIn(page);
    const { card, input, save } = await contactField(page);

    await input.fill("ask the team");
    await expect(card.getByText(/must be an email address/i)).toBeVisible();
    await expect(save).toBeDisabled();
    await expect(input).toHaveAttribute("aria-invalid", "true");

    // The server is the authority, not the disabled button: post the same value directly — to the
    // endpoint this card writes through, and to the one the namespace admins' page uses. Both run
    // the one shared validator.
    const ns = await teamNamespace(page);
    for (const url of [`/api/admin/namespaces/${ns.id}`, `/api/namespaces/${ns.id}/settings`]) {
      const res = await page.request.patch(url, { data: { maintainerContact: "ask the team" } });
      expect(res.status(), `${url}: ${await res.text()}`).toBe(422);
      expect((await res.json()).error).toMatch(/email address/);
    }
  });

  test("the typeahead fills a picked user's email", async ({ page }) => {
    await devSignIn(page);
    const { card, input, save } = await contactField(page);

    // Type enough to clear the endpoint's 2-char floor, using a fragment of the seeded dev user.
    await input.fill("dev");
    const option = card.getByRole("option").first();
    await expect(option).toBeVisible({ timeout: 10_000 });
    await option.click();

    // Picking a user fills a real address, so the field is valid and Save is live.
    await expect(input).toHaveValue(/@/);
    await expect(save).toBeEnabled();
  });

  test("a good address saves, and can be cleared again", async ({ page }) => {
    await devSignIn(page);

    const before = await teamNamespace(page);
    try {
      const { card, input, save } = await contactField(page);

      // Assert the PERSISTED value, not the "✓ Saved" tick. The tick lingers ~2s, so after the
      // second save it can still be on screen from the first — the assertion would pass instantly
      // and race the PATCH it was meant to wait for.
      const storedContact = () =>
        page.request
          .get(`/api/namespaces/${before.id}/settings`)
          .then((r) => r.json())
          .then((j) => j.namespace.maintainerContact as string | null);

      await input.fill("e2e-contact@example.com");
      await save.click();
      await expect(card.getByText("✓ Saved")).toBeVisible({ timeout: 10_000 });
      await expect.poll(storedContact, { timeout: 10_000 }).toBe("e2e-contact@example.com");

      // Clearing is always allowed and must reach the column as NULL.
      await input.fill("");
      await save.click();
      await expect.poll(storedContact, { timeout: 10_000 }).toBeNull();
    } finally {
      // Restore whatever the namespace had before this spec ran.
      await page.request.patch(`/api/namespaces/${before.id}/settings`, {
        data: { maintainerContact: before.maintainerContact ?? "" },
      });
    }
  });
});
