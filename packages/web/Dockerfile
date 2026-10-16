# Next.js standalone build for skilly web. Self-hosted; never Vercel. (SKILLY_SPEC.md §2)
# Base images are pinned by tag + digest (SKILLY_SPEC.md §49.12); bump via deploy/IMAGES.md.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS base
RUN corepack enable
WORKDIR /app

# --- deps + build (monorepo aware) ---
FROM base AS build
# Copy the lockfile so the install is reproducible (--frozen-lockfile fails on drift). Audit M-4.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/web ./packages/web
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @skilly/shared build
RUN pnpm --filter @skilly/web build

# --- runtime (standalone output) ---
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runner
WORKDIR /app
ENV NODE_ENV=production
# git: used by the propose form's pointer ref pre-check (`git ls-remote`), hardened identically
# to the worker's mirror (https-only transport allowlist, no redirects/prompts). SKILLY_SPEC.md §6.
# ca-certificates explicitly so the outbound HTTPS git has a CA trust store (don't rely on the base
# image shipping it implicitly) — without it clones fail with "CAfile: none". Matches the worker.
RUN apk add --no-cache git ca-certificates
COPY --from=build /app/packages/web/.next/standalone ./
COPY --from=build /app/packages/web/.next/static ./packages/web/.next/static
COPY --chmod=755 --from=build /app/packages/web/public ./packages/web/public
EXPOSE 3000
# Run unprivileged (no runtime writes needed). Audit M-5.
USER node
# standalone server entrypoint produced by Next for the web package
CMD ["node", "packages/web/server.js"]
