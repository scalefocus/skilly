/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-hosted standalone Node server. NEVER Vercel. (SKILLY_SPEC.md §2)
  output: "standalone",
  reactStrictMode: true,
  transpilePackages: ["@skilly/shared"],
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
