# nginx image serving the built SPA. Build context MUST be the repo root:
# @hivly/web depends on @hivly/shared (raw source) and the root lockfile for
# `npm ci`. Stage 1 builds dist with Vite; the final stage bakes dist + the
# root nginx.conf into nginx:1.27-alpine, so the compose `nginx` service serves
# the SPA at / with no separate web service or shared volume (7 services total).
FROM node:24-alpine AS build

WORKDIR /app

# Manifests first so `npm ci` is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/
COPY packages/bot/package.json ./packages/bot/
COPY packages/workers/package.json ./packages/workers/
COPY packages/web/package.json ./packages/web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/web ./packages/web
RUN npm run build -w @hivly/web

# --- final image ------------------------------------------------------------
FROM nginx:1.27-alpine

# nginx.conf fully replaces the default (events {} + http {}). AD-7: buffering
# off on /api/chat, backend is the only upstream, / serves the SPA.
COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
