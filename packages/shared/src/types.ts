// Domain types shared across web + worker. Mirrors db/migrations/0001_init.sql.
// See SKILLY_SPEC.md §3.

export type UserStatus = "active" | "inactive";
export type Role = "platform_admin" | "namespace_admin" | "namespace_member";
export type SkillType = "hosted" | "pointer";
export type Visibility = "org" | "namespace";
export type SkillStatus = "active" | "archived";
export type VersionStatus = "active" | "yanked";
export type ProposalState =
  | "proposed"
  | "under_review"
  | "changes_requested"
  | "accepted"
  | "rejected";
export type Channel = "stable" | "beta";

export interface User {
  id: string;
  entraObjectId: string;
  email: string;
  displayName: string;
  status: UserStatus;
}

export interface Namespace {
  id: string;
  slug: string;
  displayName: string;
  requireReview: boolean;
  maintainerContact: string | null;
}

/** An Entra group bound to a (namespace, role). namespaceId is null for platform_admin. */
export interface RoleMapping {
  id: string;
  groupId: string;
  namespaceId: string | null;
  role: Role;
}

export interface Skill {
  id: string;
  namespaceId: string;
  slug: string;
  title: string;
  description: string;
  categoryId: string | null;
  toolHarness: string;
  tags: string[];
  type: SkillType;
  visibility: Visibility;
  status: SkillStatus;
  promotedFromSkillVersionId: string | null;
  installCount: number;
}

export interface SkillVersion {
  id: string;
  skillId: string;
  semver: string;
  isPrerelease: boolean;
  status: VersionStatus;
  usageExamples: string | null;
  /** Per-version "What changed" note (plain text; §8/§10). Null on first versions / promotions. */
  whatChanged: string | null;
  artifactObjectKey: string | null;
  artifactSha256: string | null;
  externalRef: string | null;
  externalOriginUrl: string | null;
  createdBy: string | null;
}

export interface Proposal {
  id: string;
  targetNamespaceId: string;
  targetSkillId: string | null; // null => new skill
  proposedSemver: string;
  state: ProposalState;
  submittedBy: string;
  materializedVersionId: string | null;
  decisionReason: string | null;
}

/**
 * SEEDED defaults for the tool/harness vocabulary — not a closed enum. The effective list is
 * these ∪ distinct values on accepted skills; proposers may introduce new (normalized) values,
 * which join the vocabulary when the skill is accepted. See harness.ts, SKILLY_SPEC.md §3/§8.
 */
export const TOOL_HARNESSES = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "windsurf",
  "generic",
] as const;
export type ToolHarness = (typeof TOOL_HARNESSES)[number];
