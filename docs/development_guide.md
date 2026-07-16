# Development Guide

This guide provides step-by-step instructions for setting up the development environment and running the Share2Brain Self-Hosted system.

Share2Brain is a self-hosted AI agent that indexes a Discord community's knowledge and answers questions with verifiable sources. It is an **npm-workspaces monorepo** with a shared domain kernel and event-driven ingestion (see `docs/context/ARCHITECTURE-SPINE.md`).

## 🚀 Setup Instructions

### Prerequisites

Ensure you have the following installed:
- **Node.js** 24 LTS
- **npm** 10 or higher (workspaces support)
- **Docker** and **Docker Compose** v2
- **Git**

### 1. Clone the Repository

```bash
git clone https://github.com/borjaberrocal87/share2brain.git
cd share2brain
```

### 2. Install dependencies

```bash
npm install   # installs every workspace under packages/*
```

### 3. Configuration

The system uses **two** configuration files (never mix them):

- `Share2Brain.config.yml` — behavior configuration (channels, models, RBAC, knowledge tuning, rate limits). Validated by `loadConfig()` in `@share2brain/shared`.
- `.env` — secrets only (Discord tokens, LLM API keys, DB/Redis URLs, `SENTRY_DSN`).

Guest demo access (`access_control.guest_access`, OFF by default) is a pure YAML flag — no secret involved. It creates a real RBAC-limited session for demos and is distinct from the fake-OAuth e2e harness described below.

```bash
cp Share2Brain.config.yml.example Share2Brain.config.yml
cp .env.example .env
# edit both files with real values
```

Typical `.env` keys:

```env
# Database
DATABASE_URL="postgresql://share2brain:share2brain@localhost:5432/share2brain"
# Redis (streams + sessions) — AUTH required; password must match REDIS_PASSWORD
REDIS_URL="redis://:<your-redis-password>@localhost:6379"
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

npm run dev -w @share2brain/backend         # Express API + LangGraph agent on :3000
npm run dev -w @share2brain/web             # Vite dev server (SPA) on :5173
npm run dev -w @share2brain/bot             # Discord Bot (ingestion)
npm run dev -w @share2brain/workers         # Indexer + Sync consumers
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
npm run test -w @share2brain/backend   # scope to one workspace
npm run test:integration         # integration suites (need Postgres + Redis; see the warning below)
npm run build           # build all packages
```

The integration suites read `DATABASE_URL` / `REDIS_URL` from your repo-root `.env`, which is
loaded automatically (`vitest.integration-setup.ts`) — no need to export them by hand. Real
environment variables, when set (e.g. in CI), take precedence over the `.env` values.

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
> catch a **same-host** writer — e.g. a local `npm run dev -w @share2brain/backend` sharing your address — nor a
> writer behind a connection pooler; stopping those is on you (this doc). Set `SHARE2BRAIN_TEST_ALLOW_SHARED_DB=1`
> to bypass the guard for an intentional shared-DB run.

E2E (web workflows) run with Playwright. The harness lands with **Story 4.5**; it boots the
Backend with an injected **fake Discord OAuth** client over a test Postgres+pgvector/Redis
(seeded), so it authenticates the SPA without real Discord credentials:

```bash
npx playwright install chromium  # one-time: download the browser (chromium only)
npm run test:e2e -w @share2brain/web   # Playwright end-to-end (needs test Postgres+Redis + fake-OAuth session)
```

## 🔭 Observability (vendor-neutral port + adapter)

The three Node services (`backend`, `bot`, `workers`) ship their errors **and every
structured log line** off-box so you never have to `docker logs` the VPS. Observability is
a **vendor-neutral port** (`Observability`) with [Sentry](https://sentry.io) as the one
shipped adapter (Story ops-5). It is **opt-in and off by default**.

- **Enable it:** set `SENTRY_DSN` in `.env` to your project's DSN. That value flows into
  `Share2Brain.config.yml`'s `observability.sentry_dsn: "${SENTRY_DSN}"`, which
  `docker-compose.yml` already passes to all three services.
- **Disable it:** leave `SENTRY_DSN` empty (the default). `createObservability` then returns
  a `NoopObservability` — the vendor SDK is never initialized and logs go to `stdout`
  exactly as before.
- **What is captured** when enabled:
  - **Errors** — `uncaughtException` / `unhandledRejection` in every service, plus unhandled
    HTTP 5xx in the backend (via the port's `setupExpressErrorHandler`), with full stack traces.
  - **Logs** — *all* levels at or above `observability.log_level`, forwarded to the adapter's
    structured-log sink alongside `stdout` (dual sink). Lower the log level to reduce volume.
  - Every event/log is **tagged with the emitting `service`** (`backend` | `bot` | `workers`).
  - Backend errors also carry **user context**: the internal user id + Discord role ids only.
- **Never sent:** secrets (DB/Redis connection-string credentials are scrubbed by
  `redactSecrets`), Discord message `content`, emails, or IPs (`sendDefaultPii` stays off).
- **Volume note:** because *all* logs ship (not only errors), watch your provider quota and
  keep `observability.log_level` at `info` (or higher) in production.
- **Architecture:** services depend on the `Observability` **port**, never on `@sentry/node`.
  `@sentry/node` is imported in **exactly one file** — `packages/shared/src/observability/sentry.ts`
  (a dependency of `@share2brain/shared` only, AD-2). The shared logger takes an injected
  `StructuredLogSink` and does not import any vendor SDK.

### Adding another provider (OpenTelemetry, Datadog, Grafana, …)

The port exists so a second provider is **config-only** for the services — three steps, with
**zero edits** to `backend`/`bot`/`workers`/`web`:

1. **New adapter file** `packages/shared/src/observability/<provider>.ts` exporting
   `create<Provider>Observability(opts): Observability` (mirror `sentry.ts`).
2. **One factory branch** in `createObservability` (`observability/index.ts`), plus the new
   literal in `ObservabilityProvider` (`observability.ts`) and the `observability.provider`
   Zod enum (`config/index.ts`).
3. **Set the config value** `observability.provider: <provider>` in `Share2Brain.config.yml`.

## 🔬 LLM inference tracing (Arize Phoenix — Story ops-6)

LLM/embeddings **traces** (spans with model, tokens, latency, prompt/completion) are a
**separate seam** from the Sentry `Observability` port above (Sentry keeps errors + logs;
Phoenix takes LLM traces). They flow through a second vendor-neutral port, `LlmTracing`
(`@share2brain/shared/tracing`), to a **self-hosted Arize Phoenix** collector. Also opt-in
and off by default; scoped to `backend` + `workers` (the bot makes no LLM calls).

- **Enable it:** set `PHOENIX_ENDPOINT` in `.env` (e.g. `http://phoenix:6006`). It flows into
  `Share2Brain.config.yml`'s `observability.tracing.endpoint: "${PHOENIX_ENDPOINT}"`, which
  `docker-compose.yml` passes to all config-mounting services (incl. `bot` — the config
  references the var, and interpolation aborts on any unset `${VAR}`). The dev compose ships a
  `phoenix` service on the `data` network with a loopback-only dev port; reach the UI at
  `http://127.0.0.1:6006` (or via SSH tunnel). Phoenix is **never** publicly exposed or proxied
  by nginx (SNF-18).
- **Disable it:** leave `PHOENIX_ENDPOINT` empty (the default). `createLlmTracing` then returns
  `NoopLlmTracing` — no OTel object is constructed, no `@langchain/core` instrumentation is
  registered, and there are zero tracing network calls (byte-identical to before tracing).
- **What is captured** when enabled: the RAG pipeline (`retrieve → reason → respond`), history
  compression, workers enrichment (all auto-instrumented via OpenInference at the
  `@langchain/core` layer), plus manual spans for the query embedding
  (`embeddings.embed_query`), the pgvector similarity search (`pgvector.similarity_search`), and
  batch indexing embeddings (`embeddings.embed_documents`).
- **Content in spans:** prompts/completions/retrieved fragments MAY appear in spans **only**
  because the collector is self-hosted inside the Compose network. The never-content-to-Sentry
  rule (SNF-9) is untouched — nothing from tracing flows to the `Observability` port; manual
  span attributes carry counts/params only.
- **Architecture:** services depend on the `LlmTracing` **port**, never on
  `@opentelemetry/*`/`@arizeai/*` — those live in **exactly one file**,
  `packages/shared/src/tracing/phoenix.ts` (AD-2). Adding a provider (Langfuse, OpenLLMetry,
  Datadog, …) is the same three-step recipe as the observability port, against
  `createLlmTracing` + `observability.tracing.provider`.

## Updating a running deployment

```bash
git pull
docker compose build
docker compose up -d
# the `migrator` service applies new migrations automatically before services start
```
