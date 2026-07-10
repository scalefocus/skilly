// ClamAV client test — runs against an in-process FAKE clamd TCP server implementing the
// INSTREAM handshake, so no real daemon is needed.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { frameInstream, parseResponse, clamavScanner } from "./clamav.js";
import type { BundleEntry } from "@skilly/shared";

const enc = (s: string) => new TextEncoder().encode(s);

let server: net.Server;
let port: number;

before(async () => {
  // Fake clamd: reads an INSTREAM body, responds FOUND if it sees the EICAR marker.
  server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      const term = buf.length >= 4 && buf.subarray(buf.length - 4).equals(Buffer.from([0, 0, 0, 0]));
      if (term) {
        const infected = buf.includes(Buffer.from("EICAR-TEST"));
        sock.write(infected ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

test("frames INSTREAM with length prefix + terminator", () => {
  const f = frameInstream(enc("ab"));
  assert.ok(f.subarray(0, 10).toString().startsWith("zINSTREAM\0"));
  assert.equal(f.readUInt32BE(10), 2); // length of "ab"
  assert.deepEqual(f.subarray(f.length - 4), Buffer.from([0, 0, 0, 0]));
});

test("parses OK and FOUND replies", () => {
  assert.deepEqual(parseResponse("stream: OK\0"), { infected: false });
  assert.deepEqual(parseResponse("stream: Eicar-Test-Signature FOUND\0"), { infected: true, signature: "Eicar-Test-Signature" });
});

test("flags an infected file, passes a clean one", async () => {
  const files: BundleEntry[] = [
    { path: "clean.txt", bytes: enc("just text\n") },
    { path: "bad.txt", bytes: enc("payload EICAR-TEST marker\n") },
  ];
  const findings = await clamavScanner({ host: "127.0.0.1", port }).scan(files);
  // One per file: the clean file is recorded as an advisory `av-clean` result, the infected one
  // as a critical `malware` finding.
  assert.equal(findings.length, 2);
  const malware = findings.find((f) => f.rule === "malware")!;
  assert.equal(malware.path, "bad.txt");
  assert.equal(malware.severity, "critical");
  const clean = findings.find((f) => f.rule === "av-clean")!;
  assert.equal(clean.path, "clean.txt");
  assert.equal(clean.severity, "info");
});

test("reports advisory 'scanner-unavailable' when clamd is unreachable", async () => {
  // Port chosen after closing a throwaway server -> nothing listening -> ECONNREFUSED.
  const tmp = net.createServer();
  const p: number = await new Promise((r) => tmp.listen(0, "127.0.0.1", () => r((tmp.address() as AddressInfo).port)));
  await new Promise<void>((r) => tmp.close(() => r()));
  const findings = await clamavScanner({ host: "127.0.0.1", port: p, timeoutMs: 2000 }).scan([{ path: "a", bytes: enc("x") }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, "scanner-unavailable");
  assert.equal(findings[0]!.severity, "info");
});
