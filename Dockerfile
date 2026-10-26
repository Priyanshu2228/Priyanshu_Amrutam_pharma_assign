# syntax=docker/dockerfile:1.7
# Multi-stage build: compile with dev deps, ship only production deps + JS on a slim,
# non-root image. The same image runs the API, the worker and migrations.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps --max-old-space-size=384"
WORKDIR /app
# Apply Debian security updates, and drop npm/corepack: the runtime only ever runs `node`,
# and the package managers' bundled dependencies are the main source of image CVEs.
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && mkdir -p /app/storage && chown node:node /app/storage
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node openapi ./openapi
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
# HEALTH_PORT lets the worker image (probe on 9464) reuse the same check.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini reaps zombies and forwards SIGTERM so graceful shutdown runs.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
