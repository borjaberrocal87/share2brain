# @hivly/bot image. Build context MUST be the repo root (see the story's Dev
# Notes): @hivly/shared is consumed as raw source, so the image needs
# packages/shared/src plus the root lockfile for `npm ci`. tsx is the runtime.
FROM node:24-alpine

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
COPY packages/bot ./packages/bot

# Run from /app so loadConfig() finds the mounted /app/Hivly.config.yml (cwd).
CMD ["npx", "tsx", "packages/bot/src/main.ts"]
