// Extract a skill artifact bundle into the in-memory file list synthesizeVersion expects.
// Supports .tar.gz/.tgz (gzip) and .zip/.skill (zip), detected by magic bytes; a single
// common wrapper directory is stripped. SKILLY_SPEC.md §6.
import { mkdtemp, rm, readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { extract } from "tar";
import AdmZip from "adm-zip";
import { detectArchive, stripCommonPrefix, isJunkEntry } from "@skilly/shared";
import type { SkillFile } from "./synth.js";

// Decompression-bomb guards on the publish/reprovision/refresh path (runs on the singleton
// leader). Mirror the web upload caps so a hostile stored artifact can't OOM/disk-fill the
// worker and stall all background work. The byte cap is the CONFIGURED max_bundle_bytes (passed
// by callers via bundleContentCap) so a bundle accepted at upload always extracts here; it falls
// back to 50 MB when a caller doesn't specify one. Audit P1 (F3). §6.
const DEFAULT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 5000;

async function walk(dir: string, base: string, out: SkillFile[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, base, out);
    } else if (entry.isFile()) {
      const rel = relative(base, abs).split(sep).join("/");
      if (isJunkEntry(rel)) continue;
      const bytes = await readFile(abs);
      const st = await stat(abs);
      const executable = (st.mode & 0o111) !== 0 || /\.(sh|bash)$/.test(rel) || rel.startsWith("scripts/");
      out.push({ path: rel, bytes, mode: executable ? "100755" : "100644" });
    }
  }
}

async function extractTarGz(targz: Buffer, maxTotalBytes: number): Promise<SkillFile[]> {
  const dir = await mkdtemp(join(tmpdir(), "skilly-bundle-"));
  try {
    const archivePath = join(dir, "bundle.tgz");
    await writeFile(archivePath, targz);
    const dest = join(dir, "out");
    await mkdir(dest, { recursive: true });
    let total = 0;
    let count = 0;
    let exceeded = false;
    await extract({
      file: archivePath,
      cwd: dest,
      strip: 0,
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
    if (exceeded) throw new Error("artifact exceeds size/entry limits");
    const files: SkillFile[] = [];
    await walk(dest, dest, files);
    return files;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function extractZip(buf: Buffer, maxTotalBytes: number): SkillFile[] {
  const zip = new AdmZip(buf);
  const out: SkillFile[] = [];
  let total = 0;
  let count = 0;
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    count += 1;
    if (count > MAX_ENTRIES) throw new Error("artifact exceeds size/entry limits");
    if (total + e.header.size > maxTotalBytes) throw new Error("artifact exceeds size/entry limits");
    const data = e.getData(); // cap on ACTUAL decompressed length (declared size can lie)
    total += data.length;
    if (total > maxTotalBytes) throw new Error("artifact exceeds size/entry limits");
    const path = e.entryName.split("\\").join("/");
    if (isJunkEntry(path)) continue;
    const executable = /\.(sh|bash)$/.test(path) || path.startsWith("scripts/");
    out.push({ path, bytes: data, mode: executable ? "100755" : "100644" });
  }
  return out;
}

export async function extractBundle(archive: Buffer, maxTotalBytes: number = DEFAULT_MAX_TOTAL_BYTES): Promise<SkillFile[]> {
  const kind = detectArchive(archive);
  let files: SkillFile[];
  if (kind === "gzip") files = await extractTarGz(archive, maxTotalBytes);
  else if (kind === "zip") files = extractZip(archive, maxTotalBytes);
  else throw new Error("unsupported archive (expected .tar.gz, .zip, or .skill)");
  return stripCommonPrefix(files) as SkillFile[];
}
