// The full-text search engine — SKILLY_SPEC.md §34. ONE implementation of the query language, the
// synonym expansion and the SQL that matches and ranks skills, shared by the web tier (catalog grid
// + header dropdown) and the worker (MCP `search_skills`) so the surfaces can never disagree about
// what a query means (§34.13). Server-only: it builds SQL, so client components never import it.
//
// Pipeline:
//   parseSearchQuery  (pure)          raw text → words / phrases / OR groups / exclusions (§34.4)
//   prepareSearch     (one query)     PostgreSQL normalizes every unit — it is the only stemmer —
//                                     and looks up synonym groups (§34.8); composeSearch (pure)
//                                     turns the result into tsquery texts (§34.5)
//   searchMatch       (pure)          the WHERE predicate + the relevance ORDER BY keys (§34.6)
//
// User text reaches PostgreSQL ONLY as bound parameters. The tsquery texts handed back to the main
// query are PostgreSQL's own output (quoted lexemes), recombined with operators this module
// controls — never with user text (§22).

// ── Limits (§34.4, §34.8, §34.14) ──────────────────────────────────────────────────────────────
export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 200;
/** Words and phrases in total — OR members and exclusions included — so a tsquery is bounded. */
export const SEARCH_MAX_TERMS = 12;
export const SEARCH_PREFIX_MIN_CHARS = 2;
export const SEARCH_TYPO_MIN_CHARS = 4;
/** pg_trgm word_similarity threshold for the typo tier (title/slug). */
export const SEARCH_TYPO_THRESHOLD = 0.5;
export const SEARCH_MAX_SYNONYMS_PER_UNIT = 10;
/** The indexed share of a SKILL.md body (UTF-8 bytes). */
export const SEARCH_BODY_MAX_BYTES = 64 * 1024;
export const SYNONYM_GROUP_MIN_TERMS = 2;
export const SYNONYM_GROUP_MAX_TERMS = 10;
export const SYNONYM_TERM_MAX_WORDS = 4;
export const SYNONYM_TERM_MAX_CHARS = 60;
export const SYNONYM_MAX_GROUPS = 500;

/** "all": every word matched somewhere. "any": nothing matched every word, so some-word matches are shown. */
export type MatchMode = "all" | "any";

// ── Parse tree ─────────────────────────────────────────────────────────────────────────────────
export interface SearchWord {
  kind: "word";
  text: string;
  /** Matches as a prefix too (the query's final bare word, §34.4). */
  prefix: boolean;
}
export interface SearchPhrase {
  kind: "phrase";
  words: string[];
  /** Unclosed trailing quote: its last word also matches as a prefix. */
  prefix: boolean;
}
export interface SearchOrGroup {
  kind: "or";
  members: Array<SearchWord | SearchPhrase>;
}
export type SearchUnit = SearchWord | SearchPhrase | SearchOrGroup;

export interface ParsedSearch {
  positives: SearchUnit[];
  negatives: Array<SearchWord | SearchPhrase>;
  /** An OR group took effect (a leading/trailing/doubled OR, or one touching an exclusion, does not). */
  hasOr: boolean;
  /** No quote, exclusion or OR token anywhere — the substring and typo tiers only run then. */
  operatorFree: boolean;
  /** The normalized query text (trimmed, NFC, whitespace collapsed, capped). */
  text: string;
}

const PREFIXABLE = /^[\p{L}\p{N}]+$/u;
const codePoints = (s: string): number => [...s].length;
const prefixable = (w: string): boolean => PREFIXABLE.test(w) && codePoints(w) >= SEARCH_PREFIX_MIN_CHARS;

/** NFC, collapse whitespace, trim, cap at SEARCH_MAX_CHARS code points (never splitting a pair). */
export function normalizeSearchText(raw: string): string {
  const s = raw.normalize("NFC").replace(/\s+/g, " ").trim();
  return codePoints(s) <= SEARCH_MAX_CHARS ? s : [...s].slice(0, SEARCH_MAX_CHARS).join("").trimEnd();
}

type Item =
  | { type: "word"; text: string; neg: boolean }
  | { type: "phrase"; words: string[]; neg: boolean; closed: boolean }
  | { type: "or" };

/**
 * Parse a query (§34.4). Returns null below the 2-character floor — the caller treats that exactly
 * like no query. Never throws: every input parses to something.
 */
export function parseSearchQuery(raw: string | null | undefined): ParsedSearch | null {
  if (typeof raw !== "string") return null;
  const s = normalizeSearchText(raw);
  if (codePoints(s) < SEARCH_MIN_CHARS) return null;

  const items: Item[] = [];
  let terms = 0;
  let operatorFree = true;
  let i = 0;
  while (i < s.length && terms < SEARCH_MAX_TERMS) {
    if (s[i] === " ") {
      i++;
      continue;
    }
    // A `-` at the start of a token (we only get here at a token start) excludes what follows it.
    let neg = false;
    if (s[i] === "-" && i + 1 < s.length && s[i + 1] !== " ") {
      neg = true;
      i++;
    }
    if (s[i] === '"') {
      operatorFree = false;
      const end = s.indexOf('"', i + 1);
      const closed = end !== -1;
      const words = s.slice(i + 1, closed ? end : s.length).split(" ").filter(Boolean);
      i = closed ? end + 1 : s.length;
      if (words.length) {
        items.push({ type: "phrase", words, neg, closed });
        terms++;
      }
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== " " && s[j] !== '"') j++;
    const text = s.slice(i, j);
    i = j;
    if (neg) {
      operatorFree = false;
      items.push({ type: "word", text, neg: true });
      terms++;
    } else if (text === "OR") {
      operatorFree = false;
      items.push({ type: "or" });
    } else if (text) {
      items.push({ type: "word", text, neg: false });
      terms++;
    }
  }

  // Assemble: exclusions aside; `a OR b OR c` folds into one group. An OR only joins two positive
  // neighbours — leading, trailing, doubled or exclusion-adjacent ORs fall away (§34.4).
  const positives: SearchUnit[] = [];
  const negatives: Array<SearchWord | SearchPhrase> = [];
  let pendingOr = false;
  let lastWasPositive = false;
  let hasOr = false;
  let lastPositive: SearchWord | SearchPhrase | null = null;
  let lastPositiveIsTopLevelWord = false;
  const toUnit = (it: Extract<Item, { type: "word" | "phrase" }>): SearchWord | SearchPhrase =>
    it.type === "word" ? { kind: "word", text: it.text, prefix: false } : { kind: "phrase", words: it.words, prefix: false };

  for (const it of items) {
    if (it.type === "or") {
      if (lastWasPositive) pendingOr = true;
      continue;
    }
    if (it.neg) {
      negatives.push(toUnit(it));
      pendingOr = false;
      lastWasPositive = false;
      lastPositive = null;
      continue;
    }
    const unit = toUnit(it);
    if (pendingOr && positives.length > 0) {
      const prev = positives.pop()!;
      const group: SearchOrGroup = prev.kind === "or" ? prev : { kind: "or", members: [prev] };
      group.members.push(unit);
      positives.push(group);
      hasOr = true;
      lastPositiveIsTopLevelWord = false;
    } else {
      positives.push(unit);
      lastPositiveIsTopLevelWord = unit.kind === "word";
    }
    pendingOr = false;
    lastWasPositive = true;
    lastPositive = unit;
  }

  // Last-word prefix: only when the query's final item is that positive unit (§34.4) — and not when
  // the term cap cut the query short, since the kept tail is then not the word being typed.
  const truncated = s.slice(i).trim().length > 0;
  const last = items.filter((it): it is Exclude<Item, { type: "or" }> => it.type !== "or").at(-1);
  if (!truncated && last && !last.neg && lastPositive) {
    if (last.type === "word" && lastPositive.kind === "word" && lastPositiveIsTopLevelWord && prefixable(lastPositive.text)) {
      lastPositive.prefix = true;
    } else if (last.type === "phrase" && !last.closed && lastPositive.kind === "phrase" && prefixable(lastPositive.words.at(-1) ?? "")) {
      lastPositive.prefix = true;
    }
  }

  return { positives, negatives, hasOr, operatorFree, text: s };
}

// ── Synonym candidates (§34.5) ─────────────────────────────────────────────────────────────────

/** Runs of consecutive top-level bare positive words — the only places multi-word synonyms can match. */
function bareRuns(p: ParsedSearch): SearchWord[][] {
  const runs: SearchWord[][] = [];
  let cur: SearchWord[] = [];
  for (const u of p.positives) {
    if (u.kind === "word") cur.push(u);
    else {
      if (cur.length) runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

const ngramKey = (words: readonly SearchWord[]): string => words.map((w) => w.text).join(" ");

/** Every text that could name a synonym member: 1–4-word n-grams of each bare run, plus bare OR members. */
export function synonymCandidates(p: ParsedSearch): string[] {
  const out = new Set<string>();
  for (const run of bareRuns(p)) {
    for (let i = 0; i < run.length; i++) {
      for (let n = 1; n <= SYNONYM_TERM_MAX_WORDS && i + n <= run.length; n++) out.add(ngramKey(run.slice(i, i + n)));
    }
  }
  for (const u of p.positives) {
    if (u.kind === "or") for (const m of u.members) if (m.kind === "word") out.add(m.text);
  }
  return [...out];
}

// ── Prepare + compose (§34.5) ──────────────────────────────────────────────────────────────────

/** The minimal pg surface prepareSearch needs — a `pg` Pool or PoolClient satisfies it structurally. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** One synonym group a candidate text matched, with each member as PostgreSQL phrase-tsquery text. */
export interface SynonymMatch {
  ngram: string;
  terms: string[];
  queries: string[];
}

/** What PostgreSQL returned for a parsed query: tsquery text per fragment + synonym matches. */
export interface SearchNormalization {
  fragments: string[];
  synonyms: SynonymMatch[];
}

type FragmentReq =
  | { fn: "plain" | "prefix" | "phrase"; text: string }
  | { fn: "phrasePrefix"; head: string; last: string };

/** Walk the parse tree in a fixed order, handing out fragment indices. Shared by the SQL and compose. */
function planFragments(p: ParsedSearch) {
  const reqs: FragmentReq[] = [];
  const add = (r: FragmentReq): number => reqs.push(r) - 1;
  const leaf = (u: SearchWord | SearchPhrase): number =>
    u.kind === "word"
      ? add({ fn: u.prefix ? "prefix" : "plain", text: u.text })
      : u.prefix && u.words.length > 1
        ? add({ fn: "phrasePrefix", head: u.words.slice(0, -1).join(" "), last: u.words.at(-1)! })
        : u.prefix
          ? add({ fn: "prefix", text: u.words[0]! })
          : add({ fn: "phrase", text: u.words.join(" ") });
  const positives = p.positives.map((u) =>
    u.kind === "or" ? { unit: u, frag: -1, members: u.members.map((m) => ({ unit: m, frag: leaf(m) })) } : { unit: u, frag: leaf(u), members: [] as { unit: SearchWord | SearchPhrase; frag: number }[] },
  );
  const negatives = p.negatives.map((u) => ({ unit: u, frag: leaf(u) }));
  return { reqs, positives, negatives };
}

const CFG = "skilly_search_config()";

function fragmentSql(r: FragmentReq, params: unknown[]): string {
  const bind = (v: string): string => {
    params.push(v);
    return `$${params.length}::text`;
  };
  switch (r.fn) {
    case "plain":
      return `plainto_tsquery(${CFG}, ${bind(r.text)})::text`;
    case "prefix":
      // `prefix` texts are letters/digits only (parseSearchQuery), so appending `:*` can't smuggle
      // tsquery syntax in.
      return `to_tsquery(${CFG}, ${bind(r.text)} || ':*')::text`;
    case "phrase":
      return `phraseto_tsquery(${CFG}, ${bind(r.text)})::text`;
    case "phrasePrefix":
      return `tsquery_phrase(phraseto_tsquery(${CFG}, ${bind(r.head)}), to_tsquery(${CFG}, ${bind(r.last)} || ':*'))::text`;
  }
}

/** The one-round-trip normalization query for a parsed query (exported for tests). */
export function normalizationSql(p: ParsedSearch): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const { reqs } = planFragments(p);
  const frags = reqs.length ? `array[${reqs.map((r) => fragmentSql(r, params)).join(", ")}]::text[]` : `array[]::text[]`;
  const candidates = synonymCandidates(p);
  if (!candidates.length) return { sql: `select ${frags} as frags, '[]'::json as synonyms`, params };
  params.push(candidates);
  const k = params.length;
  return {
    sql: `with ng as (
            select c.ng, skilly_search_normalize(c.ng) as norm from unnest($${k}::text[]) as c(ng)
          )
          select ${frags} as frags,
                 coalesce((
                   select json_agg(json_build_object(
                            'ngram', ng.ng,
                            'terms', g.terms,
                            'queries', (select array_agg(phraseto_tsquery(${CFG}, m.t)::text order by m.o)
                                          from unnest(g.terms) with ordinality as m(t, o)))
                          order by ng.ng, g.created_at, g.id)
                     from ng join search_synonym_groups g on ng.norm <> '' and ng.norm = any(g.normalized)
                 ), '[]'::json) as synonyms`,
    params,
  };
}

/** Everything the matcher needs, as tsquery texts (PostgreSQL's own output) — §34.5. */
export interface ComposedSearch {
  /** Every positive unit (AND); null when no positive unit survived normalization. */
  strict: string | null;
  /** Any positive unit (OR). */
  any: string | null;
  /** One text per surviving positive unit — the any-word fallback counts how many matched. */
  units: string[];
  /** Any exclusion (OR); null when there is none. */
  excluded: string | null;
  /** The any-word fallback may apply: ≥ 2 surviving positive units and no OR group. */
  relaxable: boolean;
  /** Only exclusions survived: match everything visible except them, ranked like no query. */
  exclusionsOnly: boolean;
  /** The substring tier's text (operator-free queries only). */
  substring: string | null;
  /** The typo tier's text (operator-free queries of ≥ 4 characters only). */
  typo: string | null;
  /** The synonym groups the query actually expanded. */
  synonymsApplied: string[][];
}

const paren = (q: string): string => `(${q})`;
const orOf = (qs: readonly string[]): string => qs.filter(Boolean).map(paren).join(" | ");
const andOf = (qs: readonly string[]): string => qs.filter(Boolean).map(paren).join(" & ");

/**
 * Turn a parsed query + PostgreSQL's normalization into tsquery texts (pure — unit-tested without a
 * database). Units that normalize to nothing (stop words, bare punctuation) drop out.
 */
export function composeSearch(p: ParsedSearch, n: SearchNormalization): ComposedSearch {
  const plan = planFragments(p);
  const frag = (i: number): string => n.fragments[i] ?? "";
  const byNgram = new Map<string, SynonymMatch[]>();
  for (const m of n.synonyms) {
    const list = byNgram.get(m.ngram) ?? [];
    list.push(m);
    byNgram.set(m.ngram, list);
  }
  const applied = new Map<string, string[]>();
  // Every member of every matched group, capped (§34.14); records which groups were used.
  const synonymQueries = (ngram: string): string[] => {
    const qs: string[] = [];
    for (const m of byNgram.get(ngram) ?? []) {
      applied.set(m.terms.join("\u0000"), m.terms);
      for (const q of m.queries) if (q && qs.length < SEARCH_MAX_SYNONYMS_PER_UNIT) qs.push(q);
    }
    return qs;
  };

  const units: string[] = [];
  // Walk positives; runs of bare words take the longest synonym n-gram first, left to right.
  const planned = plan.positives;
  for (let i = 0; i < planned.length; ) {
    const pu = planned[i]!;
    if (pu.unit.kind === "or") {
      const members = pu.members.map((m) => (m.unit.kind === "word" ? orOf([frag(m.frag), ...synonymQueries(m.unit.text)]) : frag(m.frag)));
      const q = orOf(members);
      if (q) units.push(q);
      i++;
      continue;
    }
    if (pu.unit.kind === "phrase") {
      if (frag(pu.frag)) units.push(frag(pu.frag));
      i++;
      continue;
    }
    // A bare word: the longest run of following bare words (≤ 4) that names a synonym member.
    let n2 = 1;
    for (let len = Math.min(SYNONYM_TERM_MAX_WORDS, planned.length - i); len >= 2; len--) {
      const slice = planned.slice(i, i + len);
      if (slice.every((x) => x.unit.kind === "word") && byNgram.has(ngramKey(slice.map((x) => x.unit as SearchWord)))) {
        n2 = len;
        break;
      }
    }
    const slice = planned.slice(i, i + n2);
    const typed = andOf(slice.map((x) => frag(x.frag)));
    const q = orOf([typed, ...synonymQueries(ngramKey(slice.map((x) => x.unit as SearchWord)))]);
    if (q) units.push(q);
    i += n2;
  }

  const excludedParts = plan.negatives.map((x) => frag(x.frag)).filter(Boolean);
  const strict = units.length ? andOf(units) : null;
  const excluded = excludedParts.length ? orOf(excludedParts) : null;
  const substring = p.operatorFree ? p.text : null;
  return {
    strict,
    any: units.length ? orOf(units) : null,
    units,
    excluded,
    relaxable: units.length >= 2 && !p.hasOr,
    exclusionsOnly: strict === null && excluded !== null,
    substring,
    typo: substring && codePoints(substring) >= SEARCH_TYPO_MIN_CHARS ? substring : null,
    synonymsApplied: [...applied.values()],
  };
}

/** Run the normalization query and compose. A driver that returns no row composes to "no FTS units". */
export async function prepareSearch(db: Queryable, p: ParsedSearch): Promise<ComposedSearch> {
  const { sql, params } = normalizationSql(p);
  const { rows } = await db.query(sql, params);
  const row = rows[0] as { frags?: unknown; synonyms?: unknown } | undefined;
  const fragments = Array.isArray(row?.frags) ? (row.frags as unknown[]).map((f) => (typeof f === "string" ? f : "")) : [];
  const synonyms = Array.isArray(row?.synonyms)
    ? (row.synonyms as SynonymMatch[]).filter((m) => m && typeof m.ngram === "string" && Array.isArray(m.terms) && Array.isArray(m.queries))
    : [];
  return composeSearch(p, { fragments, synonyms });
}

// ── SQL fragments (§34.5 / §34.6) ──────────────────────────────────────────────────────────────

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, "\\$&");

export interface SearchMatchSql {
  /** Predicate to AND into the WHERE clause. */
  where: string;
  /** Relevance ORDER BY prefix (tier asc, sub-keys desc — ends with ", "); "" ranks like no query. */
  relevance: string;
  /** How many of `params` the WHERE needs — the any-word coverage keys bind extra parameters that
   *  only the ORDER BY uses, so a count(*) over the same WHERE must pass `params.slice(0, n)`. */
  whereParamCount: number;
}

/** `true` when the strict match (every positive unit) exists among the rows `where` admits — the
 *  caller runs it to decide the any-word fallback (§34.5). Only meaningful when `relaxable`. */
export function searchStrictPredicate(c: ComposedSearch, params: unknown[], alias = "s"): string {
  if (!c.strict) return "false";
  params.push(c.strict);
  let pred = `${alias}.search_tsv @@ $${params.length}::tsquery`;
  if (c.excluded) {
    params.push(c.excluded);
    pred += ` and not (${alias}.search_tsv @@ $${params.length}::tsquery)`;
  }
  return pred;
}

/**
 * The match predicate and relevance keys for one mode (§34.5/§34.6). Tiers: 1 every unit in the
 * name, 2 within name/description/categories, 3 anywhere, 4 some units (fallback only), 5 substring
 * or typo only — then the caller's popularity keys order within a tier.
 */
export function searchMatch(c: ComposedSearch, mode: MatchMode, params: unknown[], alias = "s"): SearchMatchSql {
  const a = alias;
  const bind = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const excluded = c.excluded ? `not (${a}.search_tsv @@ ${bind(c.excluded)}::tsquery)` : null;
  if (c.exclusionsOnly) return { where: excluded!, relevance: "", whereParamCount: params.length };

  const sub = c.substring ? bind(`%${escapeLike(c.substring)}%`) : null;
  const subName = sub ? `(${a}.title ilike ${sub} escape '\\' or ${a}.slug ilike ${sub} escape '\\')` : null;
  const subOther = sub ? `(${a}.description ilike ${sub} escape '\\' or coalesce(${a}.usage_search, '') ilike ${sub} escape '\\')` : null;
  const typoText = c.typo ? bind(c.typo) : null;
  const typo = typoText
    ? `(word_similarity(${typoText}, ${a}.title) >= ${SEARCH_TYPO_THRESHOLD} or word_similarity(${typoText}, ${a}.slug) >= ${SEARCH_TYPO_THRESHOLD})`
    : null;
  // Tier-5 sub-order: substring in the name › substring in description/usage › typo only.
  const subKey = subName ? `case when ${subName} then 2 when ${subOther} then 1 else 0 end` : null;

  // Sort keys are only ever real expressions: a bare integer in ORDER BY would name a select-list
  // COLUMN (ORDER BY 5 = "the fifth column"), so a key that would be constant is simply left out.
  let fts: string | null = null;
  let whereParamCount = params.length;
  const keys: string[] = [];
  if (c.strict && mode === "all") {
    const s = `${bind(c.strict)}::tsquery`;
    whereParamCount = params.length;
    fts = `${a}.search_tsv @@ ${s}`;
    keys.push(`case when ${fts} and ts_filter(${a}.search_tsv, '{a}') @@ ${s} then 1 when ${fts} and ts_filter(${a}.search_tsv, '{a,b,c}') @@ ${s} then 2 when ${fts} then 3 else 5 end asc`);
    if (subKey) keys.push(`case when ${fts} then 0 else ${subKey} end desc`);
  } else if (c.any && mode === "any") {
    const q = `${bind(c.any)}::tsquery`;
    whereParamCount = params.length; // the coverage terms below are ORDER BY-only
    fts = `${a}.search_tsv @@ ${q}`;
    const coverage = c.units.map((u) => `(${a}.search_tsv @@ ${bind(u)}::tsquery)::int`).join(" + ");
    keys.push(`case when ${fts} then 4 else 5 end asc`);
    keys.push(`case when ${fts} then ${coverage} else ${subKey ?? "0"} end desc`);
    keys.push(`case when ${fts} and ts_filter(${a}.search_tsv, '{a,b,c}') @@ ${q} then 1 else 0 end desc`);
  } else if (subKey) {
    keys.push(`${subKey} desc`); // no FTS unit survived: every hit is tier 5
  }
  const alternatives = [fts, subName, subOther, typo].filter((x): x is string => !!x);
  const match = alternatives.length ? `(${alternatives.join(" or ")})` : "false";
  return {
    where: excluded ? `${match} and ${excluded}` : match,
    relevance: keys.length ? `${keys.join(", ")}, ` : "",
    whereParamCount,
  };
}

/** A query resolved for one request, its match already appended to the caller's WHERE. */
export interface ResolvedSearch {
  search: ComposedSearch;
  matchMode: MatchMode;
  /** searchMatch's relevance prefix — pass it to catalogOrderBy. */
  relevance: string;
  /** How many of the caller's params its WHERE now needs (see SearchMatchSql.whereParamCount). */
  whereParamCount: number;
}

/**
 * The whole §34 match for one request, identical on every surface: prepare the query, run the
 * strict-exists probe when the any-word fallback could apply — over the SAME filtered,
 * visibility-scoped rows the caller will list, so a restricted skill can never keep an outsider's
 * query in "all" mode (§34.7) — then append the match predicate to `where` / `params`. `where`
 * must be written against `skills s` joined to `namespaces n`. Null when `q` is no query.
 */
export async function resolveSkillSearch(
  db: Queryable,
  q: string | null | undefined,
  where: string[],
  params: unknown[],
): Promise<ResolvedSearch | null> {
  const parsed = parseSearchQuery(q);
  if (!parsed) return null;
  const search = await prepareSearch(db, parsed);
  let matchMode: MatchMode = "all";
  if (search.relaxable) {
    const probeParams = [...params];
    const probe = searchStrictPredicate(search, probeParams);
    const { rows } = await db.query(
      `select exists (select 1 from skills s join namespaces n on n.id = s.namespace_id
                       where ${[...where, probe].join(" and ")}) as found`,
      probeParams,
    );
    if ((rows[0] as { found?: boolean } | undefined)?.found !== true) matchMode = "any";
  }
  const m = searchMatch(search, matchMode, params);
  where.push(m.where);
  return { search, matchMode, relevance: m.relevance, whereParamCount: m.whereParamCount };
}

/** Bayesian-smoothed rating (§18): (sum + C·m)/(count + C), C = 5 prior votes, m = the global mean. */
export const BAYES_RATING_SQL =
  `((s.rating_sum + 5 * (select coalesce(sum(rating_sum)::numeric / nullif(sum(rating_count), 0), 0) from skills))` +
  ` / (s.rating_count + 5))`;

/**
 * The catalog ORDER BY (§10/§34.6), identical for the catalog grid, the header dropdown and MCP.
 * `relevance` is searchMatch's prefix ("" without a query). `latest` needs the caller's
 * `left join skill_versions sv` + GROUP BY. Total order (… namespace slug, skill slug) so offset
 * pagination is stable.
 */
export function catalogOrderBy(sort: "relevance" | "top_rated" | "latest" | null | undefined, relevance: string): string {
  if (sort === "top_rated") return `${BAYES_RATING_SQL} desc, s.rating_count desc, s.install_count desc, s.title asc, n.slug asc, s.slug asc`;
  if (sort === "latest") return `coalesce(max(sv.created_at), s.created_at) desc, s.install_count desc, s.title asc, n.slug asc, s.slug asc`;
  // Official is a gentle final tiebreaker (§7) so it nudges without overriding a better match.
  return `${relevance}s.install_count desc, ${BAYES_RATING_SQL} desc, (s.official_at is not null) desc, s.title asc, n.slug asc, s.slug asc`;
}

// ── MCP explanations (§34.11) ──────────────────────────────────────────────────────────────────

/** Fields a hit can name in `matchedIn`. `instructions` is the SKILL.md body. */
export const SEARCH_FIELDS = ["title", "slug", "description", "categories", "usage", "instructions"] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

/**
 * Select-list columns explaining why each row matched (run over the returned page only): x_<field>
 * booleans, x_snippet (a ts_headline excerpt from description → usage → instructions, or null) and
 * the substring flags the caller needs to cut a substring snippet itself.
 */
export function searchExplainColumns(c: ComposedSearch, params: unknown[], alias = "s"): string {
  const a = alias;
  const bind = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const q = c.any ? `${bind(c.any)}::tsquery` : null;
  const sub = c.substring ? bind(`%${escapeLike(c.substring)}%`) : null;
  const typoText = c.typo ? bind(c.typo) : null;
  const ts = (expr: string): string | null => (q ? `to_tsvector(${CFG}, ${expr}) @@ ${q}` : null);
  const like = (expr: string): string | null => (sub ? `${expr} ilike ${sub} escape '\\'` : null);
  const typoOn = (expr: string): string | null => (typoText ? `word_similarity(${typoText}, ${expr}) >= ${SEARCH_TYPO_THRESHOLD}` : null);
  const any = (...xs: Array<string | null>): string => {
    const k = xs.filter((x): x is string => !!x);
    return k.length ? `(${k.join(" or ")})` : "false";
  };
  const usage = `coalesce(${a}.usage_search, '')`;
  const body = `coalesce(${a}.content_search, '')`;
  const headline = (expr: string): string =>
    `ts_headline(${CFG}, ${expr}, ${q}, 'StartSel="", StopSel="", MaxWords=30, MinWords=12, MaxFragments=1')`;
  const snippet = q
    ? `case when ${ts(`${a}.description`)} then ${headline(`${a}.description`)}
            when ${ts(usage)} then ${headline(usage)}
            when ${ts(body)} then ${headline(body)} end`
    : "null::text";
  return [
    `${any(ts(`${a}.title`), like(`${a}.title`), typoOn(`${a}.title`))} as x_title`,
    `${any(ts(`${a}.slug`), like(`${a}.slug`), typoOn(`${a}.slug`))} as x_slug`,
    `${any(ts(`${a}.description`), like(`${a}.description`))} as x_description`,
    `${q ? `ts_filter(${a}.search_tsv, '{c}') @@ ${q}` : "false"} as x_categories`,
    `${any(ts(usage), like(usage))} as x_usage`,
    `${any(ts(body))} as x_instructions`,
    `${snippet} as x_snippet`,
    `${any(like(`${a}.description`))} as x_sub_description`,
    `${any(like(usage))} as x_sub_usage`,
  ].join(",\n       ");
}

/** Collapse a headline/excerpt to one line of plain text; null when empty. */
export function cleanSnippet(s: string | null | undefined): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? t : null;
}

/** A ~30-word plain-text window around the first case-insensitive occurrence of `needle`. */
export function substringSnippet(text: string, needle: string, words = 30): string | null {
  let at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return null;
  while (at > 0 && !/\s/.test(text[at - 1]!)) at--; // start at the word containing the match
  const before = text.slice(0, at).split(/\s+/).filter(Boolean);
  const after = text.slice(at).split(/\s+/).filter(Boolean);
  const lead = Math.min(before.length, Math.floor(words / 3));
  return cleanSnippet([...before.slice(before.length - lead), ...after.slice(0, words - lead)].join(" "));
}

// ── SKILL.md body text (§34.3) ─────────────────────────────────────────────────────────────────

/**
 * The searchable text of a SKILL.md: BOM and leading YAML frontmatter stripped (its name/description
 * duplicate the skill's own), NULs removed (Postgres text can't hold them), capped at
 * SEARCH_BODY_MAX_BYTES of UTF-8, cut on a character boundary. Markdown is otherwise kept verbatim.
 */
export function skillMdSearchText(markdown: string): string {
  const text = markdown
    .replace(/^﻿/, "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/, "")
    .replace(/\u0000/g, "");
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= SEARCH_BODY_MAX_BYTES) return text;
  let cut = SEARCH_BODY_MAX_BYTES;
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--; // back off a straddling multi-byte char
  return new TextDecoder().decode(bytes.subarray(0, cut));
}

// ── Synonym input (§34.8) — the shape checks; normalization collisions need PostgreSQL ────────

/**
 * Validate and normalize admin-entered synonym terms (a comma-separated string or an array):
 * trimmed, lowercased, whitespace collapsed, exact duplicates dropped, 2–10 terms of 1–4 words and
 * ≤ 60 characters. The stop-word and cross-group checks run against the database afterwards.
 */
export function parseSynonymTerms(input: unknown): { ok: true; terms: string[] } | { ok: false; error: string } {
  const raw = typeof input === "string" ? input.split(",") : Array.isArray(input) ? input : null;
  if (!raw || raw.some((t) => typeof t !== "string")) return { ok: false, error: "Enter the terms as a comma-separated list." };
  const terms: string[] = [];
  for (const t of raw as string[]) {
    const term = t.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
    if (term && !terms.includes(term)) terms.push(term);
  }
  if (terms.length < SYNONYM_GROUP_MIN_TERMS) return { ok: false, error: `A synonym group needs at least ${SYNONYM_GROUP_MIN_TERMS} different terms.` };
  if (terms.length > SYNONYM_GROUP_MAX_TERMS) return { ok: false, error: `A synonym group holds at most ${SYNONYM_GROUP_MAX_TERMS} terms.` };
  for (const term of terms) {
    if (codePoints(term) > SYNONYM_TERM_MAX_CHARS) return { ok: false, error: `‘${term}’ is longer than ${SYNONYM_TERM_MAX_CHARS} characters.` };
    if (term.split(" ").length > SYNONYM_TERM_MAX_WORDS) return { ok: false, error: `‘${term}’ has more than ${SYNONYM_TERM_MAX_WORDS} words — a synonym term is 1–${SYNONYM_TERM_MAX_WORDS} words.` };
    if (term.includes('"')) return { ok: false, error: `‘${term}’ contains a quotation mark — search reads quotes as an exact-phrase operator.` };
    if (term.startsWith("-")) return { ok: false, error: `‘${term}’ starts with “-” — search reads that as an exclusion.` };
  }
  return { ok: true, terms };
}

/** Display label for a PostgreSQL text-search configuration (§34.9): `german` → "German". */
export function searchLanguageLabel(config: string): string {
  if (config === "simple") return "No stemming (any language)";
  return config ? config[0]!.toUpperCase() + config.slice(1) : config;
}
