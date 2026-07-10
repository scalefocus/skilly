// Scan pipeline (worker). Composes the shared pure scanners (secret + heuristics) with a
// ClamAV scanner that needs the daemon. ClamAV is included ONLY when CLAMAV_HOST is set,
// so unit tests / hermetic runs stay fast and offline. SKILLY_SPEC.md §6.
import { PURE_SCANNERS, runScanners, type Scanner, type ScanFinding, type BundleEntry } from "@skilly/shared";
import { clamavScanner } from "./clamav.js";

export type { Scanner, ScanFinding, BundleEntry };

/** Default scanner set, ClamAV added when configured via env. */
export function defaultScanners(): Scanner[] {
  const scanners: Scanner[] = [...PURE_SCANNERS];
  if (process.env.CLAMAV_HOST) {
    scanners.push(clamavScanner({ host: process.env.CLAMAV_HOST, port: Number(process.env.CLAMAV_PORT ?? 3310) }));
  }
  return scanners;
}

export async function runScanPipeline(
  files: BundleEntry[],
  scanners: Scanner[] = defaultScanners(),
): Promise<ScanFinding[]> {
  return runScanners(files, scanners);
}
