// The 24 curated MCP tools (§29). Definitions (JSON Schema, for the client) + dispatch.
//
// THE CEILING IS 24. A 25th tool is a spec change, not an implementation detail — the first
// response to pressure for more surface is to fold, not add. `mcp.test.ts` in @skilly/shared
// asserts the count, and the excluded surface (review decisions, administration, irreversible
// destruction, direct messaging, the `system` install flag) has no tool here at all: not omitted
// from a description — absent from the code.
import type { Pool } from "pg";
import {
  MCP_TOOL_NAMES,
  buildSkillResourceUri,
  decodeInlineBundle,
  isSafeBundlePath,
  listRemoteRefs,
  normalizeOriginUrl,
  normalizeSubdir,
  toolError,
  toolJson,
  type McpToolName,
} from "@skilly/shared";
import type { McpCaller } from "./auth.js";
import { getMcpSettings, getProposalsOpen } from "./settings.js";
import {
  findNamespace,
  findVisibleSkill,
  getSkillDetail,
  listVersions,
  registryMetadata,
  resolveReadVersion,
  searchSkills,
  type SkillRef,
  type VersionRow,
} from "./queries.js";
import { listBundleFiles, readBundleFile, readSkillMd, recordMcpAdoption } from "./content.js";
import { listInstalls, mintInstall, reactivate, resolveExpiry, uninstall } from "./installs.js";
import {
  createMcpProposal,
  createSkillRequest,
  loadProposalCtx,
  postProposalMessage,
  postSkillComment,
  proposerAction,
  rateSkill,
  validatePointerFields,
  type BuiltPayload,
  type ProposalMetadataInput,
} from "./writes.js";

export interface ToolDefinition {
  name: McpToolName;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP hint: the tool never mutates state. Clients use this to decide what needs confirmation. */
  readOnly: boolean;
}

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });
const strArr = (description: string) => ({ type: "array", items: { type: "string" }, description });

const SKILL_REF_PROPS = {
  namespace: str("The skill's namespace slug (the part before the / in ns/slug)."),
  slug: str("The skill's slug (the part after the /)."),
};
const SKILL_REF_REQUIRED = ["namespace", "slug"];

const METADATA_SCHEMA = {
  type: "object",
  description: "The skill's metadata for this version.",
  properties: {
    skillSlug: str("Kebab-case slug. For a new version this must match the existing skill's slug."),
    title: str("Human-readable title (3–120 chars)."),
    description: str("What the skill does, for the catalog (10–2000 chars)."),
    toolHarness: str("The coding agent this skill targets. Use get_registry_metadata for the allowed values; 'generic' if it isn't agent-specific."),
    visibility: { type: "string", enum: ["org", "namespace"], description: "'org' = visible to everyone; 'namespace' = only to the namespace's members. Cannot be 'namespace' in the global namespace." },
    categories: strArr("Category labels (created on the fly, max 12)."),
    tags: strArr("Free-form tags (max 20)."),
    usageExamples: str("Optional worked examples shown on the detail page and matched by search."),
    whatChanged: str("Required for a NEW VERSION of an existing skill: what changed, in plain text."),
  },
  required: ["skillSlug", "title", "description", "toolHarness", "visibility"],
} as const;

/**
 * The tool inventory advertised to clients. Descriptions are written for a MODEL — they say what
 * the tool does, what it needs, and (where it matters) what it deliberately cannot do, so an agent
 * doesn't waste a turn discovering a boundary.
 */
export function toolDefinitions(): ToolDefinition[] {
  return [
    // ── Core read ─────────────────────────────────────────────────────────────────────────────
    {
      name: "search_skills",
      title: "Search skills",
      readOnly: true,
      description:
        "Search this skilly registry's catalog. THIS IS THE DISCOVERY PATH — the resource list deliberately advertises templates only and never enumerates the catalog, so start here. Results are filtered to what you are allowed to see. Each hit includes a `resourceUri` you can read directly.",
      inputSchema: {
        type: "object",
        properties: {
          query: str("Free-text search over title, slug, description, tags and usage examples. Substring match, so partial words work."),
          category: str("Restrict to one category label."),
          tool: str("Restrict to one tool/harness slug (e.g. claude-code)."),
          type: { type: "string", enum: ["hosted", "pointer"], description: "'hosted' = the bytes live in this registry; 'pointer' = mirrored from an external repo." },
          sort: { type: "string", enum: ["relevance", "top_rated", "latest"], description: "Default 'relevance' (name matches first, then popularity)." },
          limit: num("Max results, 1–50 (default 20)."),
          offset: num("Skip this many results (pagination)."),
        },
      },
    },
    {
      name: "get_skill",
      title: "Get skill details",
      readOnly: true,
      description:
        "Full detail for one skill: description, categories, tags, rating, install count, maintainers, every published version (with which are installable), and the external source for a mirrored skill.",
      inputSchema: { type: "object", properties: SKILL_REF_PROPS, required: SKILL_REF_REQUIRED },
    },
    {
      name: "get_skill_content",
      title: "Read a skill's SKILL.md",
      readOnly: true,
      description:
        "The raw SKILL.md of a skill version — the instructions themselves. Defaults to the latest stable version. Reading this counts as adopting the skill (the same way a download or install does), so use search_skills to browse and this to actually use a skill.",
      inputSchema: {
        type: "object",
        properties: { ...SKILL_REF_PROPS, semver: str("Exact version (e.g. 1.2.0). Omit for the latest stable version.") },
        required: SKILL_REF_REQUIRED,
      },
    },
    {
      name: "list_skill_files",
      title: "List a skill version's files",
      readOnly: true,
      description:
        "Every file in a skill version's bundle, with size and sha256 — the scripts, references and assets SKILL.md points at. Use get_skill_file to read one.",
      inputSchema: {
        type: "object",
        properties: { ...SKILL_REF_PROPS, semver: str("Exact version. Omit for the latest stable version.") },
        required: SKILL_REF_REQUIRED,
      },
    },
    {
      name: "get_skill_file",
      title: "Read one file from a skill",
      readOnly: true,
      description: "Read a single file out of a skill version's bundle. Text comes back inline; binary comes back base64-encoded. Large files are refused rather than truncated.",
      inputSchema: {
        type: "object",
        properties: {
          ...SKILL_REF_PROPS,
          path: str("Bundle-relative path, exactly as list_skill_files reports it."),
          semver: str("Exact version. Omit for the latest stable version."),
        },
        required: [...SKILL_REF_REQUIRED, "path"],
      },
    },
    {
      name: "get_registry_metadata",
      title: "Registry metadata",
      readOnly: true,
      description:
        "The categories, tool/harness vocabulary, namespaces you can see (and which ones you can review), and the limits that apply to proposals. Call this before proposing a skill so you fill the fields with values the registry accepts.",
      inputSchema: { type: "object", properties: {} },
    },

    // ── Install ───────────────────────────────────────────────────────────────────────────────
    {
      name: "install_skill",
      title: "Get an install command",
      readOnly: false,
      description:
        "Mint a personal install command for a skill and return it as a shell command to run (`npx skills add …`). The command embeds a reusable, revocable token scoped to that one skill. Run it with your shell to actually install. This does NOT install anything by itself.",
      inputSchema: {
        type: "object",
        properties: {
          ...SKILL_REF_PROPS,
          semver: str("Pin an exact version. Omit to track the latest stable version (re-cloning picks up updates)."),
          expiresAt: str("ISO date/time when the install URL should stop working. Omit for this registry's default horizon; pass null for 'never'."),
        },
        required: SKILL_REF_REQUIRED,
      },
    },
    {
      name: "list_installed_skills",
      title: "List your installed skills",
      readOnly: true,
      description: "The skills you have installed through this registry, with what version each tracks and when its install URL expires.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "uninstall_skill",
      title: "Uninstall a skill",
      readOnly: false,
      description:
        "Revoke one of your own installations: the install URL stops working. The skill itself is untouched, and past install counts are preserved. Use list_installed_skills to get the id.",
      inputSchema: { type: "object", properties: { installId: str("The install's id from list_installed_skills.") }, required: ["installId"] },
    },
    {
      name: "reactivate_install",
      title: "Reactivate an expired install",
      readOnly: false,
      description: "Give an expired installation a new expiry so its existing URL works again. No new token is minted.",
      inputSchema: {
        type: "object",
        properties: {
          installId: str("The install's id from list_installed_skills."),
          expiresAt: str("New ISO expiry, or null for 'never'."),
        },
        required: ["installId"],
      },
    },

    // ── Propose ───────────────────────────────────────────────────────────────────────────────
    {
      name: "check_duplicate",
      title: "Check for a duplicate skill",
      readOnly: true,
      description:
        "Before proposing, check whether the registry already has this skill — by slug in the target namespace, or by external origin URL for a mirrored skill. Cheap, and it saves a rejected proposal.",
      inputSchema: {
        type: "object",
        properties: {
          namespace: str("Target namespace slug."),
          skillSlug: str("The slug you intend to use."),
          originUrl: str("For a pointer/mirrored skill: the upstream repository URL."),
          subdir: str("For a pointer skill in a multi-skill repo: the folder inside it."),
        },
      },
    },
    {
      name: "list_upstream_refs",
      title: "List an upstream repo's refs",
      readOnly: true,
      description:
        "List the branches and tags a public git repository publishes, so you can pin a real ref in a pointer proposal. Pointer proposals must pin an immutable ref (a tag or a commit-ish), never a moving branch.",
      inputSchema: { type: "object", properties: { url: str("The upstream repository URL.") }, required: ["url"] },
    },
    {
      name: "propose_pointer_skill",
      title: "Propose a skill mirrored from a repo",
      readOnly: false,
      description:
        "Propose a skill whose source is an external git repository, pinned to an immutable ref. skilly mirrors the bytes itself on acceptance. The proposal goes to the namespace's reviewers — you cannot approve your own proposal from here.",
      inputSchema: {
        type: "object",
        properties: {
          namespace: str("Target namespace slug (see get_registry_metadata)."),
          semver: str("The version to publish, e.g. 1.0.0. Must not already exist for this skill."),
          metadata: METADATA_SCHEMA,
          url: str("Upstream git repository URL (https)."),
          ref: str("Immutable ref to pin — a tag or commit, not a branch."),
          subdir: str("Folder inside the repo holding SKILL.md, for a multi-skill repo."),
        },
        required: ["namespace", "semver", "metadata", "url", "ref"],
      },
    },
    {
      name: "propose_hosted_skill",
      title: "Propose a skill from a bundle",
      readOnly: false,
      description:
        "Propose a skill by uploading its bundle inline, base64-encoded (.skill/.zip/.tar.gz containing SKILL.md at the root). The bundle is validated and virus-scanned exactly like a browser upload. There is a hard size limit for inline uploads — get_registry_metadata reports it; bigger bundles must go through the web UI. The proposal goes to reviewers.",
      inputSchema: {
        type: "object",
        properties: {
          namespace: str("Target namespace slug."),
          semver: str("The version to publish, e.g. 1.0.0."),
          metadata: METADATA_SCHEMA,
          bundleBase64: str("The bundle archive, base64-encoded."),
          filename: str("Original filename, e.g. my-skill.skill — its extension decides how the bundle is read back."),
        },
        required: ["namespace", "semver", "metadata", "bundleBase64"],
      },
    },
    {
      name: "list_my_proposals",
      title: "List your proposals",
      readOnly: true,
      description: "Your own submissions and their state. `changes_requested` means it is your turn: revise and resubmit.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_proposal",
      title: "Get a proposal",
      readOnly: true,
      description: "One proposal you can see: its state, current revision payload, scan findings, and the review conversation.",
      inputSchema: { type: "object", properties: { proposalId: str("The proposal's id.") }, required: ["proposalId"] },
    },
    {
      name: "revise_proposal",
      title: "Revise a proposal under review",
      readOnly: false,
      description:
        "Edit your proposal while it is still being reviewed, without changing its state. Pass the COMPLETE new payload (metadata, plus pointer fields if it is a pointer proposal). A pointer proposal's files are frozen during review — to change the source, wait for the reviewer to request changes, then resubmit.",
      inputSchema: {
        type: "object",
        properties: {
          proposalId: str("The proposal's id."),
          metadata: METADATA_SCHEMA,
          url: str("Pointer proposals: the upstream URL (must be unchanged during review)."),
          ref: str("Pointer proposals: the pinned ref (must be unchanged during review)."),
          subdir: str("Pointer proposals: the subdir (must be unchanged during review)."),
          note: str("Optional short note for the revision history."),
        },
        required: ["proposalId", "metadata"],
      },
    },
    {
      name: "resubmit_proposal",
      title: "Resubmit after changes were requested",
      readOnly: false,
      description:
        "Answer a reviewer's requested changes: submit a new revision and put the proposal back into review. Pass the COMPLETE new payload; for a pointer proposal you may change the source here.",
      inputSchema: {
        type: "object",
        properties: {
          proposalId: str("The proposal's id."),
          metadata: METADATA_SCHEMA,
          url: str("Pointer proposals: upstream URL."),
          ref: str("Pointer proposals: pinned ref."),
          subdir: str("Pointer proposals: subdir."),
          note: str("Optional short note for the revision history."),
        },
        required: ["proposalId", "metadata"],
      },
    },
    {
      name: "post_proposal_message",
      title: "Reply in a proposal's review thread",
      readOnly: false,
      description: "Post a message in a proposal's review conversation — how you answer a reviewer's question. Visible to the submitter and the namespace's reviewers.",
      inputSchema: {
        type: "object",
        properties: { proposalId: str("The proposal's id."), body: str("Message text (max 4000 chars).") },
        required: ["proposalId", "body"],
      },
    },

    // ── Social ────────────────────────────────────────────────────────────────────────────────
    {
      name: "rate_skill",
      title: "Rate a skill",
      readOnly: false,
      description: "Set your own 1–5 star rating for a skill, or pass stars: null to remove it. One rating per person per skill; rating again replaces it.",
      inputSchema: {
        type: "object",
        properties: { ...SKILL_REF_PROPS, stars: num("1–5, or null to clear your rating.") },
        required: SKILL_REF_REQUIRED,
      },
    },
    {
      name: "get_skill_discussion",
      title: "Read a skill's discussion",
      readOnly: true,
      description: "The comment thread on a skill's page — questions, tips and gotchas from the people using it. Newest first.",
      inputSchema: {
        type: "object",
        properties: { ...SKILL_REF_PROPS, limit: num("Max comments, 1–100 (default 30)."), offset: num("Skip this many.") },
        required: SKILL_REF_REQUIRED,
      },
    },
    {
      name: "post_skill_comment",
      title: "Comment on a skill",
      readOnly: false,
      description: "Post a comment on a skill's discussion (max 500 chars). Optionally stamp which version you are talking about. Notifies the skill's maintainers and watchers.",
      inputSchema: {
        type: "object",
        properties: {
          ...SKILL_REF_PROPS,
          body: str("Comment text (max 500 chars)."),
          contextSemver: str("The version your comment is about — must be an active version of the skill."),
        },
        required: [...SKILL_REF_REQUIRED, "body"],
      },
    },
    {
      name: "list_skill_requests",
      title: "List requested skills",
      readOnly: true,
      description: "Skills people have asked for but that don't exist yet — the best place to look for something worth building.",
      inputSchema: {
        type: "object",
        properties: {
          query: str("Free-text over title and description."),
          state: { type: "string", enum: ["open", "fulfilled", "all"], description: "Default 'open'." },
          mine: bool("Only your own requests."),
          limit: num("Max results, 1–50 (default 20)."),
        },
      },
    },
    {
      name: "request_skill",
      title: "Request a skill",
      readOnly: false,
      description: "File a request for a skill that doesn't exist yet, so whoever builds it knows what's needed. Org-visible to everyone.",
      inputSchema: {
        type: "object",
        properties: {
          title: str("Short title (3–120 chars)."),
          description: str("What you need and why (10–4000 chars)."),
          toolHarness: str("The agent it should target, or 'generic'."),
          usageExamples: str("Optional: how you'd expect to use it."),
          categories: strArr("Optional category labels."),
        },
        required: ["title", "description", "toolHarness"],
      },
    },
  ];
}

// Fail fast at boot if the definitions and the shared inventory ever diverge.
{
  const defined = toolDefinitions().map((t) => t.name);
  const missing = MCP_TOOL_NAMES.filter((n) => !defined.includes(n));
  const extra = defined.filter((n) => !(MCP_TOOL_NAMES as readonly string[]).includes(n));
  if (missing.length || extra.length) {
    throw new Error(`MCP tool inventory mismatch — missing: ${missing.join(",")} extra: ${extra.join(",")}`);
  }
}

// ── Dispatch ────────────────────────────────────────────────────────────────────────────────────

type Args = Record<string, unknown>;
const s = (a: Args, k: string): string | undefined => (typeof a[k] === "string" ? (a[k] as string).trim() || undefined : undefined);
const n = (a: Args, k: string): number | undefined => (typeof a[k] === "number" ? (a[k] as number) : undefined);
const b = (a: Args, k: string): boolean | undefined => (typeof a[k] === "boolean" ? (a[k] as boolean) : undefined);

/** `undefined` = field absent; `null` = explicitly "never"/"clear". The distinction matters. */
function tri(a: Args, k: string): string | null | undefined {
  if (!(k in a)) return undefined;
  const v = a[k];
  if (v === null) return null;
  return typeof v === "string" ? v : undefined;
}

const NOT_FOUND = "no such skill, or it isn't visible to you";

type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

async function resolveSkill(pool: Pool, caller: McpCaller, a: Args): Promise<Resolved<SkillRef>> {
  const ns = s(a, "namespace");
  const slug = s(a, "slug");
  if (!ns || !slug) return { ok: false, error: "namespace and slug are required" };
  const skill = await findVisibleSkill(pool, caller.access, ns, slug);
  return skill ? { ok: true, value: skill } : { ok: false, error: NOT_FOUND };
}

/** Resolve the version to read + its artifact key, honoring the yanked-by-exact-pin rule. */
async function resolveArtifact(
  pool: Pool,
  skillId: string,
  semver: string | undefined,
): Promise<Resolved<{ version: VersionRow; yanked: boolean; key: string }>> {
  const versions = await listVersions(pool, skillId);
  const picked = resolveReadVersion(versions, semver ?? null);
  if ("error" in picked) return { ok: false, error: picked.error };
  if (!picked.version.artifactObjectKey) {
    return { ok: false, error: "this version's files aren't available yet — they're still being mirrored" };
  }
  return { ok: true, value: { version: picked.version, yanked: picked.yanked, key: picked.version.artifactObjectKey } };
}

function buildPointerPayload(a: Args, metadata: ProposalMetadataInput): Resolved<BuiltPayload> {
  const url = s(a, "url");
  const ref = s(a, "ref");
  if (!url || !ref) return { ok: false, error: "url and ref are required for a pointer proposal" };
  const p = validatePointerFields({ url, ref, subdir: s(a, "subdir") ?? null });
  if (!p.ok) return { ok: false, error: p.error };
  return { ok: true, value: { metadata, pointer: p.value } };
}

function readMetadata(a: Args): Resolved<ProposalMetadataInput> {
  const m = a.metadata;
  if (typeof m !== "object" || m === null) return { ok: false, error: "metadata is required" };
  return { ok: true, value: { ...(m as ProposalMetadataInput) } };
}

/**
 * Run one tool. Returns an MCP tool result — expected failures come back as `isError` results with
 * a human-readable message (models act on those far better than on transport errors), never as
 * JSON-RPC errors.
 */
export async function callTool(
  pool: Pool,
  caller: McpCaller,
  tool: string,
  args: Args,
): Promise<Record<string, unknown>> {
  const settings = await getMcpSettings(pool);

  switch (tool as McpToolName) {
    // ── Core read ─────────────────────────────────────────────────────────────────────────────
    case "search_skills": {
      const res = await searchSkills(pool, caller.access, {
        q: s(args, "query"),
        category: s(args, "category"),
        tool: s(args, "tool"),
        type: (s(args, "type") as "hosted" | "pointer" | undefined) ?? null,
        sort: (s(args, "sort") as "relevance" | "top_rated" | "latest" | undefined) ?? null,
        limit: n(args, "limit"),
        offset: n(args, "offset"),
      });
      return toolJson(res);
    }

    case "get_skill": {
      const r = await resolveSkill(pool, caller, args);
      if (!r.ok) return toolError(r.error);
      const detail = await getSkillDetail(pool, r.value);
      return detail ? toolJson(detail) : toolError(NOT_FOUND);
    }

    case "get_skill_content": {
      const r = await resolveSkill(pool, caller, args);
      if (!r.ok) return toolError(r.error);
      const art = await resolveArtifact(pool, r.value.id, s(args, "semver"));
      if (!art.ok) return toolError(art.error);
      const text = await readSkillMd(pool, art.value.key, settings.resourceBytes);
      if (text == null) return toolError("this version has no readable SKILL.md");
      // The adoption signal (§21) — first SKILL.md read per (user, skill), deduped against clones
      // and downloads by the shared ledger.
      recordMcpAdoption(pool, r.value.id, caller.userId);
      return toolJson({
        namespace: r.value.namespaceSlug,
        slug: r.value.skillSlug,
        semver: art.value.version.semver,
        yanked: art.value.yanked,
        ...(art.value.yanked ? { warning: "this version is yanked — it is served only because you pinned it exactly" } : {}),
        resourceUri: buildSkillResourceUri(r.value.namespaceSlug, r.value.skillSlug, art.value.version.semver),
        content: text,
      });
    }

    case "list_skill_files": {
      const r = await resolveSkill(pool, caller, args);
      if (!r.ok) return toolError(r.error);
      const art = await resolveArtifact(pool, r.value.id, s(args, "semver"));
      if (!art.ok) return toolError(art.error);
      const files = await listBundleFiles(pool, art.value.key);
      if (!files) return toolError("this version's bundle couldn't be read");
      return toolJson({ semver: art.value.version.semver, files });
    }

    case "get_skill_file": {
      const path = s(args, "path");
      if (!path) return toolError("path is required");
      if (!isSafeBundlePath(path)) return toolError("path must be a plain bundle-relative path (no leading /, no ..)");
      const r = await resolveSkill(pool, caller, args);
      if (!r.ok) return toolError(r.error);
      const art = await resolveArtifact(pool, r.value.id, s(args, "semver"));
      if (!art.ok) return toolError(art.error);
      const file = await readBundleFile(pool, art.value.key, path, settings.resourceBytes);
      if (file.kind === "missing") return toolError(`no such file in ${r.value.skillSlug}@${art.value.version.semver}: ${path}`);
      if (file.kind === "too_large") {
        return toolError(`that file is ${file.bytes} bytes, over this registry's ${settings.resourceBytes}-byte limit for a single read — download the version from the web UI instead`);
      }
      return toolJson(
        file.kind === "text"
          ? { semver: art.value.version.semver, path: file.path, encoding: "utf-8", content: file.text }
          : { semver: art.value.version.semver, path: file.path, encoding: "base64", mimeType: file.mimeType, content: file.base64 },
      );
    }

    case "get_registry_metadata": {
      const meta = await registryMetadata(pool, caller.access);
      return toolJson({
        ...meta,
        limits: {
          inlineUploadBytes: settings.inlineUploadBytes,
          resourceReadBytes: settings.resourceBytes,
        },
        proposalsOpen: await getProposalsOpen(pool),
        notes: [
          "Proposals submitted through MCP always go to review — there is no direct-publish path here.",
          "Review decisions (accept/reject), administration and destructive actions are not available over MCP.",
        ],
      });
    }

    // ── Install ───────────────────────────────────────────────────────────────────────────────
    case "install_skill": {
      if ("system" in args) {
        return toolError("system installations are platform-admin only and can't be minted over MCP — an administrator mints those in the web UI");
      }
      const r = await resolveSkill(pool, caller, args);
      if (!r.ok) return toolError(r.error);
      const semver = s(args, "semver") ?? null;
      const versions = await listVersions(pool, r.value.id);
      if (semver) {
        const v = versions.find((x) => x.semver === semver);
        if (!v) return toolError(`version ${semver} not found`);
        if (v.status !== "active") return toolError(`version ${semver} is yanked and can't be installed`);
        if (!v.gitPublished) return toolError(`version ${semver} isn't published to git yet — try again shortly`);
      } else if (!versions.some((v) => v.status === "active" && v.gitPublished)) {
        return toolError("this skill has no installable version yet");
      }
      const exp = await resolveExpiry(pool, tri(args, "expiresAt"));
      if ("error" in exp) return toolError(exp.error);
      const minted = await mintInstall(pool, caller.userId, r.value, semver, exp.value);
      return toolJson({
        ...minted,
        skill: `${r.value.namespaceSlug}/${r.value.skillSlug}`,
        nextStep: "Run the `command` in a shell to install the skill. It is reusable — re-run it later to pick up updates.",
      });
    }

    case "list_installed_skills":
      return toolJson({ installs: await listInstalls(pool, caller.userId) });

    case "uninstall_skill": {
      const id = s(args, "installId");
      if (!id) return toolError("installId is required");
      const done = await uninstall(pool, caller.userId, id);
      return done
        ? toolJson({ ok: true, uninstalled: id, note: "the install URL no longer works; install counts are unchanged" })
        : toolError("no such installation of yours");
    }

    case "reactivate_install": {
      const id = s(args, "installId");
      if (!id) return toolError("installId is required");
      const exp = await resolveExpiry(pool, tri(args, "expiresAt"));
      if ("error" in exp) return toolError(exp.error);
      const done = await reactivate(pool, caller.userId, id, exp.value);
      return done
        ? toolJson({ ok: true, installId: id, expiresAt: exp.value?.toISOString() ?? null })
        : toolError("no such expired installation of yours (only an expired install can be reactivated)");
    }

    // ── Propose ───────────────────────────────────────────────────────────────────────────────
    case "check_duplicate": {
      const nsSlug = s(args, "namespace");
      const slug = s(args, "skillSlug");
      const originUrl = s(args, "originUrl");
      const subdir = s(args, "subdir");
      const out: Record<string, unknown> = { slugTaken: false, originMatch: null };
      if (nsSlug && slug) {
        const ns = await findNamespace(pool, nsSlug);
        if (!ns) return toolError(`no such namespace: ${nsSlug}`);
        const { rows } = await pool.query<{ slug: string; status: string }>(
          `select slug, status from skills where namespace_id = $1 and slug = $2`,
          [ns.id, slug],
        );
        out.slugTaken = rows.length > 0;
        if (rows[0]) {
          out.slugNote = `${nsSlug}/${slug} already exists — propose a NEW VERSION of it rather than a new skill`;
        }
      }
      if (originUrl) {
        const { rows } = await pool.query<{ ns_slug: string; slug: string; origin: string; subdir: string | null }>(
          `select n.slug as ns_slug, s.slug, sv.external_origin_url as origin, sv.external_subdir as subdir
             from skill_versions sv
             join skills s on s.id = sv.skill_id
             join namespaces n on n.id = s.namespace_id
            where sv.external_origin_url is not null and s.status = 'active'`,
        );
        const wantUrl = normalizeOriginUrl(originUrl);
        const wantSub = normalizeSubdir(subdir);
        const match = rows.find((x) => normalizeOriginUrl(x.origin) === wantUrl && normalizeSubdir(x.subdir) === wantSub);
        // Only report a match the caller can actually see — a duplicate check must not become a
        // side channel onto restricted skills (invariant #3).
        if (match) {
          const visible = await findVisibleSkill(pool, caller.access, match.ns_slug, match.slug);
          if (visible) out.originMatch = `${match.ns_slug}/${match.slug}`;
        }
      }
      return toolJson(out);
    }

    case "list_upstream_refs": {
      const url = s(args, "url");
      if (!url) return toolError("url is required");
      const refs = await listRemoteRefs(url);
      if (!refs.ok) return toolError(refs.error);
      return toolJson({
        branches: refs.branches.slice(0, 100),
        tags: refs.tags.slice(0, 200),
        ...(refs.latest ? { latest: refs.latest } : {}),
        note: "pin a TAG or commit — a branch moves, and pointer versions must be immutable",
      });
    }

    case "propose_pointer_skill":
    case "propose_hosted_skill": {
      const nsSlug = s(args, "namespace");
      const semver = s(args, "semver");
      if (!nsSlug || !semver) return toolError("namespace and semver are required");
      const ns = await findNamespace(pool, nsSlug);
      if (!ns) return toolError(`no such namespace: ${nsSlug}`);
      if (!(await getProposalsOpen(pool)) && !caller.access.isPlatformAdmin && !caller.access.namespaceRoles.has(ns.id)) {
        return toolError("open contribution is disabled on this registry — only members of the namespace may propose");
      }
      const meta = readMetadata(args);
      if (!meta.ok) return toolError(meta.error);

      if (tool === "propose_pointer_skill") {
        const built = buildPointerPayload(args, meta.value);
        if (!built.ok) return toolError(built.error);
        const res = await createMcpProposal(pool, caller.userId, ns, semver, built.value, caller.clientName);
        return res.ok ? toolJson(res) : toolError(res.error);
      }

      const decoded = decodeInlineBundle(args.bundleBase64, settings.inlineUploadBytes);
      if (!decoded.ok) return toolError(decoded.error);
      const { ingestHostedBundle } = await import("./writes.js");
      const ingested = await ingestHostedBundle(
        pool,
        caller.userId,
        decoded.bytes,
        meta.value.skillSlug?.trim().toLowerCase() ?? "",
        s(args, "filename") ?? "bundle.skill",
      );
      if (!ingested.ok) return toolError(ingested.error);
      const payload: BuiltPayload = {
        metadata: meta.value,
        artifactObjectKey: ingested.artifactObjectKey,
        artifactSha256: ingested.artifactSha256,
        artifactFilename: ingested.artifactFilename,
        contentSha256: ingested.contentSha256,
      };
      const res = await createMcpProposal(pool, caller.userId, ns, semver, payload, caller.clientName, ingested.scanSeverity);
      return res.ok ? toolJson(res) : toolError(res.error);
    }

    case "list_my_proposals": {
      const { rows } = await pool.query<{
        id: string; state: string; semver: string; ns_slug: string; created_at: string; updated_at: string; slug: string | null;
      }>(
        `select p.id, p.state, p.proposed_semver as semver, n.slug as ns_slug, p.created_at, p.updated_at,
                (select payload->'metadata'->>'skillSlug' from proposal_revisions
                  where proposal_id = p.id order by revision_no desc limit 1) as slug
           from proposals p join namespaces n on n.id = p.target_namespace_id
          where p.submitted_by = $1
          order by p.updated_at desc limit 50`,
        [caller.userId],
      );
      return toolJson({
        proposals: rows.map((r) => ({
          proposalId: r.id,
          state: r.state,
          namespace: r.ns_slug,
          skillSlug: r.slug,
          semver: r.semver,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          yourTurn: r.state === "changes_requested",
        })),
      });
    }

    case "get_proposal": {
      const id = s(args, "proposalId");
      if (!id) return toolError("proposalId is required");
      const p = await loadProposalCtx(pool, id);
      if (!p) return toolError("no such proposal, or it isn't visible to you");
      const isReviewer = caller.access.isPlatformAdmin || caller.access.namespaceRoles.get(p.namespaceId) === "namespace_admin";
      if (p.submittedBy !== caller.userId && !isReviewer) return toolError("no such proposal, or it isn't visible to you");
      const [rev, scan, msgs] = await Promise.all([
        pool.query<{ revision_no: number; payload: unknown; note: string | null; created_at: string }>(
          `select revision_no, payload, note, created_at from proposal_revisions
            where proposal_id = $1 order by revision_no desc limit 1`,
          [id],
        ),
        pool.query<{ severity: string | null; findings: unknown }>(
          `select sr.severity, sr.findings from scan_reports sr
            where sr.subject_type = 'artifact'
              and sr.subject_id = (select payload->>'artifactObjectKey' from proposal_revisions
                                    where proposal_id = $1 order by revision_no desc limit 1)
            order by sr.created_at desc limit 1`,
          [id],
        ),
        pool.query<{ body: string; created_at: string; author: string; via: string | null }>(
          `select m.body, m.created_at, u.display_name as author, m.via_mcp_client as via
             from messages m
             join conversations c on c.id = m.conversation_id
             join users u on u.id = m.author_id
            where c.subject_type = 'proposal' and c.subject_id = $1
            order by m.created_at asc limit 50`,
          [id],
        ),
      ]);
      return toolJson({
        proposalId: p.id,
        state: p.state,
        namespace: p.namespaceSlug,
        semver: p.proposedSemver,
        isNewVersion: p.targetSkillId !== null,
        yourTurn: p.submittedBy === caller.userId && p.state === "changes_requested",
        revisionNo: rev.rows[0]?.revision_no ?? null,
        payload: rev.rows[0]?.payload ?? null,
        scan: scan.rows[0] ? { severity: scan.rows[0].severity, findings: scan.rows[0].findings } : null,
        conversation: msgs.rows.map((m) => ({
          author: m.author,
          body: m.body,
          createdAt: m.created_at,
          ...(m.via ? { viaMcpClient: m.via } : {}),
        })),
      });
    }

    case "revise_proposal":
    case "resubmit_proposal": {
      const id = s(args, "proposalId");
      if (!id) return toolError("proposalId is required");
      const meta = readMetadata(args);
      if (!meta.ok) return toolError(meta.error);
      const p = await loadProposalCtx(pool, id);
      if (!p) return toolError("no such proposal, or it isn't visible to you");
      // Carry the existing revision's source forward, then let the caller's fields override it —
      // so a metadata-only edit doesn't require restating the pointer.
      const { rows: prev } = await pool.query<{ payload: BuiltPayload }>(
        `select payload from proposal_revisions where proposal_id = $1 order by revision_no desc limit 1`,
        [id],
      );
      const previous = prev[0]?.payload;
      let payload: BuiltPayload = { ...previous, metadata: meta.value };
      if (s(args, "url") || s(args, "ref") || s(args, "subdir")) {
        const built = buildPointerPayload(
          {
            url: s(args, "url") ?? previous?.pointer?.url,
            ref: s(args, "ref") ?? previous?.pointer?.ref,
            subdir: s(args, "subdir") ?? previous?.pointer?.subdir ?? undefined,
          },
          meta.value,
        );
        if (!built.ok) return toolError(built.error);
        payload = { ...payload, pointer: built.value.pointer };
      }
      const res = await proposerAction(
        pool,
        caller.access,
        caller.userId,
        id,
        tool === "revise_proposal" ? "revise" : "resubmit",
        payload,
        s(args, "note") ?? null,
        caller.clientName,
      );
      return res.ok ? toolJson(res) : toolError(res.error);
    }

    case "post_proposal_message": {
      const id = s(args, "proposalId");
      const body = s(args, "body");
      if (!id || !body) return toolError("proposalId and body are required");
      const res = await postProposalMessage(pool, caller.access, caller.userId, id, body, caller.clientName);
      return res.ok ? toolJson({ ok: true, messageId: res.messageId }) : toolError(res.error);
    }

    // ── Social ────────────────────────────────────────────────────────────────────────────────
    case "rate_skill": {
      const r = await resolveSkill(pool, caller, args);
      if (!r.ok) return toolError(r.error);
      const stars = args.stars === null ? null : n(args, "stars");
      if (stars === undefined) return toolError("stars is required (1–5, or null to clear)");
      const res = await rateSkill(pool, caller.userId, r.value.id, stars, caller.clientName);
      return res.ok ? toolJson({ ok: true, stars: res.stars }) : toolError(res.error);
    }

    case "get_skill_discussion": {
      const r = await resolveSkill(pool, caller, args);
      if (!r.ok) return toolError(r.error);
      const limit = Math.min(100, Math.max(1, n(args, "limit") ?? 30));
      const offset = Math.max(0, n(args, "offset") ?? 0);
      const { rows } = await pool.query<{
        body: string; created_at: string; author: string; context_semver: string | null; via: string | null;
      }>(
        `select m.body, m.created_at, u.display_name as author, m.context_semver, m.via_mcp_client as via
           from messages m
           join conversations c on c.id = m.conversation_id
           join users u on u.id = m.author_id
          where c.subject_type = 'skill' and c.subject_id = $1
          order by m.created_at desc, m.id desc limit $2 offset $3`,
        [r.value.id, limit, offset],
      );
      return toolJson({
        skill: `${r.value.namespaceSlug}/${r.value.skillSlug}`,
        comments: rows.map((m) => ({
          author: m.author,
          body: m.body,
          createdAt: m.created_at,
          aboutVersion: m.context_semver,
          ...(m.via ? { viaMcpClient: m.via } : {}),
        })),
      });
    }

    case "post_skill_comment": {
      const body = s(args, "body");
      if (!body) return toolError("body is required");
      const r = await resolveSkill(pool, caller, args);
      if (!r.ok) return toolError(r.error);
      const res = await postSkillComment(
        pool,
        caller.access,
        caller.userId,
        {
          id: r.value.id,
          namespaceId: r.value.namespaceId,
          namespaceSlug: r.value.namespaceSlug,
          skillSlug: r.value.skillSlug,
          visibility: r.value.visibility,
        },
        body,
        s(args, "contextSemver") ?? null,
        caller.clientName,
      );
      return res.ok ? toolJson({ ok: true, messageId: res.messageId }) : toolError(res.error);
    }

    case "list_skill_requests": {
      const params: unknown[] = [];
      const where: string[] = [];
      const state = s(args, "state") ?? "open";
      if (state !== "all") {
        params.push(state);
        where.push(`r.state = $${params.length}`);
      }
      const q = s(args, "query");
      if (q) {
        params.push(`%${q}%`);
        where.push(`(r.title ilike $${params.length} or r.description ilike $${params.length})`);
      }
      if (b(args, "mine")) {
        params.push(caller.userId);
        where.push(`r.requester_user_id = $${params.length}`);
      }
      params.push(Math.min(50, Math.max(1, n(args, "limit") ?? 20)));
      const { rows } = await pool.query<{
        id: string; title: string; description: string; state: string; tool_harness: string;
        created_at: string; requester: string; via: string | null;
      }>(
        `select r.id, r.title, r.description, r.state, r.tool_harness, r.created_at,
                u.display_name as requester, r.via_mcp_client as via
           from skill_requests r join users u on u.id = r.requester_user_id
          ${where.length ? `where ${where.join(" and ")}` : ""}
          order by r.created_at desc limit $${params.length}`,
        params,
      );
      return toolJson({
        requests: rows.map((r) => ({
          requestId: r.id,
          title: r.title,
          description: r.description,
          state: r.state,
          toolHarness: r.tool_harness,
          requestedBy: r.requester,
          createdAt: r.created_at,
          ...(r.via ? { viaMcpClient: r.via } : {}),
        })),
      });
    }

    case "request_skill": {
      const res = await createSkillRequest(
        pool,
        caller.userId,
        {
          title: s(args, "title") ?? "",
          description: s(args, "description") ?? "",
          usageExamples: s(args, "usageExamples") ?? null,
          toolHarness: s(args, "toolHarness") ?? "generic",
          categories: Array.isArray(args.categories) ? (args.categories as string[]) : [],
        },
        caller.clientName,
      );
      return res.ok ? toolJson({ ok: true, requestId: res.id }) : toolError(res.error);
    }

    default:
      return toolError(`unknown tool: ${tool}`);
  }
}
