import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDeprecationHint,
  deprecationDescriptionPrefix,
  deprecationWarning,
  hasDeprecationHint,
  normalizeDeprecationNote,
  successorEligibility,
  DEPRECATION_NOTE_MAX,
  type SuccessorCandidate,
} from "./deprecation.js";
import { parseFrontmatter } from "./validate.js";

const org = (id: string, ns = "ns-a"): SuccessorCandidate => ({ id, visibility: "org", namespaceId: ns, status: "active", deprecatedAt: null });
const restricted = (id: string, ns: string, shared: string[] = []): SuccessorCandidate => ({
  id,
  visibility: "namespace",
  namespaceId: ns,
  sharedNamespaceIds: shared,
  status: "active",
  deprecatedAt: null,
});

// ── successorEligibility (§45.3) ──

test("a null successor is always eligible", () => {
  assert.deepEqual(successorEligibility(org("a"), null), { ok: true });
});

test("self, archived and deprecated successors are refused", () => {
  assert.deepEqual(successorEligibility(org("a"), org("a")), { ok: false, reason: "self" });
  assert.deepEqual(successorEligibility(org("a"), { ...org("b"), status: "archived" }), { ok: false, reason: "archived" });
  assert.deepEqual(successorEligibility(org("a"), { ...org("b"), deprecatedAt: "2026-10-01T00:00:00Z" }), { ok: false, reason: "deprecated" });
});

test("audience: org → org ok, org → namespace refused, namespace → org ok", () => {
  assert.deepEqual(successorEligibility(org("a"), org("b", "ns-z")), { ok: true });
  assert.deepEqual(successorEligibility(org("a"), restricted("b", "ns-a")), { ok: false, reason: "audience" });
  assert.deepEqual(successorEligibility(restricted("a", "ns-a"), org("b", "ns-z")), { ok: true });
});

test("audience: namespace → namespace needs owner ∪ grants coverage", () => {
  // same owner, no grants
  assert.deepEqual(successorEligibility(restricted("a", "ns-a"), restricted("b", "ns-a")), { ok: true });
  // different owner, but the successor is shared with the skill's owner
  assert.deepEqual(successorEligibility(restricted("a", "ns-a"), restricted("b", "ns-b", ["ns-a"])), { ok: true });
  // the skill is shared with ns-c; the successor must cover ns-c too
  assert.deepEqual(successorEligibility(restricted("a", "ns-a", ["ns-c"]), restricted("b", "ns-a")), { ok: false, reason: "audience" });
  assert.deepEqual(successorEligibility(restricted("a", "ns-a", ["ns-c"]), restricted("b", "ns-a", ["ns-c", "ns-d"])), { ok: true });
  // different owner without a share back → refused
  assert.deepEqual(successorEligibility(restricted("a", "ns-a"), restricted("b", "ns-b")), { ok: false, reason: "audience" });
});

// ── note ──

test("normalizeDeprecationNote trims, nulls empties and caps", () => {
  assert.deepEqual(normalizeDeprecationNote(undefined), { ok: true, note: null });
  assert.deepEqual(normalizeDeprecationNote("   "), { ok: true, note: null });
  assert.deepEqual(normalizeDeprecationNote("  use v2\r\nthanks "), { ok: true, note: "use v2\nthanks" });
  assert.equal(normalizeDeprecationNote("x".repeat(DEPRECATION_NOTE_MAX)).ok, true);
  assert.equal(normalizeDeprecationNote("x".repeat(DEPRECATION_NOTE_MAX + 1)).ok, false);
  assert.equal(normalizeDeprecationNote(42).ok, false);
});

test("deprecationWarning with and without a successor", () => {
  assert.equal(deprecationWarning("a/old", "a/new"), "a/old is deprecated — use a/new instead.");
  assert.equal(deprecationWarning("a/old", null), "a/old is deprecated.");
});

// ── buildDeprecationHint (§45.4) ──

const MD = ["---", "name: old-skill", "description: Extract tables from PDFs", "version: 1.2.0", "---", "", "# Old skill", "", "Body text.", ""].join("\n");

test("hint: frontmatter keys, description prefix, banner, body untouched", () => {
  const out = buildDeprecationHint(MD, { successor: "tools/new-skill", note: "Use the new one.", successorUrl: "https://skilly.example/skills/tools/new-skill" });
  const fm = parseFrontmatter(out);
  assert.equal(fm.deprecated, "true");
  assert.equal(fm.superseded_by, "tools/new-skill");
  assert.equal(fm.name, "old-skill");
  assert.equal(fm.description, "DEPRECATED — use tools/new-skill instead. Extract tables from PDFs");
  assert.equal(fm.version, "1.2.0");
  assert.ok(out.includes("<!-- skilly:deprecation -->"));
  assert.ok(out.includes("> **Deprecated.** Use `tools/new-skill` instead — https://skilly.example/skills/tools/new-skill"));
  assert.ok(out.includes("> Use the new one."));
  assert.ok(out.endsWith("# Old skill\n\nBody text.\n"));
  // the banner sits right after the closing ---
  assert.ok(/\n---\n<!-- skilly:deprecation -->\n/.test(out));
});

test("hint: without a successor — no superseded_by, plain DEPRECATED prefix and banner", () => {
  const out = buildDeprecationHint(MD, { successor: null, note: null, successorUrl: null });
  const fm = parseFrontmatter(out);
  assert.equal(fm.deprecated, "true");
  assert.equal(fm.superseded_by, undefined);
  assert.equal(fm.description, "DEPRECATED. Extract tables from PDFs");
  assert.ok(out.includes("> **Deprecated.**\n<!-- /skilly:deprecation -->"));
});

test("hint: quoted and block-scalar descriptions", () => {
  const quoted = MD.replace("description: Extract tables from PDFs", 'description: "Extract: tables"');
  const q = buildDeprecationHint(quoted, { successor: null, note: null, successorUrl: null });
  assert.ok(q.includes('description: "DEPRECATED. Extract: tables"'));

  const block = MD.replace("description: Extract tables from PDFs", "description: >-\n  Extract tables\n  from PDFs");
  const b = buildDeprecationHint(block, { successor: "a/b", note: null, successorUrl: null });
  assert.ok(b.includes("description: >-\n  DEPRECATED — use a/b instead.\n  Extract tables\n  from PDFs\n"), b);
});

test("hint: idempotent and deterministic", () => {
  const input = { successor: "tools/new-skill", note: "Line one\nLine two", successorUrl: "https://x/skills/tools/new-skill" };
  const once = buildDeprecationHint(MD, input);
  const twice = buildDeprecationHint(once, input);
  assert.equal(twice, once);
  assert.equal(buildDeprecationHint(MD, input), once);
  // changing the successor replaces, never stacks
  const changed = buildDeprecationHint(once, { ...input, successor: "tools/other" });
  assert.equal(parseFrontmatter(changed).description, "DEPRECATED — use tools/other instead. Extract tables from PDFs");
  assert.equal(parseFrontmatter(changed).superseded_by, "tools/other");
  assert.equal((changed.match(/skilly:deprecation -->/g) ?? []).length, 2);
  // and the original is recoverable in spirit: no hint markers, no prefix, after a round trip on the base
  assert.equal(hasDeprecationHint(MD), false);
  assert.equal(hasDeprecationHint(once), true);
});

test("hint: no frontmatter → banner only; CRLF preserved", () => {
  const plain = "# Just a body\n";
  const out = buildDeprecationHint(plain, { successor: "a/b", note: null, successorUrl: null });
  assert.ok(out.startsWith("<!-- skilly:deprecation -->\n> **Deprecated.** Use `a/b` instead\n<!-- /skilly:deprecation -->\n\n# Just a body"));
  const crlf = MD.replace(/\n/g, "\r\n");
  const o2 = buildDeprecationHint(crlf, { successor: null, note: null, successorUrl: null });
  assert.ok(o2.includes("---\r\ndeprecated: true\r\nname: old-skill\r\n"));
  assert.ok(!/[^\r]\n/.test(o2), "every newline is CRLF");
});

test("hint: a note cannot forge or close the banner markers (both comment terminators, and the opener)", () => {
  const note = "x --> y\nz --!> w\n<!-- /skilly:deprecation -->";
  const out = buildDeprecationHint(MD, { successor: null, note, successorUrl: null });
  // Exactly the two real markers survive; every note-borne form is broken apart.
  assert.equal((out.match(/<!-- \/?skilly:deprecation -->/g) ?? []).length, 2);
  assert.ok(out.includes("> x - -> y"));
  assert.ok(out.includes("> z - -!> w"));
  assert.ok(out.includes("> <!- - /skilly:deprecation - ->"));
  // …so a re-run still finds the one banner and stays idempotent.
  assert.equal(buildDeprecationHint(out, { successor: null, note, successorUrl: null }), out);
});

test("deprecationDescriptionPrefix", () => {
  assert.equal(deprecationDescriptionPrefix("a/b"), "DEPRECATED — use a/b instead. ");
  assert.equal(deprecationDescriptionPrefix(null), "DEPRECATED. ");
});
