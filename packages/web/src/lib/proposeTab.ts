// The propose page's three tabs and the `mode` address parameter (SKILLY_SPEC.md §64.2, §26):
// "I have a skill" (no `mode`), "I have a repo" (`mode=repo`) and "I want a skill" (`mode=want`).
// Pure, so the page and the /propose/import redirect share it and it unit-tests without a DOM.

export type ProposeTab = "have" | "repo" | "want";

/** The tab an address opens. A new-version link always opens "I have a skill" (no tabs show). */
export function proposeTabFromAddress(mode: string | null, newVersion: boolean): ProposeTab {
  if (newVersion) return "have";
  return mode === "repo" || mode === "want" ? mode : "have";
}

/** The query string after switching to `tab`: `mode` rewritten (dropped for "have"), the rest kept. */
export function proposeTabQuery(search: string, tab: ProposeTab): string {
  const q = new URLSearchParams(search);
  if (tab === "have") q.delete("mode");
  else q.set("mode", tab);
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** The address that opens the repo tab with Repository and Ref filled (§64.9). */
export function repoTabHref(url: string, ref: string | null): string {
  const q = new URLSearchParams({ mode: "repo", url, ...(ref ? { ref } : {}) });
  return `/propose?${q.toString()}`;
}

/** Where the old /propose/import address goes: the repo tab, every query value kept. */
export function legacyImportRedirect(searchParams: Record<string, string | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (typeof v === "string") q.append(k, v);
    else if (Array.isArray(v)) for (const one of v) q.append(k, one);
  }
  return `/propose${proposeTabQuery(q.toString(), "repo")}`;
}
