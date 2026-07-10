# @share2brain/backend image. Build context MUST be the repo root (see the story's
# Dev Notes): @share2brain/shared is consumed as raw source, so the image needs
# packages/shared/src plus the root lockfile for `npm ci`. tsx is the runtime —
# Node's native type-stripping can't resolve the workspace's .ts exports.
FROM node:24-alpine

WORKDIR /app

# Manifests first so `npm ci` is cached until a dependency actually changes.
# All workspace manifests are required for npm to validate the workspace tree.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/
COPY packages/bot/package.json ./packages/bot/
COPY packages/workers/package.json ./packages/workers/
COPY packages/web/package.json ./packages/web/
RUN npm ci

# Sources: the shared kernel and this service only.
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/backend ./packages/backend

# Run from /app so loadConfig() finds the mounted /app/Share2Brain.config.yml (cwd).
CMD ["npx", "tsx", "packages/backend/src/main.ts"]
