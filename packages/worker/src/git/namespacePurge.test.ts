// §71.4 the disk purge after a namespace delete — real directories, real `git` synthesis, and a
// stub pool standing in for repo_disk_purges + the canonical-address lookup.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { synthesizeVersion, listTags } from "./synth.js";
import { repoPath, repoProvisioned } from "./repoStore.js";
import { marketplaceRepoDir } from "./marketplace.js";
import { namespaceRepoDir, purgeDeletedNamespaces, purgeOne, loadPurgeRows, type PurgeRow } from "./namespacePurge.js";

const enc = (s: string) => new TextEncoder().encode(s);
let root: string;

const exists = async (p: string) => access(p).then(() => true, () => false);
const synth = (ns: string, slug: string, semver: string) =>
  synthesizeVersion({ bareRepoPath: repoPath(root, ns, slug), semver, isLatestStable: true, files: [{ path: "SKILL.md", bytes: enc(`# ${slug} ${semver}\n`) }] });

type Db = Parameters<typeof purgeOne>[0];

/** A stub of the two queries the purge runs, over an in-memory queue and skill table. */
function stubPool(queue: PurgeRow[], skills: Record<string, { ns_slug: string; skill_slug: string }>) {
  const deleted: string[] = [];
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (/delete from repo_disk_purges/.test(sql)) {
        deleted.push(String(params[0]));
        return { rows: [], rowCount: 1 };
      }
      if (/select .* from repo_disk_purges/.test(sql)) return { rows: queue.filter((r) => !deleted.includes(r.id)), rowCount: queue.length };
      if (/from skills s join namespaces/.test(sql)) {
        const hit = skills[String(params[0])];
        return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  } as unknown as Db;
  return { db, deleted, queue };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "skilly-nspurge-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("relocates a moved-out skill still at the old address, then removes the namespace and its marketplace repo", async () => {
  await synth("gone-a", "moved", "1.0.0");
  await synth("gone-a", "moved", "1.1.0");
  await synth("gone-a", "purged", "2.0.0"); // an archived skill purged with the namespace
  const mp = marketplaceRepoDir(root, { kind: "namespace", namespaceSlug: "gone-a" });
  await mkdir(mp, { recursive: true });
  await writeFile(join(mp, "HEAD"), "ref: refs/heads/main\n");

  const pool = stubPool(
    [{ id: "q1", namespace_slug: "gone-a", relocations: [{ slug: "moved", skillId: "s-moved" }] }],
    { "s-moved": { ns_slug: "team-b", skill_slug: "moved" } },
  );
  assert.equal(await purgeDeletedNamespaces(pool.db, root), 1);

  assert.ok(await repoProvisioned(root, "team-b", "moved"), "the moved skill now serves from its canonical address");
  assert.deepEqual((await listTags(repoPath(root, "team-b", "moved"))).sort(), ["v1.0.0", "v1.1.0"]);
  assert.equal(await exists(join(root, "gone-a")), false, "the namespace directory is gone");
  assert.equal(await exists(mp), false, "the namespace marketplace repo is gone");
  assert.deepEqual(pool.deleted, ["q1"], "the queue row is deleted");
});

test("a skill permanently deleted since the namespace delete is skipped; its directory still goes", async () => {
  await synth("gone-b", "vanished", "1.0.0");
  const pool = stubPool([{ id: "q2", namespace_slug: "gone-b", relocations: [{ slug: "vanished", skillId: "s-none" }] }], {});
  const out = await purgeOne(pool.db, root, pool.queue[0]!);
  assert.equal(out.relocated, 0);
  assert.equal(await exists(join(root, "gone-b")), false);
  assert.deepEqual(pool.deleted, ["q2"]);
});

test("idempotent: nothing on disk is still a successful purge", async () => {
  const pool = stubPool([{ id: "q3", namespace_slug: "never-had-files", relocations: [] }], {});
  assert.equal(await purgeDeletedNamespaces(pool.db, root), 1);
  assert.deepEqual(pool.deleted, ["q3"]);
});

test("a failing row stays queued and doesn't stop the next one", async () => {
  await synth("gone-c", "x", "1.0.0");
  const pool = stubPool(
    [
      { id: "bad", namespace_slug: "../escape", relocations: [] },
      { id: "q4", namespace_slug: "gone-c", relocations: [] },
    ],
    {},
  );
  assert.equal(await purgeDeletedNamespaces(pool.db, root), 1);
  assert.deepEqual(pool.deleted, ["q4"]);
  assert.equal(await exists(join(root, "gone-c")), false);
  // The bad row is retried next sweep (still in the queue).
  assert.deepEqual((await loadPurgeRows(pool.db)).map((r) => r.id), ["bad"]);
});

test("namespaceRepoDir refuses anything but a plain slug", () => {
  assert.equal(namespaceRepoDir(root, "team-a"), join(root, "team-a"));
  for (const bad of ["", "..", "../x", "a/b", "_marketplace", "Team", "-x"]) {
    assert.throws(() => namespaceRepoDir(root, bad), `${bad} must be refused`);
  }
});

test("loadPurgeRows drops malformed relocation entries", async () => {
  const pool = {
    async query() {
      return { rows: [{ id: "q", namespace_slug: "ns", relocations: [{ slug: "a", skillId: "s" }, { slug: 1 }, null, "x"] }], rowCount: 1 };
    },
  } as unknown as Db;
  assert.deepEqual(await loadPurgeRows(pool), [{ id: "q", namespace_slug: "ns", relocations: [{ slug: "a", skillId: "s" }] }]);
});
