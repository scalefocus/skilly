/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-hosted standalone Node server. NEVER Vercel. (SKILLY_SPEC.md §2)
  output: "standalone",
  reactStrictMode: true,
  // DEV-SERVER ONLY (`next dev`; `next build` ignores it). The e2e suite pre-compiles every route
  // (packages/web/e2e/global-setup.ts), but the dev server keeps just 5 on-demand entries and
  // disposes the rest after 60s idle - so with ~115 routes the warm-up was undone within a
  // minute and every "first hit" compile came back mid-run as an 11-25s stall that failed the
  // spec holding it. Opt-in via env so day-to-day dev keeps the default memory profile; the CI
  // e2e stages and the Playwright webServer set it.
  ...(process.env.SKILLY_DEV_KEEP_ROUTES === "1"
    ? { onDemandEntries: { maxInactiveAge: 24 * 60 * 60 * 1000, pagesBufferLength: 500 } }
    : {}),
  transpilePackages: ["@skilly/shared"],
  // sharp (§33 icon normalization) ships native prebuilt binaries per platform/libc — keep it OUT
  // of the webpack/traced server bundle so its `@img/*` optional-dependency binaries are resolved
  // from node_modules at runtime instead of statically traced (which can silently drop the wrong
  // platform's binary in `output: "standalone"`).
  serverExternalPackages: ["sharp"],
  experimental: {
    // keep server actions on; used for proposal/review flows
    serverActions: { bodySizeLimit: "12mb" }, // ~10MB bundle cap + overhead (§6)
  },
  // Static security headers (audit P1). The Content-Security-Policy is NOT set here — it carries a
  // per-request nonce, which a static header can't express, so it's emitted by src/middleware.ts
  // (SKILLY_SPEC.md §22). These headers are request-independent and stay in next.config; /api/*
  // additionally gets no-store so authenticated JSON (incl. the install token) is never cached by
  // a shared proxy or bfcache.
  async headers() {
    const base = [
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    ];
    return [
      { source: "/:path*", headers: base },
      { source: "/api/:path*", headers: [...base, { key: "Cache-Control", value: "no-store" }] },
    ];
  },
  webpack: (config) => {
    // @skilly/shared is ESM TypeScript using ".js" import specifiers (NodeNext style).
    // Teach webpack to resolve those to ".ts"/".tsx" when transpiling the workspace pkg.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};
export default nextConfig;
