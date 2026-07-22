// Unit tests for the per-version "What changed" note validation in verifySubmissionPayload
// (SKILLY_SPEC.md §8): required on a new VERSION (opts.targetSkillId set), omitted on a first
// version, length-capped, and normalized (trim → null). These paths never touch the DB (a stub
// pool that throws proves it), so this runs as a pure unit test.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { verifySubmissionPayload, type RevisionPayload } from "./proposals";
import { WHAT_CHANGED_MAX_LEN } from "@skilly/shared/proposal";

// A pool that fails loudly if queried — the note/harness("generic") paths must not hit the DB.
const noDb = { query: async () => { throw new Error("DB must not be queried in these cases"); } } as unknown as Pool;

function payload(whatChanged: string | null | undefined): RevisionPayload {
  return {
    metadata: {
      skillSlug: "demo", title: "Demo", description: "d", toolHarness: "generic",
      categories: [], tags: [], usageExamples: null, whatChanged, visibility: "org",
    },
  };
}

test("new-version submission REQUIRES a non-empty What-changed note", async () => {
  const err = await verifySubmissionPayload(noDb, "u1", payload(""), { targetSkillId: "skill-1" });
  assert.ok(err && /what changed/i.test(err), `expected a required-note error, got: ${err}`);
});

test("whitespace-only note is treated as empty on a new version (required)", async () => {
  const p = payload("   \n  ");
  const err = await verifySubmissionPayload(noDb, "u1", p, { targetSkillId: "skill-1" });
  assert.ok(err && /what changed/i.test(err));
  assert.equal(p.metadata.whatChanged, null, "whitespace-only normalizes to null");
});

test("new-version submission with a note passes and the note is trimmed", async () => {
  const p = payload("  Fixed the parser  ");
  const err = await verifySubmissionPayload(noDb, "u1", p, { targetSkillId: "skill-1" });
  assert.equal(err, null);
  assert.equal(p.metadata.whatChanged, "Fixed the parser");
});

test("new-SKILL submission does NOT require the note (first version)", async () => {
  const err = await verifySubmissionPayload(noDb, "u1", payload(undefined), {});
  assert.equal(err, null);
});

test("a note over the length cap is rejected", async () => {
  const p = payload("x".repeat(WHAT_CHANGED_MAX_LEN + 1));
  const err = await verifySubmissionPayload(noDb, "u1", p, { targetSkillId: "skill-1" });
  assert.ok(err && /too long/i.test(err), `expected a length error, got: ${err}`);
});

test("a note exactly at the cap passes", async () => {
  const p = payload("x".repeat(WHAT_CHANGED_MAX_LEN));
  const err = await verifySubmissionPayload(noDb, "u1", p, { targetSkillId: "skill-1" });
  assert.equal(err, null);
});
