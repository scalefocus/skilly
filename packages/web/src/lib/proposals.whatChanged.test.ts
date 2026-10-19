// Unit tests for the per-version "What changed" note validation in verifySubmissionPayload
// (SKILLY_SPEC.md §8): required on a new VERSION (opts.targetSkillId set), omitted on a first
// version, length-capped, and normalized (trim → null). Apart from the §8 target visibility
// lookup (answered by a stub below), these paths never touch the DB — a stub pool that throws on
// anything else proves it — so this runs as a pure unit test.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { EffectiveAccess } from "@skilly/shared";
import { verifySubmissionPayload, TARGET_NOT_FOUND, type RevisionPayload } from "./proposals";
import { WHAT_CHANGED_MAX_LEN } from "@skilly/shared/proposal";

// A pool that answers ONLY the target-visibility lookup (an org skill) and fails loudly on any
// other query — the note/harness("generic") paths must not hit the DB.
const noDb = {
  query: async (sql: string) => {
    if (/from skills s where s\.id = \$1/.test(sql)) return { rows: [{ namespace_id: "ns-1", visibility: "org", shared_namespace_ids: [] }], rowCount: 1 };
    throw new Error("DB must not be queried in these cases");
  },
} as unknown as Pool;
const VIEWER: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map() };

function payload(whatChanged: string | null | undefined): RevisionPayload {
  return {
    metadata: {
      skillSlug: "demo", title: "Demo", description: "d", toolHarness: "generic",
      categories: [], usageExamples: null, whatChanged, visibility: "org",
    },
  };
}

test("a stale client's `tags` field is ignored silently and stripped from the payload (§10)", async () => {
  // Free-form tags were removed (migration 0068). Older browser tabs may still send the field: it
  // must neither 400 nor be persisted into the revision payload.
  const p = payload("Updated metadata");
  (p.metadata as unknown as Record<string, unknown>).tags = ["legacy", "tag"];
  const err = await verifySubmissionPayload(noDb, "u1", p, { targetSkillId: "skill-1", access: VIEWER });
  assert.equal(err, null, `tags must not cause a rejection, got: ${err}`);
  assert.equal("tags" in (p.metadata as unknown as Record<string, unknown>), false, "tags stripped from the payload");
});

test("new-version submission REQUIRES a non-empty What-changed note", async () => {
  const err = await verifySubmissionPayload(noDb, "u1", payload(""), { targetSkillId: "skill-1", access: VIEWER });
  assert.ok(err && /what changed/i.test(err), `expected a required-note error, got: ${err}`);
});

test("whitespace-only note is treated as empty on a new version (required)", async () => {
  const p = payload("   \n  ");
  const err = await verifySubmissionPayload(noDb, "u1", p, { targetSkillId: "skill-1", access: VIEWER });
  assert.ok(err && /what changed/i.test(err));
  assert.equal(p.metadata.whatChanged, null, "whitespace-only normalizes to null");
});

test("new-version submission with a note passes and the note is trimmed", async () => {
  const p = payload("  Fixed the parser  ");
  const err = await verifySubmissionPayload(noDb, "u1", p, { targetSkillId: "skill-1", access: VIEWER });
  assert.equal(err, null);
  assert.equal(p.metadata.whatChanged, "Fixed the parser");
});

test("new-SKILL submission does NOT require the note (first version)", async () => {
  const err = await verifySubmissionPayload(noDb, "u1", payload(undefined), {});
  assert.equal(err, null);
});

test("a note over the length cap is rejected", async () => {
  const p = payload("x".repeat(WHAT_CHANGED_MAX_LEN + 1));
  const err = await verifySubmissionPayload(noDb, "u1", p, { targetSkillId: "skill-1", access: VIEWER });
  assert.ok(err && /too long/i.test(err), `expected a length error, got: ${err}`);
});

test("a note exactly at the cap passes", async () => {
  const p = payload("x".repeat(WHAT_CHANGED_MAX_LEN));
  const err = await verifySubmissionPayload(noDb, "u1", p, { targetSkillId: "skill-1", access: VIEWER });
  assert.equal(err, null);
});

test("a new-version payload fails closed without the actor's access (§8 target visibility gate)", async () => {
  const err = await verifySubmissionPayload(noDb, "u1", payload("Fixed the parser"), { targetSkillId: "skill-1" });
  assert.equal(err, TARGET_NOT_FOUND);
});
