// Scan pipeline (worker). Composes the shared pure scanners (secret + heuristics) with a
// ClamAV scanner that needs the daemon. ClamAV is included ONLY when CLAMAV_HOST is set,
// so unit tests / hermetic runs stay fast and offline. SKILLY_SPEC.md §6.
import { PURE_SCANNERS, runScanners, countContentRiskFindings, type Scanner, type ScanFinding, type BundleEntry } from "@skilly/shared";
import { M } from "../metrics.js";
import { clamavScannerFromEnv } from "@skilly/shared/clamav";

export type { Scanner, ScanFinding, BundleEntry };

/** Default scanner set, ClamAV added when configured via env. */
export function defaultScanners(): Scanner[] {
  const scanners: Scanner[] = [...PURE_SCANNERS];
  const av = clamavScannerFromEnv();
  if (av) scanners.push(av);
  return scanners;
}

export async function runScanPipeline(
  files: BundleEntry[],
  scanners: Scanner[] = defaultScanners(),
): Promise<ScanFinding[]> {
  const findings = await runScanners(files, scanners);
  countContentRiskFindings(M.contentRiskFindings, findings); // §37.13
  return findings;
}
