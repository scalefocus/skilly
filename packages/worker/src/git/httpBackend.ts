// CGI bridge to `git http-backend` — the canonical git smart-HTTP server. We gate access
// in Express (authorize.ts) and then delegate the protocol to git itself. Read-only:
// only upload-pack reaches here. Requires the `git` binary in the runtime image.
// SKILLY_SPEC.md §9.
import { spawn } from "node:child_process";
import type { Request, Response } from "express";

export interface BackendOptions {
  /** GIT_PROJECT_ROOT — directory containing the <ns>/<skill>.git repos. */
  projectRoot: string;
  /** PATH_INFO — the repo-relative path, e.g. /team-a/pdf.git/info/refs */
  pathInfo: string;
  queryString: string;
}

/**
 * Stream an HTTP request through `git http-backend` and write its CGI response to `res`.
 * Resolves true once the response completes successfully.
 */
export function gitHttpBackend(req: Request, res: Response, opts: BackendOptions): Promise<boolean> {
  return new Promise((resolveDone, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_PROJECT_ROOT: opts.projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: opts.pathInfo,
      REQUEST_METHOD: req.method,
      QUERY_STRING: opts.queryString,
      CONTENT_TYPE: req.header("content-type") ?? "",
      // Advertise protocol v2 if the client asked for it.
      GIT_PROTOCOL: req.header("git-protocol") ?? "",
      REMOTE_USER: "skilly",
    };

    const cgi = spawn("git", ["http-backend"], { env });
    cgi.on("error", reject);
    req.pipe(cgi.stdin);

    // Parse CGI headers (terminated by a blank line) then stream the body.
    let headerBuf = Buffer.alloc(0);
    let headersParsed = false;

    cgi.stdout.on("data", (chunk: Buffer) => {
      if (headersParsed) {
        res.write(chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      // git http-backend emits Unix line endings (\n), not CRLF (\r\n).
      // Search for both separators; prefer the one that appears first.
      const sepCRLF = headerBuf.indexOf("\r\n\r\n");
      const sepLF   = headerBuf.indexOf("\n\n");
      const sep = sepCRLF >= 0 && (sepLF < 0 || sepCRLF < sepLF) ? sepCRLF : sepLF;
      if (sep === -1) return;
      const sepLen = sep === sepCRLF ? 4 : 2;

      const rawHeaders = headerBuf.subarray(0, sep).toString("utf8");
      const rest = headerBuf.subarray(sep + sepLen);
      headersParsed = true;

      let status = 200;
      for (const line of rawHeaders.split(/\r?\n/)) {
        const cidx = line.indexOf(":");
        if (cidx === -1) continue;
        const key = line.slice(0, cidx).trim();
        const value = line.slice(cidx + 1).trim();
        if (key.toLowerCase() === "status") {
          status = parseInt(value, 10) || 200;
        } else {
          res.setHeader(key, value);
        }
      }
      res.status(status);
      if (rest.length) res.write(rest);
    });

    cgi.stdout.on("end", () => {
      res.end();
      resolveDone(res.statusCode >= 200 && res.statusCode < 400);
    });
    cgi.stderr.on("data", () => {
      /* git http-backend diagnostics; intentionally not logged to avoid leaking creds */
    });
  });
}
