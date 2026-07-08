# Development Guide

This guide provides step-by-step instructions for setting up the development environment and running the Hivly Self-Hosted system.

Hivly is a self-hosted AI agent that indexes a Discord community's knowledge and answers questions with verifiable sources. It is an **npm-workspaces monorepo** with a shared domain kernel and event-driven ingestion (see `docs/context/ARCHITECTURE-SPINE.md`).

## 🚀 Setup Instructions

### Prerequisites

Ensure you have the following installed:
- **Node.js** 24 LTS
- **npm** 10 or higher (workspaces support)
- **Docker** and **Docker Compose** v2
- **Git**

### 1. Clone the Repository

```bash
git clone https://github.com/Hivly/hivly.git
cd hivly
```

### 2. Install dependencies

```bash
npm install   # installs every workspace under packages/*
```

### 3. Configuration

The system uses **two** configuration files (never mix them):

- `Hivly.config.yml` — behavior configuration (channels, models, RBAC, knowledge tuning, rate limits). Validated by `loadConfig()` in `@hivly/shared`.
- `.env` — secrets only (Discord tokens, LLM API keys, DB/Redis URLs, `SENTRY_DSN`).

```bash
cp Hivly.config.yml.example Hivly.config.yml
cp .env.example .env
# edit both files with real values
```

Typical `.env` keys:

```env
# Database
DATABASE_URL="postgresql://hivly:hivly@localhost:5432/hivly"
# Redis (streams + sessions)
REDIS_URL="redis://localhost:6379"
# Discord
DISCORD_BOT_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_CLIENT_SECRET=...
DISCORD_GUILD_ID=...
# LLM / embeddings
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
# Web (dev)
FRONTEND_URL="http://localhost:5173"
SESSION_SECRET=...
```

### 4. Full stack with Docker Compose (recommended)

The whole system runs with a single command. Compose has 7 services: `migrator` (one-shot, runs `drizzle-kit migrate`), `nginx`, `bot`, `backend`, `workers`, `postgres` (pgvector), `redis`. Services depend on `migrator` completing successfully.

```bash
docker compose up -d          # start everything
docker compose ps             # verify service state
docker compose logs -f backend
docker compose down           # stop
```

nginx is the only host-exposed service (ports 80/443): it serves the SPA and reverse-proxies `/api/*` to the backend.

### 5. Local development (services outside Docker)

Run only the infrastructure in Docker and the app services locally with hot reload:

```bash
docker compose up -d postgres redis   # infra only
npx drizzle-kit migrate               # apply migrations against local DB

npm run dev -w @hivly/backend         # Express API + LangGraph agent on :3000
npm run dev -w @hivly/web             # Vite dev server (SPA) on :5173
npm run dev -w @hivly/bot             # Discord Bot (ingestion)
npm run dev -w @hivly/workers         # Indexer + Sync consumers
```

In dev the Web App runs on Vite (`:5173`) and the Backend on `:3000` (different origins); the Vite proxy forwards `/api/*` to the backend and the Backend allows `FRONTEND_URL` via CORS.

### 6. Database migrations (Drizzle)

The schema is the single source of truth in `packages/shared/src/db/schema.ts`. Only `packages/shared` does DDL.

```bash
npx drizzle-kit generate   # generate SQL migration from schema.ts
npx drizzle-kit migrate    # apply migrations (the `migrator` service does this in Compose)
```

Never hand-edit generated migration SQL.

## 🧪 Testing

Verification gate for every story: **type-check + tests + build** must run green before committing.

```bash
npm run lint            # ESLint across all packages
npm run lint:fix
npm run test            # Vitest (unit/integration) across workspaces
npm run test -w @hivly/backend   # scope to one workspace
npm run test:integration         # integration suites (need Postgres + Redis; see the warning below)
npm run build           # build all packages
```

> ⚠️ **Do not run `npm run test:integration` against a database a live app stack is also using.**
> The integration suites seed and assert on shared tables (`channel_permissions`, `discord_messages`,
> …). A running `docker compose` **backend** materializes `channel_permissions` from its own config on
> boot, and the **bot**/**workers** write ingest rows — both perturb the tests and cause intermittent
> failures. Before running integration tests, stop the app containers (infra stays up):
>
> ```bash
> docker compose stop bot backend workers   # leave postgres + redis running
> npm run test:integration
> docker compose start bot backend workers   # restore when done
> ```
>
> `openTestClients` has a **best-effort** guard (Story OPS-2) that fails fast if it detects a connection to
> the test DB from a *foreign client address* (a dockerized app container or a remote client). It does **not**
> catch a **same-host** writer — e.g. a local `npm run dev -w @hivly/backend` sharing your address — nor a
> writer behind a connection pooler; stopping those is on you (this doc). Set `HIVLY_TEST_ALLOW_SHARED_DB=1`
> to bypass the guard for an intentional shared-DB run.

E2E (web workflows) run with Playwright. The harness lands with **Story 4.5**; it boots the
Backend with an injected **fake Discord OAuth** client over a test Postgres+pgvector/Redis
(seeded), so it authenticates the SPA without real Discord credentials:

```bash
npx playwright install chromium  # one-time: download the browser (chromium only)
npm run test:e2e -w @hivly/web   # Playwright end-to-end (needs test Postgres+Redis + fake-OAuth session)
```

## Updating a running deployment

```bash
git pull
docker compose build
docker compose up -d
# the `migrator` service applies new migrations automatically before services start
```
