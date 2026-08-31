// Install-expiry policy (§23) — the calendar-month horizon a user's install URL may be set to.
//
// This lives in shared because THREE callers must agree on it: the web API (which mints and
// validates), the expiry picker in the browser (which bounds what a user can choose), and — since
// §29 — the worker's `install_skill` MCP tool. A tool that minted a longer-lived install than the
// browser allows would be a quiet policy hole, so the arithmetic is written once.
export const INSTALL_TTL_MONTHS_DEFAULT = 12;
export const INSTALL_TTL_MONTHS_MIN = 1;
export const INSTALL_TTL_MONTHS_MAX = 120;

/**
 * Add `n` calendar months to `d`, clamping a day that overflows a shorter month
 * (Jan 31 + 1mo → Feb 28/29).
 */
export function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  const day = r.getDate();
  r.setMonth(r.getMonth() + n);
  if (r.getDate() < day) r.setDate(0); // rolled into the next month → back up to the intended month's last day
  return r;
}

/**
 * Latest allowable install-expiry instant: `now + months` calendar months, plus a 2-day grace so an
 * end-of-day-in-user-timezone pick exactly at the horizon isn't rejected.
 */
export function installExpiryCeiling(months: number, from: Date = new Date()): Date {
  return new Date(addMonths(from, months).getTime() + 2 * 86_400_000);
}

/** Coerce a stored month count into range, falling back to the default on anything malformed. */
export function coerceInstallTtlMonths(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= INSTALL_TTL_MONTHS_MIN && (value as number) <= INSTALL_TTL_MONTHS_MAX
    ? (value as number)
    : INSTALL_TTL_MONTHS_DEFAULT;
}
