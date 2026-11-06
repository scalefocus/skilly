// Live-DB integration test for the directory hover card's read side (SKILLY_SPEC.md §28).
// Gated by SKILLY_DB_E2E=1. Covers: the three directory fields come back for a normal user;
// presence resolves against the FIXED 5-minute window; the self-service opt-out and a GDPR
// tombstone both null the directory block out (name/email/presence unaffected); and an unknown or
// malformed id resolves to null (→ 404) rather than erroring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getUserCard } from "./directory";
import { setVisitsEnabled } from "./settings";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

async function mkUser(oid: string, fields: Record<string, unknown> = {}): Promise<string> {
  const id = (
    await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ($1,$2,$3)
       on conflict (entra_object_id) do update set email = excluded.email, display_name = excluded.display_name
       returning id`,
      [oid, `${oid}@org`, `User ${oid}`],
    )
  ).rows[0]!.id;
  // Reset every column this suite touches, so a re-run never inherits the previous run's state.
  await pool.query(
    `update users set job_title = $2, office_location = $3, department = $4,
            directory_hidden = $5, last_seen = $6
      where id = $1`,
    [
      id,
      fields.job_title ?? null,
      fields.office_location ?? null,
      fields.department ?? null,
      fields.directory_hidden ?? false,
      fields.last_seen ?? null,
    ],
  );
  return id;
}

test("getUserCard: returns the Entra directory profile", { skip: !enabled }, async () => {
  const id = await mkUser("card-full", { job_title: "Delivery Lead", office_location: "Sofia", department: "Engineering" });

  const c = await getUserCard(id);

  assert.equal(c?.displayName, "User card-full");
  assert.equal(c?.email, "card-full@org");
  assert.equal(c?.jobTitle, "Delivery Lead");
  assert.equal(c?.officeLocation, "Sofia");
  assert.equal(c?.department, "Engineering");
});

test("getUserCard: online is the fixed 5-minute window, never a wider one", { skip: !enabled }, async () => {
  const fresh = await mkUser("card-fresh");
  const stale = await mkUser("card-stale");
  const never = await mkUser("card-never");
  await pool.query(`update users set last_seen = now() - interval '1 minute' where id = $1`, [fresh]);
  await pool.query(`update users set last_seen = now() - interval '30 minutes' where id = $1`, [stale]);

  assert.equal((await getUserCard(fresh))?.online, true);

  const s = await getUserCard(stale);
  assert.equal(s?.online, false); // inside the admin list's 1h window, but NOT online here
  assert.ok(s?.lastSeen, "a stale user still reports when they were last seen");

  const n = await getUserCard(never);
  assert.equal(n?.online, false);
  assert.equal(n?.lastSeen, null);
});

test("getUserCard: the opt-out nulls the directory block but keeps name/email/presence", { skip: !enabled }, async () => {
  const id = await mkUser("card-hidden", {
    job_title: "Delivery Lead",
    office_location: "Sofia",
    department: "Engineering",
    directory_hidden: true,
  });

  const c = await getUserCard(id);

  assert.equal(c?.jobTitle, null);
  assert.equal(c?.officeLocation, null);
  assert.equal(c?.department, null);
  assert.equal(c?.displayName, "User card-hidden");
  assert.equal(c?.email, "card-hidden@org");
});

test("getUserCard: an erased tombstone carries no directory information", { skip: !enabled }, async () => {
  const id = await mkUser("card-erased", { job_title: "Delivery Lead", department: "Engineering" });
  // Erasure itself scrubs these columns; the read side refuses them for a tombstone regardless.
  await pool.query(`update users set erased_at = now() where id = $1`, [id]);

  const c = await getUserCard(id);

  assert.equal(c?.jobTitle, null);
  assert.equal(c?.department, null);

  await pool.query(`update users set erased_at = null where id = $1`, [id]); // leave the fixture reusable
});

test("getUserCard: unknown and malformed ids resolve to null, not an error", { skip: !enabled }, async () => {
  assert.equal(await getUserCard("00000000-0000-0000-0000-000000000000"), null);
  assert.equal(await getUserCard("not-a-uuid"), null);
});

// --- Visits and New user (§66.4) ----------------------------------------------------------------
// These tests pin `visits_since` to a date long ago (so every window is a full 28 days unless the
// person's own first visit is recent) and restore it afterwards. Only cards read that key.

/** A card fixture with a first visit `firstSeenDaysAgo` days back (null = never visited). */
async function mkVisitor(
  oid: string,
  opts: { firstSeenDaysAgo: number | null; status?: "active" | "inactive"; hidden?: boolean },
): Promise<string> {
  const id = await mkUser(oid, { directory_hidden: opts.hidden ?? false });
  await pool.query(
    `update users set status = $2, erased_at = null,
            first_seen = case when $3::int is null then null else now() - make_interval(days => $3::int) end
      where id = $1`,
    [id, opts.status ?? "active", opts.firstSeenDaysAgo],
  );
  await pool.query(`delete from user_visit_days where user_id = $1`, [id]);
  return id;
}

/** Replace the person's visit days with the `n` most recent UTC days (today included). */
async function seedVisitDays(id: string, n: number): Promise<void> {
  await pool.query(`delete from user_visit_days where user_id = $1`, [id]);
  if (n > 0) {
    await pool.query(
      `insert into user_visit_days (user_id, day)
       select $1, (now() at time zone 'utc')::date - g from generate_series(0, $2::int - 1) g`,
      [id, n],
    );
  }
}

async function withVisitsSince(day: string, fn: () => Promise<void>): Promise<void> {
  const saved = (await pool.query<{ value: unknown }>(`select value from platform_settings where key = 'visits_since'`)).rows[0];
  const put = (value: string) =>
    pool.query(
      `insert into platform_settings (key, value) values ('visits_since', $1::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [value],
    );
  try {
    await put(JSON.stringify(day));
    await fn();
  } finally {
    if (saved) await put(JSON.stringify(saved.value));
    else await pool.query(`delete from platform_settings where key = 'visits_since'`);
  }
}

test("getUserCard: Visits buckets over a full 28-day window, and Never for someone never seen", { skip: !enabled }, async () => {
  await withVisitsSince("2020-01-01", async () => {
    const id = await mkVisitor("card-visits", { firstSeenDaysAgo: 100 });
    const freq = async (n: number) => {
      await seedVisitDays(id, n);
      return (await getUserCard(id))?.visitFrequency;
    };
    assert.equal(await freq(28), "daily");
    assert.equal(await freq(15), "daily");
    assert.equal(await freq(14), "weekly");
    assert.equal(await freq(4), "weekly");
    assert.equal(await freq(3), "monthly");
    assert.equal(await freq(1), "monthly");
    assert.equal(await freq(0), "rare");
    assert.equal((await getUserCard(id))?.newUser, false, "a 100-day-old first visit is not new");

    const never = await mkVisitor("card-visits-never", { firstSeenDaysAgo: null });
    const n = await getUserCard(never);
    assert.equal(n?.visitFrequency, "never");
    assert.equal(n?.newUser, false);
  });
});

test("getUserCard: a newcomer is New user from day one, with Visits hidden for the first week", { skip: !enabled }, async () => {
  await withVisitsSince("2020-01-01", async () => {
    const hire = await mkVisitor("card-newhire", { firstSeenDaysAgo: 2 });
    await seedVisitDays(hire, 3);
    const h = await getUserCard(hire);
    assert.equal(h?.visitFrequency, null, "3 observed days: the row stays hidden");
    assert.equal(h?.newUser, true);

    // Pro-rated once a week has been observed: 9 of 10 days reads daily.
    const week = await mkVisitor("card-newhire-wk", { firstSeenDaysAgo: 9 });
    await seedVisitDays(week, 9);
    assert.equal((await getUserCard(week))?.visitFrequency, "daily");

    assert.equal((await getUserCard(await mkVisitor("card-new-29", { firstSeenDaysAgo: 29 })))?.newUser, true);
    assert.equal((await getUserCard(await mkVisitor("card-new-31", { firstSeenDaysAgo: 31 })))?.newUser, false);

    // Inactive: Visits is computed as normal, but they are not a newcomer.
    const gone = await mkVisitor("card-new-inactive", { firstSeenDaysAgo: 10, status: "inactive" });
    await seedVisitDays(gone, 2);
    const g = await getUserCard(gone);
    assert.equal(g?.visitFrequency, "weekly"); // 2 of 11 days: 56 ≥ 44
    assert.equal(g?.newUser, false);
  });
});

test("getUserCard: the opt-out, a tombstone and the platform switch hide Visits and New user", { skip: !enabled }, async () => {
  await withVisitsSince("2020-01-01", async () => {
    // 20 days since the first visit and 5 visit days: visible, this reads "weekly" and New user.
    const hidden = await mkVisitor("card-visits-hidden", { firstSeenDaysAgo: 20, hidden: true });
    await seedVisitDays(hidden, 5);
    const h = await getUserCard(hidden);
    assert.equal(h?.visitFrequency, null);
    assert.equal(h?.newUser, false);

    const erased = await mkVisitor("card-visits-erased", { firstSeenDaysAgo: 20 });
    await seedVisitDays(erased, 5);
    await pool.query(`update users set erased_at = now() where id = $1`, [erased]);
    const e = await getUserCard(erased);
    assert.equal(e?.visitFrequency, null);
    assert.equal(e?.newUser, false);
    await pool.query(`update users set erased_at = null where id = $1`, [erased]); // leave the fixture reusable

    // The switch: off hides both for everyone, and the change is audited as a setting.
    const actor = (await pool.query<{ id: string }>(
      `insert into users (entra_object_id, email, display_name) values ('visits-audit-actor', 'visits-audit-actor@org', 'Visits audit actor')
       on conflict (entra_object_id) do update set email = excluded.email returning id`,
    )).rows[0]!.id;
    const visible = await mkVisitor("card-visits-switch", { firstSeenDaysAgo: 20 });
    await seedVisitDays(visible, 5);
    const on = await getUserCard(visible);
    assert.equal(on?.visitFrequency, "weekly"); // 5 of 21 days: 140 ≥ 84
    assert.equal(on?.newUser, true);
    try {
      await setVisitsEnabled(false, actor);
      const off = await getUserCard(visible);
      assert.equal(off?.visitFrequency, null);
      assert.equal(off?.newUser, false);
      const audit = (await pool.query<{ after: { visitsEnabled?: boolean } }>(
        `select after from audit_log where action = 'settings.updated' and target_id = 'visits_enabled' and actor_user_id = $1
          order by seq desc limit 1`,
        [actor],
      )).rows[0];
      assert.equal(audit?.after.visitsEnabled, false);
    } finally {
      await setVisitsEnabled(true, actor);
    }
    assert.equal((await getUserCard(visible))?.newUser, true, "switching back on is instant");
  });
});
