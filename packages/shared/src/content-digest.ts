// Content-set digest of a skill bundle — the identity used for hosted duplicate detection
// (SKILLY_SPEC.md §6, §8). Filenames and directory layout are DISREGARDED: we hash each file's
// raw bytes, sort those hex hashes, join them, and hash the result. So two bundles with the same
// SET of file contents — regardless of where the files sit or how the archive was packed — share
// one digest. Junk entries (.DS_Store, __MACOSX, …) are excluded so editor/OS cruft can't perturb
// it. This is packaging-independent, unlike the whole-archive artifact_sha256.
import { createHash } from "node:crypto";
import { isJunkEntry } from "./archive.js";
import type { BundleEntry } from "./validate.js";

export function contentDigest(entries: BundleEntry[]): string {
  const perFile = entries
    .filter((e) => !isJunkEntry(e.path))
    .map((e) => createHash("sha256").update(e.bytes).digest("hex"))
    .sort(); // multiset order-independence: same files in any order → same digest
  return createHash("sha256").update(perFile.join("\n")).digest("hex");
}
