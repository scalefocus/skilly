// Live-DB integration test for "Propose an existing skill" (SKILLY_SPEC.md §26) — the immediate,
// no-review fulfilment path. Gated by SKILLY_DB_E2E=1. Covers: happy path (state flip, credit,
// notification, audit `via`), server-side rejection of a namespace-restricted skill even though
// the row exists, the atomic "still open" guard (409 once already fulfilled), and self-fulfilment
// (silent — no notification).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { fulfilWithExistingSkill } from "./requests";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";

after(async () => {
  if (enabled) await pool.end();
});

async function mkUser(key: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ($1, $2, $1)
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
    [key, `${key}@org`],
  )).rows[0]!.id;
}

async function mkSkill(ns: string, slug: string, visibility: "org" | "namespace"): Promise<string> {
  return (await pool.query<{ id: string }>(
    `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status)
     values ($1,$2,$2,'d','claude','hosted',$3,'active')
     on conflict (namespace_id, slug) do update set visibility = excluded.visibility, status = 'active' returning id`,
    [ns, slug, visibility],
  )).rows[0]!.id;
}

async function mkRequest(requesterUserId: string, title: string): Promise<string> {
  return (await pool.query<{ id: string }>(
    `insert into skill_requests (requester_user_id, title, description) values ($1, $2, 'd') returning id`,
    [requesterUserId, title],
  )).rows[0]!.id;
}

test("fulfilWithExistingSkill: happy path credits the linker and notifies the requester", { skip: !enabled }, async () => {
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ('reqfx-ns','ReqFX NS', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  )).rows[0]!.id;
  const requester = await mkUser("reqfx-requester");
  const linker = await mkUser("reqfx-linker");
  const skill = await mkSkill(ns, "reqfx-existing", "org");
  const reqId = await mkRequest(requester, "reqfx wish");

  try {
    const result = await fulfilWithExistingSkill(linker, reqId, "reqfx-ns", "reqfx-existing");
    assert.deepEqual(result, { ok: true });

    const { rows: reqRows } = await pool.query<{ state: string; fulfilled_skill_id: string; fulfilled_by_user_id: string }>(
      `select state, fulfilled_skill_id, fulfilled_by_user_id from skill_requests where id = $1`,
      [reqId],
    );
    assert.equal(reqRows[0]!.state, "fulfilled");
    assert.equal(reqRows[0]!.fulfilled_skill_id, skill);
    assert.equal(reqRows[0]!.fulfilled_by_user_id, linker);

    const { rows: notif } = await pool.query<{ payload: { requestId: string; byName: string | null } }>(
      `select payload from notifications where user_id = $1 and type = 'request.fulfilled' order by created_at desc limit 1`,
      [requester],
    );
    assert.ok(notif[0], "requester was notified");
    assert.equal(notif[0]!.payload.requestId, reqId);

    const { rows: audit } = await pool.query<{ after: { via: string; skillId: string } }>(
      `select after from audit_log where target_type = 'skill_request' and target_id = $1 and action = 'request.fulfilled' order by created_at desc limit 1`,
      [reqId],
    );
    assert.equal(audit[0]!.after.via, "existing_skill");
    assert.equal(audit[0]!.after.skillId, skill);
  } finally {
    // audit_log is append-only (invariant #5) — never deleted, only the request/notification rows.
    await pool.query(`delete from notifications where user_id = $1`, [requester]);
    await pool.query(`delete from skill_requests where id = $1`, [reqId]);
    await pool.query(`delete from skills where id = $1`, [skill]);
  }
});

test("fulfilWithExistingSkill: rejects a namespace-restricted skill (422), request stays open", { skip: !enabled }, async () => {
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ('reqfx-ns','ReqFX NS', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  )).rows[0]!.id;
  const requester = await mkUser("reqfx-requester2");
  const linker = await mkUser("reqfx-linker2");
  const skill = await mkSkill(ns, "reqfx-restricted", "namespace");
  const reqId = await mkRequest(requester, "reqfx wish 2");

  try {
    const result = await fulfilWithExistingSkill(linker, reqId, "reqfx-ns", "reqfx-restricted");
    assert.equal("error" in result && result.status, 422);

    const { rows } = await pool.query<{ state: string }>(`select state from skill_requests where id = $1`, [reqId]);
    assert.equal(rows[0]!.state, "open", "namespace-restricted skill must not fulfil the request");
  } finally {
    await pool.query(`delete from skill_requests where id = $1`, [reqId]);
    await pool.query(`delete from skills where id = $1`, [skill]);
  }
});

test("fulfilWithExistingSkill: 409s once the request is no longer open (race guard)", { skip: !enabled }, async () => {
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ('reqfx-ns','ReqFX NS', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  )).rows[0]!.id;
  const requester = await mkUser("reqfx-requester3");
  const linker = await mkUser("reqfx-linker3");
  const skill = await mkSkill(ns, "reqfx-existing3", "org");
  const reqId = await mkRequest(requester, "reqfx wish 3");
  await pool.query(`update skill_requests set state = 'withdrawn' where id = $1`, [reqId]);

  try {
    const result = await fulfilWithExistingSkill(linker, reqId, "reqfx-ns", "reqfx-existing3");
    assert.equal("error" in result && result.status, 409);
  } finally {
    await pool.query(`delete from skill_requests where id = $1`, [reqId]);
    await pool.query(`delete from skills where id = $1`, [skill]);
  }
});

test("fulfilWithExistingSkill: self-fulfilment is silent (no notification)", { skip: !enabled }, async () => {
  const ns = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ('reqfx-ns','ReqFX NS', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
  )).rows[0]!.id;
  const requester = await mkUser("reqfx-requester4");
  const skill = await mkSkill(ns, "reqfx-existing4", "org");
  const reqId = await mkRequest(requester, "reqfx wish 4");

  try {
    const result = await fulfilWithExistingSkill(requester, reqId, "reqfx-ns", "reqfx-existing4");
    assert.deepEqual(result, { ok: true });

    const { rows } = await pool.query<{ state: string }>(`select state from skill_requests where id = $1`, [reqId]);
    assert.equal(rows[0]!.state, "fulfilled");

    const { rows: notif } = await pool.query(
      `select 1 from notifications where user_id = $1 and type = 'request.fulfilled'`,
      [requester],
    );
    assert.equal(notif.length, 0, "self-fulfilment sends no notification");
  } finally {
    await pool.query(`delete from skill_requests where id = $1`, [reqId]);
    await pool.query(`delete from skills where id = $1`, [skill]);
  }
});
