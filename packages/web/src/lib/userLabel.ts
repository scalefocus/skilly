// A human-readable label for a user: their display name — unless it's blank or a bare Entra
// object id (a GUID), in which case their email, so the UI never shows a raw id as a name.
// Defensive: provisioning shouldn't store an id as a name, but old/clobbered rows might, and
// repairing them depends on an Entra reconcile with directory-read permission. SKILLY_SPEC.md §5.

const SQL_GUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const UNKNOWN = "Unknown user";

/**
 * SQL CASE for a human label: the display name, else the email, else "Unknown user" — never a
 * blank or a bare Entra object id (GUID). Trusted column names only (no user input interpolated).
 */
export const nameSql = (name: string, email: string): string =>
  `(case when ${name} is not null and ${name} <> '' and ${name} !~ '${SQL_GUID}' then ${name}
         when ${email} is not null and ${email} <> '' then ${email}
         else '${UNKNOWN}' end)`;

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** JS form of the same rule. */
export function userLabel(name: string | null | undefined, email: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (n && !GUID_RE.test(n)) return n;
  const e = (email ?? "").trim();
  return e || UNKNOWN;
}
