// Line-level unified diff — pure, dependency-free. Powers the reviewer file-change view's inline
// diffs for text/Markdown files (SKILLY_SPEC.md §8). LCS-based and BOUNDED: a file with more than
// DIFF_MAX_LINES_PER_SIDE lines is refused ("too large to diff — download to compare") so a
// pathological file can never blow up the review page or the server's memory.

export type DiffLineType = "context" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** 1-based line number on the OLD side; null on added lines. */
  oldLine: number | null;
  /** 1-based line number on the NEW side; null on deleted lines. */
  newLine: number | null;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface LineDiff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

/** Max lines per side before we refuse to diff (matches the ~2,000-changed-line cap, §8). */
export const DIFF_MAX_LINES_PER_SIDE = 2000;
/** Unified-diff context lines around each change. */
const CONTEXT = 3;

export type DiffResult = { ok: true; diff: LineDiff } | { ok: false; reason: "too-large" };

/** Split into lines, treating a trailing newline as a terminator (so "a\n" is one line, not two). */
function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Unified line diff of `oldText` → `newText`. Returns hunks (with CONTEXT lines around each change)
 * plus added/removed counts, or `{ ok: false, reason: "too-large" }` when either side exceeds the
 * line cap. Pure; safe to run on untrusted file contents (bounded work, no regex on the content).
 */
export function diffLines(oldText: string, newText: string): DiffResult {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length > DIFF_MAX_LINES_PER_SIDE || b.length > DIFF_MAX_LINES_PER_SIDE) {
    return { ok: false, reason: "too-large" };
  }

  // LCS length table: dp[i*W+j] = LCS(a[i:], b[j:]). Filled bottom-up.
  const n = a.length;
  const m = b.length;
  const W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] =
        a[i] === b[j]
          ? dp[(i + 1) * W + (j + 1)]! + 1
          : Math.max(dp[(i + 1) * W + j]!, dp[i * W + (j + 1)]!);
    }
  }

  // Backtrack into a flat edit script (context / del / add), preferring deletes on ties so the
  // output is deterministic.
  const script: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      script.push({ type: "context", text: a[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (dp[(i + 1) * W + j]! >= dp[i * W + (j + 1)]!) {
      script.push({ type: "del", text: a[i]!, oldLine: i + 1, newLine: null });
      removed++;
      i++;
    } else {
      script.push({ type: "add", text: b[j]!, oldLine: null, newLine: j + 1 });
      added++;
      j++;
    }
  }
  for (; i < n; i++) {
    script.push({ type: "del", text: a[i]!, oldLine: i + 1, newLine: null });
    removed++;
  }
  for (; j < m; j++) {
    script.push({ type: "add", text: b[j]!, oldLine: null, newLine: j + 1 });
    added++;
  }

  return { ok: true, diff: { hunks: groupHunks(script), added, removed } };
}

/** Group the edit script into unified-diff hunks: each change plus CONTEXT lines, merged when
 *  their context windows touch. Returns [] when nothing changed. */
function groupHunks(script: DiffLine[]): DiffHunk[] {
  const changed: number[] = [];
  for (let k = 0; k < script.length; k++) if (script[k]!.type !== "context") changed.push(k);
  if (!changed.length) return [];

  const ranges: Array<[number, number]> = [];
  for (const k of changed) {
    const s = Math.max(0, k - CONTEXT);
    const e = Math.min(script.length - 1, k + CONTEXT);
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else ranges.push([s, e]);
  }

  return ranges.map(([s, e]) => {
    const lines = script.slice(s, e + 1);
    const oldStart = lines.find((l) => l.oldLine != null)?.oldLine ?? 0;
    const newStart = lines.find((l) => l.newLine != null)?.newLine ?? 0;
    const oldLines = lines.filter((l) => l.type !== "add").length;
    const newLines = lines.filter((l) => l.type !== "del").length;
    return { oldStart, oldLines, newStart, newLines, lines };
  });
}
