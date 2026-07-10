"use client";
import { SessionProvider } from "next-auth/react";
import type { ReactNode } from "react";
import { DateFormatProvider } from "./DateFormat";

export function Providers({ children }: { children: ReactNode }) {
  // refetchOnWindowFocus disabled: the JWT session is long-lived; re-hitting
  // /api/auth/session on every tab refocus is needless load.
  return (
    <SessionProvider refetchOnWindowFocus={false}>
      <DateFormatProvider>{children}</DateFormatProvider>
    </SessionProvider>
  );
}
