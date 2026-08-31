// The §29 MCP endpoint: `POST /mcp`, Streamable HTTP, JSON-RPC 2.0.
//
// Deliberately STATELESS — no server-held session beyond the OAuth token — so the worker can be
// replicated without sticky routing, and so MCP serving is not gated on the leader lock (the lock
// guards batch jobs; this is request-serving, like the git smart server).
//
// The deprecated HTTP+SSE transport is not implemented.
import { Router, type Request, type Response } from "express";
import express from "express";
import type { Pool } from "pg";
import {
  JSONRPC_VERSION,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSIONS_SUPPORTED,
  MCP_SERVER_NAME,
  MCP_WRITE_TOOLS,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  buildSkillResourceUri,
  isJsonRpcRequest,
  parseSkillResourceUri,
  resourceTemplates,
  rpcError,
  rpcResult,
  toolError,
  wwwAuthenticate,
  type JsonRpcRequest,
} from "@skilly/shared";
import { APP_VERSION } from "@skilly/shared/version";
import { authenticate, type McpCaller } from "./auth.js";
import { getMcpSettings } from "./settings.js";
import { logMcpEvent, type McpErrorCode } from "./systemLog.js";
import { RESOURCE_READ_LIMIT, RPC_ENVELOPE_LIMIT, checkMcpLimit, toolLimit } from "./rateLimit.js";
import { callTool, toolDefinitions } from "./tools.js";
import { findVisibleSkill, listVersions, resolveReadVersion } from "./queries.js";
import { readBundleFile, readSkillMd, recordMcpAdoption } from "./content.js";
import { publicBaseUrl } from "./url.js";
import { M } from "../metrics.js";

const MCP_PATH = "/mcp";

/** The one client-facing 401. It never says WHY — the reason lives in the system log (§25). */
function unauthorized(res: Response): void {
  res
    .status(401)
    .setHeader("WWW-Authenticate", wwwAuthenticate(publicBaseUrl()))
    .json({ error: "unauthorized" });
}

interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

/**
 * Read one `skilly://skill/...` resource. Gated exactly like the detail page: visibility-filtered,
 * yanked versions only by exact pin, pointer skills served from the skilly-stored mirror (never
 * upstream). A first SKILL.md read counts as adoption.
 */
async function readResource(pool: Pool, caller: McpCaller, uri: string): Promise<ResourceContent[]> {
  const ref = parseSkillResourceUri(uri);
  if (!ref) throw new RpcFault(RPC_INVALID_PARAMS, `not a skilly resource URI: ${uri}`);

  const skill = await findVisibleSkill(pool, caller.access, ref.namespaceSlug, ref.skillSlug);
  // "Not visible" and "doesn't exist" are the same answer (invariant #3).
  if (!skill) throw new RpcFault(RPC_INVALID_PARAMS, "no such skill, or it isn't visible to you");

  const versions = await listVersions(pool, skill.id);
  const picked = resolveReadVersion(versions, ref.semver);
  if ("error" in picked) throw new RpcFault(RPC_INVALID_PARAMS, picked.error);
  const key = picked.version.artifactObjectKey;
  if (!key) throw new RpcFault(RPC_INVALID_PARAMS, "this version's files aren't available yet — they're still being mirrored");

  const settings = await getMcpSettings(pool);

  if (!ref.path) {
    const text = await readSkillMd(pool, key, settings.resourceBytes);
    if (text == null) throw new RpcFault(RPC_INVALID_PARAMS, "this version has no readable SKILL.md");
    recordMcpAdoption(pool, skill.id, caller.userId);
    const warning = picked.yanked
      ? `> **Note:** version ${picked.version.semver} of this skill is yanked; it is served only because you pinned it exactly.\n\n`
      : "";
    return [
      {
        uri: buildSkillResourceUri(skill.namespaceSlug, skill.skillSlug, ref.semver ?? undefined),
        mimeType: "text/markdown",
        text: warning + text,
      },
    ];
  }

  const file = await readBundleFile(pool, key, ref.path, settings.resourceBytes);
  if (file.kind === "missing") throw new RpcFault(RPC_INVALID_PARAMS, `no such file in this version: ${ref.path}`);
  if (file.kind === "too_large") {
    throw new RpcFault(
      RPC_INVALID_PARAMS,
      `that file is ${file.bytes} bytes, over this registry's ${settings.resourceBytes}-byte single-read limit — download the version from the web UI instead`,
    );
  }
  const outUri = buildSkillResourceUri(skill.namespaceSlug, skill.skillSlug, ref.semver, ref.path);
  return file.kind === "text"
    ? [{ uri: outUri, mimeType: "text/plain", text: file.text }]
    : [{ uri: outUri, mimeType: file.mimeType, blob: file.base64 }];
}

/** A JSON-RPC-level failure (bad params, unknown method) as opposed to a tool-level error. */
class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function handleRpc(pool: Pool, caller: McpCaller, req: JsonRpcRequest): Promise<Record<string, unknown> | null> {
  const id = (req.id ?? null) as string | number | null;
  const params = (req.params ?? {}) as Record<string, unknown>;

  switch (req.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : null;
      const version =
        asked && (MCP_PROTOCOL_VERSIONS_SUPPORTED as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: {
          tools: {},
          // `listChanged: false` is honest: the template list is static, and we never enumerate
          // the catalog, so there is nothing to notify about.
          resources: { listChanged: false, subscribe: false },
        },
        serverInfo: { name: MCP_SERVER_NAME, version: APP_VERSION, title: "skilly registry" },
        instructions:
          "This is a skilly skill registry. Use search_skills to find a skill (the resource list is templates only — the catalog is never enumerated), get_skill_content to read one, and install_skill to get an `npx skills add` command to run. You act as the signed-in user with exactly their permissions: review decisions, administration and destructive actions are not available here.",
      });
    }

    // Notifications carry no id and expect no response.
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        tools: toolDefinitions().map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false },
        })),
      });

    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      if (!name) throw new RpcFault(RPC_INVALID_PARAMS, "tools/call requires a tool name");
      if (!toolDefinitions().some((t) => t.name === name)) {
        // An unknown tool is a tool-level error, not a transport failure: the model can recover by
        // calling tools/list.
        return rpcResult(id, toolError(`unknown tool: ${name}. Call tools/list to see what this server offers.`));
      }
      const gate = checkMcpLimit(name, caller.userId, caller.clientDbId, toolLimit(name));
      if (!gate.ok) {
        M.mcpRateLimited.inc();
        await logMcpEvent(pool, {
          errorCode: "mcp_rate_limited",
          status: 429,
          route: MCP_PATH,
          path: MCP_PATH,
          message: `rate limit hit on ${name}`,
          userId: caller.userId,
        });
        return rpcResult(id, toolError(`rate limit exceeded for ${name} — retry in ${gate.retryAfterSeconds}s`));
      }
      const outcome = MCP_WRITE_TOOLS.has(name) ? "write" : "read";
      try {
        const result = await callTool(pool, caller, name, args);
        M.mcpToolCalls.inc({ tool: name, outcome });
        return rpcResult(id, result);
      } catch (e) {
        M.mcpToolCalls.inc({ tool: name, outcome: "error" });
        console.error(JSON.stringify({ level: "error", msg: "mcp tool failed", tool: name, err: String(e instanceof Error ? e.message : e) }));
        // Never leak an internal message to a client; the stack is on stdout for the SIEM.
        return rpcResult(id, toolError(`${name} failed unexpectedly — try again, or use the web UI if it persists`));
      }
    }

    case "resources/list":
      // TEMPLATES ONLY, BY DESIGN (§29). Clients pull listed resources into context, so a
      // few-hundred-skill catalog would flood the agent. Discovery is search_skills.
      return rpcResult(id, { resources: [], resourceTemplates: resourceTemplates() });

    case "resources/templates/list":
      return rpcResult(id, { resourceTemplates: resourceTemplates() });

    case "resources/read": {
      const uri = typeof params.uri === "string" ? params.uri : "";
      if (!uri) throw new RpcFault(RPC_INVALID_PARAMS, "resources/read requires a uri");
      const gate = checkMcpLimit("resources/read", caller.userId, caller.clientDbId, RESOURCE_READ_LIMIT);
      if (!gate.ok) {
        M.mcpRateLimited.inc();
        throw new RpcFault(RPC_INVALID_REQUEST, `rate limit exceeded — retry in ${gate.retryAfterSeconds}s`);
      }
      return rpcResult(id, { contents: await readResource(pool, caller, uri) });
    }

    case "prompts/list":
      // Prompts are not exposed in v1 (§29): they'd duplicate /quick-start with a second thing to
      // keep in sync, for no capability the tools don't already provide. An empty list is kinder
      // than a method error to clients that probe unconditionally.
      return rpcResult(id, { prompts: [] });

    default:
      throw new RpcFault(RPC_METHOD_NOT_FOUND, `unknown method: ${req.method}`);
  }
}

/** The Express router for `POST /mcp` (plus a GET that explains itself rather than 404-ing). */
export function mcpRouter(pool: Pool): Router {
  const r = Router();
  const json = express.json({ limit: "24mb", type: ["application/json"] });

  r.get(MCP_PATH, async (_req, res) => {
    // The deprecated SSE transport opened a stream on GET. We answer with a clear pointer instead
    // of a bare 405 so a misconfigured client's error message is actionable.
    const { enabled } = await getMcpSettings(pool);
    res
      .status(enabled ? 405 : 503)
      .json({
        error: enabled
          ? "this endpoint speaks Streamable HTTP — POST JSON-RPC here (the deprecated HTTP+SSE transport is not supported)"
          : "MCP is disabled on this registry",
      });
  });

  r.post(MCP_PATH, json, async (req: Request, res: Response) => {
    const { enabled } = await getMcpSettings(pool);
    if (!enabled) {
      await logMcpEvent(pool, { errorCode: "mcp_disabled", status: 503, route: MCP_PATH, path: MCP_PATH, message: "request refused — MCP disabled" });
      res.status(503).json({ error: "MCP is disabled on this registry" });
      return;
    }

    const auth = await authenticate(pool, req.header("authorization"));
    if (!auth.ok) {
      M.mcpAuthFailures.inc();
      if (auth.reason !== "missing_token") {
        // The response is identical in every case; only the log distinguishes them (§25).
        await logMcpEvent(pool, {
          errorCode: auth.reason as McpErrorCode,
          status: 401,
          route: MCP_PATH,
          path: MCP_PATH,
          message: `MCP request refused: ${auth.reason}`,
        });
      }
      unauthorized(res);
      return;
    }
    const caller = auth.caller;

    const envelope = checkMcpLimit("rpc", caller.userId, caller.clientDbId, RPC_ENVELOPE_LIMIT);
    if (!envelope.ok) {
      M.mcpRateLimited.inc();
      await logMcpEvent(pool, {
        errorCode: "mcp_rate_limited",
        status: 429,
        route: MCP_PATH,
        path: MCP_PATH,
        message: "envelope rate limit hit",
        userId: caller.userId,
      });
      res.status(429).setHeader("retry-after", String(envelope.retryAfterSeconds)).json({ error: "rate limit exceeded" });
      return;
    }

    const body = req.body as unknown;
    const batch = Array.isArray(body) ? body : [body];
    if (batch.length === 0 || batch.length > 20) {
      res.status(400).json(rpcError(null, RPC_INVALID_REQUEST, "expected a JSON-RPC request (batches of 1–20)"));
      return;
    }

    const responses: Array<Record<string, unknown>> = [];
    for (const entry of batch) {
      if (!isJsonRpcRequest(entry)) {
        responses.push(rpcError(null, RPC_INVALID_REQUEST, `not a JSON-RPC ${JSONRPC_VERSION} request`));
        continue;
      }
      try {
        const out = await handleRpc(pool, caller, entry);
        if (out) responses.push(out);
      } catch (e) {
        const id = (entry.id ?? null) as string | number | null;
        if (e instanceof RpcFault) {
          responses.push(rpcError(id, e.code, e.message));
        } else {
          console.error(JSON.stringify({ level: "error", msg: "mcp rpc failed", method: entry.method, err: String(e instanceof Error ? e.message : e) }));
          responses.push(rpcError(id, RPC_INTERNAL_ERROR, "internal error"));
        }
      }
    }

    // All-notifications batch: nothing to answer with (JSON-RPC says return no body).
    if (responses.length === 0) {
      res.status(202).end();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(Array.isArray(body) ? responses : responses[0]);
  });

  return r;
}
