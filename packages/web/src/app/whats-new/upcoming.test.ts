// Unit tests for the What's new "Coming soon" list (SKILLY_SPEC.md §23 "Coming soon"): the real
// SKILLY_SPEC.md and UPCOMING must be in step, the checker catches every failure case, and
// `upcomingFor` filters by audience. Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UPCOMING, upcomingFor, type UpcomingEntry } from "./upcoming";
import { parseGapMarkers, upcomingProblems } from "./upcomingSync";

const SPEC = readFileSync(fileURLToPath(new URL("../../../../../SKILLY_SPEC.md", import.meta.url)), "utf8");

const entry = (ids: string[], over: Partial<UpcomingEntry> = {}): UpcomingEntry => ({
  ids,
  key: ids.map((id) => id.toLowerCase()).join("-") || "no-ids",
  title: "Team channels",
  teaser: "Announcements in your team's channel.",
  audience: "everyone",
  ...over,
});

test("coming soon: SKILLY_SPEC.md's open new-feature markers and UPCOMING are in step", () => {
  assert.deepEqual(upcomingProblems(SPEC, UPCOMING), []);
});

test("coming soon: placeholders and quoted example ids are not markers", () => {
  assert.deepEqual(parseGapMarkers("> starts **`⚠ GAP-nn · new feature`** e.g. `[\"GAP-3\", \"GAP-4\"]`"), []);
  assert.deepEqual(parseGapMarkers("> **⚠ GAP-7 · new feature** — x\n> **⚠ GAP-8 · code fix** — y"), [
    { id: "GAP-7", kind: "new feature" },
    { id: "GAP-8", kind: "code fix" },
  ]);
});

test("coming soon: in step when every open new-feature marker has exactly one entry", () => {
  const spec = "⚠ GAP-1 · new feature\n⚠ GAP-2 · new feature\n⚠ GAP-3 · code fix";
  assert.deepEqual(upcomingProblems(spec, [entry(["GAP-1", "GAP-2"])]), []);
  assert.deepEqual(upcomingProblems("no markers", []), []);
});

test("coming soon: catches every failure case", () => {
  const spec = "⚠ GAP-1 · new feature\n⚠ GAP-2 · code fix";
  const has = (problems: string[], re: RegExp) => assert.ok(problems.some((p) => re.test(p)), problems.join("\n"));

  has(upcomingProblems(spec, []), /GAP-1 is an open new-feature marker with no UPCOMING entry/);
  has(upcomingProblems(spec, [entry(["GAP-1"]), entry(["GAP-9"])]), /lists GAP-9, which is not an open/);
  has(upcomingProblems(spec, [entry(["GAP-1", "GAP-2"])]), /lists GAP-2, which is not an open/); // code fix ≠ teaser
  has(upcomingProblems(spec, [entry(["GAP-1"]), entry(["GAP-1"])]), /GAP-1 belongs to 2 UPCOMING entries/);
  has(upcomingProblems(spec, [entry(["GAP-1"]), entry([])]), /has no ids/);
  has(upcomingProblems(`${spec}\n⚠ GAP-1 · new feature`, [entry(["GAP-1"])]), /GAP-1 appears in more than one marker/);
  has(upcomingProblems(spec, [entry(["GAP-1"], { title: " " })]), /empty title/);
  has(upcomingProblems(spec, [entry(["GAP-1"], { teaser: "" })]), /empty teaser/);
  has(upcomingProblems(spec, [entry(["GAP-1"], { title: "See §12" })]), /title mentions a spec section/);
  has(upcomingProblems(spec, [entry(["GAP-1"], { teaser: "Closes GAP-1." })]), /teaser mentions a spec section/);
  // §60.3 vote keys.
  has(upcomingProblems(spec, [entry(["GAP-1"], { key: "" })]), /missing or malformed key/);
  has(upcomingProblems(spec, [entry(["GAP-1"], { key: "Team_Channels" })]), /missing or malformed key/);
  has(upcomingProblems(`${spec}\n⚠ GAP-3 · new feature`, [entry(["GAP-1"], { key: "same" }), entry(["GAP-3"], { key: "same" })]), /reuses the key "same"/);
});

test("coming soon: upcomingFor filters by audience and keeps order", () => {
  const list = [
    entry(["GAP-1"], { title: "a", audience: "platform_admin" }),
    entry(["GAP-2"], { title: "b", audience: "everyone" }),
    entry(["GAP-3"], { title: "c", audience: "admins" }),
  ];
  const titles = (v: { isPlatformAdmin: boolean; administersNamespace: boolean }) => upcomingFor(list, v).map((e) => e.title);
  assert.deepEqual(titles({ isPlatformAdmin: true, administersNamespace: false }), ["a", "b", "c"]);
  assert.deepEqual(titles({ isPlatformAdmin: true, administersNamespace: true }), ["a", "b", "c"]);
  assert.deepEqual(titles({ isPlatformAdmin: false, administersNamespace: true }), ["b", "c"]);
  assert.deepEqual(titles({ isPlatformAdmin: false, administersNamespace: false }), ["b"]);
});
