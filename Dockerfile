# syntax=docker/dockerfile:1

# ---- build stage -------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Build tools are only needed if no prebuilt better-sqlite3 binary is available.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json ./
COPY server/package.json server/
COPY tracker/package.json tracker/
COPY dashboard/package.json dashboard/
RUN npm ci --no-audit --no-fund

COPY server server
COPY tracker tracker
COPY dashboard dashboard
RUN npm run build

# Production dependencies of the server only.
RUN rm -rf node_modules server/node_modules \
 && npm ci --omit=dev --workspace=server --include-workspace-root=false --no-audit --no-fund

# ---- runtime stage -----------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data
WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/tracker/dist ./tracker/dist
COPY --from=build /app/dashboard/dist ./dashboard/dist

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server/dist/index.js"]
