// Repo synthesis — materialize a skill's serving git repo from its stored artifact.
// Each version becomes an IMMUTABLE lightweight tag `v<semver>` on a root commit; the
// `main` branch tracks the latest stable version. Uses git plumbing against a BARE repo
// (no working tree). SKILLY_SPEC.md §6 ("serving architecture"), §7 (version=tag).
import { spawn } from "node:child_process";
import { mkdir, access } from "node:fs/promises";
import { versionTag } from "@skilly/shared";

export interface SkillFile {
  /** repo-relative path, e.g. "SKILL.md" or "scripts/run.sh" */
  path: string;
  bytes: Uint8Array;
  /** git mode; default 100644 (regular file), 100755 for executables */
  mode?: "100644" | "100755";
}

export interface SynthesizeInput {
  bareRepoPath: string;
  semver: string;
  files: SkillFile[];
  /** when true, point `main` at this version (it is the new latest stable) */
  isLatestStable: boolean;
  message?: string;
  /** deterministic ISO date for author/committer (tests pass a fixed value) */
  date?: string;
  author?: { name: string; email: string };
}

function git(args: string[], opts: { gitDir?: string; cwd?: string; env?: NodeJS.ProcessEnv; input?: Buffer }): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...opts.env };
    if (opts.gitDir) env.GIT_DIR = opts.gitDir;
    const child = spawn("git", args, { cwd: opts.cwd, env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`git ${args.join(" ")} failed (${code}): ${err}`)),
    );
    if (opts.input) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

interface TreeNode {
  files: Map<string, { mode: string; sha: string }>;
  dirs: Map<string, TreeNode>;
}
function emptyNode(): TreeNode {
  return { files: new Map(), dirs: new Map() };
}

async function writeBlob(gitDir: string, bytes: Uint8Array): Promise<string> {
  const sha = await git(["hash-object", "-w", "--stdin"], { gitDir, input: Buffer.from(bytes) });
  return sha.trim();
}

async function mkTree(gitDir: string, node: TreeNode): Promise<string> {
  const lines: string[] = [];
  for (const [name, f] of node.files) lines.push(`${f.mode} blob ${f.sha}\t${name}`);
  for (const [name, dir] of node.dirs) {
    const ts = await mkTree(gitDir, dir);
    lines.push(`040000 tree ${ts}\t${name}`);
  }
  const out = await git(["mktree"], { gitDir, input: Buffer.from(lines.join("\n") + "\n") });
  return out.trim();
}

/** The version tags present in a bare repo (empty list if the repo doesn't exist yet). */
export async function listTags(bareRepoPath: string): Promise<string[]> {
  if (!(await exists(bareRepoPath))) return [];
  const out = await git(["tag", "--list"], { gitDir: bareRepoPath });
  return out.split("\n").map((t) => t.trim()).filter(Boolean);
}

/**
 * Ensure `refs/heads/main` points at <tag>'s commit. Returns true if it created/moved main,
 * false if main was already correct or the tag doesn't exist. `main` is the default branch a
 * fragment-less `npx skills add` clones, so it MUST track the latest stable version — a missing
 * or stale main yields an empty ("No skills found") clone. Cheap repair used by the self-heal
 * sweep for repos whose latest-stable tag exists but whose main drifted/never got written.
 */
export async function pointMainAtTag(bareRepoPath: string, tag: string): Promise<boolean> {
  let want: string;
  try {
    want = (await git(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], { gitDir: bareRepoPath })).trim();
  } catch {
    return false; // tag missing — the caller re-synthesizes the version instead
  }
  let cur = "";
  try {
    cur = (await git(["rev-parse", "--verify", "refs/heads/main"], { gitDir: bareRepoPath })).trim();
  } catch {
    /* main is unborn */
  }
  if (cur === want) return false;
  await git(["update-ref", "refs/heads/main", want], { gitDir: bareRepoPath });
  return true;
}

/**
 * Synthesize (or extend) the serving repo with a new immutable version.
 * Throws if the version's tag already exists (immutability) or if no SKILL.md is present.
 */
export async function synthesizeVersion(input: SynthesizeInput): Promise<{ commit: string; tag: string }> {
  const { bareRepoPath, semver, files } = input;
  if (!files.some((f) => f.path === "SKILL.md")) {
    throw new Error("bundle must contain a top-level SKILL.md");
  }
  const tag = versionTag(semver);

  if (!(await exists(bareRepoPath))) {
    await mkdir(bareRepoPath, { recursive: true });
    await git(["init", "--bare", "--initial-branch=main", bareRepoPath], {});
  }

  // Immutability: never overwrite an existing version tag.
  const existingTags = (await git(["tag", "--list"], { gitDir: bareRepoPath })).split("\n").map((t) => t.trim());
  if (existingTags.includes(tag)) {
    throw new Error(`version tag ${tag} already exists (immutable)`);
  }

  // Build the tree from the bundle. SKILL.md lives at the repo ROOT: `npx skills add`
  // installs a single-skill repo by reading a root-level SKILL.md (EXTERNAL_TOOL_CONTRACT
  // skillMdLocation = "repo-root"; the tool scans the root and `skills/<name>/`, NOT an
  // arbitrary top-level `<slug>/` wrapper — wrapping there yields "No skills found").
  const root = emptyNode();
  for (const f of files) {
    const segments = f.path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      if (!node.dirs.has(seg)) node.dirs.set(seg, emptyNode());
      node = node.dirs.get(seg)!;
    }
    const name = segments[segments.length - 1]!;
    const sha = await writeBlob(bareRepoPath, f.bytes);
    node.files.set(name, { mode: f.mode ?? "100644", sha });
  }
  const treeSha = await mkTree(bareRepoPath, root);

  const author = input.author ?? { name: "skilly", email: "skilly@localhost" };
  const date = input.date ?? "2026-01-01T00:00:00Z";
  const commitEnv: NodeJS.ProcessEnv = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_COMMITTER_DATE: date,
  };
  const commit = (
    await git(["commit-tree", treeSha, "-m", input.message ?? `skilly: publish ${tag}`], {
      gitDir: bareRepoPath,
      env: commitEnv,
    })
  ).trim();

  // Immutable lightweight tag for this exact version.
  await git(["update-ref", `refs/tags/${tag}`, commit], { gitDir: bareRepoPath });

  // main tracks latest stable.
  if (input.isLatestStable) {
    await git(["update-ref", "refs/heads/main", commit], { gitDir: bareRepoPath });
  }

  return { commit, tag };
}
