// The §34 search engine's pure parts: the query language, synonym expansion, tsquery composition
// and the SQL builder's parameter discipline. The database halves (normalization, ranking against
// real vectors) are covered by the live-DB suite in packages/web/src/lib/search.dbtest.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSearchQuery,
  synonymCandidates,
  composeSearch,
  normalizationSql,
  searchMatch,
  searchStrictPredicate,
  searchExplainColumns,
  catalogOrderBy,
  skillMdSearchText,
  parseSynonymTerms,
  substringSnippet,
  searchLanguageLabel,
  SEARCH_BODY_MAX_BYTES,
  SEARCH_MAX_TERMS,
  type ParsedSearch,
  type SearchNormalization,
} from "./search.js";

const parse = (q: string): ParsedSearch => {
  const p = parseSearchQuery(q);
  assert.ok(p, `expected ${JSON.stringify(q)} to parse`);
  return p;
};

// ── Parsing (§34.4) ────────────────────────────────────────────────────────────────────────────

test("below the 2-character floor a query is no query", () => {
  assert.equal(parseSearchQuery(""), null);
  assert.equal(parseSearchQuery("  a  "), null);
  assert.equal(parseSearchQuery(null), null);
  assert.equal(parseSearchQuery(undefined), null);
  assert.ok(parseSearchQuery("ab"));
});

test("plain words AND together, the last one is a prefix, and the text is normalized", () => {
  const p = parse("  pdf \t  extr  ");
  assert.equal(p.text, "pdf extr");
  assert.equal(p.operatorFree, true);
  assert.deepEqual(p.positives, [
    { kind: "word", text: "pdf", prefix: false },
    { kind: "word", text: "extr", prefix: true },
  ]);
  assert.deepEqual(p.negatives, []);
});

test("a 1-character last word matches exactly, never as a prefix; punctuation words never prefix", () => {
  assert.equal((parse("pdf e").positives[1] as { prefix: boolean }).prefix, false);
  assert.equal((parse("learn c++").positives[1] as { prefix: boolean }).prefix, false);
  assert.equal((parse("front-end").positives[0] as { prefix: boolean }).prefix, false);
  assert.equal((parse("инстр").positives[0] as { prefix: boolean }).prefix, true, "any letters, not just ASCII");
});

test("quotes make a phrase; an unclosed trailing quote gets a last-word prefix, a closed one never", () => {
  const closed = parse('"extract tables" pdf');
  assert.deepEqual(closed.positives[0], { kind: "phrase", words: ["extract", "tables"], prefix: false });
  assert.equal(closed.operatorFree, false);
  const open = parse('pdf "extract tab');
  assert.deepEqual(open.positives[1], { kind: "phrase", words: ["extract", "tab"], prefix: true });
  assert.deepEqual(parse('"pdf tools"').positives[0], { kind: "phrase", words: ["pdf", "tools"], prefix: false });
});

test("a leading - excludes a word or a phrase; a - inside a word is not an operator", () => {
  const p = parse('slides -google -"keynote deck" front-end');
  assert.deepEqual(p.negatives, [
    { kind: "word", text: "google", prefix: false },
    { kind: "phrase", words: ["keynote", "deck"], prefix: false },
  ]);
  assert.deepEqual(p.positives.map((u) => (u.kind === "word" ? u.text : u.kind)), ["slides", "front-end"]);
  assert.equal(p.operatorFree, false);
  assert.equal(parse("a - b").operatorFree, true, "a lone dash is punctuation, not an exclusion");
});

test("capital OR binds tighter than AND and chains into one group; lowercase or is a word", () => {
  const p = parse("markdown OR html OR docx slides");
  assert.equal(p.hasOr, true);
  assert.equal(p.positives.length, 2);
  const g = p.positives[0]!;
  assert.equal(g.kind, "or");
  assert.deepEqual(g.kind === "or" ? g.members.map((m) => (m.kind === "word" ? m.text : "?")) : [], ["markdown", "html", "docx"]);
  const lower = parse("markdown or html slides");
  assert.equal(lower.hasOr, false);
  assert.equal(lower.positives.length, 4);
  assert.equal(lower.operatorFree, true);
});

test("leading, trailing, doubled and exclusion-adjacent ORs fall away", () => {
  assert.equal(parse("OR pdf").hasOr, false);
  const trailing = parse("pdf OR");
  assert.equal(trailing.hasOr, false);
  assert.equal(trailing.operatorFree, false, "the OR token still counts as an operator");
  assert.equal((trailing.positives[0] as { prefix: boolean }).prefix, true, "a trailing OR leaves pdf the final unit");
  const doubled = parse("pdf OR OR docx");
  assert.equal(doubled.positives.length, 1);
  assert.equal(doubled.positives[0]!.kind, "or");
  const negAfter = parse("pdf OR -docx");
  assert.equal(negAfter.hasOr, false);
  assert.equal(negAfter.negatives.length, 1);
  const negBefore = parse("-pdf OR docx");
  assert.equal(negBefore.hasOr, false);
  assert.equal(negBefore.positives.length, 1);
});

test("prefix only when the query's FINAL item is that bare word", () => {
  assert.equal((parse("pdf -scan").positives[0] as { prefix: boolean }).prefix, false, "an exclusion ends the query");
  const orLast = parse("pdf OR docx");
  assert.equal(orLast.positives[0]!.kind, "or");
  assert.ok(orLast.positives[0]!.kind === "or" && orLast.positives[0]!.members.every((m) => !m.prefix), "an OR group never takes a prefix");
});

test("exclusions only parse to no positives", () => {
  const p = parse("-excel");
  assert.equal(p.positives.length, 0);
  assert.equal(p.negatives.length, 1);
});

test("caps: 200 characters and 12 words/phrases in total", () => {
  const long = "x".repeat(250);
  assert.equal(parse(long).text.length, 200);
  const many = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
  const p = parse(many);
  assert.equal(p.positives.length, SEARCH_MAX_TERMS);
  assert.equal((p.positives.at(-1) as { prefix: boolean }).prefix, false, "a truncated tail is not the word being typed");
  const mixed = parse(Array.from({ length: 8 }, (_, i) => `a${i} OR b${i}`).join(" "));
  const counted = mixed.positives.reduce((n, u) => n + (u.kind === "or" ? u.members.length : 1), 0);
  assert.equal(counted, SEARCH_MAX_TERMS, "OR members count toward the cap");
  // An emoji straddling the cut is never split into half a surrogate pair.
  const emoji = parse("a".repeat(199) + "😀😀").text;
  assert.equal([...emoji].length, 200);
});

// ── Synonym candidates + composition (§34.5) ──────────────────────────────────────────────────

test("synonym candidates: 1–4-word n-grams of bare runs plus bare OR members; never phrases or exclusions", () => {
  const c = synonymCandidates(parse('continuous integration pipeline "a b" x OR y -z'));
  for (const want of ["continuous", "integration", "pipeline", "continuous integration", "integration pipeline", "continuous integration pipeline", "x", "y"]) {
    assert.ok(c.includes(want), `missing ${want}`);
  }
  for (const not of ["a", "b", "a b", "z", "pipeline a"]) assert.ok(!c.includes(not), `unexpected ${not}`);
});

/** Fragment texts in plan order, as PostgreSQL would return them (fake lexemes). */
const norm = (fragments: string[], synonyms: SearchNormalization["synonyms"] = []): SearchNormalization => ({ fragments, synonyms });

test("compose: words AND, stop words drop out, exclusions OR together, prefix fragments pass through", () => {
  const p = parse("the pdf extr -scan");
  // plan order: the, pdf, extr (prefix), scan
  const c = composeSearch(p, norm(["", "'pdf'", "'extr':*", "'scan'"]));
  assert.equal(c.strict, "((('pdf'))) & ((('extr':*)))");
  assert.equal(c.any, "((('pdf'))) | ((('extr':*)))");
  assert.deepEqual(c.units, ["(('pdf'))", "(('extr':*))"]);
  assert.equal(c.excluded, "('scan')");
  assert.equal(c.relaxable, true);
  assert.equal(c.exclusionsOnly, false);
  assert.equal(c.substring, null, "an exclusion switches the substring tier off");
  assert.equal(c.typo, null);
});

test("compose: a single word, or an OR group, is not relaxable", () => {
  assert.equal(composeSearch(parse("pdf"), norm(["'pdf':*"])).relaxable, false);
  const c = composeSearch(parse("pdf OR docx slides"), norm(["'pdf'", "'docx'", "'slide':*"]));
  assert.equal(c.relaxable, false, "a query that spells out its alternatives is never rewritten");
  assert.equal(c.strict, "((('pdf')) | (('docx'))) & ((('slide':*)))", "(pdf | docx) & slides*");
});

test("compose: operator-free text feeds the substring tier; ≥ 4 characters also the typo tier", () => {
  const short = composeSearch(parse("sql"), norm(["'sql':*"]));
  assert.equal(short.substring, "sql");
  assert.equal(short.typo, null);
  const long = composeSearch(parse("powerpiont"), norm(["'powerpiont':*"]));
  assert.equal(long.typo, "powerpiont");
});

test("compose: only exclusions survive → exclusions-only; nothing survives → no units at all", () => {
  const only = composeSearch(parse("the -excel"), norm(["", "'excel'"]));
  assert.equal(only.strict, null);
  assert.equal(only.exclusionsOnly, true);
  const nothing = composeSearch(parse('"the"'), norm([""]));
  assert.equal(nothing.strict, null);
  assert.equal(nothing.exclusionsOnly, false);
  assert.equal(nothing.substring, null);
});

test("compose: a single-word synonym ORs the group in; the typed word keeps its prefix", () => {
  const p = parse("ppt");
  const c = composeSearch(p, norm(["'ppt':*"], [{ ngram: "ppt", terms: ["ppt", "powerpoint", "slides"], queries: ["'ppt'", "'powerpoint'", "'slide'"] }]));
  assert.equal(c.units.length, 1);
  assert.equal(c.units[0], "(('ppt':*)) | ('ppt') | ('powerpoint') | ('slide')");
  assert.deepEqual(c.synonymsApplied, [["ppt", "powerpoint", "slides"]]);
});

test("compose: the longest multi-word synonym wins and stays ONE unit", () => {
  const p = parse("continuous integration pipeline");
  const c = composeSearch(
    p,
    norm(["'continu'", "'integr'", "'pipelin':*"], [
      { ngram: "continuous integration", terms: ["ci", "continuous integration"], queries: ["'ci'", "'continu' <-> 'integr'"] },
      { ngram: "integration", terms: ["integration", "integ"], queries: ["'integr'", "'integ'"] },
    ]),
  );
  assert.equal(c.units.length, 2, "continuous+integration folded into one unit");
  assert.equal(c.units[0], "(('continu') & ('integr')) | ('ci') | ('continu' <-> 'integr')");
  assert.deepEqual(c.synonymsApplied, [["ci", "continuous integration"]], "the shorter overlapping match was not used");
});

test("compose: quoted phrases and exclusions are literal — never expanded", () => {
  const p = parse('"ppt" -ppt');
  // Candidates exclude both, so even a stray match for the text is ignored.
  assert.deepEqual(synonymCandidates(p), []);
  const c = composeSearch(p, norm(["'ppt'", "'ppt'"], [{ ngram: "ppt", terms: ["ppt", "slides"], queries: ["'ppt'", "'slide'"] }]));
  assert.equal(c.units[0], "'ppt'");
  assert.equal(c.excluded, "('ppt')");
  assert.deepEqual(c.synonymsApplied, []);
});

test("compose: a word matching several groups expands to their union, capped at 10 members", () => {
  const big = Array.from({ length: 8 }, (_, i) => `'s${i}'`);
  const c = composeSearch(parse("data"), norm(["'data':*"], [
    { ngram: "data", terms: big.map((_, i) => `s${i}`), queries: big },
    { ngram: "data", terms: ["data", "dataset", "table"], queries: ["'data'", "'dataset'", "'tabl'"] },
  ]));
  const members = c.units[0]!.split(" | ").length - 1;
  assert.equal(members, 10);
  assert.equal(c.synonymsApplied.length, 2);
});

// ── SQL discipline (§22 / §34.13) ─────────────────────────────────────────────────────────────

const HOSTILE = [
  "'; drop table skills; --",
  "pdf & !cat | (x:*",
  "back\\slash %_wild_%",
  "quote's \"unbalanced",
  "nul\u0000byte",
  "<-> <2> :* :A",
  "x".repeat(400),
];

test("the normalization query binds every user string — none ever appears in the SQL text", () => {
  for (const q of HOSTILE) {
    const p = parseSearchQuery(q);
    if (!p) continue;
    const { sql, params } = normalizationSql(p);
    for (const u of p.positives.flatMap((x) => (x.kind === "or" ? x.members : [x]))) {
      const texts = u.kind === "word" ? [u.text] : u.words;
      for (const t of texts) if (t.length > 2) assert.ok(!sql.includes(t), `user text ${JSON.stringify(t)} leaked into SQL`);
    }
    assert.ok(params.length > 0);
  }
});

test("searchMatch / searchStrictPredicate / searchExplainColumns bind every value", () => {
  for (const q of HOSTILE) {
    const p = parseSearchQuery(q);
    if (!p) continue;
    const c = composeSearch(p, norm(Array.from({ length: 20 }, () => "'lex'")));
    for (const mode of ["all", "any"] as const) {
      const params: unknown[] = [];
      const m = searchMatch(c, mode, params);
      const explain = searchExplainColumns(c, params);
      const strict = searchStrictPredicate(c, params);
      for (const sql of [m.where, m.relevance, explain, strict]) {
        assert.ok(!sql.includes(p.text), `query text leaked into SQL for ${JSON.stringify(q)}`);
        assert.ok(!sql.includes("'lex'"), "tsquery texts are bound, never inlined");
      }
      if (c.substring) assert.ok(params.includes(`%${c.substring.replace(/[\\%_]/g, "\\$&")}%`), "LIKE metacharacters are escaped");
    }
  }
});

test("searchMatch: strict mode ranks name › name/description/categories › anywhere › substring/typo", () => {
  const c = composeSearch(parse("pdf tables"), norm(["'pdf'", "'tabl':*"]));
  const params: unknown[] = [];
  const m = searchMatch(c, "all", params);
  assert.match(m.where, /s\.search_tsv @@ \$\d+::tsquery/);
  assert.match(m.where, /s\.title ilike \$\d+ escape '\\'/);
  assert.match(m.where, /word_similarity\(\$\d+, s\.title\) >= 0\.5/);
  assert.match(m.relevance, /ts_filter\(s\.search_tsv, '\{a\}'\)/);
  assert.match(m.relevance, /ts_filter\(s\.search_tsv, '\{a,b,c\}'\)/);
  assert.ok(m.relevance.endsWith(", "));
});

test("searchMatch: any mode counts matched units and prefers description-level hits", () => {
  const c = composeSearch(parse("pdf tables"), norm(["'pdf'", "'tabl':*"]));
  const params: unknown[] = [];
  const m = searchMatch(c, "any", params);
  assert.match(m.relevance, /then 4 else 5/);
  assert.equal((m.relevance.match(/::int/g) ?? []).length, 2, "one coverage term per unit");
  // The coverage params are ORDER BY-only: a count(*) over the same WHERE must stop before them.
  assert.equal(params.length - m.whereParamCount, 2);
  const referenced = [...m.where.matchAll(/\$(\d+)/g)].map((x) => Number(x[1]));
  assert.equal(Math.max(...referenced), m.whereParamCount);
});

test("searchMatch: exclusions only → everything but them, ranked like no query; nothing at all → false", () => {
  const only = composeSearch(parse("-excel"), norm(["'excel'"]));
  const m = searchMatch(only, "all", []);
  assert.match(m.where, /^not \(s\.search_tsv @@ \$1::tsquery\)$/);
  assert.equal(m.relevance, "");
  const none = searchMatch(composeSearch(parse('"the"'), norm([""])), "all", []);
  assert.equal(none.where, "false");
});

test("relevance keys are never bare integers (ORDER BY 5 would sort by the fifth COLUMN)", () => {
  const cases = [
    composeSearch(parse("pdf tables"), norm(["'pdf'", "'tabl':*"])), // units + substring
    composeSearch(parse('"pdf" tables'), norm(["'pdf'", "'tabl':*"])), // units, operators: no substring
    composeSearch(parse("the"), norm([""])), // substring only
    composeSearch(parse('"the"'), norm([""])), // nothing at all
  ];
  for (const c of cases) {
    for (const mode of ["all", "any"] as const) {
      const { relevance } = searchMatch(c, mode, []);
      for (const key of relevance.split(/,\s*(?=case|$)/).map((k) => k.trim()).filter(Boolean)) {
        assert.ok(!/^\d+( asc| desc)?$/.test(key), `bare integer key ${JSON.stringify(key)}`);
      }
    }
  }
});

test("catalogOrderBy: one total order for every surface, relevance keys first", () => {
  assert.match(catalogOrderBy("relevance", "T asc, "), /^T asc, s\.install_count desc, .* s\.title asc, n\.slug asc, s\.slug asc$/);
  assert.match(catalogOrderBy(undefined, ""), /^s\.install_count desc/);
  assert.match(catalogOrderBy("top_rated", "IGNORED"), /^\(\(s\.rating_sum/);
  assert.match(catalogOrderBy("latest", "IGNORED"), /^coalesce\(max\(sv\.created_at\)/);
});

// ── SKILL.md text (§34.3) ──────────────────────────────────────────────────────────────────────

test("skillMdSearchText strips BOM + frontmatter, removes NULs, keeps the Markdown", () => {
  const md = "\uFEFF---\r\nname: pdf-tools\r\ndescription: x\r\n---\r\n# PDF tools\n\nUse `pdftotext`.\u0000\n";
  assert.equal(skillMdSearchText(md), "# PDF tools\n\nUse `pdftotext`.\n");
  assert.equal(skillMdSearchText("# no frontmatter"), "# no frontmatter");
  assert.equal(skillMdSearchText("---\nname: only\n---"), "");
});

test("skillMdSearchText caps at 64 KB on a character boundary", () => {
  const ascii = skillMdSearchText("a".repeat(SEARCH_BODY_MAX_BYTES + 10));
  assert.equal(new TextEncoder().encode(ascii).length, SEARCH_BODY_MAX_BYTES);
  const multi = skillMdSearchText("é".repeat(SEARCH_BODY_MAX_BYTES)); // 2 bytes each
  const bytes = new TextEncoder().encode(multi).length;
  assert.ok(bytes <= SEARCH_BODY_MAX_BYTES && bytes >= SEARCH_BODY_MAX_BYTES - 1);
  assert.ok(!multi.includes("\uFFFD"), "never half a character");
});

// ── Synonym input (§34.8) ─────────────────────────────────────────────────────────────────────

test("parseSynonymTerms normalizes and enforces the group shape", () => {
  assert.deepEqual(parseSynonymTerms(" K8s ,  kubernetes,k8s ,, "), { ok: true, terms: ["k8s", "kubernetes"] });
  assert.deepEqual(parseSynonymTerms(["Continuous   Integration", "CI"]), { ok: true, terms: ["continuous integration", "ci"] });
  assert.equal(parseSynonymTerms("solo").ok, false);
  assert.equal(parseSynonymTerms("a, a").ok, false, "duplicates collapse to one term");
  assert.equal(parseSynonymTerms(Array.from({ length: 11 }, (_, i) => `t${i}`)).ok, false);
  assert.equal(parseSynonymTerms(["one two three four five", "x"]).ok, false);
  assert.equal(parseSynonymTerms(["x".repeat(61), "y"]).ok, false);
  assert.equal(parseSynonymTerms(['"quoted"', "y"]).ok, false);
  assert.equal(parseSynonymTerms(["-neg", "y"]).ok, false);
  assert.equal(parseSynonymTerms(42).ok, false);
  assert.equal(parseSynonymTerms([1, 2]).ok, false);
});

test("substringSnippet cuts a window around the match; searchLanguageLabel names configurations", () => {
  const text = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ") + " PostgreSQL migrations " + "tail ".repeat(40);
  const s = substringSnippet(text, "sql")!;
  assert.ok(s.includes("PostgreSQL"));
  assert.ok(s.split(" ").length <= 30);
  assert.equal(substringSnippet("nothing here", "sql"), null);
  assert.equal(searchLanguageLabel("german"), "German");
  assert.equal(searchLanguageLabel("simple"), "No stemming (any language)");
});
