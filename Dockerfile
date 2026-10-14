# syntax=docker/dockerfile:1

# Base image pinned by digest (Dependabot keeps it up to date).
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# ---- build stage -------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# --ignore-scripts: no dependency code runs during install. better-sqlite3 ships
# prebuilt binaries, so no native compilation (and no compiler toolchain) is needed.
COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json server/
COPY tracker/package.json tracker/
COPY dashboard/package.json dashboard/
COPY landing/package.json landing/
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY server server
COPY tracker tracker
COPY dashboard dashboard
RUN npm run build

# Production dependencies of the server only.
RUN rm -rf node_modules server/node_modules \
 && npm ci --omit=dev --ignore-scripts --workspace=server --include-workspace-root=false --no-audit --no-fund

# ---- runtime stage -----------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app

# npm/corepack are not needed at runtime; removing them shrinks the attack surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && install -d -o node -g node -m 0700 /data

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/tracker/dist ./tracker/dist
COPY --from=build /app/dashboard/dist ./dashboard/dist

USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server/dist/index.js"]
