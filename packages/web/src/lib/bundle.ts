// Extract an uploaded skill bundle into BundleEntry[] for validation/scanning at upload.
// Supports .tar.gz/.tgz (gzip) and .zip/.skill (zip), detected by magic bytes; a single
// common wrapper directory is stripped. SKILLY_SPEC.md §6.
import { mkdtemp, rm, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { extract } from "tar";
import AdmZip from "adm-zip";
import { detectArchive, stripCommonPrefix, isJunkEntry, type BundleEntry } from "@skilly/shared";

// Decompression-bomb guards: a small archive can expand to many GB. Cap the cumulative
// uncompressed size and entry count, and refuse non-regular entries (symlinks/devices →
// path-traversal). The blocking validator enforces a stricter 10 MB later; these just bound
// what we materialize. SKILLY_SPEC.md §6, §14.
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 2000;

async function walk(dir: string, base: string, out: BundleEntry[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) await walk(abs, base, out);
    else if (entry.isFile()) {
      const rel = relative(base, abs).split(sep).join("/");
      if (!isJunkEntry(rel)) out.push({ path: rel, bytes: await readFile(abs) });
    }
  }
}

async function extractTarGz(targz: Buffer, maxTotalBytes: number): Promise<BundleEntry[]> {
  const dir = await mkdtemp(join(tmpdir(), "skilly-upload-"));
  try {
    const archive = join(dir, "bundle.tgz");
    await writeFile(archive, targz);
    const dest = join(dir, "out");
    await mkdir(dest, { recursive: true });

    let total = 0;
    let count = 0;
    let exceeded = false;
    await extract({
      file: archive,
      cwd: dest,
      strip: 0,
      // entry.size comes from the tar header (known before write), so we cap BEFORE extracting.
      filter: (_p, entry) => {
        const e = entry as unknown as { type?: string; size?: number };
        if (e.type && e.type !== "File" && e.type !== "Directory") return false; // block symlinks/links/devices
        if (e.type === "Directory") return true;
        count += 1;
        total += e.size ?? 0;
        if (count > MAX_ENTRIES || total > maxTotalBytes) { exceeded = true; return false; }
        return true;
      },
    });
    if (exceeded) throw new Error("bundle exceeds size/entry limits");

    const files: BundleEntry[] = [];
    await walk(dest, dest, files);
    return files;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function extractZip(buf: Buffer, maxTotalBytes: number): BundleEntry[] {
  const zip = new AdmZip(buf);
  const out: BundleEntry[] = [];
  let total = 0;
  let count = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    count += 1;
    if (count > MAX_ENTRIES) throw new Error("bundle exceeds size/entry limits");
    // The DECLARED size (e.header.size) is attacker-controlled and can lie, so check it as a
    // cheap pre-filter, then enforce the cap again on the ACTUAL decompressed length — a zip
    // bomb that declares a tiny size still trips here before we accumulate it. Audit P1 (M-3).
    if (total + e.header.size > maxTotalBytes) throw new Error("bundle exceeds size/entry limits");
    const data = e.getData();
    total += data.length;
    if (total > maxTotalBytes) throw new Error("bundle exceeds size/entry limits");
    const path = e.entryName.split("\\").join("/");
    if (!isJunkEntry(path)) out.push({ path, bytes: data });
  }
  return out;
}

/** Fallback archive kind from a filename when magic-byte sniffing is inconclusive. A `.skill`
 *  bundle is a zip (Claude/agent exports), as is `.zip`; tarball extensions map to gzip. */
function kindFromExtension(filename?: string): "gzip" | "zip" | null {
  const name = (filename ?? "").toLowerCase();
  if (name.endsWith(".skill") || name.endsWith(".zip")) return "zip";
  if (name.endsWith(".tgz") || name.endsWith(".tar.gz") || name.endsWith(".gz") || name.endsWith(".tar")) return "gzip";
  return null;
}

export async function extractBundle(archive: Buffer, filename?: string, maxTotalBytes: number = MAX_TOTAL_BYTES): Promise<BundleEntry[]> {
  // Prefer magic bytes (authoritative). Only when the header isn't a recognized gzip/zip
  // signature do we fall back to the filename extension — so a `.skill` export whose bytes don't
  // sniff cleanly is still treated as the zip it is, instead of "unsupported archive". §6.
  // `maxTotalBytes` caps cumulative UNCOMPRESSED size (decompression-bomb guard); callers serving
  // larger configured upload limits raise it so a within-limit bundle isn't pre-rejected.
  const kind = detectArchive(archive) ?? kindFromExtension(filename);
  let files: BundleEntry[];
  if (kind === "gzip") files = await extractTarGz(archive, maxTotalBytes);
  else if (kind === "zip") files = extractZip(archive, maxTotalBytes);
  else throw new Error("unsupported archive (expected .tar.gz, .zip, or .skill)");
  return stripCommonPrefix(files);
}
