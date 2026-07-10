"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useApi, useEnterKey, ScrollToTop, formatCount } from "../components/ui";
import { SkillCard, type CatalogEntry } from "../components/SkillCard";

export default function Overview() {
  const { status } = useSession();
  const authed = status === "authenticated";
  const router = useRouter();
  // Press Enter anywhere on the overview to jump into the catalog.
  useEnterKey(() => router.push("/catalog"));
  // Skip the calls entirely when signed out — these APIs 401 for anonymous visitors.
  const { data } = useApi<{ skills: CatalogEntry[] }>(authed ? "/api/skills" : null);
  // O(1) pre-aggregated read (install_counters, summed across all months) — safe to fetch per page view.
  const { data: stats } = useApi<{ totalInstalls: number }>(authed ? "/api/stats" : null);
  // Featured skills (§7): platform-admin-pinned spotlight, visibility-filtered server-side. Empty
  // (or none visible to this viewer) ⇒ the section is omitted entirely.
  const { data: featured } = useApi<{ skills: CatalogEntry[] }>(authed ? "/api/skills/featured" : null);
  const featuredSkills = featured?.skills ?? [];
  const skills = data?.skills ?? [];
  const hosted = skills.filter((s) => s.type === "hosted").length;
  const pointer = skills.filter((s) => s.type === "pointer").length;

  return (
    <div>
      <ScrollToTop />
      <section className="page-head reveal">
        <div className="eyebrow">Self-hosted · Entra-governed</div>
        <h1 className="page-title" style={{ maxWidth: "16ch" }}>
          One controlled home for every agent&nbsp;skill.
        </h1>
        <p className="page-sub">
          Publish, version, govern and distribute Anthropic-style <span className="mono">SKILL.md</span> packages across your
          organization — discovered through a catalog, installed with the tools your teams already use.
        </p>
        {/* Catalog and propose are signed-in-only pages — only offer them to signed-in users. */}
        {authed && (
          <div style={{ display: "flex", gap: 12, marginTop: 26 }}>
            <Link href="/catalog" className="btn btn-primary">Browse the catalog →</Link>
            <Link href="/propose" className="btn">Propose a skill</Link>
          </div>
        )}
      </section>

      {authed && (
        <section className="stat-row reveal" style={{ animationDelay: "80ms", marginBottom: 44 }}>
          <div className="stat"><div className="stat-num">{formatCount(skills.length)}</div><div className="stat-label">Skills visible to you</div></div>
          <div className="stat"><div className="stat-num">{formatCount(hosted)}</div><div className="stat-label">Hosted</div></div>
          <div className="stat"><div className="stat-num">{formatCount(pointer)}</div><div className="stat-label">External</div></div>
          <div className="stat"><div className="stat-num">{formatCount(stats?.totalInstalls ?? 0)}</div><div className="stat-label">Total installs</div></div>
        </section>
      )}

      {authed && featuredSkills.length > 0 && (
        <section className="reveal" style={{ animationDelay: "120ms", marginBottom: 44 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 18 }}>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 24 }}>Featured skills</h2>
          </div>
          <div className="card-grid">
            {featuredSkills.map((s, i) => (
              <SkillCard key={`${s.namespaceSlug}/${s.skillSlug}`} s={s} index={i} />
            ))}
          </div>
        </section>
      )}

      <section className="reveal" style={{ animationDelay: "140ms", marginBottom: 44 }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 24, marginBottom: 6 }}>Installing is one command.</h2>
        <p className="muted" style={{ marginBottom: 16, maxWidth: "62ch" }}>
          Every skill — org-wide or restricted — installs through an authenticated git URL that carries your own
          personal <strong>key</strong>. Generate one from any skill&rsquo;s page; the standard
          <span className="mono"> npx skills add</span> client does the rest — no bespoke CLI, and no anonymous installs.
        </p>
        <div className="code" style={{ maxWidth: 760 }}>
          <span className="prompt">$</span>
          <code className="code-cmd">npx skills add https://x-access-token:<span style={{ color: "var(--accent-2)" }}>&lt;your-key&gt;</span>@skilly.your-org.com/team-a/pdf-tools.git#v1.4.0</code>
        </div>
        <ul className="muted" style={{ maxWidth: "62ch", marginTop: 16, paddingLeft: 0, listStyle: "none", display: "grid", gap: 10, fontSize: 14 }}>
          <li>
            <strong style={{ color: "var(--ink)" }}>Key-only, even for public skills.</strong> The key identifies you and is
            required for every install — there are no tokenless clones. Each install is recorded, and you can manage or
            revoke any key from <span className="mono">Installed skills</span> (uninstalling revokes it).
          </li>
          <li>
            <strong style={{ color: "var(--ink)" }}>Pin a version, or track latest.</strong> End the URL with
            <span className="mono"> #v1.4.0</span> for a reproducible, pinned install, or drop the fragment to always pull
            the latest stable release.
          </li>
          <li>
            <strong style={{ color: "var(--ink)" }}>Expiry is yours to choose.</strong> When you generate the command, set
            the key to expire on a date (up to a year out) or <span className="mono">Never</span>. After it expires the key
            simply stops working — the skill and your other keys are untouched.
          </li>
        </ul>
      </section>

      {authed && (
        <section className="reveal" style={{ animationDelay: "160ms" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 18 }}>
            <h2 style={{ fontFamily: "var(--font-display)", fontSize: 24 }}>Recently published</h2>
            <Link href="/catalog" className="btn-ghost mono" style={{ fontSize: 12 }}>view all →</Link>
          </div>
          {skills.length === 0 ? (
            <div className="card card-pad muted">Nothing here yet — once skills are published they’ll surface in your catalog.</div>
          ) : (
            <div className="card-grid">
              {skills.slice(0, 6).map((s, i) => (
                <SkillCard key={`${s.namespaceSlug}/${s.skillSlug}`} s={s} index={i} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
