// Mention token grammar (SKILLY_SPEC.md §24 "Mentions"). A message body may embed
// `<@uuid>` (a person) / `<#uuid>` (a skill) tokens — a grammar deliberately DISTINCT from
// markdown so the skill-discussion markdown renderer and the mention resolver never collide.
// Client-safe, dependency-free: shared by the web composer/renderer, the API validators, and
// the worker's email renderer.

export type MentionKind = "user" | "skill";

export interface MentionRef {
  kind: MentionKind;
  /** The target's uuid, lowercased. */
  id: string;
}

export type MentionSegment =
  | { type: "text"; text: string }
  | { type: "mention"; kind: MentionKind; id: string; token: string };

/** Hard cap on DISTINCT mentions per message (§24) — posts above it are rejected (422). */
export const MAX_MENTIONS_PER_MESSAGE = 10;

/** Raw width of one token: `<@` + 36-char uuid + `>` — used for the raw-length backstop. */
export const MENTION_TOKEN_RAW_LEN = 39;

// `<@uuid>` / `<#uuid>`, uuid hex case-insensitive. NB: no `g` flag here — every user gets a
// fresh regex from tokenRe() so shared-lastIndex bugs can't happen.
const TOKEN_SRC = "<([@#])([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>";
const tokenRe = () => new RegExp(TOKEN_SRC, "g");

const kindOf = (sigil: string): MentionKind => (sigil === "@" ? "user" : "skill");

/** The literal token for a mention — also the key of the API's per-thread resolution map. */
export function mentionToken(kind: MentionKind, id: string): string {
  return `<${kind === "user" ? "@" : "#"}${id.toLowerCase()}>`;
}

/**
 * Split a body into text/mention segments for rendering. Purely lexical — no code-fence
 * masking here: the markdown renderer keeps code spans/fences on a path that never resolves
 * segments, and plain-text contexts have no code semantics (§24).
 */
export function splitMentionSegments(body: string): MentionSegment[] {
  const out: MentionSegment[] = [];
  const re = tokenRe();
  let last = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m.index > last) out.push({ type: "text", text: body.slice(last, m.index) });
    out.push({ type: "mention", kind: kindOf(m[1]!), id: m[2]!.toLowerCase(), token: mentionToken(kindOf(m[1]!), m[2]!) });
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push({ type: "text", text: body.slice(last) });
  return out;
}

/**
 * Mask markdown code regions (fenced blocks + inline backtick spans) with spaces, preserving
 * length/positions, so tokens inside them are neither extracted nor counted as mentions (§24:
 * they render literally). Mirrors the web Markdown renderer's line-based fence rule.
 */
function maskMarkdownCode(body: string): string {
  const lines = body.split("\n");
  const isFence = (l: string) => /^\s*```/.test(l);
  let inFence = false;
  const masked = lines.map((line) => {
    if (isFence(line)) {
      inFence = !inFence;
      return " ".repeat(line.length);
    }
    if (inFence) return " ".repeat(line.length);
    // Inline `code` spans (same non-greedy single-line rule as the renderer).
    return line.replace(/`[^`]+`/g, (s) => " ".repeat(s.length));
  });
  return masked.join("\n");
}

/**
 * The DISTINCT mentions of a body, in first-appearance order. With `markdown: true` (the skill
 * discussion), tokens inside code fences / inline backticks are ignored — they render literally,
 * create no `message_mentions` row, and notify no one.
 */
export function extractMentions(body: string, opts: { markdown?: boolean } = {}): MentionRef[] {
  const scan = opts.markdown ? maskMarkdownCode(body) : body;
  const seen = new Set<string>();
  const out: MentionRef[] = [];
  const re = tokenRe();
  for (let m = re.exec(scan); m; m = re.exec(scan)) {
    const kind = kindOf(m[1]!);
    const id = m[2]!.toLowerCase();
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, id });
  }
  return out;
}

/**
 * Body length with each mention token counted as ONE character — what the 500/4000 caps measure
 * (§24: the cap follows what the reader sees, not the token's raw width). Deliberately counts
 * every token as 1 even inside markdown code (more permissive, never stricter; the raw-length
 * backstop below bounds storage regardless).
 */
export function mentionCollapsedLength(body: string): number {
  return body.replace(tokenRe(), "x").length;
}

/** The absolute raw-byte backstop for a cap: the cap plus every allowed token at full width. */
export function maxRawMentionLength(cap: number): number {
  return cap + MAX_MENTIONS_PER_MESSAGE * (MENTION_TOKEN_RAW_LEN - 1);
}
