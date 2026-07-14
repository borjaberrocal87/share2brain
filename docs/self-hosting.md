# Self-Hosting Guide

This guide covers everything you need to deploy and operate a Share2Brain instance — from prerequisites to production tuning.

## Prerequisites

- **Docker** and **Docker Compose v2** (the whole stack runs in containers)
- **Git** (to clone the repository)
- A **Discord application** with a bot token and OAuth2 credentials
- An **LLM API key** (Anthropic, OpenAI, or any OpenAI-compatible endpoint)
- An **embeddings API key** (OpenAI or custom — Anthropic does not offer embeddings)

For local development you also need **Node.js 24 LTS** and **npm 10+**, but the Docker Compose deployment does not require a local Node.js runtime.

## Install with Docker Compose

Clone the repository and copy the configuration templates:

```bash
git clone https://github.com/borjaberrocal87/share2brain.git
cd share2brain
cp .env.example .env
cp Share2Brain.config.yml.example Share2Brain.config.yml
```

Edit both files before launching (see sections below for each value). Then start all services:

```bash
docker compose up -d
docker compose ps -a
```

The stack includes seven services:

| Service | Role |
|---------|------|
| `postgres` | PostgreSQL 17 + pgvector (data tier) |
| `redis` | Redis 8 — session store (AD-10) + event streams (AD-13) |
| `migrator` | One-shot container — runs `drizzle-kit migrate`, then exits 0 |
| `backend` | Express 5 API + LangGraph RAG agent, SSE streaming |
| `bot` | Discord Bot — message ingestion (backfill + realtime + sync) |
| `workers` | Indexer + Sync consumers — Redis Streams → pgvector |
| `nginx` | Single public entry point — SPA + reverse proxy |

nginx binds ports `80` and `443` on the host. Postgres and Redis also bind to `127.0.0.1` for local tooling (free those ports or stop local instances first).

Two networks isolate the edge from the data tier (M-14): `frontend` (nginx + backend) and `data` (backend + bot + workers + migrator + postgres + redis). Only the backend bridges both.

## Create the Discord application

### 1. Bot credentials

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Go to the **Bot** section and click **Reset Token** (or copy the existing one). This is your `DISCORD_BOT_TOKEN`.
3. Under **Privileged Gateway Intents**, enable:
   - `GUILD_MEMBERS`
   - `MESSAGE_CONTENT`
4. Save changes.

### 2. OAuth2 credentials

1. In the same application, go to **OAuth2 → General**.
2. Copy the **Client ID** (`DISCORD_CLIENT_ID`) and **Client Secret** (`DISCORD_CLIENT_SECRET`).
3. Add a redirect URI under **Redirects**:
   - Development: `http://localhost:5173/api/auth/callback`
   - Production: `https://your-domain.com/api/auth/callback`
4. Update `DISCORD_REDIRECT_URI` in `.env` to match.

### 3. Invite the bot to your guild

Use the OAuth2 URL Generator to build an invite link with the `bot` scope and the `Send Messages` / `Read Message History` permissions. The bot must be able to read the channels you want to index.

### 4. Get your guild (server) ID

Enable Developer Mode in Discord (Settings → Advanced → Developer Mode), right-click your server name, and copy the ID. This is `DISCORD_GUILD_ID`.

### 5. Get channel IDs

Right-click each channel you want to index and copy its ID. Add them to `Share2Brain.config.yml` under `discord.channels`.

## First startup

Services start in dependency order:

1. `postgres` and `redis` become healthy (5–10s)
2. `migrator` runs one-shot (applies any pending SQL migrations) and exits 0
3. `backend`, `bot`, and `workers` start in parallel
4. `nginx` starts after `backend` is up

The first boot also triggers:

- **Backfill** — the bot reads historical messages from the configured channels (up to `discord.backfill.limit` per channel) and publishes them as ingestion events.
- **Offline sync** — after backfill, the bot reconciles any edits/deletes that happened while the bot was offline.
- **Indexing** — workers consume the events: extract URLs, fetch pages (SSRF-guarded), LLM-enrich (title + description), embed, and persist to pgvector.

Open `http://localhost` in a browser. You should see the Share2Brain SPA. Click **Login with Discord** to start.

Check service logs if something isn't right:

```bash
docker compose logs -f backend
docker compose logs -f bot
docker compose logs -f workers
```

## Environment variables and config

Share2Brain uses a strict two-file system — secrets and behavior are never mixed (AD Consistency Conventions).

### `.env` — secrets (tokens, API keys, URLs)

| Variable | Required | Purpose |
|----------|----------|---------|
| `DISCORD_BOT_TOKEN` | Yes | Bot Gateway token |
| `DISCORD_CLIENT_ID` | Yes | OAuth2 application ID |
| `DISCORD_CLIENT_SECRET` | Yes | OAuth2 client secret |
| `DISCORD_GUILD_ID` | Yes | Target guild snowflake |
| `DISCORD_REDIRECT_URI` | Yes | OAuth2 callback URL (must match Discord app registration) |
| `LLM_API_KEY` | Yes* | RAG agent chat model |
| `LLM_BASE_URL` | No | Custom chat endpoint (blank for standard providers) |
| `EMBEDDINGS_API_KEY` | Yes* | Embeddings model |
| `EMBEDDINGS_BASE_URL` | No | Custom embeddings endpoint |
| `ENRICHMENT_LLM_API_KEY` | Yes* | Enrichment pipeline LLM |
| `ENRICHMENT_LLM_BASE_URL` | No | Custom enrichment endpoint |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `POSTGRES_PASSWORD` | Yes | Docker Compose PostgreSQL password |
| `REDIS_URL` | Yes | Redis connection string (AUTH required) |
| `REDIS_PASSWORD` | Yes | Redis AUTH password |
| `SESSION_SECRET` | Yes | express-session signing secret |
| `SESSION_TTL_DAYS` | No | Session lifetime (default 7) |
| `FRONTEND_URL` | Yes | CORS origin / SPA URL |
| `VITE_COMMUNITY_NAME` | No | SPA header name (build-time) |
| `SENTRY_DSN` | No | Sentry project DSN (empty = disabled) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram crash alerts |
| `TELEGRAM_CHAT_ID` | No | Telegram target chat |
| `SLACK_WEBHOOK_URL` | No | Slack crash alerts |

\* Required when the corresponding provider is configured (all three are required in the default template).

### `Share2Brain.config.yml` — behavior (channels, models, RBAC, tuning)

This file is mounted read-only into every app container (`backend`, `bot`, `workers`). It references secrets via `${VAR}` placeholders that `loadConfig()` resolves from the environment at startup.

All keys are validated by the Zod schema in `packages/shared/src/config/index.ts`. Invalid or missing keys cause a hard startup abort before any connection is opened.

## Provider and model

Three independent LLM blocks in `Share2Brain.config.yml`:

### Agent (RAG chat)

```yaml
agent:
  provider: "anthropic"       # "anthropic" | "openai" | "custom"
  model: "claude-sonnet-4-6"
  temperature: 0.7
  max_iterations: 10
  memory_window: 20
  api_key: "${LLM_API_KEY}"
  base_url: "${LLM_BASE_URL}"
```

- `"custom"` uses the `base_url` as an OpenAI-compatible endpoint (LiteLLM, Ollama, etc.) — all three use the LangChain SDK (`ChatAnthropic` or `ChatOpenAI`).
- `"custom"` without a `base_url` is a hard startup error.

### Embeddings

```yaml
embeddings:
  provider: "openai"          # "openai" | "custom" only
  model: "text-embedding-3-small"
  dimensions: 1536
  api_key: "${EMBEDDINGS_API_KEY}"
  base_url: "${EMBEDDINGS_BASE_URL}"
```

- Anthropic is **not** a valid embeddings provider (no embeddings API).
- `dimensions` must match the model's output dimension. Changing dimensions after embeddings exist requires a migration + reindex.
- All providers use `OpenAIEmbeddings` under the hood with `encodingFormat: 'float'`.

### Enrichment LLM

```yaml
enrichment:
  language: "en"
  llm:
    provider: "anthropic"
    model: "claude-sonnet-4-6"
    temperature: 0.3
    api_key: "${ENRICHMENT_LLM_API_KEY}"
    base_url: "${ENRICHMENT_LLM_BASE_URL}"
```

The enrichment LLM generates `title` and `description` for each indexed URL. A lower temperature (0.2–0.4) is recommended for this extraction task.

## System prompt and temperature

The agent's system prompt lives in `packages/backend/src/agent/prompt.ts`:

- Instructs the model to answer **only** from curated community resources.
- Requires citations (channel, author, date, link).
- Admits when insufficient information exists — no hallucination.

RAG context is injected in an **untrusted** `<context>` user turn with explicit prompt-injection guards: field values are `JSON.stringify()`'d, and the text instructs the model to never obey embedded instructions.

Temperature defaults:

| Context | Default | Recommended range |
|---------|---------|------------------|
| Agent (chat) | 0.7 | 0–2 |
| Enrichment (extraction) | 0.3 | 0.2–0.4 |

The config schema validates `temperature` is within `[0, 2]`.

## RBAC permissions

RBAC is configured under `access_control` in `Share2Brain.config.yml`:

```yaml
access_control:
  enabled: true
  default_policy: "deny"
  role_cache_ttl: 300
  guest_access:
    enabled: false
    role: "guest"
    username: "Invitado"
    session_ttl_minutes: 120
  channel_permissions:
    - channel_id: "1234567890"
      name: "general"
      allowed_roles: ["admin_role_id", "mod_role_id", "member_role_id"]
    - channel_id: "1234567891"
      name: "support"
      allowed_roles: ["admin_role_id", "mod_role_id"]
```

Key behaviour:

- `default_policy: "deny"` — any channel not listed is inaccessible.
- `allowed_roles` values are **Discord role snowflake IDs** (numeric strings), plus the synthetic `"guest"` role for guest access.
- `@everyone` is injected automatically — the Discord API omits it from the guild-member response, so the code adds its ID (which equals the guild ID).
- Permissions are **materialized** into the `channel_permissions` table at backend startup, and **expanded per request** (never cached in the session). Changes take effect after a restart.
- The RBAC filter is applied **inside the pgvector query** (SQL `WHERE channel_id = ANY(...)`), not as a post-filter. This is invariant AD-12.

Guest access is a pure YAML flag — no secret involved. It creates a short-lived, RBAC-limited session for demos.

## Login with Discord OAuth2

The login flow is a standard **authorization code grant**:

1. User clicks **Login with Discord** in the SPA.
2. Backend generates a CSRF state nonce (16 random bytes), stores it in the session, and redirects to:
   `https://discord.com/oauth2/authorize?response_type=code&client_id={DISCORD_CLIENT_ID}&scope=identify%20guilds.members.read&redirect_uri={DISCORD_REDIRECT_URI}&state={nonce}`
3. Discord prompts the user to authorize.
4. Discord redirects to `DISCORD_REDIRECT_URI` with `?code=...&state=...`.
5. Backend validates the state matches the session, deletes it (one-time use), exchanges the code for an access token, fetches the user profile, checks guild membership, and upserts the user in the database.
6. Session ID is **regenerated** (anti-fixation, P1).
7. `userId` and `discordRoles` are stored in the Redis session.
8. Browser is redirected to the SPA with the new session cookie.

All Discord REST calls use a 10-second timeout. Failed state validation returns `INVALID_OAUTH_STATE`; failed guild check returns `GUILD_MEMBER_REQUIRED` (403).

## Guild membership

Share2Brain serves **one Discord guild per deployment** (invariant AD-8 / SO-8).

Guild membership is verified during OAuth2 callback via `GET https://discord.com/api/users/@me/guilds/{guildId}/member`:

- **200**: user is a member — `roles` array is extracted for RBAC.
- **404**: user is **not** a member — returns `GUILD_MEMBER_REQUIRED` (HTTP 403).

`@everyone` is injected into the roles array since Discord omits it from the API response.

The guild ID comes from `discord.guild_id` in the config (typically `${DISCORD_GUILD_ID}`).

## Channel access by role

After login, every API request passes through the RBAC middleware (`packages/backend/src/middleware/rbac.ts`):

1. Reads `req.session.discordRoles` (set during login).
2. Calls `findAllowedChannelIds(roles)` which queries the `channel_permissions` table using PostgreSQL's array overlap operator (`&&`):
   ```sql
   SELECT channel_id FROM channel_permissions WHERE allowed_roles && :roles
   ```
3. Attaches `req.allowedChannelIds` to the request.
4. All downstream handlers (search, chat, documents, stats) pass this array into their pgvector SQL:
   ```sql
   WHERE channel_id = ANY(:allowed_channel_ids)
   ```

Empty roles results in zero allowed channels (deny-by-default). The RBAC is recomputed on **every request**, so config changes take effect immediately after a restart.

## Sessions and cookies

Sessions are managed entirely in **Redis** via `connect-redis` (no `sessions` table in PostgreSQL — invariant AD-10).

Configuration (`packages/backend/src/infrastructure/sessionStore.ts`):

| Setting | Value |
|---------|-------|
| Cookie name | `sid` |
| `httpOnly` | `true` |
| `secure` | Configurable (`security.cookie_secure`), fails-closed to `true` |
| `sameSite` | `lax` |
| `maxAge` | `SESSION_TTL_DAYS` (default 7) |
| Redis TTL | Matches cookie `maxAge` |
| Redis key prefix | `sess:` |
| `resave` | `false` |
| `saveUninitialized` | `false` |

For local development over plain HTTP, set `security.cookie_secure: false` in `Share2Brain.config.yml`.

### Session lifecycle

- **Login**: `userId` + `discordRoles` stored in session, session ID regenerated.
- **Logout**: session destroyed, `sid` cookie cleared.
- **Guest expiry**: enforced by `requireAuth` middleware — checks `req.session.guestExpiresAt` and destroys if expired.

### CSRF protection

Every mutating request under `/api` must carry the `X-Requested-With: share2brain` header. Requests without it receive HTTP 403.

## Index knowledge

Share2Brain indexes **links (URLs)** shared in Discord messages, not the raw message text itself. The pipeline is event-driven:

```
Discord message → Bot (persist + XADD) → Redis Stream → Workers Indexer → pgvector
```

### Pipeline steps

1. **Ingestion** (`bot`): On `messageCreate`, the bot does an atomic `INSERT` into `discord_messages` + `XADD` to the `share2brain:discord:messages` stream. Idempotent via `onConflictDoNothing`.

2. **Consumption** (`workers/indexer/consumer.ts`): The indexer consumes the stream via `XREADGROUP` (consumer group `share2brain:indexer`, batch size 10, 5s block). PEL replay on boot for crash recovery.

3. **URL extraction** (`workers/enrichment/extractUrls.ts`): URLs are extracted from message content and filtered by `allowed_schemes` (HTTPS only).

4. **SSRF-guarded fetch** (`workers/enrichment/ssrfGuard.ts`, `urlFetcher.ts`): Each URL is fetched with a timeout, max bytes cap (2 MB), max redirects (3), and private IP blocking.

5. **AI enrichment** (`workers/enrichment/enrich.ts`): The enrichment LLM generates `{title, description}` for each URL using the Discord message context + fetched page content (OG tags, meta description, body text). Structured output with Zod validation + JSON fallback.

6. **Embedding** (`shared/src/providers/index.ts`): The embedding text `"{title}\n\n{description}"` is embedded via the configured embeddings provider.

7. **Persistence** (`workers/src/indexer/indexBatch.ts`): UPSERT into the `embeddings` table by `chunk_key` (`"{messageId}:{urlIndex}"`) in a single transaction with `FOR UPDATE` row lock.

8. **Acknowledgement**: The stream entry is ACKed only after a successful COMMIT (at-least-once semantics).

### Historical backfill

On first boot, the bot runs a per-channel, cursor-based backfill of historical messages (up to `discord.backfill.limit`). These flow through the same pipeline as live messages.

## Re-index sources

Three mechanisms keep the index up to date with Discord:

### 1. Sync worker (real-time edits/deletes)

- **Edits**: `packages/workers/src/sync/processUpdate.ts` — when a message is edited in Discord, re-indexes by link-diff. URLs that haven't changed reuse existing embeddings (zero cost). New/changed URLs run the full pipeline. Single transaction wipe-and-reinsert under `FOR UPDATE` row lock.
- **Deletes**: `packages/workers/src/sync/processDelete.ts` — soft delete (stamp `deleted_at`) or hard delete (row removal), governed by `sync.delete_policy`.

### 2. Offline sync (startup reconciliation)

`packages/bot/src/sync/offlineSync.ts` — after backfill on every boot, fetches the latest messages from Discord, diffs against the database (`reconcile.ts`), and republishes edits/deletes. Controlled by `config.sync.sync_on_start`.

### 3. PEL replay (crash recovery)

On boot, the indexer reads pending entries (`XREADGROUP` from id `'0'`) to replay un-acked work. A periodic poison reaper retries stale entries and dead-letters intractable ones.

### 4. Manual re-index

There is no API endpoint for manual re-index. To force a full re-index, you can clear `indexed_at` timestamps in the database and restart the bot (which triggers offline sync if `sync_on_start: true`).

## Usage limits and cost

### API rate limiting (3 tiers)

All configured in `Share2Brain.config.yml` under `security.rate_limit`:

| Tier | Window | Max requests | Key prefix |
|------|--------|--------------|------------|
| `api` | 15 min | 100 | `rl:api:` |
| `auth` | 15 min | 10 | `rl:auth:` |
| `chat` | 1 min | 20 | `rl:chat:` |

Rate limiting is backed by Redis (shared counters across restarts). The `/health` endpoint is **never rate-limited**.

### Enrichment budget

The enrichment pipeline has a Redis-backed spend limiter (`packages/workers/src/enrichment/rateLimiter.ts`) with two fixed-window counters:

- `per_author_hourly`: max enrichments triggered by one Discord author per hour (default: 20)
- `global_daily`: max enrichments across the whole instance per day (default: 500)

When the budget is exceeded, the message is still stamped and ACKed but no URLs are enriched (degraded indexing). Fail-open on Redis errors.

### No persistent cost tracking

There is no token counter, cost dashboard, or billing integration. The enrichment rate limiter is the closest guard against runaway provider costs.

## Observability and health checks

### Health endpoint

`GET /health` — top-level route, auth-exempt, never rate-limited:

```json
{
  "status": "healthy",
  "components": {
    "database": "connected",
    "redis": "connected",
    "discord": "pending",
    "indexer": "pending"
  }
}
```

- Probes Postgres (`SELECT 1`) and Redis (`PING`) concurrently with a 2-second timeout per probe.
- HTTP 200 when both database and redis are `connected`; HTTP 503 when either is `disconnected`.
- `discord` and `indexer` currently report as `"pending"` (the Bot and Workers don't expose readiness yet).

### Sentry (opt-in)

All three services (`backend`, `bot`, `workers`) integrate with Sentry for error tracking and structured logging:

- **Enable**: set `SENTRY_DSN` in `.env`.
- **Disable**: leave it empty — `initSentry()` becomes a no-op.
- **Captured**: uncaught exceptions, unhandled rejections, HTTP 5xx, all structured logs (`observability.log_level`).
- **Never sent**: secrets (redacted by `beforeSend`), Discord message `content`, IPs (`sendDefaultPii: false`).
- **User context**: internal user ID + Discord role IDs only (no PII).

### External crash notifications

Optional Telegram or Slack alerts via `notifications` config block. Sent on `uncaughtException`, `unhandledRejection`, and fatal shutdown. Messages are redacted and capped at 3,900 characters.

### Graceful shutdown

All three services implement bounded graceful shutdown on SIGTERM/SIGINT:

| Service | Grace period | Drain steps |
|---------|-------------|-------------|
| `backend` | 30s | Close HTTP server → quit Redis → close DB → flush Sentry → exit |
| `bot` | 30s | Backfill/sync wait → destroy Gateway → quit Redis → close DB → flush Sentry → exit |
| `workers` | 35s | Consumer loops drain → up to 3 Redis quits → close DB → flush Sentry → exit |

### Docker health checks

- `postgres`: `pg_isready` (5s interval, 10 retries)
- `redis`: `redis-cli ping` (5s interval, 10 retries)
- All app services depend on `postgres: healthy`, `redis: healthy`, and `migrator: service_completed_successfully`.