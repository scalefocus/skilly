// ClamAV scanner — speaks clamd's INSTREAM protocol over TCP. SKILLY_SPEC.md §6.
//
// INSTREAM wire format: send "zINSTREAM\0", then one or more chunks of
// <uint32be length><bytes>, terminated by a zero-length chunk (4 zero bytes). clamd
// replies "stream: OK\0" or "stream: <signature> FOUND\0".
//
// If clamd is unreachable the scan is reported as advisory "unavailable" rather than
// failing the whole pipeline (scans are advisory; a reviewer still sees the gap).
import net from "node:net";
import type { Scanner, ScanFinding } from "@skilly/shared";

export interface ClamdOpts {
  host: string;
  port?: number;
  timeoutMs?: number;
  /** injectable connector for testing; defaults to net.connect */
  connect?: (port: number, host: string) => net.Socket;
}

/** Frame a file as a complete INSTREAM body (single chunk + terminator). Pure. */
export function frameInstream(bytes: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.byteLength, 0);
  return Buffer.concat([Buffer.from("zINSTREAM\0"), len, Buffer.from(bytes), Buffer.from([0, 0, 0, 0])]);
}

/** Parse a clamd stream reply. Pure. */
export function parseResponse(text: string): { infected: boolean; signature?: string } {
  const t = text.replace(/\0/g, "").trim();
  const m = /stream:\s*(.+?)\s+FOUND/.exec(t);
  if (m) return { infected: true, signature: m[1]!.trim() };
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
    name: "clamav",
    async scan(files) {
      const findings: ScanFinding[] = [];
      for (const f of files) {
        let r: { infected: boolean; signature?: string };
        try {
          r = await scanBytes(f.bytes, opts);
        } catch (e) {
          // clamd unreachable -> advisory gap, reported once; don't fail the pipeline.
          return [{ scanner: "clamav", severity: "info", rule: "scanner-unavailable", message: `clamav scan unavailable: ${String(e)}` }];
        }
        // Record EVERY file's result — including clean ones — so reviewers can see exactly what the
        // AV engine returned per file, even when nothing is flagged. Clean results are `info`
        // (rule `av-clean`) so they never raise severity or trip the override gate; only a real
        // detection is a `critical` `malware` finding. §6, §9.
        if (r.infected) {
          findings.push({ scanner: "clamav", severity: "critical", rule: "malware", message: r.signature ?? "malware detected", path: f.path });
        } else {
          findings.push({ scanner: "clamav", severity: "info", rule: "av-clean", message: "stream: OK", path: f.path });
        }
      }
      return findings;
    },
  };
}
