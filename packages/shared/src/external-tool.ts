// External-tool fetch contract — PINNED (was implementation task #1).
// SKILLY_SPEC.md §9; CLAUDE.md "the one constraint".
import { skillsHubApiUrl, validateSkillsHubSlug } from "./skills-hub.js";
import { isAgentSlug } from "./agents.js";
//
// The consumer is `vercel-labs/skills` (`npx skills add <source>`), verified from source
// (v1.5.10). Findings that shaped this design:
//   - `add` resolves GIT repositories (GitHub/GitLab/any clone-able git URL/local) OR a
//     `.well-known` HTTP index. There is NO "fetch a tarball from a registry URL with a
//     query-string token" path.
//   - For a git source it runs `git clone --depth 1 --branch <ref>` via `simple-git`, and
//     passes the URL through to git verbatim — so credentials embedded in the URL
//     (https://user:token@host/...) flow straight to git as HTTP basic auth.
//   - The `.well-known` HTTP path is UNAUTHENTICATED (plain fetch, no headers/tokens) —
//     unusable for restricted/visibility-scoped skills.
//   - Refs pin via `source#<ref>` (and GitHub `/tree/<ref>/`); shallow clone => use TAGS.
//
// DECISION (locked): skilly exposes each skill as a git repository over an AUTHENTICATED
// HTTP git smart server. Each skill version = an immutable git TAG. Visibility/auth is
// enforced by validating the basic-auth token (one-time or PAT) embedded in the clone URL.
// This is the ONLY place that knows the external tool's wire format — keep it here.

export interface InstallUrlInput {
  /** SKILLY_REGISTRY_URL, e.g. https://skilly.example.com (host of the git smart server) */
  registryBaseUrl: string;
  namespaceSlug: string;
  skillSlug: string;
  /**
   * Exact version => resolved to an immutable git tag (e.g. "1.2.0" -> tag "v1.2.0").
   * Omit/null = "latest": the URL carries NO `#ref`, so git clones the default branch
   * (`main`), which the publish sweep keeps pointed at the latest stable version. §9/§23.
   */
  semver?: string | null;
  /**
   * The skill-scoped `install` token (SKILLY_SPEC.md §23), embedded as the git HTTP
   * basic-auth PASSWORD. Required for every clone (org + namespace).
   * SECURITY: tokens-in-URL leak to shell history / logs — the git server MUST NOT log
   * credentials. install tokens are reusable + user-TTL'd + owner-revocable (uninstall).
   */
  token?: string;
  /**
   * The skill's coding-agent slug (its `tool_harness`). When it's a RECOGNIZED non-generic agent
   * (see agents.ts), the command appends `--agent <slug>` so the consumer tool installs the skill
   * into that agent. `generic`/empty/unrecognized-legacy → no flag. SKILLY_SPEC.md §6/§9.
   */
  agent?: string | null;
}

/** Git basic-auth username placeholder (value is irrelevant; the token is the password). */
const TOKEN_USERNAME = "x-access-token";

/** Map a semver to its immutable git tag. Keep in sync with the publish/tagging logic. */
export function versionTag(semver: string): string {
  return `v${semver}`;
}

/**
 * Build the `npx skills add <url>` source string for a skill version.
 * Form: https://x-access-token:<token>@<host>/<ns>/<skill>.git#v<semver>
 */
export function buildInstallSource(input: InstallUrlInput): string {
  const { registryBaseUrl, namespaceSlug, skillSlug, semver, token } = input;
  const u = new URL(registryBaseUrl);
  if (token) {
    u.username = TOKEN_USERNAME;
    u.password = token;
  }
  // path: /<ns>/<skill>.git ; a pinned version => #tag fragment. "latest" (no semver) omits
  // the fragment entirely so git clones the default branch (= latest stable). §9/§23.
  u.pathname = `/${namespaceSlug}/${skillSlug}.git`;
  if (semver) u.hash = versionTag(semver);
  return u.toString();
}

/** Full copy-paste command shown in the UI / generated for users. A recognized non-generic agent
 *  appends `--agent <slug>` at the END (§9); generic/unrecognized adds nothing. */
export function buildInstallCommand(input: InstallUrlInput): string {
  const base = `npx skills add ${buildInstallSource(input)}`;
  return isAgentSlug(input.agent) ? `${base} --agent ${input.agent}` : base;
}

export type ParsedInstallCommand =
  | {
      ok: true;
      /** normalized origin URL (owner/repo shorthand → https://github.com/owner/repo.git; skills-hub slug → its API URL) */
      url: string;
      /** pinned ref from `#ref` or a /tree/<ref>/ URL; null when the command names none */
      ref: string | null;
      /** skill folder from `--skill <name>` or the /tree/.../<path> remainder; null = repo root */
      subdir: string | null;
      /** set for non-git origins; "skills-hub" = mirrored via the registry API, not git (§6) */
      provider?: "skills-hub";
      /** the registry slug, when provider = "skills-hub" (drives the skilly slug suggestion) */
      hubSlug?: string;
      /** agent slug from `--agent <slug>` (raw, un-validated) if the command carried one; else null.
       *  The propose form preselects the tool/harness from it when it's a recognized agent (§8). */
      agent?: string | null;
    }
  | { ok: false; error: string };

/**
 * Parse a consumer-tool install command (`npx skills add <source> [--skill name]`) into
 * pointer-proposal fields — the INVERSE of buildInstallCommand, for the propose form's
 * paste-to-fill accelerator (SKILLY_SPEC.md §8). Pure + lenient on prompt noise (`$ `, quotes),
 * strict on meaning:
 *  - `--all` is rejected (skilly imports one skill per proposal, §6);
 *  - a missing `#ref` returns ref:null — the caller must require a pinned ref (§6/§7);
 *  - URL schemes are NOT rewritten; downstream validatePointerUrl stays the gate.
 * Source forms (pinned tool v1.5.10): full git URL (+#ref), owner/repo GitHub shorthand,
 * and GitHub /tree/<ref>/<path> URLs. For /tree/ URLs the first path segment is taken as the
 * ref (refs containing "/" are ambiguous in that form — known limitation).
 * Wrapper-CLI tolerance: the git source is detected wherever it appears, so commands from
 * other agent-skill installers also work as long as they name a git repo — e.g.
 * `npx -y skills add owner/repo --agent claude-code`, `npx agent-skills-cli add owner/repo`.
 * Commands that only reference a proprietary registry slug (i.e. a private marketplace, not a
 * git repo) name nothing for skilly to mirror and are rejected with a clear message.
 */
export function parseInstallCommand(raw: string): ParsedInstallCommand {
  const cleaned = raw.trim().replace(/^\$\s+/, "").replace(/^[`'"]+|[`'"]+$/g, "");
  if (!cleaned) return { ok: false, error: "paste an npx skills add command" };

  const tokens = cleaned.split(/\s+/);

  // skills-hub.ai form: `npx @skills-hub-ai/cli install <slug>` (also the installed `skills-hub`
  // binary). Resolves to the registry's API origin; the proposer pins a registry VERSION as the
  // ref (e.g. 1.0.0) — the command itself names none.
  const hubIdx = tokens.findIndex(
    (t, i) => t === "install" && tokens.slice(0, i).some((p) => p === "@skills-hub-ai/cli" || p.startsWith("@skills-hub-ai/cli@") || p === "skills-hub"),
  );
  if (hubIdx >= 0) {
    const slug = tokens.slice(hubIdx + 1).find((t) => !t.startsWith("-"))?.replace(/^[`'"]+|[`'"]+$/g, "");
    if (!slug) return { ok: false, error: "no skill name found — expected `npx @skills-hub-ai/cli install <skill>`" };
    const slugErr = validateSkillsHubSlug(slug);
    if (slugErr) return { ok: false, error: slugErr };
    return { ok: true, url: skillsHubApiUrl(slug), ref: null, subdir: null, provider: "skills-hub", hubSlug: slug };
  }

  // Beyond `skills add`, accept ANY wrapper CLI by scanning for a git SOURCE token — a full
  // git URL or a GitHub `owner/repo` shorthand — independent of the binary/verb. This covers
  // `npx -y skills add owner/repo --agent claude-code`, `npx agent-skills-cli add owner/repo`,
  // `npx skills add <git-url> --skill name`, and bare pastes. Flags are consumed or ignored;
  // `--skill <name>` sets the folder. CLIs that only reference a proprietary registry slug
  // (a private marketplace, not a git repo) carry no git repo, so they fall through to the
  // clear error below — there is nothing for skilly to mirror.
  const strip = (s: string) => s.replace(/^[`'"]+|[`'"]+$/g, "");
  const isGitSource = (t: string) =>
    /^(https?|git|ssh):\/\//i.test(t) ||
    /^git@/.test(t) ||
    /\.git(#.*)?$/i.test(t) ||
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(#.+)?$/.test(t); // GitHub owner/repo shorthand (no leading @)

  let source: string | null = null;
  let skillFlag: string | null = null;
  let agentFlag: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--all" || t === "-a") {
      return { ok: false, error: "skilly imports one skill per proposal — use --skill <name> (or paste a single-skill repo) instead of --all" };
    }
    if (t === "--skill" || t === "-s") {
      skillFlag = tokens[i + 1] ? strip(tokens[++i]!) : null;
      continue;
    }
    if (t.startsWith("--skill=")) {
      skillFlag = strip(t.slice("--skill=".length)) || null;
      continue;
    }
    if (t === "--agent" || t === "-A" || t === "--target") {
      // agent/target selector + its value (e.g. `--agent claude-code`) — irrelevant to mirroring,
      // but captured so the propose form can preselect the tool/harness from it (§8).
      if (tokens[i + 1]) agentFlag = strip(tokens[++i]!);
      continue;
    }
    if (t.startsWith("--agent=")) {
      agentFlag = strip(t.slice("--agent=".length)) || null;
      continue;
    }
    if (t.startsWith("-")) continue; // any other flag/noise (-y, --yes, --global, --latest, --claude, …)
    const candidate = strip(t);
    if (!source && isGitSource(candidate)) source = candidate;
  }
  if (!source) {
    return {
      ok: false,
      error:
        "couldn’t find a git repository in that command — skilly mirrors a git repo. Paste a command containing a git URL or a GitHub owner/repo (e.g. `npx skills add owner/repo --skill name`), or fill the Pointer fields below by hand.",
    };
  }

  let url = source;
  let ref: string | null = null;
  let subdir: string | null = null;

  // #ref fragment (any source form)
  const hash = url.indexOf("#");
  if (hash >= 0) {
    ref = url.slice(hash + 1) || null;
    url = url.slice(0, hash);
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url)) {
    // GitHub owner/repo shorthand
    url = `https://github.com/${url}.git`;
  } else if (/^https?:\/\//i.test(url)) {
    // GitHub-style /tree/<ref>/<path> URL → split into repo + ref + subdir
    const tree = /^(https?:\/\/[^/]+\/[^/]+\/[^/]+)\/tree\/([^/]+)(?:\/(.+))?$/.exec(url.replace(/\/+$/, ""));
    if (tree) {
      url = `${tree[1]}.git`;
      ref = ref ?? tree[2]!;
      subdir = tree[3] ?? null;
    } else if (!/\.git$/.test(url)) {
      url = `${url.replace(/\/+$/, "")}.git`;
    }
  } else {
    return { ok: false, error: "unrecognized source — paste a git URL or a GitHub owner/repo" };
  }

  if (skillFlag) subdir = skillFlag; // explicit --skill wins over a /tree/ path
  return { ok: true, url, ref, subdir, agent: agentFlag };
}

/**
 * Canonicalize a pointer origin URL for DUPLICATE matching (SKILLY_SPEC.md §8). Stored
 * `external_origin_url` values are "as submitted" (a pasted command is normalized by
 * parseInstallCommand, but a hand-typed URL is verbatim), so both the stored and the incoming
 * URL must pass through the SAME canonicalizer before comparison. Pure; lenient. It folds the
 * common equivalences — owner/repo shorthand, `git@host:owner/repo` SCP form, a trailing `.git`,
 * trailing slashes, embedded credentials, scheme/host case — to one form. It does NOT decide
 * safety (validatePointerUrl owns that) and is deliberately conservative: when in doubt it
 * lowercases the raw string rather than guessing, so a false MATCH is unlikely.
 */
const WRAPPING_QUOTE_CHARS = "`'\"";

/** Strips leading/trailing backtick/quote chars without regex backtracking (a `/^[..]+|[..]+$/g`
 *  pattern here is polynomial-time on adversarial input — CodeQL js/polynomial-redos). */
function stripWrappingQuotes(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && WRAPPING_QUOTE_CHARS.includes(s[start]!)) start++;
  while (end > start && WRAPPING_QUOTE_CHARS.includes(s[end - 1]!)) end--;
  return s.slice(start, end);
}

export function normalizeOriginUrl(raw: string | null | undefined): string {
  let u = stripWrappingQuotes((raw ?? "").trim());
  if (!u) return "";
  const scp = /^git@([^:/]+):(.+)$/.exec(u); // git@github.com:owner/repo(.git)
  if (scp) u = `https://${scp[1]}/${scp[2]}`;
  else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(u)) u = `https://github.com/${u}`; // owner/repo
  u = u.replace(/\.git$/i, "").replace(/\/+$/, "");
  try {
    const p = new URL(u);
    p.username = "";
    p.password = "";
    p.hash = "";
    p.search = "";
    return `${p.protocol.toLowerCase()}//${p.host.toLowerCase()}${p.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return u.toLowerCase();
  }
}

/** Canonicalize a pointer subdir for duplicate matching: trimmed, slash-stripped, lowercased;
 *  null/empty/repo-root all collapse to "". */
export function normalizeSubdir(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/^\/+|\/+$/g, "").toLowerCase();
}

/** Pinned contract metadata (verified from vercel-labs/skills source). */
export const EXTERNAL_TOOL_CONTRACT = {
  toolName: "vercel-labs/skills (npx skills add)",
  pinnedAtToolVersion: "1.5.10",
  /** How skilly serves skills to the tool. */
  serveAs: "git-smart-http" as const,
  /** Each version is served as this git tag form. */
  tagPrefix: "v",
  /** Auth mechanism the tool actually honors for our host. */
  auth: "git-basic-auth-in-url" as const,
  /** SKILL.md must live at the repo root (tool walks depth ~1-2; one skill per repo). */
  skillMdLocation: "repo-root",
} as const;
