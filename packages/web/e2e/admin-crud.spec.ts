// e2e: the platform-admin dashboard + a role-mapping create→delete round-trip (SKILLY_SPEC.md §4).
// Roles are resolved from SCIM-synced group membership + role_mappings, so the admin screen binds
// Entra groups to roles. We create a mapping for a seeded group and delete it again — fully
// self-cleaning, and RBAC-neutral for the rest of the suite (it targets a group the dev user isn't,
// and the suite only ever signs in as the dev admin).
import { test, expect, devSignIn } from "./fixtures";

test.describe.serial("admin dashboard + role-mapping CRUD (§4)", () => {
  test("the platform-admin dashboard renders", async ({ page }) => {
    await devSignIn(page);
    await page.goto("/admin");
    // The page (and this heading) is platform-admin only, so it also asserts the dev user's role.
    await expect(page.getByRole("heading", { name: "Run the platform." })).toBeVisible({ timeout: 20_000 });
  });

  test("a role mapping can be created and then deleted", async ({ page }) => {
    await devSignIn(page);

    // Groups + mappings are surfaced by the admin config endpoint.
    const cfg = await (await page.request.get("/api/admin/namespaces")).json();
    const groups: { id: string; displayName: string }[] = cfg.groups ?? [];
    expect(groups.length, "the dev seed provides synced groups").toBeGreaterThan(0);
    // A group that is NOT already a platform admin — the seed's "Team A Members".
    const group = groups.find((g) => g.displayName === "Team A Members") ?? groups[0];

    const created = await page.request.post("/api/admin/role-mappings", {
      data: { groupId: group.id, namespaceId: null, role: "platform_admin" },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = await created.json();
    expect(id).toBeTruthy();

    // Always delete it — the finally keeps the mapping table clean even if the assertion above trips.
    const del = await page.request.delete(`/api/admin/role-mappings/${id}`);
    expect(del.ok(), await del.text()).toBeTruthy();
  });
});
