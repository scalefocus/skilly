import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMatchSlug, slugMatchClashes, slugClashMessage, slugExistsMessage, slugRejectReason } from "./slug-match.js";
import { findSlugMatches, type SlugMatchDb } from "./slug-match-db.js";

function fakeDb(rows: unknown[] = []): SlugMatchDb & { calls: { text: string; params: unknown[] }[] } {
  const calls: { text: string; params: unknown[] }[] = [];
  return {
    calls,
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return { rows };
    },
  };
}

const member = { isPlatformAdmin: false, namespaceRoles: new Map([["ns-1", "namespace_member" as const]]) };
const admin = { isPlatformAdmin: true, namespaceRoles: new Map() };

test("normalizeMatchSlug trims and lowercases", () => {
  assert.equal(normalizeMatchSlug("  PDF-Tools "), "pdf-tools");
  assert.equal(normalizeMatchSlug(null), "");
  assert.equal(normalizeMatchSlug(undefined), "");
  assert.equal(normalizeMatchSlug({}), "", "a non-string never throws");
});

test("a clash needs a supplied source of the other type", () => {
  assert.equal(slugMatchClashes({ type: "pointer" }, null), false);
  assert.equal(slugMatchClashes({ type: "pointer" }, "pointer"), false);
  assert.equal(slugMatchClashes({ type: "pointer" }, "hosted"), true);
  assert.equal(slugMatchClashes({ type: "hosted" }, "pointer"), true);
});

test("clash guidance names the skill and its type", () => {
  assert.equal(
    slugClashMessage({ namespaceSlug: "data", slug: "pdf-tools", type: "pointer" }),
    "data/pdf-tools exists as a pointer skill — propose a new version with a pointer source, or choose a different slug.",
  );
});

test("slugExistsMessage covers one and several matches", () => {
  assert.equal(slugExistsMessage([]), "");
  assert.match(slugExistsMessage([{ namespaceSlug: "data", slug: "pdf-tools" }]), /already exists as data\/pdf-tools/);
  const many = slugExistsMessage([{ namespaceSlug: "data", slug: "pdf-tools" }, { namespaceSlug: "global", slug: "pdf-tools" }]);
  assert.match(many, /several namespaces \(data\/pdf-tools, global\/pdf-tools\)/);
});

test("an empty slug runs no query", async () => {
  const db = fakeDb();
  assert.deepEqual(await findSlugMatches(db, member, "  "), []);
  assert.equal(db.calls.length, 0);
});

test("a non-admin query is active-only, case-insensitive and visibility-filtered", async () => {
  const db = fakeDb();
  await findSlugMatches(db, member, "PDF-Tools");
  const { text, params } = db.calls[0]!;
  assert.equal(params[0], "pdf-tools");
  assert.match(text, /lower\(s\.slug\) = \$1/);
  assert.match(text, /s\.status = 'active'/);
  assert.match(text, /s\.visibility = 'org'/); // the shared predicate (invariant #3)
  assert.doesNotMatch(text, /deprecated_at is null/); // deprecated skills still match (§45)
});

test("a platform admin needs no visibility predicate", async () => {
  const db = fakeDb();
  await findSlugMatches(db, admin, "pdf-tools");
  assert.doesNotMatch(db.calls[0]!.text, /visibility = 'org'/);
});

test("excludeSkillId is bound as a parameter", async () => {
  const db = fakeDb();
  await findSlugMatches(db, admin, "pdf-tools", { excludeSkillId: "skill-9" });
  const { text, params } = db.calls[0]!;
  assert.equal(params.at(-1), "skill-9");
  assert.match(text, new RegExp(`s\\.id <> \\$${params.length}`));
});

test("rows map to SlugMatch", async () => {
  const db = fakeDb([
    { id: "a", namespace_slug: "data", slug: "pdf-tools", title: "PDF Tools", type: "pointer", deprecated: true },
    { id: "b", namespace_slug: "global", slug: "pdf-tools", title: "PDF", type: "hosted", deprecated: false },
  ]);
  assert.deepEqual(await findSlugMatches(db, admin, "pdf-tools"), [
    { skillId: "a", namespaceSlug: "data", slug: "pdf-tools", title: "PDF Tools", type: "pointer", deprecated: true },
    { skillId: "b", namespaceSlug: "global", slug: "pdf-tools", title: "PDF", type: "hosted", deprecated: false },
  ]);
});

test("slugRejectReason names nothing when the reviewer can't see the match", () => {
  assert.doesNotMatch(slugRejectReason([]), /\/skills\//);
});

test("slugRejectReason links every match", () => {
  assert.match(slugRejectReason([{ namespaceSlug: "data", slug: "pdf-tools" }]), /^A skill with this slug already exists: \/skills\/data\/pdf-tools — /);
  assert.match(
    slugRejectReason([{ namespaceSlug: "data", slug: "pdf-tools" }, { namespaceSlug: "global", slug: "pdf-tools" }]),
    /\/skills\/data\/pdf-tools, \/skills\/global\/pdf-tools/,
  );
});
