// The ClamAV client moved to @skilly/shared/clamav (§49.2) so the web upload path runs the same
// engine code. This shim keeps the worker's import sites and its fake-clamd test unchanged.
export { frameInstream, parseResponse, scanBytes, clamavScanner, clamavScannerFromEnv, type ClamdOpts } from "@skilly/shared/clamav";
