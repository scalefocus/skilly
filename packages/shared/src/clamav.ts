// ClamAV scanner — speaks clamd's INSTREAM protocol over TCP. SKILLY_SPEC.md §6, §49.2.
//
// Lives in @skilly/shared (server-only subpath `@skilly/shared/clamav`, never imported by a client
// component) so BOTH ingest doors run the same engine code: the web upload route / chunked
// finaliser and the worker's MCP inline upload, pointer pre-scan, mirror and AV sweep.
//
// INSTREAM wire format: send "zINSTREAM\0", then one or more chunks of
// <uint32be length><bytes>, terminated by a zero-length chunk (4 zero bytes). clamd
// replies "stream: OK\0" or "stream: <signature> FOUND\0".
//
// If clamd is unreachable the scan records ONE `scanner-unavailable` finding at severity HIGH
// (§49.2): the upload still succeeds, but the report now trips the override gate until the worker's
// AV sweep supersedes it with a real engine result. Before the October 2026 review this was an
// `info` finding, so an engine outage silently read as "no findings".
import net from "node:net";
import type { Scanner, ScanFinding } from "./scan.js";

export interface ClamdOpts {
  host: string;
  port?: number;
  timeoutMs?: number;
  /** injectable connector for testing; defaults to net.connect */
  connect?: (port: number, host: string) => net.Socket;
}

export const CLAMAV_SCANNER = "clamav";
export const AV_UNAVAILABLE_RULE = "scanner-unavailable";

/** Frame a file as a complete INSTREAM body (single chunk + terminator). Pure. */
export function frameInstream(bytes: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.byteLength, 0);
  return Buffer.concat([Buffer.from("zINSTREAM\0"), len, Buffer.from(bytes), Buffer.from([0, 0, 0, 0])]);
}

/**
 * Parse a clamd stream reply (`stream: OK` or `stream: <signature> FOUND`). Pure.
 *
 * Linear string scanning, no regex: the reply is daemon-supplied input, and the former
 * `/stream:\s*(.+?)\s+FOUND/` backtracked quadratically on `stream:` followed by many spaces
 * (CodeQL js/polynomial-redos, code-scanning alert 31). Same semantics: the signature is the
 * non-empty text between `stream:` and the first `FOUND` that is preceded by whitespace.
 */
export function parseResponse(text: string): { infected: boolean; signature?: string } {
  const t = text.split("\0").join("").trim();
  const start = t.indexOf("stream:");
  if (start < 0) return { infected: false };
  const rest = t.slice(start + "stream:".length);
  for (let at = rest.indexOf("FOUND"); at > 0; at = rest.indexOf("FOUND", at + 1)) {
    const before = rest.charCodeAt(at - 1);
    if (before !== 32 && before !== 9 && before !== 10 && before !== 13) continue;
    const signature = rest.slice(0, at).trim();
    if (signature) return { infected: true, signature };
  }
  return { infected: false };
}

export function scanBytes(bytes: Uint8Array, opts: ClamdOpts): Promise<{ infected: boolean; signature?: string }> {
  return new Promise((resolve, reject) => {
    const port = opts.port ?? 3310;
    const socket = opts.connect ? opts.connect(port, opts.host) : net.connect(port, opts.host);
    let resp = "";
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    socket.setTimeout(opts.timeoutMs ?? 10_000);
    socket.on("connect", () => socket.write(frameInstream(bytes)));
    socket.on("data", (d: Buffer) => {
      resp += d.toString();
      if (/OK|FOUND/.test(resp)) socket.end();
    });
    socket.on("end", () => done(() => resolve(parseResponse(resp))));
    socket.on("close", () => done(() => resolve(parseResponse(resp))));
    socket.on("timeout", () => { socket.destroy(); done(() => reject(new Error("clamd timeout"))); });
    socket.on("error", (e) => done(() => reject(e)));
  });
}

export function clamavScanner(opts: ClamdOpts): Scanner {
  return {
    name: CLAMAV_SCANNER,
    async scan(files) {
      const findings: ScanFinding[] = [];
      for (const f of files) {
        let r: { infected: boolean; signature?: string };
        try {
          r = await scanBytes(f.bytes, opts);
        } catch (e) {
          // clamd unreachable -> a HIGH gap, reported once; the pipeline still completes (§49.2).
          return [{ scanner: CLAMAV_SCANNER, severity: "high", rule: AV_UNAVAILABLE_RULE, message: `clamav scan unavailable: ${String(e)}` }];
        }
        // Record EVERY file's result — including clean ones — so reviewers can see exactly what the
        // AV engine returned per file, even when nothing is flagged. Clean results are `info`
        // (rule `av-clean`) so they never raise severity or trip the override gate; only a real
        // detection is a `critical` `malware` finding. §6, §9.
        if (r.infected) {
          findings.push({ scanner: CLAMAV_SCANNER, severity: "critical", rule: "malware", message: r.signature ?? "malware detected", path: f.path });
        } else {
          findings.push({ scanner: CLAMAV_SCANNER, severity: "info", rule: "av-clean", message: "stream: OK", path: f.path });
        }
      }
      return findings;
    },
  };
}

/** The ClamAV scanner for this process when `CLAMAV_HOST` is set, else null (§49.2). */
export function clamavScannerFromEnv(env: NodeJS.ProcessEnv = process.env): Scanner | null {
  if (!env.CLAMAV_HOST) return null;
  return clamavScanner({ host: env.CLAMAV_HOST, port: Number(env.CLAMAV_PORT ?? 3310) });
}
