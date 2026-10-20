/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-hosted standalone Node server. NEVER Vercel. (SKILLY_SPEC.md §2)
  output: "standalone",
  reactStrictMode: true,
  // E2E SHARDS ONLY. A sharded CI run starts one `next dev` per shard from this same directory, and
  // two dev servers can't share `.next`: Next 16 holds a lock file in it, and their compiled output
  // would collide anyway. Each shard's Playwright webServer sets its own build folder
  // (playwright.config.ts); unset everywhere else, so `.next` stays the default.
  ...(process.env.SKILLY_NEXT_DIST_DIR ? { distDir: process.env.SKILLY_NEXT_DIST_DIR } : {}),
  // @skilly/shared is consumed from its compiled dist/ (its package exports), whose ".js" import
  // specifiers resolve as written, so the bundler needs no extension aliasing for it.
  transpilePackages: ["@skilly/shared"],
  // sharp (§33 icon normalization) ships native prebuilt binaries per platform/libc — keep it OUT
  // of the bundled/traced server code so its `@img/*` optional-dependency binaries are resolved
  // from node_modules at runtime instead of statically traced (which can silently drop the wrong
  // platform's binary in `output: "standalone"`).
  serverExternalPackages: ["sharp"],
  // ...and copy sharp's installed platform packages into the standalone output whole. Turbopack's
  // file tracing follows only the `.node` binary sharp require()s, not the libvips shared library
  // that binary loads (inside @img/sharp-win32-x64/lib on Windows, a separate
  // @img/sharp-libvips-<platform> package on Linux), so without this every route that imports
  // sharp answers 500 in production ("Could not load the sharp module"). Webpack's tracer had a
  // sharp special case that did this. The paths are pnpm's store (the repo's package manager),
  // resolved from this package's directory; only the current platform's packages are installed.
  outputFileTracingIncludes: {
    "/*": ["../../node_modules/.pnpm/@img+sharp-*/node_modules/@img/sharp-*/**/*"],
  },
  experimental: {
    // keep server actions on; used for proposal/review flows
    serverActions: { bodySizeLimit: "12mb" }, // ~10MB bundle cap + overhead (§6)
    // DEV-SERVER ONLY (`next dev`; `next build` ignores it), and only for the e2e dev server
    // (SKILLY_E2E_DEV_SERVER=1: the Playwright webServer and both CI e2e stages set it). Turbopack
    // writes every compiled route to the build folder's disk cache (<distDir>/dev/cache, on by
    // default in dev); "full" eviction then drops that output from memory after each cache
    // snapshot, instead of only when it expects a large saving or the host runs short ("auto",
    // the default, which day-to-day dev keeps). The e2e warm-up (e2e/global-setup.ts) compiles
    // every route up front, so a spec's first request to one restores it from disk instead of
    // compiling it, and the server's memory no longer grows with every route it has served.
    // Under webpack the e2e server instead kept every route compiled in memory (onDemandEntries,
    // which Turbopack ignores) and had Next's memory-threshold restart switched off, because a
    // restart threw that warm-up away. Neither is needed now: the heap stays far below the restart
    // line, and a restart would restore routes from the disk cache rather than recompile them.
    ...(process.env.SKILLY_E2E_DEV_SERVER === "1" ? { turbopackMemoryEviction: "full" } : {}),
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
};
export default nextConfig;
