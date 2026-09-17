// Live-DB integration test for skill icons (§33). Gated by SKILLY_DB_E2E=1. Covers: normalize +
// content-addressed storage + dedupe (icons.ts), ownership enforcement (verifySubmissionPayload),
// and the accept-time sync onto `skills` — including the SET (not coalesce) remove semantics.
// Runs inside a transaction per test and rolls back.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import sharp from "sharp";
import { pool } from "./db";
import { ingestIcon, iconOwnedBy } from "./icons";
import { materializeVersion, verifySubmissionPayload, type RevisionPayload } from "./proposals";

const enabled = process.env.SKILLY_DB_E2E === "1";

after(async () => {
  if (enabled) await pool.end();
});

async function seed(client: PoolClient, key: string): Promise<{ ns: string; user: string; other: string }> {
  const ns = (await client.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ($1, $1, true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
    [`${key}-ns`],
  )).rows[0]!.id;
  const user = (await client.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ($1, $2, 'Sub')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
    [`${key}-sub`, `${key}@org`],
  )).rows[0]!.id;
  const other = (await client.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ($1, $2, 'Other')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
    [`${key}-other`, `${key}-other@org`],
  )).rows[0]!.id;
  return { ns, user, other };
}

async function png(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
}

test("ingestIcon: normalizes + stores content-addressed, dedupes identical bytes", { skip: !enabled }, async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { user } = await seed(client, "icodup");
    const bytes = await png(500, 500);
    const a = await ingestIcon(bytes, user, client);
    const b = await ingestIcon(bytes, user, client);
    assert.ok(a.ok && b.ok);
    if (a.ok && b.ok) assert.equal(a.sha256, b.sha256);
    const { rows } = await client.query(`select count(*)::int as n from skill_icons where sha256 = $1`, [a.ok ? a.sha256 : ""]);
    assert.equal(rows[0].n, 1);
  } finally {
    await client.query("rollback");
    client.release();
  }
});

test("iconOwnedBy: true for the uploader, false for anyone else", { skip: !enabled }, async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { user, other } = await seed(client, "icoby");
    const up = await ingestIcon(await png(300, 300), user, client);
    assert.ok(up.ok);
    const sha = up.ok ? up.sha256 : "";
    assert.equal(await iconOwnedBy(sha, user, client), true);
    assert.equal(await iconOwnedBy(sha, other, client), false);
  } finally {
    await client.query("rollback");
    client.release();
  }
});

test("verifySubmissionPayload: rejects an icon the caller didn't upload; accepts the target skill's current icon carried forward", { skip: !enabled }, async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { ns, user, other } = await seed(client, "icoown");

    const mine = await ingestIcon(await png(300, 300), user, client);
    assert.ok(mine.ok);
    const sha = mine.ok ? mine.sha256 : "";

    const payload: RevisionPayload = {
      metadata: { skillSlug: "icoown-skill", title: "T", description: "D", toolHarness: "generic", visibility: "org", iconSha256: sha },
      artifactObjectKey: "uploads/x/y.bundle",
    };
    // A caller who is NOT the uploader is rejected.
    const err = await verifySubmissionPayload(client, other, payload, {});
    assert.match(err ?? "", /icon does not belong to you/);
    // The uploader themselves passes the ownership check (other fields aside).
    const ok = await verifySubmissionPayload(client, user, { metadata: payload.metadata }, {});
    assert.equal(ok, null);

    // Materialize a skill with this icon, then confirm a DIFFERENT caller may carry the SAME
    // (now current) icon forward on a re-version, via the targetSkillId carve-out.
    const created = await materializeVersion(client, {
      targetNamespaceId: ns, targetSkillId: null, semver: "1.0.0", submittedBy: user,
      payload: { metadata: { ...payload.metadata, iconSha256: sha } },
    });
    const carried = await verifySubmissionPayload(client, other, { metadata: { ...payload.metadata, iconSha256: sha, whatChanged: "carried the icon forward" } }, { targetSkillId: created.skillId });
    assert.equal(carried, null);
  } finally {
    await client.query("rollback");
    client.release();
  }
});

test("materializeVersion: syncs icon on new-skill create, SETs (not coalesces) on re-version, remove clears explicitly", { skip: !enabled }, async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { ns, user } = await seed(client, "icosync");
    const icon1 = await ingestIcon(await png(300, 300), user, client);
    assert.ok(icon1.ok);
    const sha1 = icon1.ok ? icon1.sha256 : "";

    const created = await materializeVersion(client, {
      targetNamespaceId: ns, targetSkillId: null, semver: "1.0.0", submittedBy: user,
      payload: { metadata: { skillSlug: "icosync-skill", title: "T", description: "D", toolHarness: "generic", visibility: "org", iconSha256: sha1, iconSource: "upload" } },
    });
    let row = (await client.query(`select icon_sha256, icon_emoji, icon_source from skills where id = $1`, [created.skillId])).rows[0];
    assert.equal(row.icon_sha256, sha1);
    assert.equal(row.icon_source, "upload");

    // Re-version WITHOUT resending icon fields (undefined) leaves the icon untouched.
    await materializeVersion(client, {
      targetNamespaceId: ns, targetSkillId: created.skillId, semver: "1.1.0", submittedBy: user,
      payload: { metadata: { skillSlug: "icosync-skill", title: "T", description: "D", toolHarness: "generic", visibility: "org" } },
    });
    row = (await client.query(`select icon_sha256 from skills where id = $1`, [created.skillId])).rows[0];
    assert.equal(row.icon_sha256, sha1);

    // Re-version with an explicit null Removes it — a coalesce would have wrongly kept sha1.
    await materializeVersion(client, {
      targetNamespaceId: ns, targetSkillId: created.skillId, semver: "1.2.0", submittedBy: user,
      payload: { metadata: { skillSlug: "icosync-skill", title: "T", description: "D", toolHarness: "generic", visibility: "org", iconSha256: null, iconEmoji: null, iconSource: null } },
    });
    row = (await client.query(`select icon_sha256, icon_emoji from skills where id = $1`, [created.skillId])).rows[0];
    assert.equal(row.icon_sha256, null);
    assert.equal(row.icon_emoji, null);
  } finally {
    await client.query("rollback");
    client.release();
  }
});
