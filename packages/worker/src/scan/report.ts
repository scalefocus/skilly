// Persist a scan report at INGEST, keyed to the artifact (the skill_version may not exist
// yet at hosted-upload time). Reviewers find it via the proposal's artifact key, pre-accept.
// SKILLY_SPEC.md §6, §9.
import type { Pool } from "pg";
import { maxSeverity, type ScanFinding } from "@skilly/shared";

export async function writeArtifactScanReport(
  pool: Pool,
  artifactKey: string,
  findings: ScanFinding[],
): Promise<void> {
  await pool.query(
    `insert into scan_reports (subject_type, subject_id, scanner, findings, severity, status)
     values ('artifact', $1, 'pipeline', $2::jsonb, $3, 'scanned')`,
    [artifactKey, JSON.stringify(findings), maxSeverity(findings) ?? "info"],
  );
}
