// One-off false-positive budget report for the content-risk scanner (SKILLY_SPEC.md §37.14).
// READ-ONLY: scans every active version's stored artifact with the current ruleset and prints
// per-rule counts plus a few sample excerpts. Writes nothing — no reports, no audit, no
// notifications. Run before a release that changes the ruleset; paste the summary into the PR.
//
//   pnpm --filter @skilly/worker build && pnpm --filter @skilly/worker content-risk:report
//
// Needs the worker's DATABASE_URL and S3_* environment, like the worker itself.
import { contentRiskScanner, CONTENT_RULESET_VERSION, type ScanFinding } from "@skilly/shared";
import { pool } from "../db.js";
import { s3ArtifactStore } from "../storage/objectStore.js";
import { extractAny } from "../git/contentBackfill.js";

const SAMPLES_PER_RULE = Number(process.env.CONTENT_RISK_REPORT_SAMPLES ?? 5);

async function main(): Promise<void> {
  const store = s3ArtifactStore();
  const { rows } = await pool.query<{ key: string; label: string }>(
    `select distinct on (sv.artifact_object_key) sv.artifact_object_key as key,
            n.slug || '/' || s.slug || '@' || sv.semver as label
       from skill_versions sv
       join skills s on s.id = sv.skill_id and s.status = 'active'
       join namespaces n on n.id = s.namespace_id
      where sv.status = 'active' and sv.artifact_object_key is not null
      order by sv.artifact_object_key`,
  );
  const byRule = new Map<string, { findings: number; versions: Set<string>; samples: string[]; severities: Set<string> }>();
  let scanned = 0;
  let unreadable = 0;
  let flaggedVersions = 0;
  for (const r of rows) {
    let findings: ScanFinding[];
    try {
      findings = contentRiskScanner.scan(await extractAny(await store.get(r.key))) as ScanFinding[];
    } catch {
      unreadable++;
      continue;
    }
    scanned++;
    if (findings.some((f) => f.severity === "high" || f.severity === "critical")) flaggedVersions++;
    for (const f of findings) {
      if (f.rule === "cr-scanned") continue;
      const e = byRule.get(f.rule) ?? { findings: 0, versions: new Set<string>(), samples: [], severities: new Set<string>() };
      e.findings++;
      e.versions.add(r.label);
      e.severities.add(f.severity);
      if (e.samples.length < SAMPLES_PER_RULE) e.samples.push(`${r.label} ${f.path ?? ""}:${f.line ?? "?"}  ${f.excerpt ?? f.message}`);
      byRule.set(f.rule, e);
    }
  }
  console.log(`Content-risk false-positive report — ruleset ${CONTENT_RULESET_VERSION}`);
  console.log(`Artifacts scanned: ${scanned} of ${rows.length} (${unreadable} unreadable)`);
  console.log(`Artifacts with a gate-tripping finding: ${flaggedVersions}`);
  console.log("");
  console.log("rule".padEnd(26) + "severities".padEnd(16) + "findings".padStart(9) + "versions".padStart(10));
  for (const [rule, e] of [...byRule.entries()].sort((a, b) => b[1].versions.size - a[1].versions.size)) {
    console.log(rule.padEnd(26) + [...e.severities].join(",").padEnd(16) + String(e.findings).padStart(9) + String(e.versions.size).padStart(10));
  }
  for (const [rule, e] of byRule) {
    console.log(`\n${rule} — samples`);
    for (const s of e.samples) console.log(`  ${s}`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
