"use client";
// Lets a dynamic-title page (skill/request/proposal detail) override the static default page
// label the presence beacon uses (SKILLY_SPEC.md §4), once it's fetched its own title.
import { createContext, useContext, useEffect } from "react";

const PageLabelOverrideContext = createContext<(label: string | null) => void>(() => {});

export const PageLabelOverrideProvider = PageLabelOverrideContext.Provider;

/**
 * Call with the page's resolved title once known (e.g. `"Skill: SEO Checklist"`), or `null`
 * while it's still loading (keeps the static route default until then). Clears itself on
 * unmount so leaving the page never leaves a stale override for the next route.
 */
export function usePageLabelOverride(label: string | null): void {
  const setOverride = useContext(PageLabelOverrideContext);
  useEffect(() => {
    setOverride(label);
    return () => setOverride(null);
  }, [label, setOverride]);
}
