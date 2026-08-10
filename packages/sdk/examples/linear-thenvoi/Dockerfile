# syntax=docker/dockerfile:1

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY linear-thenvoi-bridge-agent.ts linear-thenvoi-bridge-server.ts ./
RUN npm run build

FROM node:22-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts \
    && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY prompt.md ./prompt.md
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data

ENV PORT=8787
ENV LINEAR_THENVOI_STATE_DB=/app/data/state.sqlite
ENV LINEAR_THENVOI_PROMPT_PATH=/app/prompt.md

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8787/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/linear-thenvoi-bridge-server.js"]
