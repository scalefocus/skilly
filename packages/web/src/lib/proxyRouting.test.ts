// Routing guard (SKILLY_SPEC.md §13): no web page or route handler may sit under a path the reverse
// proxy hands to the worker. The proxy routes by path alone, so such a page works in `pnpm dev` and
// in the e2e suite (both reach Next directly, with no proxy in front) and is unreachable in
// production. That shipped once: the §29 MCP setup page lived at /mcp, the worker's MCP endpoint,
// and behind the proxy it only ever showed the worker's 405 JSON until it moved to /mcp-server.
//
// Reads the two routing configs the repo ships (deploy/Caddyfile and the Helm Ingress) and matches
// every route under src/app against their worker-bound rules the way each proxy matches them. The
// Caddyfile parser throws on syntax it does not model, so a new kind of rule cannot slip past it.
// Run via `pnpm --filter @skilly/web test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCP_ENDPOINT_PATH, MCP_PAGE_PATH } from "@skilly/shared";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const APP_DIR = fileURLToPath(new URL("../app/", import.meta.url));
const CADDYFILE = readFileSync(join(REPO, "deploy", "Caddyfile"), "utf8");
const INGRESS = readFileSync(join(REPO, "deploy", "helm", "skilly", "templates", "ingress.yaml"), "utf8");

type Matcher = (path: string) => boolean;
interface Rule {
  label: string;
  toWorker: boolean;
  matches: Matcher;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── Web routes ──────────────────────────────────────────────────────────────────────────────────

const ROUTE_FILE = /^(page|route)\.(tsx?|jsx?)$/;

/** One app-dir segment as it appears in a URL; null when the segment adds nothing to the URL. */
function urlSegment(seg: string): string | null {
  if (seg.startsWith("(") && seg.endsWith(")")) return null; // route group
  if (seg.startsWith("@")) return null; // parallel-route slot
  if (seg.startsWith("[[...") || seg.startsWith("[...")) return "sample/rest"; // catch-all
  if (seg.startsWith("[")) return "sample"; // dynamic segment
  return seg;
}

/** Every page and route handler under src/app, as a sample URL path. */
function webRoutes(dir = APP_DIR, segments: string[] = []): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && ROUTE_FILE.test(e.name))) out.push(`/${segments.join("/")}`);
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith("_")) continue; // private folders are not routable
    const seg = urlSegment(e.name);
    out.push(...webRoutes(join(dir, e.name), seg === null ? segments : [...segments, seg]));
  }
  return [...new Set(out)].sort();
}

// ── Caddy ───────────────────────────────────────────────────────────────────────────────────────

/** Caddy's `path` matcher: case-insensitive; `*` at the end is a prefix, at the start a suffix. */
function caddyPath(pattern: string): Matcher {
  const p = pattern.toLowerCase();
  const stars = p.split("*").length - 1;
  if (stars === 0) return (path) => path.toLowerCase() === p;
  if (stars === 1 && p.endsWith("*")) return (path) => path.toLowerCase().startsWith(p.slice(0, -1));
  if (stars === 1 && p.startsWith("*")) return (path) => path.toLowerCase().endsWith(p.slice(1));
  if (stars === 2 && p.startsWith("*") && p.endsWith("*")) return (path) => path.toLowerCase().includes(p.slice(1, -1));
  // Anywhere else, `*` is a glob wildcard that stays within one path segment.
  const re = new RegExp(`^${p.split("*").map(escapeRe).join("[^/]*")}$`);
  return (path) => re.test(path.toLowerCase());
}

function caddyRules(text: string): Rule[] {
  const named = new Map<string, Matcher>();
  const rules: Rule[] = [];
  let depth = 0;
  let open: { label: string; matches: Matcher; body: string[]; depth: number } | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;

    if (open) {
      open.body.push(line);
    } else if (depth === 1) {
      const tokens = line.split(/\s+/);
      const head = tokens[0] ?? "";
      if (head.startsWith("@")) {
        // A named matcher, one line: `@name path <pattern>...` or `@name path_regexp [name] <re>`.
        const [name = "", kind = "", ...args] = tokens;
        if (opens > 0) throw new Error(`Caddyfile: matcher block "${name} {" is not modelled — extend proxyRouting.test.ts`);
        if (kind === "path") {
          const each = args.map(caddyPath);
          named.set(name, (path) => each.some((m) => m(path)));
        } else if (kind === "path_regexp") {
          const re = new RegExp(args.at(-1) ?? "");
          named.set(name, (path) => re.test(path));
        } else {
          throw new Error(`Caddyfile: matcher type "${kind}" (${name}) is not modelled — extend proxyRouting.test.ts`);
        }
      } else if (head === "handle" || head === "route" || head === "reverse_proxy") {
        if (head !== "handle") {
          throw new Error(`Caddyfile: top-level "${head}" is not modelled — wrap it in a handle block`);
        }
        const arg = tokens[1] === "{" ? undefined : tokens[1];
        let matches: Matcher;
        if (arg === undefined) matches = () => true;
        else if (arg.startsWith("@")) {
          const m = named.get(arg);
          if (!m) throw new Error(`Caddyfile: handle uses ${arg} before it is defined`);
          matches = m;
        } else matches = caddyPath(arg);
        open = { label: `handle ${arg ?? "(catch-all)"}`, matches, body: [], depth };
      }
    }

    depth += opens - closes;
    if (open && depth <= open.depth) {
      const toWorker = open.body.some((l) => /^reverse_proxy\s+worker:/.test(l));
      rules.push({ label: open.label, toWorker, matches: open.matches });
      open = null;
    }
  }
  return rules;
}

// ── Helm Ingress (ingress-nginx) ────────────────────────────────────────────────────────────────

function ingressRules(text: string): Rule[] {
  // With use-regex on, ingress-nginx renders EVERY path on the host as `location ~* "^<path>"`,
  // whatever its pathType: a case-insensitive regex anchored only at the start. That is why a
  // `Prefix /mcp` would also catch /mcp-server.
  assert.match(text, /nginx\.ingress\.kubernetes\.io\/use-regex:\s*"true"/, "the guard models ingress-nginx with use-regex on");
  const rules: Rule[] = [];
  let current: { path: string; backend?: string } | null = null;
  const flush = () => {
    if (!current) return;
    assert.ok(current.backend, `ingress path ${current.path} has no recognisable backend`);
    const re = new RegExp(`^${current.path}`, "i");
    rules.push({ label: `ingress ${current.path}`, toWorker: current.backend === "worker", matches: (p) => re.test(p) });
  };
  for (const line of text.split("\n")) {
    const path = /^\s*- path:\s*(\S+)\s*$/.exec(line);
    if (path) {
      flush();
      current = { path: path[1] ?? "" };
      continue;
    }
    const backend = /^\s*name:\s*\{\{\s*\$fullName\s*\}\}-(worker|web)\s*$/.exec(line);
    if (backend && current) current.backend = backend[1];
  }
  flush();
  return rules;
}

// ── The guard ───────────────────────────────────────────────────────────────────────────────────

const ROUTES = webRoutes();
const PROXIES = [
  { name: "deploy/Caddyfile", rules: caddyRules(CADDYFILE) },
  { name: "Helm Ingress", rules: ingressRules(INGRESS) },
];

const workerRulesFor = (rules: Rule[], path: string) => rules.filter((r) => r.toWorker && r.matches(path)).map((r) => r.label);

/** The routes §13 sends to the worker, and web routes that sit right next to them. */
const KNOWN_WORKER = [
  MCP_ENDPOINT_PATH,
  `${MCP_ENDPOINT_PATH}/`,
  "/scim/v2/Users",
  "/oauth/token",
  "/oauth/revoke",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/acme/pdf-tools.git/info/refs",
];
const KNOWN_WEB = [MCP_PAGE_PATH, "/oauth/authorize", "/oauth/register", "/oauth/consent", "/api/mcp/connections", "/catalog"];

test("the guard sees the app's routes, including the MCP setup page the worker redirects to", () => {
  assert.ok(ROUTES.length >= 25, `only ${ROUTES.length} routes found under src/app — is APP_DIR right?`);
  for (const r of ["/", "/catalog", "/skills/sample/sample", "/oauth/authorize", "/oauth/register", "/api/mcp/connections"]) {
    assert.ok(ROUTES.includes(r), `expected ${r} among the app's routes`);
  }
  assert.ok(ROUTES.includes(MCP_PAGE_PATH), `the worker redirects browsers to ${MCP_PAGE_PATH}, but no page lives there`);
  assert.equal(ROUTES.includes(MCP_ENDPOINT_PATH), false, `a web page at ${MCP_ENDPOINT_PATH} is shadowed by the MCP endpoint`);
});

for (const { name, rules } of PROXIES) {
  test(`${name}: parsed into worker-bound and web rules`, () => {
    assert.ok(rules.some((r) => r.toWorker), `${name}: no worker-bound rules parsed`);
    assert.ok(rules.some((r) => !r.toWorker), `${name}: no web rules parsed`);
  });

  test(`${name}: the known worker routes reach the worker and their web neighbours do not`, () => {
    for (const path of KNOWN_WORKER) {
      assert.ok(workerRulesFor(rules, path).length > 0, `${name}: ${path} should reach the worker`);
    }
    for (const path of KNOWN_WEB) {
      assert.deepEqual(workerRulesFor(rules, path), [], `${name}: ${path} should reach web`);
    }
  });

  test(`${name}: no web page or route handler is routed to the worker`, () => {
    const shadowed = ROUTES.map((path) => ({ path, by: workerRulesFor(rules, path) })).filter((r) => r.by.length > 0);
    assert.deepEqual(shadowed, [], `${name} sends these web routes to the worker; move the page or tighten the rule (§13)`);
  });
}

test("the old glob rule would have been caught (the guard bites)", () => {
  const old = caddyRules(":8080 {\n\thandle /mcp* {\n\t\treverse_proxy worker:4000\n\t}\n\thandle {\n\t\treverse_proxy web:3000\n\t}\n}\n");
  assert.deepEqual(workerRulesFor(old, MCP_PAGE_PATH), ["handle /mcp*"]);
  const oldIngress = ingressRules(
    'nginx.ingress.kubernetes.io/use-regex: "true"\n- path: /mcp\n  pathType: Prefix\n  name: {{ $fullName }}-worker\n- path: /\n  name: {{ $fullName }}-web\n',
  );
  assert.deepEqual(workerRulesFor(oldIngress, MCP_PAGE_PATH), ["ingress /mcp"]);
});
