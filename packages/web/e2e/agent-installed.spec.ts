// e2e: an AION agent install record on the Installed Skills page (SKILLY_SPEC.md §69.7). Runs against
// the dev stack (SKILLY_DEV_AUTH=1) on the seeded `global/web-scraper` skill (one active version,
// 1.2.0). A record is written by the git gateway when AION clones with an agent key; this dev-server
// suite has no gateway, so the spec plays that part with one SQL insert — which needs DATABASE_URL
// in the launching shell; skipped otherwise. It only touches the signed-in user's own rows for
// web-scraper and deletes them afterwards.
import { Pool } from "pg";
import { test, expect, devSignIn, signedInOid } from "./fixtures";
import { acceptNextDialog, clickAndAwait, gotoLoaded } from "./helpers/ready";

const dbUrl = process.env.DATABASE_URL;
const SKILL = 'a[href="/skills/global/web-scraper"]';
const WEB_SCRAPER = `(select s.id from skills s join namespaces n on n.id = s.namespace_id where n.slug = 'global' and s.slug = 'web-scraper')`;
const ME = `(select id from users where entra_object_id = $1)`;

test.describe("AION rows on the Installed page (§69.7)", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!dbUrl, "DATABASE_URL not set — cannot play the gateway's agent clone");
  let pool: Pool;

  const clear = async () => {
    await pool.query(`delete from agent_installs where user_id = ${ME} and skill_id = ${WEB_SCRAPER}`, [signedInOid()]);
    // A token install of the same skill would group both into one card; this spec wants a plain row.
    await pool.query(`delete from tokens where user_id = ${ME} and skill_id = ${WEB_SCRAPER} and type = 'install'`, [signedInOid()]);
  };

  test.beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl });
  });
  test.afterAll(async () => {
    await clear().catch(() => {});
    await pool.end();
  });

  test("an AION row shows client AION, its freshness and only Remove; Remove deletes the record", async ({ page }) => {
    await clear();
    // What the gateway records on AION's clone (recordAgentClone): served 1.2.0 = latest → up to date.
    const id = (await pool.query<{ id: string }>(
      `insert into agent_installs (user_id, skill_id, source, last_served_semver, client_user_agent)
       values (${ME}, ${WEB_SCRAPER}, 'aion', '1.2.0', 'git/2.45.0') returning id`,
      [signedInOid()],
    )).rows[0]!.id;

    await devSignIn(page);
    await gotoLoaded(page, "/installed", /\/api\/installs$/);

    const row = page.locator(".installed-row", { has: page.locator(SKILL) });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId("install-client")).toHaveText("AION");
    await expect(row.getByTestId("install-client")).toHaveAttribute("title", "git/2.45.0");
    await expect(row.locator(".install-freshness")).toHaveAttribute("data-freshness", "current");
    await expect(row.locator(".install-freshness")).toContainText("installed v1.2.0 · up to date");
    await expect(row.getByText("kept in sync by AION")).toBeVisible();
    await expect(row.getByText("latest", { exact: true })).toBeVisible();

    // A record, not a credential: no uninstall, no Show install URL, no Activate, no Install latest.
    await expect(row.getByTestId("remove-agent-install")).toBeVisible();
    await expect(row.getByRole("button", { name: "uninstall" })).toHaveCount(0);
    await expect(row.getByTestId("show-install-url")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "activate" })).toHaveCount(0);
    await expect(row.getByTestId("install-latest")).toHaveCount(0);

    // Remove → confirm → the record is gone from the page and the table.
    const confirmed = acceptNextDialog(page);
    await clickAndAwait(page, () => row.getByTestId("remove-agent-install").click(), `/api/installs/${id}`, { method: "DELETE" });
    await confirmed;
    await expect(page.getByText("Removed from the list.")).toBeVisible();
    await expect(page.locator(".installed-row", { has: page.locator(SKILL) })).toHaveCount(0);
    expect((await pool.query(`select 1 from agent_installs where id = $1`, [id])).rowCount).toBe(0);
  });
});
