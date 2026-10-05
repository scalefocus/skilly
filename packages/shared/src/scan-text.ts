// Text decoding shared by the text-oriented scanners (SKILLY_SPEC.md §6, §37). A file that looks
// binary (a NUL byte in its first 8 KB) is skipped by every scanner.
export function decodeScanText(bytes: Uint8Array): string | null {
  const sample = bytes.subarray(0, 8000);
  for (const b of sample) if (b === 0) return null;
  return new TextDecoder().decode(bytes);
}
