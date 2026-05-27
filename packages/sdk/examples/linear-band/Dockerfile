# Linear Bridge Agent
#
# Build context: repository root (pnpm workspace)
#
#   docker build -f packages/sdk/examples/linear-thenvoi/Dockerfile -t thenvoi-linear-bridge .
#   docker run --env-file .env -p 8787:8787 thenvoi-linear-bridge
#

FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@10.22.0 --activate

WORKDIR /app

# ── dependency layer (cached until manifests change) ──────────────
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/openclaw/package.json packages/openclaw/

RUN pnpm install --frozen-lockfile

# ── source layer ──────────────────────────────────────────────────
COPY packages/sdk/src ./packages/sdk/src
COPY packages/sdk/examples/linear-thenvoi ./packages/sdk/examples/linear-thenvoi

# ── run as non-root ───────────────────────────────────────────────
RUN addgroup --system --gid 1001 bridge && \
    adduser --system --uid 1001 --ingroup bridge bridge

USER bridge

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8787/healthz || exit 1

# tsx is required because the example imports TypeScript source (../../src/*) directly.
# devDependencies (including tsx) are installed before NODE_ENV=production is set.
CMD ["pnpm", "--filter", "@thenvoi/sdk", "start:linear"]
