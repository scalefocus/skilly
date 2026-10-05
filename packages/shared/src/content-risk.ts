// The content-risk scanner (SKILLY_SPEC.md §37). It reads a skill's text the way an agent will:
// as instructions. Pure and rule-based — regex and Unicode-table matching only, no I/O, no model,
// no network — so it runs anywhere PURE_SCANNERS run (web upload, MCP, worker pipeline).
//
// Cost discipline (§22 ReDoS rule): every pattern below is linear-time. No nested quantifiers, no
// back-references, and no `[^\n]*` prefix before an alternation. "A and B on the same line" rules
// test two independent patterns instead of one combined one.
import type { BundleEntry } from "./validate.js";
import type { ScanFinding, Scanner, Severity } from "./scan.js";
import { decodeScanText } from "./scan-text.js";
import { CONTENT_RISK_SCANNER, CONTENT_RULESET_VERSION, type ContentRiskRule } from "./content-risk-status.js";

/** Characters of decoded text checked per file (§37.1). */
export const CONTENT_SCAN_MAX_CHARS = 2 * 1024 * 1024;
/** Findings kept per rule per file (§37.2). */
export const CONTENT_FINDINGS_PER_RULE = 5;
/** Excerpt length cap (§37.3). */
export const CONTENT_EXCERPT_MAX = 200;

// ── hidden characters ──────────────────────────────────────────────────────────────────────────

const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);
const isBidi = (cp: number) => (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
const isTag = (cp: number) => cp >= 0xe0000 && cp <= 0xe007f;
const isVariationSelector = (cp: number) => cp === 0xfe0e || cp === 0xfe0f;
const isSkinTone = (cp: number) => cp >= 0x1f3fb && cp <= 0x1f3ff;
const PICTO = /\p{Extended_Pictographic}/u;
const isPicto = (cp: number) => PICTO.test(String.fromCodePoint(cp));

/** Every code point that is invisible / direction-changing and therefore stripped or marked. */
export function isHiddenCodePoint(cp: number): boolean {
  return ZERO_WIDTH.has(cp) || isBidi(cp) || isTag(cp);
}

const hex = (cp: number) => cp.toString(16).toUpperCase().padStart(4, "0");

/** Rewrite hidden characters as visible `⟨U+XXXX⟩` markers so an excerpt carries no payload. */
export function revealHidden(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    out += isHiddenCodePoint(cp) ? `⟨U+${hex(cp)}⟩` : ch;
  }
  return out;
}

/**
 * Indices (in code points of `cps`) of hidden characters that are NOT exempt (§37.2): a ZWJ
 * joining two emoji, variation selectors, a leading BOM, and a well-formed emoji tag sequence
 * (subdivision flags such as England's) are ordinary text.
 */
function hiddenIndices(cps: number[], allowLeadingBom: boolean): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < cps.length) {
    const cp = cps[i]!;
    // Subdivision-flag tag sequence: U+1F3F4, tag letters/digits, U+E007F cancel tag.
    if (cp === 0x1f3f4) {
      let j = i + 1;
      while (j < cps.length && j - i <= 7 && ((cps[j]! >= 0xe0030 && cps[j]! <= 0xe0039) || (cps[j]! >= 0xe0061 && cps[j]! <= 0xe007a))) j++;
      if (j > i + 1 && cps[j] === 0xe007f) { i = j + 1; continue; }
    }
    if (isHiddenCodePoint(cp)) {
      let exempt = false;
      if (cp === 0xfeff && i === 0 && allowLeadingBom) exempt = true;
      if (cp === 0x200d) {
        let p = i - 1;
        while (p >= 0 && (isVariationSelector(cps[p]!) || isSkinTone(cps[p]!))) p--;
        const next = cps[i + 1];
        exempt = p >= 0 && isPicto(cps[p]!) && next !== undefined && isPicto(next);
      }
      if (!exempt) out.push(i);
    }
    i++;
  }
  return out;
}

// ── text model ─────────────────────────────────────────────────────────────────────────────────

interface Line { no: number; text: string }

function splitLines(text: string): Line[] {
  return text.split(/\r\n|\n|\r/).map((t, i) => ({ no: i + 1, text: t }));
}

const isMarkdownPath = (p: string) => /\.(?:md|markdown|mdx)$/i.test(p);

/**
 * Normalized copy of `text` for phrase matching (§37.1): hidden characters removed, NFKC, typographic
 * apostrophes folded, lower-cased, every whitespace run (newlines included) collapsed to one space.
 * `lineOf[i]` is the 1-based source line of normalized character i, so matches map back to a line.
 */
export function normalizeForMatching(text: string): { norm: string; lineOf: number[] } {
  const out: string[] = [];
  const lineOf: number[] = [];
  let line = 1;
  let lastSpace = true;
  let prevCR = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 10) { if (!prevCR) line++; prevCR = false; }
    else if (cp === 13) { line++; prevCR = true; }
    else prevCR = false;
    // ASCII fast path: no NFKC or Unicode whitespace lookups needed.
    if (cp < 128) {
      if (cp === 32 || (cp >= 9 && cp <= 13)) {
        if (!lastSpace) { out.push(" "); lineOf.push(line); lastSpace = true; }
        continue;
      }
      out.push(cp >= 65 && cp <= 90 ? String.fromCharCode(cp + 32) : ch);
      lineOf.push(line);
      lastSpace = false;
      continue;
    }
    if (isHiddenCodePoint(cp)) continue;
    if (/\s/u.test(ch)) {
      if (!lastSpace) { out.push(" "); lineOf.push(line); lastSpace = true; }
      continue;
    }
    const folded = (ch === "’" || ch === "‘" || ch === "ʼ" ? "'" : ch.normalize("NFKC")).toLowerCase();
    // One lineOf entry per UTF-16 code unit, so regex match indices map back correctly.
    out.push(folded);
    for (let k = 0; k < folded.length; k++) lineOf.push(line);
    lastSpace = false;
  }
  return { norm: out.join(""), lineOf };
}

// ── phrase and pattern catalogs ────────────────────────────────────────────────────────────────
// Phrase patterns run on the NORMALIZED text (lower-case, single spaces). Keep them linear.

export const OVERRIDE_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget) (?:all |any )?(?:of )?(?:the |your |my |these )?(?:previous|prior|above|earlier|preceding|foregoing|original) (?:instructions?|rules?|prompts?|context|directions?|guidance|messages?)\b/g,
  /\b(?:ignore|disregard|forget) (?:your |the )?system prompt\b/g,
  /\byou are no longer\b/g,
  /\bnew instructions ?:/g,
  /\boverride (?:your |the |all )?(?:safety|guidelines|guardrails|rules|restrictions)\b/g,
];

export const CONCEALMENT_PATTERNS: RegExp[] = [
  /\b(?:do not|don't|never) (?:tell|inform|show|notify|alert|warn|mention (?:this |it )?to|reveal (?:this |it )?to) the user\b/g,
  /\bwithout (?:telling|informing|asking|notifying|alerting|warning) the user\b/g,
  /\bthe user (?:must|should|will) (?:not|never) (?:know|see|find out|notice|be told)\b/g,
  /\bhide (?:this|it|these|that|them) from the user\b/g,
  /\bsilently (?:send|upload|run|execute|delete|install|post|transmit|exfiltrate|copy|forward)\b/g,
];

export const PROMPT_REFERENCE_PATTERNS: RegExp[] = [/\bsystem prompt\b/g, /\bdeveloper message\b/g, /\bjailbreak/g, /\bdan mode\b/g];

// Credential stores and environment dumps. Run per RAW line, case-insensitive.
export const CREDENTIAL_PATTERNS: RegExp[] = [
  /[/\\]\.ssh(?:[/\\]|\b)/i,
  /\bid_(?:rsa|ed25519|ecdsa|dsa)\b/i,
  /\.aws[/\\]credentials\b/i,
  /\.azure[/\\]/i,
  /\.config[/\\]gcloud\b/i,
  /\.netrc\b/i,
  /\.git-credentials\b/i,
  /\.npmrc\b/i,
  /\.pypirc\b/i,
  /\.docker[/\\]config\.json\b/i,
  /\.kube[/\\]config\b/i,
  /\bsecurity find-(?:generic|internet)-password\b/i,
  /\bprintenv\b *(?:\||>)/i,
  /(?:^|[\s;&|(])env *(?:\||>)/i,
  /\b(?:get-childitem|gci|ls|dir) +env:/i,
  /\$env:\*/i,
];

// Outbound transmission: a tool AND a sending flag on the same raw line (two linear tests), or a
// prose verb AND a URL target (also two tests). §37.2 `cr-credential-exfil`.
const TRANSMIT_PAIRS: [RegExp, RegExp][] = [
  [/\bcurl\b/i, /(?:^|\s)(?:-d|--data(?:-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file)(?=[\s=]|$)/],
  [/\bwget\b/i, /--post-(?:data|file)\b/i],
  [/\b(?:nc|ncat|netcat)\b/i, /\b(?:nc|ncat|netcat) +[\w.-]+ +\d{2,5}\b/i],
  [/\bscp\b/i, /\S@[\w.-]+:/],
  [/\binvoke-(?:webrequest|restmethod)\b|\b(?:iwr|irm)\b/i, /-(?:body|infile)\b/i],
  [/\b(?:send|upload|post|exfiltrate|transmit|forward)\b/i, /\bto https?:\/\//i],
];

// ── finding helpers ────────────────────────────────────────────────────────────────────────────

const SEV: Record<Exclude<ContentRiskRule, "cr-homoglyph" | "cr-scanned" | "cr-truncated">, Severity> = {
  "cr-hidden-unicode": "high",
  "cr-hidden-markup": "high",
  "cr-credential-exfil": "high",
  "cr-credential-access": "medium",
  "cr-instruction-override": "medium",
  "cr-concealment": "medium",
  "cr-prompt-reference": "low",
};

/** Excerpt of `lineText` around column `col` (code points), hidden characters made visible (§37.3). */
export function excerptAround(lineText: string, col = 0): string {
  const cps = [...lineText];
  const half = 80;
  const start = Math.max(0, col - half);
  const slice = cps.slice(start, start + 160).join("");
  let ex = revealHidden(slice).trim();
  if (start > 0) ex = `…${ex}`;
  if (start + 160 < cps.length) ex = `${ex}…`;
  if ([...ex].length > CONTENT_EXCERPT_MAX) ex = `${[...ex].slice(0, CONTENT_EXCERPT_MAX - 1).join("")}…`;
  return ex;
}

interface Hit { line: number; col: number; message: string; severity?: Severity }

/** Keep the first 5 hits per rule and note how many more there were (§37.2). */
function emit(out: ScanFinding[], rule: ContentRiskRule, path: string, lines: Line[], hits: Hit[], defaultSeverity: Severity): void {
  const kept = hits.slice(0, CONTENT_FINDINGS_PER_RULE);
  const more = hits.length - kept.length;
  kept.forEach((h, idx) => {
    const lineText = lines[h.line - 1]?.text ?? "";
    out.push({
      scanner: CONTENT_RISK_SCANNER,
      severity: h.severity ?? defaultSeverity,
      rule,
      message: idx === kept.length - 1 && more > 0 ? `${h.message} (and ${more} more in this file)` : h.message,
      path,
      line: h.line,
      excerpt: excerptAround(lineText, h.col),
      ruleset: CONTENT_RULESET_VERSION,
    });
  });
}

/** Column (in code points) of the first non-space char of the line the normalized match maps to. */
function phraseHits(norm: string, lineOf: number[], patterns: RegExp[], message: (m: string) => string): Hit[] {
  const hits: Hit[] = [];
  const seenLines = new Set<number>();
  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of norm.matchAll(re)) {
      const line = lineOf[m.index!] ?? 1;
      if (seenLines.has(line)) continue;
      seenLines.add(line);
      hits.push({ line, col: 0, message: message(m[0]) });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

// ── homoglyphs ─────────────────────────────────────────────────────────────────────────────────

const WORD = /[\p{L}\p{M}]+/gu;
const LATIN = /\p{Script=Latin}/u;
// Only letters that actually pass for Latin ones count (§37.2), so a Greek μ in "100μs" never
// trips the rule. Each script's set is its Latin look-alikes.
const LOOKALIKE: [Set<string>, string][] = [
  [new Set([..."аеорсухіјѕԁԛԝһӏԍлтАВЕКМНОРСТХІЈЅԌԚԜ"]), "Cyrillic"],
  [new Set([..."οανρτυικΑΒΕΖΗΙΚΜΝΟΡΤΥΧ"]), "Greek"],
  [new Set([..."սօոհցռԱՏՕ"]), "Armenian"],
];

/** Mixed-script words on one line. `codeRanges` are [start, end) code-unit spans that count as code. */
function homoglyphHits(line: Line, wholeLineIsCode: boolean, codeRanges: [number, number][]): Hit[] {
  const hits: Hit[] = [];
  WORD.lastIndex = 0;
  for (const m of line.text.matchAll(WORD)) {
    const word = m[0];
    if (!LATIN.test(word)) continue;
    let script: string | null = null;
    const foreign: number[] = [];
    for (const ch of word) {
      for (const [set, name] of LOOKALIKE) {
        if (set.has(ch)) { script ??= name; if (foreign.length < 3) foreign.push(ch.codePointAt(0)!); }
      }
    }
    if (!script) continue;
    const at = m.index!;
    const inCode = wholeLineIsCode || codeRanges.some(([s, e]) => at >= s && at < e);
    const cps = foreign.map((c) => `U+${hex(c)}`).join(", ");
    hits.push({
      line: line.no,
      col: [...line.text.slice(0, at)].length,
      message: `\`${word}\` mixes Latin and ${script} (${cps})`,
      severity: inCode ? "high" : "medium",
    });
  }
  return hits;
}

// ── the scanner ────────────────────────────────────────────────────────────────────────────────

/** Scan one text file. Exported for tests and the false-positive report. */
export function scanContentFile(path: string, rawText: string): ScanFinding[] {
  const out: ScanFinding[] = [];
  let text = rawText;
  if (text.length > CONTENT_SCAN_MAX_CHARS) {
    text = text.slice(0, CONTENT_SCAN_MAX_CHARS);
    out.push({
      scanner: CONTENT_RISK_SCANNER,
      severity: "info",
      rule: "cr-truncated",
      message: `only the first ${CONTENT_SCAN_MAX_CHARS / (1024 * 1024)} MB of this file was checked`,
      path,
      ruleset: CONTENT_RULESET_VERSION,
    });
  }
  const lines = splitLines(text);
  const markdown = isMarkdownPath(path);

  // cr-hidden-unicode — raw text, every file.
  const hidden: Hit[] = [];
  lines.forEach((ln, idx) => {
    const cps = [...ln.text].map((c) => c.codePointAt(0)!);
    // A leading BOM is only exempt at the very start of the file.
    const marks = hiddenIndices(cps, idx === 0);
    if (marks.length === 0) return;
    const names = [...new Set(marks.map((i) => `U+${hex(cps[i]!)}`))].slice(0, 3).join(", ");
    hidden.push({ line: ln.no, col: marks[0]!, message: `hidden character${marks.length === 1 ? "" : "s"} on this line (${names})` });
  });
  emit(out, "cr-hidden-unicode", path, lines, hidden, SEV["cr-hidden-unicode"]);

  // cr-homoglyph — every file; code context decides severity.
  const glyphs: Hit[] = [];
  let fence: string | null = null;
  for (const ln of lines) {
    if (markdown) {
      const fm = /^ {0,3}(`{3,}|~{3,})/.exec(ln.text);
      if (fm) {
        const marker = fm[1]!;
        if (fence === null) fence = marker[0]!.repeat(marker.length);
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        continue;
      }
      const ranges: [number, number][] = [];
      if (fence === null) {
        for (const m of ln.text.matchAll(/`[^`]+`/g)) ranges.push([m.index!, m.index! + m[0].length]);
      }
      glyphs.push(...homoglyphHits(ln, fence !== null, ranges));
    } else {
      glyphs.push(...homoglyphHits(ln, true, []));
    }
  }
  emit(out, "cr-homoglyph", path, lines, glyphs, "high");

  // Credentials — raw lines, every file.
  const credLines: Hit[] = [];
  const sendLines: Hit[] = [];
  for (const ln of lines) {
    const cred = CREDENTIAL_PATTERNS.find((re) => re.test(ln.text));
    if (cred) {
      const m = cred.exec(ln.text);
      credLines.push({ line: ln.no, col: m ? [...ln.text.slice(0, m.index)].length : 0, message: `refers to a credential store or environment dump (${(m?.[0] ?? "").trim()})` });
    }
    if (TRANSMIT_PAIRS.some(([a, b]) => a.test(ln.text) && b.test(ln.text))) {
      sendLines.push({ line: ln.no, col: 0, message: "" });
    }
  }
  if (credLines.length > 0 && sendLines.length > 0) {
    const firstCred = credLines[0]!.line;
    emit(out, "cr-credential-exfil", path, lines,
      sendLines.map((h) => ({ ...h, message: `sends data to a remote destination in a file that reads credentials (line ${firstCred})` })),
      SEV["cr-credential-exfil"]);
  } else {
    emit(out, "cr-credential-access", path, lines, credLines, SEV["cr-credential-access"]);
  }

  if (markdown) {
    const { norm, lineOf } = normalizeForMatching(text);
    emit(out, "cr-instruction-override", path, lines,
      phraseHits(norm, lineOf, OVERRIDE_PATTERNS, (m) => `tells the agent to drop its instructions ("${m}")`), SEV["cr-instruction-override"]);
    emit(out, "cr-concealment", path, lines,
      phraseHits(norm, lineOf, CONCEALMENT_PATTERNS, (m) => `tells the agent to hide something from the user ("${m}")`), SEV["cr-concealment"]);
    emit(out, "cr-prompt-reference", path, lines,
      phraseHits(norm, lineOf, PROMPT_REFERENCE_PATTERNS, (m) => `mentions "${m}"`), SEV["cr-prompt-reference"]);

    // cr-hidden-markup — an HTML comment whose content trips an instruction or credential rule.
    const markup: Hit[] = [];
    let from = 0;
    // Line counting is incremental (never re-scans from the start), so many comments stay linear.
    let countedTo = 0;
    let startLine = 1;
    const advanceTo = (pos: number) => {
      for (let i = countedTo; i < pos; i++) {
        const c = text.charCodeAt(i);
        if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) startLine++;
      }
      countedTo = pos;
    };
    for (;;) {
      const open = text.indexOf("<!--", from);
      if (open < 0) break;
      const close = text.indexOf("-->", open + 4);
      const body = text.slice(open + 4, close < 0 ? text.length : close);
      advanceTo(open);
      const bn = normalizeForMatching(body).norm;
      const instr = [...OVERRIDE_PATTERNS, ...CONCEALMENT_PATTERNS].some((re) => { re.lastIndex = 0; return re.test(bn); });
      const cred = CREDENTIAL_PATTERNS.some((re) => re.test(body));
      if (instr || cred) {
        markup.push({ line: startLine, col: 0, message: `an HTML comment hidden from the rendered page contains ${instr ? "instructions to the agent" : "a credential reference"}` });
      }
      if (close < 0) break;
      from = close + 3;
    }
    emit(out, "cr-hidden-markup", path, lines, markup, SEV["cr-hidden-markup"]);
  }

  return out;
}

/** The content-risk scanner (§37). Always emits exactly one `cr-scanned` marker (§37.2). */
export const contentRiskScanner: Scanner = {
  name: CONTENT_RISK_SCANNER,
  scan(files: BundleEntry[]): ScanFinding[] {
    const out: ScanFinding[] = [];
    for (const f of files) {
      const text = decodeScanText(f.bytes);
      if (text == null) continue;
      out.push(...scanContentFile(f.path, text));
    }
    out.push({
      scanner: CONTENT_RISK_SCANNER,
      severity: "info",
      rule: "cr-scanned",
      message: `content check ruleset ${CONTENT_RULESET_VERSION}`,
      ruleset: CONTENT_RULESET_VERSION,
    });
    return out;
  },
};

/**
 * A stable fingerprint of the rule catalog — every pattern source and severity. A unit test pins it
 * together with CONTENT_RULESET_VERSION, so a rule change without a version bump fails the build.
 */
export function contentRuleCatalogFingerprint(): string {
  const parts = [
    JSON.stringify(SEV),
    ...OVERRIDE_PATTERNS.map(String),
    ...CONCEALMENT_PATTERNS.map(String),
    ...PROMPT_REFERENCE_PATTERNS.map(String),
    ...CREDENTIAL_PATTERNS.map(String),
    ...TRANSMIT_PAIRS.map(([a, b]) => `${a}&${b}`),
    [...ZERO_WIDTH].join(","),
    "bidi:202A-202E,2066-2069;tags:E0000-E007F;exempt:zwj-emoji,fe0e,fe0f,bom0,subdivision-flag",
    `homoglyph:${LOOKALIKE.map(([set, n]) => `${n}=${[...set].join("")}`).join(",")};code=high;prose=medium`,
    `caps:${CONTENT_SCAN_MAX_CHARS},${CONTENT_FINDINGS_PER_RULE},${CONTENT_EXCERPT_MAX}`,
  ];
  // FNV-1a 32-bit — no node:crypto, so the module stays isomorphic.
  let h = 0x811c9dc5;
  for (const ch of parts.join("\n")) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
