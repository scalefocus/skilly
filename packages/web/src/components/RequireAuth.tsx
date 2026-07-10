"use client";
import { type ReactNode, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

/**
 * Client-side gate for pages that must not be shown to anonymous visitors
 * (catalog, review queue, propose, access tokens). The data APIs already 401,
 * but this keeps the *page* itself behind sign-in. Anonymous visitors are sent
 * to the public landing (which carries the sign-in affordance in the sidebar) —
 * we never render a sign-in wall/button in the page body. The nav links to these
 * pages are likewise hidden when signed out (see AppShell). Spec: CLAUDE.md
 * invariant #3 (auth-required catalog).
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "unauthenticated") router.replace("/");
  }, [status, router]);

  if (status !== "authenticated") {
    // Loading, or redirecting an anonymous visitor to the landing — neutral placeholder only.
    return <div className="skeleton" style={{ height: 260, borderRadius: "var(--radius)" }} />;
  }

  return <>{children}</>;
}
