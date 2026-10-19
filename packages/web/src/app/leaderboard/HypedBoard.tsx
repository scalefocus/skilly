"use client";
// The "Hyped skills" tab of /leaderboard (SKILLY_SPEC.md §50.6): skills ranked by the §50.4 hype
// score over the trailing 7 days — no window or sort toggles. Each row: rank, icon + title, score
// and hype count, the hyper strip (12 + "+N"), and the Hype button. Rows in the current top N (as
// of the last sweep) carry the 🔥 Hyped pill. A line under the header shows the viewer's budget.
import { useState } from "react";
import Link from "next/link";
import { useApi, EmptyState, formatCount } from "../../components/ui";
import { SkillIcon } from "../../components/SkillIcon";
import { useDateFmt } from "../../components/DateFormat";
import { HypeButton, HypedPill, HyperStrip, type HyperChip } from "../../components/Hype";

interface Row {
  rank: number;
  skillId: string;
  namespaceSlug: string;
  skillSlug: string;
  title: string;
  icon: { url: string | null; emoji: string | null } | null;
  score: number;
  hypeCount: number;
  isTop: boolean;
  hypers: HyperChip[];
  hyperTotal: number;
  canHype: boolean;
  hypedByMe: boolean;
  isMaintainer: boolean;
  /** Still open to new hypes (young and small). */
  open: boolean;
}

interface Board {
  entries: Row[];
  budget: { budget: number; used: number; remaining: number; nextAt: string | null } | null;
  topN: number;
}

export function HypedBoard() {
  const { data, loading, error, reload } = useApi<Board>("/api/leaderboard/hyped");
  const fmt = useDateFmt();
  const [msg, setMsg] = useState<string | null>(null);
  const entries = data?.entries ?? [];
  const b = data?.budget ?? null;

  return (
    <div data-testid="hyped-board">
      <p className="page-sub" style={{ marginBottom: 6 }}>
        New and small skills people are excited about, ranked by hypes in the last 7 days. Early hypes count for more.
        The top {data?.topN ?? 5} are <strong>Hyped</strong>.
      </p>
      {b && (
        <p className="muted mono" style={{ fontSize: 12, marginBottom: 16 }} data-testid="hype-budget">
          You have {b.remaining} of {b.budget} {b.budget === 1 ? "hype" : "hypes"} left
          {b.remaining === 0 && b.nextAt ? <> · next frees {fmt.dateTime(b.nextAt)}</> : null}
        </p>
      )}
      {msg && <div style={{ fontSize: 13, color: "var(--danger)", marginBottom: 10 }}>{msg}</div>}

      {error ? (
        <EmptyState icon="⚠" title="Couldn’t load the Hyped skills board" hint={error} />
      ) : loading ? (
        <div className="skeleton" style={{ height: 240, borderRadius: "var(--radius)" }} />
      ) : entries.length === 0 ? (
        <>
          <EmptyState icon="🔥" title="Nobody has hyped a skill in the last 7 days" hint="Found something new? Hype it." />
          <div style={{ textAlign: "center", marginTop: -8 }}>
            <Link href="/catalog" className="btn-ghost mono" style={{ fontSize: 12 }}>browse the catalog →</Link>
          </div>
        </>
      ) : (
        <div className="rows reveal">
          {entries.map((e) => (
            <div className="row lb-row" key={e.skillId} style={{ alignItems: "center", gap: 12 }} data-testid="hyped-row">
              <span className="mono" style={{ fontSize: 14, fontWeight: 600, color: e.rank <= 3 ? "var(--accent-2)" : "var(--faint)", minWidth: 28, textAlign: "right" }}>
                {e.rank}
              </span>
              <SkillIcon icon={e.icon} title={e.title} size={34} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <Link href={`/skills/${e.namespaceSlug}/${e.skillSlug}`} style={{ fontWeight: 600, fontSize: 14.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {e.title}
                  </Link>
                  {e.isTop && <HypedPill />}
                </div>
                <div className="muted mono" style={{ fontSize: 11.5, marginBottom: 6 }}>
                  @{e.namespaceSlug}/{e.skillSlug} · {e.hypeCount} {e.hypeCount === 1 ? "hype" : "hypes"}
                </div>
                <HyperStrip ns={e.namespaceSlug} slug={e.skillSlug} hypers={e.hypers} total={e.hyperTotal} size={22} />
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 600 }}>{formatCount(e.score)}</div>
                <div className="muted mono" style={{ fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase" }}>points</div>
              </div>
              <div className="lb-actions" style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                <HypeButton
                  ns={e.namespaceSlug}
                  slug={e.skillSlug}
                  state={{ canHype: e.canHype, hypedByMe: e.hypedByMe, remaining: b?.remaining ?? 0, nextAt: b?.nextAt ?? null, open: e.open, isMaintainer: e.isMaintainer }}
                  onHyped={() => { setMsg(null); reload(); }}
                  onError={setMsg}
                  compact
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
