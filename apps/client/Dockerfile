# syntax=docker/dockerfile:1
# PokéBattles client: the built pages on nginx, which also forwards /api to the server container.
# Build from the repository root:
#   docker build -f apps/client/Dockerfile -t pokebattles-client .
# API_UPSTREAM (default http://server:8787) is where /api goes. To host the pages apart from the
# server instead, build with --build-arg VITE_API_URL=https://api.example.com and set CORS_ORIGIN on the server.

FROM node:22-bookworm-slim AS build
RUN npm install -g pnpm@10.34.5
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/game/package.json packages/game/
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY tools/package.json tools/
RUN pnpm install --frozen-lockfile --filter "@pokebattles/client..."
COPY packages/game packages/game
COPY apps/client apps/client
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @pokebattles/client build

FROM nginx:1.27-alpine
ENV API_UPSTREAM=http://server:8787
COPY apps/client/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/client/dist /usr/share/nginx/html
EXPOSE 80
