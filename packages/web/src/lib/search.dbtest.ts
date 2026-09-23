// Live-DB integration test for the §34 full-text search engine (SKILLY_SPEC.md §34.16). Gated by
// SKILLY_DB_E2E=1; needs every migration through 0077. Builds an isolated fixture namespace and
// exercises the real engine: stemming, prefix, substring and typo tiers, the match-quality ranking
// (incl. the body-noise case), the any-word fallback, exclusions, synonyms, category names, the
// indexed-version rules, the search-language switch, visibility negatives (incl. the fallback-mode
// oracle), dropdown = catalog, web = worker, and the admin library's validation + audit.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseSearchQuery, prepareSearch, type EffectiveAccess } from "@skilly/shared";
import { searchCatalog, suggestSkillsResult } from "./catalog";
import {
  createSynonymGroup,
  updateSynonymGroup,
  deleteSynonymGroup,
  listSynonymGroups,
  setSearchLanguage,
  getSearchIndexStatus,
  retryFailedSearchIndex,
  SearchAdminError,
} from "./searchAdmin";
import { pool } from "./db";

const enabled = process.env.SKILLY_DB_E2E === "1";
const NS = "fts-dbtest";
const TOKEN = "zqfixtoken"; // in every fixture description — isolates the un-namespaced queries
const SYNONYM_TERMS = ["florp", "zargle", "wibble wobble", "wbw", "quagga", "zebra", "slide", "deckz", "slides", "keynotez"];
const CATEGORIES = ["zobservability", "zebracat"];

let nsId = "";
let adminUserId = "";
let originalLanguage: unknown = undefined;
const ids: Record<string, string> = {};
const versionIds: Record<string, string> = {};

const admin: EffectiveAccess = { isPlatformAdmin: true, namespaceRoles: new Map() };
const outsider: EffectiveAccess = { isPlatformAdmin: false, namespaceRoles: new Map() };
let insider: EffectiveAccess = outsider;

async function wipe(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    // The immutability guard forbids version deletes unless explicitly allowed (§7).
    await c.query("set local skilly.allow_version_delete = 'on'");
    await c.query(`delete from skills where namespace_id in (select id from namespaces where slug = $1)`, [NS]);
    await c.query("commit");
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
  await pool.query(`delete from search_synonym_groups where terms && $1::text[]`, [SYNONYM_TERMS]);
  await pool.query(`delete from categories where name = any($1::text[])`, [CATEGORIES]);
}

async function setLanguage(value: unknown): Promise<void> {
  if (value === undefined) await pool.query(`delete from platform_settings where key = 'search_language'`);
  else {
    await pool.query(
      `insert into platform_settings (key, value, updated_by, updated_at) values ('search_language', $1::jsonb, $2, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [JSON.stringify(value), adminUserId],
    );
  }
  // What the worker's reindex job does (§34.9), scoped to the fixture + the synonym groups.
  await pool.query(`update skills set search_lang = null where namespace_id = $1`, [nsId]);
  await pool.query(`update search_synonym_groups set terms = terms where normalized_lang is distinct from skilly_search_config()::text`);
}

interface Fixture {
  slug: string;
  title: string;
  description: string;
  installs: number;
  visibility?: "org" | "namespace";
  categories?: string[];
  versions?: { semver: string; body?: string; usage?: string }[];
}

async function addVersion(skillId: string, v: { semver: string; body?: string; usage?: string }): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into skill_versions (skill_id, semver, is_prerelease, status, usage_examples, artifact_object_key)
     values ($1, $2, $3, 'active', $4, $5) returning id`,
    [skillId, v.semver, v.semver.includes("-"), v.usage ?? null, `fixture/${skillId}/${v.semver}`],
  );
  const id = rows[0]!.id;
  // The trigger created the `pending` extraction row; fill it the way the worker would.
  if (v.body !== undefined) await pool.query(`update skill_version_search set body_text = $2, status = 'indexed' where skill_version_id = $1`, [id, v.body]);
  return id;
}

async function addCategory(skillId: string, name: string): Promise<void> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into categories (name, slug) values ($1, $1) on conflict (name) do update set name = excluded.name returning id`,
    [name],
  );
  await pool.query(`insert into skill_categories (skill_id, category_id) values ($1, $2) on conflict do nothing`, [skillId, rows[0]!.id]);
}

const FIXTURES: Fixture[] = [
  { slug: "pptgen", title: "PowerPoint Generator", description: `Turns markdown notes into slide decks. ${TOKEN}`, installs: 5 },
  { slug: "pdf-tables", title: "PDF Table Extractor", description: `Extract tables from PDF files into CSV. ${TOKEN}`, installs: 1 },
  { slug: "doc-converter", title: "Document Converter", description: `Reads PDF tables and saves them. ${TOKEN}`, installs: 50 },
  {
    slug: "doc-helper", title: "Document Helper", description: `General document utilities. ${TOKEN}`, installs: 100,
    versions: [{ semver: "1.0.0", body: "# Helper\n\nThis helper can open a pdf and summarise the tables inside it. More pdf tables." }],
  },
  { slug: "pg-migrate", title: "Schema Migrations", description: `PostgreSQL migrations made easy. ${TOKEN}`, installs: 3 },
  { slug: "zargle-kit", title: "Zargle Kit", description: `Handy things. ${TOKEN}`, installs: 7 },
  { slug: "florp-tool", title: "Florp Tool", description: `Useful stuff. ${TOKEN}`, installs: 8 },
  { slug: "wbw-skill", title: "WBW Helper", description: `Handles the work. ${TOKEN}`, installs: 9 },
  { slug: "trace-kit", title: "Tracing Kit", description: `OpenTelemetry helpers. ${TOKEN}`, installs: 11, categories: ["zobservability"] },
  {
    slug: "ver-skill", title: "Versioned Thing", description: TOKEN, installs: 12,
    versions: [
      { semver: "1.0.0", body: "alphaword" },
      { semver: "1.1.0", body: "gammaword", usage: "usagegamma" },
      { semver: "2.0.0-beta.1", body: "epsilonword" },
    ],
  },
  { slug: "beta-skill", title: "Beta Thing", description: TOKEN, installs: 13, versions: [{ semver: "0.1.0-beta.1", body: "zetaword" }] },
  {
    slug: "rz-secret", title: "Zebra Secret", description: `zebra ${TOKEN}`, installs: 14, visibility: "namespace",
    categories: ["zebracat"], versions: [{ semver: "1.0.0", body: "zebracorn playbook" }],
  },
  { slug: "bau-plan", title: "Bauplan", description: `Häuser bauen ${TOKEN}`, installs: 15 },
];

before(async () => {
  if (!enabled) return;
  const { rows: lang } = await pool.query<{ value: unknown }>(`select value from platform_settings where key = 'search_language'`);
  originalLanguage = lang[0]?.value;
  adminUserId = (await pool.query<{ id: string }>(
    `insert into users (entra_object_id, email, display_name) values ('fts-admin', 'fts-admin@org', 'FTS Admin')
     on conflict (entra_object_id) do update set email = excluded.email returning id`,
  )).rows[0]!.id;
  await wipe();
  nsId = (await pool.query<{ id: string }>(
    `insert into namespaces (slug, display_name, require_review) values ($1, 'FTS test', true)
     on conflict (slug) do update set display_name = excluded.display_name returning id`,
    [NS],
  )).rows[0]!.id;
  await setLanguage("english");
  insider = { isPlatformAdmin: false, namespaceRoles: new Map([[nsId, "namespace_member"]]) };
  for (const f of FIXTURES) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into skills (namespace_id, slug, title, description, tool_harness, type, visibility, status, install_count)
       values ($1, $2, $3, $4, 'generic', 'hosted', $5, 'active', $6) returning id`,
      [nsId, f.slug, f.title, f.description, f.visibility ?? "org", f.installs],
    );
    ids[f.slug] = rows[0]!.id;
    for (const c of f.categories ?? []) await addCategory(rows[0]!.id, c);
    for (const v of f.versions ?? []) versionIds[`${f.slug}@${v.semver}`] = await addVersion(rows[0]!.id, v);
  }
  await createSynonymGroup("florp, zargle", adminUserId);
  await createSynonymGroup(["wibble wobble", "wbw"], adminUserId);
  await createSynonymGroup("quagga, zebra", adminUserId);
});

after(async () => {
  if (!enabled) return;
  try {
    await wipe();
    await setLanguage(originalLanguage);
  } finally {
    await pool.end();
  }
});

const search = (access: EffectiveAccess, q: string, extra: Parameters<typeof searchCatalog>[1] = {}) =>
  searchCatalog(access, { q, namespaceSlug: NS, limit: 100, ...extra });
const slugs = async (access: EffectiveAccess, q: string, extra: Parameters<typeof searchCatalog>[1] = {}) =>
  (await search(access, q, extra)).skills.map((s) => s.skillSlug);
/** The fixture slugs from `xs`, in the order the result listed them. */
const only = (xs: string[], keep: string[]) => xs.filter((x) => keep.includes(x));

// ── Matching (§34.4 / §34.5) ──────────────────────────────────────────────────────────────────

test("stemming: 'extracting tables' finds a skill that says 'Extract tables'", { skip: !enabled }, async () => {
  const r = await search(admin, "extracting tables");
  assert.ok(r.skills.some((s) => s.skillSlug === "pdf-tables"));
  assert.equal(r.matchMode, "all");
});

test("last-word prefix: 'powerpo' finds PowerPoint, ranked first", { skip: !enabled }, async () => {
  assert.equal((await slugs(admin, "powerpo"))[0], "pptgen");
});

test("substring tier: 'sql' still finds a skill described as 'PostgreSQL migrations'", { skip: !enabled }, async () => {
  assert.ok((await slugs(admin, "sql")).includes("pg-migrate"));
});

test("typo tier: 'powerpiont' finds 'PowerPoint Generator'", { skip: !enabled }, async () => {
  assert.ok((await slugs(admin, "powerpiont")).includes("pptgen"));
});

test("tiers: name › description › body beats popularity (the body-noise case)", { skip: !enabled }, async () => {
  // installs: pdf-tables 1, doc-converter 50, doc-helper 100 — relevance still wins. (Slugs are
  // indexed with the title at weight A, so the fixture slugs avoid the query words.)
  assert.deepEqual(only(await slugs(admin, "pdf tables"), ["pdf-tables", "doc-converter", "doc-helper"]), ["pdf-tables", "doc-converter", "doc-helper"]);
});

test("any-word fallback: no skill has every word → some-word matches, flagged 'any'", { skip: !enabled }, async () => {
  const r = await search(admin, "pdf banana");
  assert.equal(r.matchMode, "any");
  // All three match one unit; A–C hits (doc-converter, pdf-tables) first, popularity between them.
  assert.deepEqual(only(r.skills.map((s) => s.skillSlug), ["pdf-tables", "doc-converter", "doc-helper"]), ["doc-converter", "pdf-tables", "doc-helper"]);
});

test("no fallback for a single unit or a query that uses OR", { skip: !enabled }, async () => {
  const single = await search(admin, "banana");
  assert.equal(single.matchMode, "all");
  assert.equal(single.skills.length, 0);
  const withOr = await search(admin, "banana OR kiwi pdf");
  assert.equal(withOr.matchMode, "all");
  assert.equal(withOr.skills.length, 0);
});

test("exclusions hold in strict mode AND in the fallback", { skip: !enabled }, async () => {
  const strict = await slugs(admin, "pdf -extractor");
  assert.ok(strict.includes("doc-converter") && strict.includes("doc-helper"));
  assert.ok(!strict.includes("pdf-tables"));
  const r = await search(admin, "pdf banana -extractor");
  assert.equal(r.matchMode, "any");
  assert.ok(!r.skills.some((s) => s.skillSlug === "pdf-tables"), "a fallback never lets an excluded skill back in");
  assert.ok(r.skills.some((s) => s.skillSlug === "doc-converter"));
});

test("exclusions only: every visible skill except them", { skip: !enabled }, async () => {
  const r = await search(admin, "-pdf");
  const got = r.skills.map((s) => s.skillSlug);
  assert.equal(r.matchMode, "all");
  assert.ok(got.includes("pptgen") && got.includes("pg-migrate"));
  assert.ok(!["pdf-tables", "doc-converter", "doc-helper"].some((s) => got.includes(s)));
});

// ── Synonyms, categories, the indexed version (§34.3 / §34.8) ─────────────────────────────────

test("synonyms expand both ways; quotes and exclusions stay literal; multi-word members match", { skip: !enabled }, async () => {
  assert.deepEqual(only(await slugs(admin, "florp"), ["florp-tool", "zargle-kit"]).sort(), ["florp-tool", "zargle-kit"]);
  assert.deepEqual(only(await slugs(admin, "zargle"), ["florp-tool", "zargle-kit"]).sort(), ["florp-tool", "zargle-kit"]);
  assert.deepEqual(only(await slugs(admin, '"florp"'), ["florp-tool", "zargle-kit"]), ["florp-tool"], "a quoted phrase is never expanded");
  const excluded = await slugs(admin, "-florp");
  assert.ok(excluded.includes("zargle-kit") && !excluded.includes("florp-tool"), "an exclusion is never expanded");
  assert.ok((await slugs(admin, "wibble wobble")).includes("wbw-skill"));
});

test("category names are searchable and refresh when a category is removed", { skip: !enabled }, async () => {
  assert.ok((await slugs(admin, "zobservability")).includes("trace-kit"));
  await pool.query(`delete from skill_categories where skill_id = $1`, [ids["trace-kit"]]);
  assert.ok(!(await slugs(admin, "zobservability")).includes("trace-kit"));
});

test("the indexed version: latest stable; yank falls back; restore returns; beta-only is findable", { skip: !enabled }, async () => {
  assert.ok((await slugs(admin, "gammaword")).includes("ver-skill"));
  assert.ok((await slugs(admin, "usagegamma")).includes("ver-skill"), "usage comes from the indexed version too");
  assert.ok(!(await slugs(admin, "alphaword")).includes("ver-skill"));
  assert.ok(!(await slugs(admin, "epsilonword")).includes("ver-skill"), "a newer beta never displaces the stable text");
  await pool.query(`update skill_versions set status = 'yanked' where id = $1`, [versionIds["ver-skill@1.1.0"]]);
  assert.ok((await slugs(admin, "alphaword")).includes("ver-skill"));
  assert.ok(!(await slugs(admin, "gammaword")).includes("ver-skill"));
  await pool.query(`update skill_versions set status = 'active' where id = $1`, [versionIds["ver-skill@1.1.0"]]);
  assert.ok((await slugs(admin, "gammaword")).includes("ver-skill"));
  assert.ok((await slugs(admin, "zetaword")).includes("beta-skill"));
});

test("search language: German stems 'Häuser' to 'haus'; English doesn't; a bad value falls back to english", { skip: !enabled }, async () => {
  try {
    await setLanguage("german");
    assert.ok((await slugs(admin, "haus")).includes("bau-plan"));
    await setLanguage("klingon");
    const { rows } = await pool.query<{ cfg: string }>(`select skilly_search_config()::text as cfg`);
    assert.equal(rows[0]!.cfg, "english");
    assert.ok(!(await slugs(admin, "haus")).includes("bau-plan"));
  } finally {
    await setLanguage("english");
  }
});

// ── Visibility (invariant #3, §34.7) ──────────────────────────────────────────────────────────

test("a restricted skill never matches an outsider — by title, body, category, synonym, prefix, substring or typo", { skip: !enabled }, async () => {
  for (const q of ["zebra", "zebracorn", "zebracat", "quagga", "zebr", "ebra", "zebraa"]) {
    assert.ok(!(await slugs(outsider, q)).includes("rz-secret"), `leaked through "${q}"`);
  }
  assert.ok((await slugs(insider, "zebracorn")).includes("rz-secret"), "positive control: members see it");
});

test("the fallback decision never reveals a hidden match (no matchMode oracle)", { skip: !enabled }, async () => {
  const inside = await search(insider, "zebra playbook");
  assert.equal(inside.matchMode, "all");
  const outside = await search(outsider, "zebra playbook");
  assert.equal(outside.matchMode, "any", "strict must be decided over the VISIBLE rows only");
  assert.equal(outside.skills.length, 0);
});

// ── One engine everywhere (§34.2 / §34.13) ────────────────────────────────────────────────────

test("the header dropdown's 5 are the unfiltered catalog's first 5", { skip: !enabled }, async () => {
  for (const q of [TOKEN, `${TOKEN} pdf`, `pdf tables ${TOKEN}`, "powerpo"]) {
    const drop = (await suggestSkillsResult(admin, q, 5)).suggestions.map((s) => `${s.namespaceSlug}/${s.skillSlug}`);
    const cat = (await searchCatalog(admin, { q, limit: 100 })).skills.slice(0, 5).map((s) => `${s.namespaceSlug}/${s.skillSlug}`);
    assert.deepEqual(drop, cat, `mismatch for "${q}"`);
  }
});

test("web and worker (MCP search_skills) return identical ordered results", { skip: !enabled }, async () => {
  // Loaded at runtime (not type-checked into web): the worker's own implementation, same database.
  const workerQueries = (await import(new URL("../../../worker/src/mcp/queries.ts", import.meta.url).href)) as {
    searchSkills: (p: typeof pool, a: EffectiveAccess, o: { q?: string; limit?: number }) => Promise<{
      skills: { namespaceSlug: string; skillSlug: string; matchedIn?: string[]; snippet?: string | null }[];
      total: number;
      matchMode: string | null;
      synonymsApplied: string[][];
    }>;
  };
  for (const access of [admin, outsider]) {
    for (const q of [TOKEN, `${TOKEN} pdf`, `pdf tables ${TOKEN}`, `${TOKEN} -pdf`, "florp", "pdf banana zzqq", "zebra playbook"]) {
      const web = await searchCatalog(access, { q, limit: 50 });
      const mcp = await workerQueries.searchSkills(pool, access, { q, limit: 50 });
      assert.deepEqual(
        mcp.skills.map((s) => `${s.namespaceSlug}/${s.skillSlug}`),
        web.skills.map((s) => `${s.namespaceSlug}/${s.skillSlug}`),
        `order mismatch for "${q}"`,
      );
      assert.equal(mcp.matchMode, web.matchMode, `matchMode mismatch for "${q}"`);
    }
  }
  // MCP explanations (§34.11): which fields matched + a snippet from the body when only the body did.
  const noise = (await workerQueries.searchSkills(pool, admin, { q: "summarise tables", limit: 50 })).skills.find((s) => s.skillSlug === "doc-helper");
  assert.ok(noise, "the body match is found");
  assert.deepEqual(noise.matchedIn, ["instructions"]);
  assert.match(noise.snippet ?? "", /summarise the tables/);
  const florp = await workerQueries.searchSkills(pool, admin, { q: "florp", limit: 50 });
  assert.deepEqual(florp.synonymsApplied, [["florp", "zargle"]]);
  const secret = await workerQueries.searchSkills(pool, outsider, { q: "zebracorn", limit: 50 });
  assert.equal(secret.total, 0, "an invisible skill never counts");
});

// ── Administration (§34.8–§34.10) ─────────────────────────────────────────────────────────────

test("synonym validation: stop words, same-word groups, cross-group overlap, shape", { skip: !enabled }, async () => {
  const rejects = async (input: unknown, re: RegExp) => {
    await assert.rejects(createSynonymGroup(input, adminUserId), (e: unknown) => e instanceof SearchAdminError && e.status === 422 && re.test(e.message));
  };
  await rejects("the, zqz", /ignored by search/);
  await rejects("zqboxes, zqbox", /same word to search/);
  await rejects("florp, zqother", /already in the group “florp, zargle”/);
  await rejects("lonely", /at least 2/);
});

test("synonym edits and deletes are audited; unknown ids are 404", { skip: !enabled }, async () => {
  const groups = await listSynonymGroups();
  const g = groups.find((x) => x.terms.includes("wbw"))!;
  await updateSynonymGroup(g.id, "wibble wobble, wbw, wobbly", adminUserId);
  const { rows: upd } = await pool.query<{ before: { terms: string[] }; after: { terms: string[] } }>(
    `select before, after from audit_log where action = 'search.synonym_group_updated' and target_id = $1 order by seq desc limit 1`,
    [g.id],
  );
  assert.deepEqual(upd[0]!.before.terms, ["wibble wobble", "wbw"]);
  assert.deepEqual(upd[0]!.after.terms, ["wibble wobble", "wbw", "wobbly"]);
  await deleteSynonymGroup(g.id, adminUserId);
  const { rows: del } = await pool.query(`select 1 from audit_log where action = 'search.synonym_group_deleted' and target_id = $1`, [g.id]);
  assert.equal(del.length, 1);
  await assert.rejects(deleteSynonymGroup(g.id, adminUserId), (e: unknown) => e instanceof SearchAdminError && e.status === 404);
});

test("after a language switch, colliding groups are flagged and a searched word expands to their union", { skip: !enabled }, async () => {
  try {
    await setLanguage("simple"); // no stemming: 'slide' and 'slides' are different words
    await createSynonymGroup("slide, deckz", adminUserId);
    await createSynonymGroup("slides, keynotez", adminUserId);
    await setLanguage("english"); // now both normalize to 'slide'
    const flagged = (await listSynonymGroups()).filter((x) => x.terms.includes("deckz") || x.terms.includes("keynotez"));
    assert.equal(flagged.length, 2);
    assert.ok(flagged.every((x) => x.collidesWith.length === 1));
    const c = await prepareSearch(pool, parseSearchQuery("slide")!);
    assert.equal(c.synonymsApplied.length, 2, "union of both groups");
  } finally {
    await setLanguage("english");
  }
});

test("search language: unknown values are 422; a switch is audited with from → to", { skip: !enabled }, async () => {
  await assert.rejects(setSearchLanguage("klingon", adminUserId), (e: unknown) => e instanceof SearchAdminError && e.status === 422);
  try {
    await setSearchLanguage("german", adminUserId);
    const { rows } = await pool.query<{ before: { searchLanguage: string }; after: { searchLanguage: string } }>(
      `select before, after from audit_log where action = 'settings.updated' and target_id = 'search_language' order by seq desc limit 1`,
    );
    assert.deepEqual([rows[0]!.before.searchLanguage, rows[0]!.after.searchLanguage], ["english", "german"]);
    const status = await getSearchIndexStatus();
    assert.equal(status.rebuild.language, "german");
    assert.equal(status.rebuild.running, true, "vectors built with english now need a rebuild");
  } finally {
    await setLanguage("english");
  }
});

test("Retry failed re-arms failed extractions and is audited", { skip: !enabled }, async () => {
  const v = versionIds["doc-helper@1.0.0"]!;
  // A row that never extracted, parked as failed (the write-once body stays as it is).
  const extra = await addVersion(ids["doc-helper"]!, { semver: "1.0.1" });
  await pool.query(`update skill_version_search set status = 'failed', attempts = 5, last_error = 'boom' where skill_version_id = $1`, [extra]);
  const reset = await retryFailedSearchIndex(adminUserId);
  assert.ok(reset >= 1);
  const { rows } = await pool.query<{ status: string; attempts: number; last_error: string | null }>(
    `select status, attempts, last_error from skill_version_search where skill_version_id = $1`,
    [extra],
  );
  assert.deepEqual(rows[0], { status: "pending", attempts: 0, last_error: null });
  const { rows: audit } = await pool.query(`select 1 from audit_log where action = 'job.search_retry_requested' order by seq desc limit 1`);
  assert.equal(audit.length, 1);
  // body_text is write-once (§34.3).
  await assert.rejects(pool.query(`update skill_version_search set body_text = 'changed' where skill_version_id = $1`, [v]), /write-once/);
});
