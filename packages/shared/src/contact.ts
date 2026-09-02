// Namespace maintainer contact (SKILLY_SPEC.md §3 `namespaces`, §30.6).
//
// The value is an email address or empty — never free-form prose. It is published as
// `owner.email` in the namespace's plugin-marketplace manifest (§30.3), so a non-address here
// emits a manifest with an invalid owner. It is NOT required to name a registered user: a
// shared mailbox or a distribution list is a legitimate contact, which is why the check is on
// address *shape* only.
//
// Client-safe (no node deps): the same functions back the browser check and every server
// writer, so the dual surface (§30.6) cannot diverge on what it accepts.

/** The practical ceiling on an address (RFC 5321 forward-path limit). */
export const MAINTAINER_CONTACT_MAX = 254;

/** The stored form of a raw field value: trimmed, or `null` when the contact is cleared. */
export function normalizeMaintainerContact(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  return v === "" ? null : v;
}

/**
 * Deliberately pragmatic, not RFC 5322: a local part with no whitespace or delimiters, one `@`,
 * and a dotted domain ending in a 2+ letter TLD. A full RFC grammar would accept things no mail
 * system routes (and is famously unreadable); a looser check would let `ask the team` through
 * into a marketplace manifest, which is the failure this exists to stop.
 */
const EMAIL = /^[^\s@,;:<>()[\]\\"]+@[^\s@.,;:<>()[\]\\"]+(?:\.[^\s@.,;:<>()[\]\\"]+)*\.[A-Za-z]{2,}$/;

export function isMaintainerContact(value: string): boolean {
  return value.length <= MAINTAINER_CONTACT_MAX && EMAIL.test(value);
}

/**
 * `null` when the value is acceptable, else the message shown in the browser and returned by
 * the API (422). Clearing the contact is always allowed.
 */
export function maintainerContactError(raw: string | null | undefined): string | null {
  const v = normalizeMaintainerContact(raw);
  if (v === null) return null;
  if (v.length > MAINTAINER_CONTACT_MAX) return `maintainer contact must be at most ${MAINTAINER_CONTACT_MAX} characters`;
  return isMaintainerContact(v) ? null : "maintainer contact must be an email address, or empty";
}
