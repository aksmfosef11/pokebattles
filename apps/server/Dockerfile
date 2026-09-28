# syntax=docker/dockerfile:1
# PokéBattles API server (no client pages). Build from the repository root:
#   docker build -f apps/server/Dockerfile -t pokebattles-server .
#   docker run -d -p 8787:8787 -e DATABASE_URL=postgres://user:pass@host:5432/pokebattles pokebattles-server
# Without DATABASE_URL the server keeps its data in embedded PGlite under /data/pglite (one container only):
#   docker run -d -p 8787:8787 -v pokebattles-data:/data pokebattles-server
# Environment: PORT (8787), DATABASE_URL, PG_POOL_MAX (10), POKEBATTLES_PGDATA (/data/pglite), ADMIN_TOKEN (balance stats),
# CORS_ORIGIN (comma-separated origins, when the client is hosted on another site), REGISTER_PER_HOUR (10),
# BUILD_ID (tags recorded battles and runs for the statistics; default: a hash of the server bundle).

FROM node:22-bookworm-slim AS build
RUN npm install -g pnpm@10.34.5
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/game/package.json packages/game/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY tools/package.json tools/
RUN pnpm install --frozen-lockfile --filter "@pokebattles/server..."
COPY packages/game packages/game
COPY apps/server apps/server
# One bundle with the game rules and content inside. The database drivers stay outside: PGlite loads its
# .wasm/.data files from next to its own module.
RUN pnpm --filter @pokebattles/server build \
 && mkdir /out && cd /out \
 && npm init -y > /dev/null \
 && npm install --omit=dev --no-audit --no-fund \
      "pg@$(node -p "require('/repo/apps/server/package.json').dependencies['pg']")" \
      "@electric-sql/pglite@$(node -p "require('/repo/apps/server/package.json').dependencies['@electric-sql/pglite']")"

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8787 \
    POKEBATTLES_PGDATA=/data/pglite
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/server/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
# /api/health also checks the database.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/main.mjs"]
