# skilly worker: SCIM endpoints + reconciliation + scan pipeline. (SKILLY_SPEC.md §2)
FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
# Copy the lockfile so the install is reproducible (--frozen-lockfile fails on drift). Audit M-4.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/worker ./packages/worker
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @skilly/shared build
RUN pnpm --filter @skilly/worker build

FROM node:20-slim AS runner
# `git` is required for the smart-HTTP server (git http-backend / upload-pack).
# IMPORTANT: node:20-alpine does NOT ship git-http-backend in any package — switch to
# Debian slim where `apt-get install git` includes /usr/lib/git-core/git-http-backend.
# SKILLY_SPEC.md §9.
# `ca-certificates` is a Recommends of git (not a hard dep), so --no-install-recommends drops it —
# without it git has no CA trust store and EVERY outbound HTTPS clone (the pointer mirror, §6) fails
# with "server certificate verification failed. CAfile: none". Install it explicitly.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /app
ENV NODE_ENV=production
ENV GIT_REPO_ROOT=/data/git
COPY --from=build /app/pnpm-workspace.yaml /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/worker ./packages/worker
RUN pnpm install --prod --frozen-lockfile
# Run unprivileged (audit M-5). The git repo root is created node-owned; in k8s set fsGroup so
# the PVC is group-writable, in compose ensure the bind-mounted ./data/git is uid-1000 writable.
RUN mkdir -p /data/git && chown -R node:node /data/git /app
USER node
EXPOSE 4000
CMD ["node", "packages/worker/dist/index.js"]
