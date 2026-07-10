---
baseline_commit: 3577eec
status: done
story_id: 3.1
epic: 3
---

# Story 3.1: Discord Bot — Gateway connection & messageCreate listener

Status: done

## Story

As an **Operator**,
I want the Discord bot to connect to the Gateway and listen for new messages in the configured channels,
so that the community's knowledge is captured in real time and flows into the indexing pipeline with no manual intervention.

This is the **second story of Epic 3** (Knowledge Indexing Pipeline), after Story 3.0 (LLM/embeddings provider config, now `done`). It **unblocks Story 3.2** (historical backfill) and **Story 3.3** (Indexer worker), which consume the `share2brain:discord:messages` stream this story produces.

**Baseline commit:** `3577eec` — Story 3.0 merged; `epic-3: in-progress`; `packages/bot` exists but `src/main.ts` is a config-validating placeholder with no Gateway logic.

---

## ⚠️ Reconciliation notes — read before implementing

The Epic 3 spec (`epics.md` §Historia 3.1) and the previous draft of this story referenced **fields and behaviors that do not exist in the current codebase**. These were verified against the real source at baseline `3577eec` and corrected below. Where a decision changes an epic-level AC, it is flagged **[DECISION]** and summarized again in *Open Questions* at the end.

1. **The bot token is NOT in `Share2Brain.config.yml`.** The config `discord` block has only `guild_id`, `channels[]`, and `backfill` (see `packages/shared/src/config/index.ts:36-44`). The token is a secret read from `.env` as `DISCORD_BOT_TOKEN` via the `requireEnv()` pattern used by the backend (`packages/backend/src/main.ts:15-21`). **Do not** reference `config.discord.token` — it does not exist and will not type-check.
2. **Channel identifier is `id`, not `channel_id`.** Config `ChannelSchema` = `{ id, name, enabled }` (`config/index.ts:22-26`). Match `message.channelId` against `config.discord.channels[].id`.
3. **`ignore_bots` lives under `discord.backfill.ignore_bots`** (`config/index.ts:39-43`) — there is no top-level `discord.ignore_bots`. Reuse `config.discord.backfill.ignore_bots` for the live-ingestion bot filter. **[DECISION]** (see Open Questions).
4. **`discord_messages` has no `channel_name`, `author_name`, or `last_seen_message_id` columns.** The real columns are `id, channelId, guildId, authorId, content, createdAt, updatedAt, indexedAt, deletedAt` (`packages/shared/src/db/schema.ts:37-53`). The epic's INSERT field list is stale — insert only the columns that exist.
5. **There is no `last_seen_message_id` column to persist** (epic AC-4). Backfill resume (Story 3.2) derives the per-channel cursor from `MAX(id)` (snowflakes are monotonic-in-time), so **no column and no extra write are required in this story** — inserting each message is sufficient. **[DECISION]** (see Open Questions).
6. **There is no shared logger.** No `getLogger`/`createLogger` exists anywhere (`grep` is empty). The codebase uses `console.*` with a `[service]` prefix (`bot/src/main.ts`, `backend/src/main.ts`, `backend/src/infrastructure/redis.ts`). **[DECISION]:** add a tiny local `packages/bot/src/logger.ts` that respects `config.observability.log_level` and wraps `console` — no new dependency, honest with the codebase.
7. **There is no shared Redis client factory.** `createRedisClient` lives in `packages/backend/src/infrastructure/redis.ts`, which the bot **must not** import (AD-2). **[DECIDED with Borja]:** promote `createRedisClient` + `RedisClient` to `@share2brain/shared`; both backend and bot import it from there (see Task 2). No bot-local copy.
8. **This story implements `messageCreate` only.** The epic AC-1 says "register `messageCreate`, `messageUpdate`, `messageDelete`", but the update/delete *logic* is Story 6.1 ("Bot — real-time edit/delete detection"), which publishes to `DISCORD_MESSAGES_UPDATED` / `DISCORD_MESSAGES_DELETED`. The story title is "listener **messageCreate**". **[DECISION]:** implement `messageCreate` fully; defer `messageUpdate`/`messageDelete` registration to Story 6.1 (see Open Questions).

---

## Acceptance Criteria

### AC-1 — Bot connects to the Gateway with the required intents

**Given** the `bot` service starts and `loadConfig()` returns a valid config
**And** `DISCORD_BOT_TOKEN` is present in the environment
**When** the process boots
**Then** a `discord.js` `Client` is created with intents `GatewayIntentBits.Guilds`, `GatewayIntentBits.GuildMessages`, and `GatewayIntentBits.MessageContent`
**And** `client.login(process.env.DISCORD_BOT_TOKEN)` is called
**And** on the `ClientReady` (`ready`) event the bot logs "Connected to Discord Gateway" at `info` with `{ botId, guildId }`.

- Intents map to Discord's "View Channel / Read Channels / Read Message History"; **`MessageContent` is a privileged intent** and must be enabled in the Discord Developer Portal (it is already ON — validated by the Epic 3 spike, see Previous Intelligence). Log an `info` line stating the privileged intent is required so a misconfigured deployment is diagnosable.
- If `loadConfig()` throws `ConfigError`, or `DISCORD_BOT_TOKEN` is missing, log `error` and `process.exit(1)` **before** any network I/O (AD-8).

### AC-2 — `messageCreate` inserts the row and publishes the stream event, atomically

**Given** a message posted in a channel whose `id` is in `config.discord.channels` with `enabled: true`
**And** (when `config.discord.backfill.ignore_bots === true`) the author is not a bot
**When** the `messageCreate` event fires
**Then** within one logical operation the bot:
1. INSERTs into `discord_messages` with exactly these columns:
   - `id` = `message.id` (snowflake string)
   - `channelId` = `message.channelId`
   - `guildId` = `message.guildId` (fall back to `config.discord.guild_id` if null)
   - `authorId` = `message.author.id`
   - `content` = `message.content`
   - `createdAt` = `message.createdAt` (a `Date`; Discord's authoritative timestamp)
   - `updatedAt` = same as `createdAt` (column is `NOT NULL`)
   - `indexedAt` = left `NULL` (the Indexer sets it in Story 3.3)
   - `deletedAt` = left `NULL`
2. `XADD`s a `MessageCreatedEvent` to the `STREAM_KEYS.DISCORD_MESSAGES` stream (`'share2brain:discord:messages'`) with **all-string** fields: `type='discord.message.created'`, `messageId`, `channelId`, `guildId`, `timestamp` (ISO 8601 UTC from `message.createdAt.toISOString()`), `content`, `authorId`. The stream ID is server-generated (`*`).
3. Both operations succeed or neither persists — see the transaction design in Dev Notes (XADD runs **inside** the Drizzle transaction; a throw rolls back the INSERT). At-least-once delivery is acceptable per AD-13 because the Indexer is idempotent.

- Import the stream key from `STREAM_KEYS` (`packages/shared/src/types/events.ts:39-48`) — never hardcode the literal.
- The event type shape is `MessageCreatedEvent` (`events.ts:15-19`); it carries **no** `authorName`/`channelName` — do not invent fields.

### AC-3 — Disabled and out-of-scope channels are silently ignored

**Given** a message in a channel with `enabled: false`, or a channel not listed in `config.discord.channels` at all
**When** `messageCreate` fires
**Then** the bot skips it: no INSERT, no XADD, and no `info` log (a single `debug`-level line is allowed).

**And Given** `config.discord.backfill.ignore_bots === true` and `message.author.bot === true`
**Then** the message is likewise skipped silently.

- Skips (expected) must be distinguishable from failures (unexpected). A DB/Redis failure while handling an *enabled* channel is logged at `error` with `{ messageId, channelId, error }` and must not crash the process.

### AC-4 — Reconnection with exponential backoff

**Given** the bot loses its Gateway connection (network drop, Discord restart, `shardDisconnect`/`error`)
**When** the disconnect/error is observed
**Then** the bot:
1. Logs the drop at `warn` with the reason;
2. Does **not** exit;
3. Reconnects with exponential backoff — initial **1 s**, factor **2×**, cap **300 s (5 min)**, with **±10 % jitter**;
4. Resets the backoff to 1 s after a successful reconnect;
5. After ≥5 consecutive failures logs a `error`-level "still retrying" line but continues retrying indefinitely (Operator investigates; the container is not killed by backoff).

- discord.js has its own auto-reconnect for transient WebSocket drops; the custom backoff is the **recovery path for a failed `login()`** (invalid session, sustained outage). Track `attempt`/`delay` in the bot's main module. See Dev Notes for a reference implementation and the discord.js event names to bind (`shardDisconnect`, `shardError`, `error`).

### AC-5 — Process-level hardening (Epic 2 retro, minimum pulled forward)

**Given** the bot is running
**Then** `process.on('uncaughtException')` and `process.on('unhandledRejection')` handlers are installed that log at `error` (with stack) and `process.exit(1)` (container restarts under Compose)
**And** `SIGTERM`/`SIGINT` trigger a clean shutdown: `client.destroy()`, `redis.destroy()`, `db.$client.end()`, then exit 0.

- This is the *minimum* hardening item from the Epic 2 retrospective (real graceful drain of consumer groups stays in Epic 6). Preserve the existing SIGTERM/SIGINT behavior already in `main.ts:11-16`.

### AC-6 — Green verification gate

**Given** all ACs are implemented
**Then**:
- `npm run lint` — 0 errors/warnings;
- `npm run test` — all suites green, including new bot unit tests (channel filter, bot-author filter, event field mapping, backoff timing/jitter/reset) and at least one integration test hitting **real Postgres + Redis** (INSERT + XADD, and rollback-on-XADD-failure);
- `npm run build` — all 5 workspaces build clean;
- **Manual smoke** (real token + test guild): bot logs "Connected to Discord Gateway"; a message in an enabled channel appears in `discord_messages` **and** in `XRANGE share2brain:discord:messages` within ~1 s; a message in a disabled channel does not; a bot-author message is skipped when `ignore_bots: true`; `docker network disconnect` + reconnect shows the backoff `warn` lines then a successful reconnect.

---

## Tasks / Subtasks

- [x] **Task 1 — Bot dependencies & config wiring** (AC: 1)
  - [x] Add `redis` (node-redis 6.x) to `packages/bot/package.json` (`discord.js@^14.26.4` is already present). Run `npm install`.
  - [x] Confirm no new env/compose work is needed: `.env`/`.env.example` already define `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DATABASE_URL`, `REDIS_URL`, and the compose `bot` service already sets `DATABASE_URL`/`REDIS_URL` and `env_file: .env` (verified — see References). Only touch these if something is missing.
- [x] **Task 2 — Promote the Redis client to `@share2brain/shared`** (AC: 2) — **[DECIDED with Borja]**
  - [x] Move `createRedisClient` + `RedisClient` type from `packages/backend/src/infrastructure/redis.ts` into `packages/shared/src/infrastructure/redis.ts`; add a `./redis` entry to `packages/shared/package.json` `exports`; add `redis` (^6) to shared `dependencies`.
  - [x] Update the backend import to `@share2brain/shared/redis` and delete `packages/backend/src/infrastructure/redis.ts` (keep the same behavior: `reconnectStrategy` capped at 2s + `error` handler). Re-run backend tests — this is a pure move, no behavior change.
  - [x] Bot imports the factory from `@share2brain/shared/redis` (never from backend — AD-2).
- [x] **Task 3 — Local logger** (AC: 1, 3, 4, 5)
  - [x] Add `packages/bot/src/logger.ts`: a minimal wrapper over `console` that honors `config.observability.log_level` (`debug|info|warn|error`) and emits `[bot] <level> <msg> <ctx-json>`. No new dependency. Never log the token, api keys, or full message `content` (log length or a redacted marker instead).
- [x] **Task 4 — Discord client factory** (AC: 1)
  - [x] `packages/bot/src/discord/client.ts`: `createDiscordClient()` returning a `Client` with intents `Guilds | GuildMessages | MessageContent`. Bind `ClientReady` → info log. Export a `login(client, token)` helper used by both boot and the reconnect path.
- [x] **Task 5 — messageCreate handler (pure, testable)** (AC: 2, 3)
  - [x] `packages/bot/src/discord/handlers/messageCreate.ts`: `handleMessageCreate(message, { config, db, redis, logger })`. Guard: channel enabled? bot-author filter? Then delegate to Task 6. Keep the guard logic pure and dependency-injected so it unit-tests without a live client.
- [x] **Task 6 — Atomic persist+publish** (AC: 2)
  - [x] `packages/bot/src/persistence/persistMessage.ts`: `db.transaction(async (tx) => { await tx.insert(discordMessages).values({...}); await redis.xAdd(STREAM_KEYS.DISCORD_MESSAGES, '*', {...stringFields}); })`. Map every field per AC-2. Ensure all XADD values are strings.
- [x] **Task 7 — Reconnect with backoff** (AC: 4)
  - [x] `packages/bot/src/discord/reconnect.ts`: `scheduleReconnect()` with 1 s→×2→300 s cap, ±10 % jitter, reset on success, indefinite retry, `error`-level escalation after ≥5 failures. Bind `shardDisconnect`/`shardError`/`error`. Keep timing math pure (`computeDelay(attempt) => ms`) for unit tests.
- [x] **Task 8 — main.ts wiring** (AC: 1, 5)
  - [x] Rewrite `packages/bot/src/main.ts`: `loadConfig()` → `requireEnv('DISCORD_BOT_TOKEN' | 'DATABASE_URL' | 'REDIS_URL')` → `createDatabase(DATABASE_URL)` (from `@share2brain/shared/db`) → redis client + background `connect()` → create client, register `messageCreate`, bind reconnect + `ClientReady` → `login`. Install `uncaughtException`/`unhandledRejection`; keep/extend the existing SIGTERM/SIGINT shutdown to also `client.destroy()`, `redis.destroy()`, `db.$client.end()`.
- [x] **Task 9 — Tests** (AC: 6)
  - [x] Unit: `messageCreate` (enabled/disabled/unlisted channel, bot-author filter), event field mapping (all strings, correct keys), `reconnect` (delay sequence, cap, jitter bounds, reset). Mock discord.js `Message`, db, redis.
  - [x] Integration (real PG + Redis, reuse `packages/backend/src/test-helpers.ts` patterns): INSERT lands the row with the right columns; XADD lands one entry with the exact fields; a forced XADD failure rolls back the INSERT (0 rows).
- [x] **Task 10 — Verification gate** (AC: 6)
  - [x] Run and paste output for `npm run lint && npm run test && npm run build`. Then the manual smoke checklist. Branch `feat/3-1-discord-bot-gateway-messagecreate`; open PR.

---

## Dev Notes

### Source tree to create/touch

```
packages/bot/src/
├── main.ts                         # UPDATE — full boot wiring (currently a placeholder)
├── logger.ts                       # NEW — console wrapper honoring observability.log_level
├── discord/
│   ├── client.ts                   # NEW — Client factory (intents) + login helper
│   ├── reconnect.ts                # NEW — exponential backoff (pure computeDelay + scheduler)
│   └── handlers/messageCreate.ts   # NEW — channel/bot guard + delegate
└── persistence/persistMessage.ts   # NEW — Drizzle tx: INSERT discord_messages + XADD
packages/bot/src/**/*.test.ts       # NEW — co-located unit tests
packages/bot/src/*.integration.test.ts  # NEW — real PG + Redis
packages/bot/package.json           # UPDATE — add "redis": "^6"
# Redis factory promotion to shared (Task 2, DECIDED):
packages/shared/src/infrastructure/redis.ts     # NEW — moved from backend
packages/shared/package.json                     # UPDATE — add redis dep + ./redis export
packages/backend/src/infrastructure/redis.ts     # DELETE — moved to shared
packages/backend/src/main.ts                      # UPDATE — import createRedisClient from @share2brain/shared/redis
```

*No changes to `docker-compose.yml`, `.env`, `.env.example` are expected* — all bot env vars are already wired (verified). No DDL / schema change (AD-5): `discord_messages` already exists.

### Exact contracts (verified at baseline `3577eec`)

- **Config `discord` block** — `packages/shared/src/config/index.ts:22-44`:
  ```ts
  discord: { guild_id: string; channels: { id: string; name: string; enabled: boolean }[];
             backfill: { enabled: boolean; limit: number; ignore_bots: boolean } }
  observability: { sentry_dsn: string; log_level: 'debug'|'info'|'warn'|'error' }
  ```
- **`discord_messages` table** — `packages/shared/src/db/schema.ts:37-53` (Drizzle export `discordMessages`; TS props camelCase, DB cols snake_case):
  `id` (text PK, snowflake), `channelId`, `guildId`, `authorId`, `content` (all `text NOT NULL`), `createdAt`, `updatedAt` (`timestamptz NOT NULL`), `indexedAt`, `deletedAt` (nullable). **Insert `updatedAt` = `createdAt`** — it is NOT NULL and has no default.
- **Event & stream key** — `packages/shared/src/types/events.ts:15-19,39-48`:
  ```ts
  MessageCreatedEvent = { type:'discord.message.created'; messageId; channelId; guildId; timestamp; content; authorId }
  STREAM_KEYS.DISCORD_MESSAGES === 'share2brain:discord:messages'   // consumed by CONSUMER_GROUPS.INDEXER in 3.3
  ```
- **DB client** — `import { createDatabase, type Database } from '@share2brain/shared/db'` (`db/index.ts:33-36`). `db.$client.end()` closes the pool. Also re-exports `sql`, `arrayOverlaps`, and the schema.
- **Env** — `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID` (already the guild in `.env`), `DATABASE_URL`, `REDIS_URL` (`.env`/`.env.example`). Read with a `requireEnv()` helper (copy the backend's, `main.ts:15-21`).

### Atomic INSERT + XADD (AC-2)

```ts
await db.transaction(async (tx) => {
  await tx.insert(discordMessages).values({
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId ?? config.discord.guild_id,
    authorId: message.author.id,
    content: message.content,
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
    // indexedAt / deletedAt left undefined → NULL
  });
  // node-redis v6: xAdd(key, id, fields). All values MUST be strings.
  await redis.xAdd(STREAM_KEYS.DISCORD_MESSAGES, '*', {
    type: 'discord.message.created',
    messageId: message.id,
    channelId: message.channelId,
    guildId: message.guildId ?? config.discord.guild_id,
    timestamp: message.createdAt.toISOString(),
    content: message.content,
    authorId: message.author.id,
  });
});
```
If `xAdd` throws, the Drizzle transaction rolls the INSERT back (no orphan row). The only residual inconsistency is a commit failing *after* a successful `xAdd` → an event with no row; this is tolerated because the Indexer is idempotent and delivery is at-least-once (AD-13). Do **not** try to make Redis a true XA participant — it cannot be.

### Reconnect backoff (AC-4) — reference

```ts
export function computeDelay(attempt: number): number {   // attempt starts at 1
  const base = Math.min(1000 * 2 ** (attempt - 1), 300_000);
  const jitter = base * (Math.random() * 0.2 - 0.1);        // ±10 %
  return Math.round(base + jitter);
}
```
Bind `client.on('shardDisconnect' | 'shardError' | 'error', …)`; on a failed `login()` schedule the next attempt with `computeDelay(++attempt)`; reset `attempt = 0` in the `ClientReady` handler. discord.js retries transient socket drops itself — the custom path exists for a rejected/expired login. Unit-test `computeDelay` for the 1s→2s→4s→…→300s cap and jitter bounds; test reset-on-success at the scheduler level with fake timers.

### Testing standards

- Vitest, co-located `*.test.ts`, AAA, behavior names `should <behavior> when <condition>` (project-context §Testing).
- **Tests-first** for the guard + mapping (pure core) and backoff math; adapter glue (client wiring) may test after.
- Mock discord.js (`Message`, `Client`); unit tests mock db/redis. Integration uses **real** Postgres + Redis (project-context §Testing rule: "integration tests hit real Postgres … where the value is in the SQL"; Epic 2 retro action item — carry integration discipline into the pipeline). There is an established real-infra test harness in `packages/backend` (`test-helpers.ts`, `*.integration.test.ts`) and root `vitest` projects — mirror it for `packages/bot`.
- **Always test** the failure path: forced XADD error ⇒ 0 rows (rollback). This is the AD-13 integrity guarantee.

### Logging & secrets (project-context §Language / anti-patterns)

Never log the token, `DATABASE_URL`, `REDIS_URL`, api keys, or full message `content`. Log `{ messageId, channelId }` and `content.length` if useful. English only in all logs/comments/commits.

### Guardrails (ARCHITECTURE-SPINE AD-*)

- **AD-1** bot is a standalone process (own package/Dockerfile/compose entry — already true).
- **AD-2** bot imports **only** `@share2brain/shared` — never `@share2brain/backend|workers|web`. This is exactly why the Redis factory must move to shared (Task 2), not be imported from backend.
- **AD-5** no DDL outside `packages/shared`; `discord_messages` already exists — do not alter the schema.
- **AD-8** `loadConfig()` first in `main.ts`; abort before any DB/Redis/Discord I/O on failure.
- **AD-13** stream key/consumer-group are fixed invariants (import `STREAM_KEYS`); at-least-once + idempotent consumer; write the message then publish the event within one tx.
- **Write ownership** (data-model): only the bot writes `discord_messages`.

### Project Structure Notes

- New folders `discord/`, `persistence/` under `packages/bot/src/` — consistent with the DDD-by-layer convention used in `packages/backend` (`domain/`, `application/`, `infrastructure/`, `presentation/`). The bot is smaller, so a lighter grouping (adapter `discord/` + `persistence/`) is appropriate; keep the guard/mapping logic pure and injectable.
- Variance: `packages/bot` has no logger and no redis client today; both are introduced here (logger local; redis promoted to shared). Flagged as **[DECISION]** in Open Questions.

### References

- [Source: packages/shared/src/config/index.ts#Share2BrainConfigSchema] — discord/observability config shape (no `token`; `channels[].id`; `backfill.ignore_bots`).
- [Source: packages/shared/src/db/schema.ts#discordMessages] — real columns (no channel_name/author_name/last_seen_message_id; `updatedAt` NOT NULL).
- [Source: packages/shared/src/types/events.ts#MessageCreatedEvent, #STREAM_KEYS] — event fields + fixed stream key.
- [Source: packages/shared/src/db/index.ts#createDatabase] — DB client + `$client.end()`.
- [Source: packages/backend/src/infrastructure/redis.ts#createRedisClient] — the factory to promote to shared.
- [Source: packages/backend/src/main.ts#requireEnv,#main] — boot pattern (config → requireEnv → db/redis → shutdown) to mirror.
- [Source: packages/bot/src/main.ts] — current placeholder to replace; keep SIGTERM/SIGINT.
- [Source: docker-compose.yml#bot] — service already sets DATABASE_URL/REDIS_URL + env_file: .env.
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 3.1] — epic AC (reconciled above).
- [Source: docs/context/ARCHITECTURE-SPINE.md] — AD-1/2/5/8/13.
- [Source: _bmad-output/implementation-artifacts/3-0-config-proveedores-llm-y-embeddings.md] — Story 3.0 gotchas (interpolateEnv runs before YAML parse; config failure must abort before I/O).
- [Source: _bmad-output/implementation-artifacts/epic-2-retro-2026-07-05.md] — minimum hardening + integration-test discipline pulled forward into 3.1.

---

## Previous Story Intelligence

**Story 3.0 (done, 2026-07-06)** shipped the config contract this story reads: extended `agent`/`embeddings` provider blocks, the provider factory (`packages/shared/src/providers/`), and dimension guards. Learnings that matter here:
- `interpolateEnv()` runs a **raw-text `${VAR}` regex before YAML parse** — a commented line with `${VAR}` still throws if the var is unset. Any new `${...}` in config must be an active line with the var defined in `.env`. This story adds **no** new config keys, so the risk is nil, but keep it in mind if you touch `Share2Brain.config.yml`.
- `loadConfig()` failure must abort the process before any I/O — the bot's `main.ts` already calls it first; preserve that ordering.
- The embeddings dimension is **4096** in the live config (Story 3.0 fixed a corrupt-zero-vector bug where the factory returned a 1024-length vector against Borja's LiteLLM endpoint). Not used by this story (the bot does no embeddings), but do not "fix" the 1536 mention in stale docs.

**Epic 3 external-integration spike (2026-07-05)** already **validated the Gateway path for this exact story**: the bot user connected to the "Test Borja" guild (`1498305407159107735`), received a real `messageCreate` from `#general` with **non-empty content** → the privileged Message Content Intent is confirmed ON. Build on that; you should not need to re-enable portal intents.

**Epic 2 retrospective action items landing in this story:** (a) minimum hardening — `uncaughtException`/`unhandledRejection` + reconnect-with-backoff (AC-4/AC-5); (b) integration-test discipline against real Redis/Postgres as part of DoD (AC-6, Task 9).

---

## Definition of Done

1. All 6 ACs green, including the manual smoke test.
2. Unit + integration coverage per Task 9 (channel/bot guards, event mapping, backoff math, real INSERT+XADD, rollback-on-XADD-failure).
3. `npm run lint && npm run test && npm run build` all green — output pasted in the Dev Agent Record (never mark an AC done without evidence).
4. No cross-service imports (AD-2); config via `loadConfig()` (AD-8); stream key via `STREAM_KEYS` (AD-13); no schema change (AD-5).
5. No secrets or full message content in logs.
6. Branch `feat/3-1-discord-bot-gateway-messagecreate`, PR opened with a what/why description; hand off to `bmad-code-review`.

---

## Open Questions (for Borja — do not block dev; defaults chosen)

1. **`ignore_bots` source** — ✅ **RESOLVED (Borja, 2026-07-06): reuse `config.discord.backfill.ignore_bots`** for live ingestion too. No new config key, no schema change.
2. **`last_seen_message_id`** — ✅ **RESOLVED (Borja, 2026-07-06): no column.** Story 3.2 resumes from `MAX(id)` per channel (snowflakes are monotonic). Story 3.1 only inserts each message.
3. **Redis factory location** — ✅ **RESOLVED (Borja, 2026-07-06): promote `createRedisClient` to `@share2brain/shared`** and refactor backend to import it. See Task 2.
4. **update/delete listeners** — deferred to Story 6.1 (which owns edit/delete logic), so 3.1 registers `messageCreate` only, matching the story title. This narrows epic AC-1's "register all three". *Default: messageCreate only.*
5. **Logger** — no shared logger exists; default is a tiny bot-local `console` wrapper honoring `log_level`. A project-wide shared logger would be a separate refactor. *Default: local wrapper.*

---

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m] (bmad-dev-story).

### Debug Log References

- `npm run lint` → 0 errors/warnings.
- `npm run test` (unit + web) → 22 files, 124 tests passed (includes new bot unit tests: messageCreate guards, event mapping, reconnect delay/cap/jitter/reset/escalation).
- `npm run build` → all 5 workspaces compile clean (backend, bot, shared, web, workers).
- `npm run test:integration` (real Postgres + Redis) → 4 files, 14 tests passed (includes new bot integration: INSERT+XADD field mapping and rollback-on-XADD-failure = 0 rows).
- Manual smoke (real `DISCORD_BOT_TOKEN`, guild `1498305407159107735`): booting `tsx --env-file=.env packages/bot/src/main.ts` logged the privileged-intent notice, then `Connected to Discord Gateway {"botId":"1498280584886091887","guildId":"1498305407159107735"}`, and on SIGTERM logged the clean-shutdown line (AC-1 + AC-5 verified live).

### Completion Notes List

- **AC-1** — `createDiscordClient()` builds the client with `Guilds | GuildMessages | MessageContent`; `ClientReady` logs "Connected to Discord Gateway" with `{ botId, guildId }` at info; `main.ts` also emits the privileged-intent notice. Missing `DISCORD_BOT_TOKEN`/config failure aborts via `requireEnv`/`loadConfig` before any I/O (AD-8). Verified live against the real token.
- **AC-2** — `persistMessage()` runs the INSERT + `xAdd(STREAM_KEYS.DISCORD_MESSAGES, '*', {...})` inside one Drizzle transaction; all stream fields are strings; `updatedAt = createdAt`; `indexedAt`/`deletedAt` left NULL; `guildId` falls back to `config.discord.guild_id`. Field mapping asserted in unit + integration tests.
- **AC-3** — `handleMessageCreate()` guards on channel enabled/configured and on `backfill.ignore_bots` + `author.bot`; skips emit only a `debug` line; a persistence failure on an in-scope message is logged at `error` with `{ messageId, channelId, error }` and does not throw (does not crash the process).
- **AC-4** — `computeDelay()` = 1s→×2→300s cap with ±10% jitter (pure, unit-tested for sequence/cap/bounds); `connectWithRetry()` retries login indefinitely, resets on success (fresh invocation → ~1s), escalates to `error` after ≥5 failures; `bindGatewayEvents()` logs `shardDisconnect`/`shardError`/`error` at warn and prevents an unhandled 'error' crash.
- **AC-5** — `uncaughtException`/`unhandledRejection` handlers log with stack + `exit(1)`; SIGTERM/SIGINT trigger `client.destroy()` → `redis.destroy()` → `db.$client.end()` → exit(0) (idempotent guard).
- **AC-6** — full gate green (evidence above). The remaining manual-smoke steps that require a human posting in Discord and toggling the container network (live message → row+stream within ~1s; disabled/bot-author skip live; `docker network disconnect` → backoff → reconnect) are handed to the Operator; the code paths behind them are covered by unit + integration tests.
- **Task 2 (Redis factory promotion, [DECIDED with Borja])** — `createRedisClient` + `RedisClient` moved to `@share2brain/shared/redis` (new `./redis` export + `redis@^6` dep in shared); backend now imports from there and its `infrastructure/redis.ts` was deleted. Pure move — backend + shared typecheck clean, backend integration tests still green.
- No schema change (AD-5); no cross-service imports (AD-2 — the bot imports only `@share2brain/shared`); stream key via `STREAM_KEYS` (AD-13); no secrets or full message content in logs (asserted by a unit test).
- Deferred (per story Open Questions): `messageUpdate`/`messageDelete` registration → Story 6.1.

### File List

**New**
- `packages/shared/src/infrastructure/redis.ts` — Redis client factory promoted from backend (Task 2).
- `packages/bot/src/logger.ts` — local console logger honoring `observability.log_level`.
- `packages/bot/src/discord/client.ts` — Gateway client factory (intents) + ClientReady log + `login()`.
- `packages/bot/src/discord/reconnect.ts` — `computeDelay`, `connectWithRetry`, `bindGatewayEvents`.
- `packages/bot/src/discord/handlers/messageCreate.ts` — channel/bot guards + delegate.
- `packages/bot/src/persistence/persistMessage.ts` — atomic INSERT + XADD in one Drizzle tx.
- `packages/bot/src/test-helpers.ts` — real PG+Redis client opener (shared clients only, AD-2).
- `packages/bot/vitest.config.ts` — `bot-integration` project.
- `packages/bot/src/persistence/persistMessage.test.ts` — event mapping / guildId fallback / propagation (unit).
- `packages/bot/src/discord/handlers/messageCreate.test.ts` — guards + error-swallow + no-content-in-logs (unit).
- `packages/bot/src/discord/reconnect.test.ts` — delay sequence/cap/jitter/reset/escalation (unit).
- `packages/bot/src/persistence/persistMessage.integration.test.ts` — real INSERT+XADD + rollback (integration).

**Modified**
- `packages/bot/src/main.ts` — full boot wiring (config → env → db/redis → client → handlers → hardening → shutdown → connectWithRetry).
- `packages/bot/package.json` — add `redis@^6`.
- `packages/shared/package.json` — add `./redis` export + `redis@^6` dep.
- `packages/backend/src/main.ts` — import `createRedisClient` from `@share2brain/shared/redis`.
- `packages/backend/src/app.ts` — import `RedisClient` from `@share2brain/shared/redis`.
- `packages/backend/src/health.ts` — import `RedisClient` from `@share2brain/shared/redis`.
- `packages/backend/src/health.test.ts` — import `RedisClient` from `@share2brain/shared/redis`.
- `packages/backend/src/test-helpers.ts` — import from `@share2brain/shared/redis`.
- `packages/backend/src/infrastructure/sessionStore.ts` — import `RedisClient` from `@share2brain/shared/redis`.
- `vitest.config.ts` — register the `bot-integration` project.
- `package.json` — `test:integration` runs `backend-integration` + `bot-integration`.
- `package-lock.json` — dependency graph updated by `npm install`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story 3-1 → in-progress → review.

**Deleted**
- `packages/backend/src/infrastructure/redis.ts` — moved to `@share2brain/shared/redis` (Task 2).

## Change Log

| Date | Change |
|---|---|
| 2026-07-06 | Implemented Story 3.1: Discord Gateway connection + `messageCreate` listener with atomic INSERT+XADD, exponential-backoff reconnect, and process hardening. Promoted the Redis client factory to `@share2brain/shared/redis`. All 6 ACs green; full lint/test/build/integration gate passed; Gateway connection verified live. Status → review. |
| 2026-07-06 | Code review (bmad-code-review): 7 patch findings, 1 deferred, 8 dismissed. See Review Findings below. |
| 2026-07-06 | Code review — 2nd pass (3 adversarial layers): 3 decision-needed (2 dismissed, 1→patch), 4 patches applied (redis.quit await+bound, abortable backoff sleep, defensive handler try/catch, fail-fast on failed initial Redis connect), 3 deferred, 4 dismissed. Gate re-run green: lint 0 · 125 unit tests · build all 5 workspaces. Status stays `done`. |
| 2026-07-06 | Code review — 3rd pass (re-verify the 2nd-pass patches): Edge Case Hunter found P4 fail-fast was dead code (node-redis `reconnectStrategy` always returns a number → `connect()` never rejects). 4 fixes applied: R1 bound initial connect with a 10s timeout → exit(1); R2 bound `client.destroy()`; R3 `.catch()` on raced `quit()`/`end()`; R4 `.catch()` on `waitOrAbort`. 3 more deferred (log truncation on exit, tx-held-across-XADD, thread channel matching). No AC regressions. Gate green: lint 0 · 125 unit tests · build all 5 workspaces. Status stays `done`. |

## Review Findings

### Patch

- [x] [Review][Patch] `redis.destroy()` → `redis.quit()` [`packages/bot/src/main.ts:87`] — node-redis v6 no expone `destroy()`. Cambiado a `redis.quit()`.
- [x] [Review][Patch] `await redis.connect()` en vez de fire-and-forget [`packages/bot/src/main.ts:42-50`] — mensajes perdidos si Redis no está conectado al arrancar. Ahora se hace `await` con fallback a fire-and-forget.
- [x] [Review][Patch] Timeout en `db.$client.end()` durante shutdown [`packages/bot/src/main.ts:90-93`] — shutdown podía colgarse. Añadido `Promise.race` con timeout de 10s.
- [x] [Review][Patch] Filtrar mensajes con `content` vacío en handler [`packages/bot/src/discord/handlers/messageCreate.ts:50-58`] — cuando el intent `MessageContent` no está habilitado, se salta el mensaje con un `warn`.
- [x] [Review][Patch] `client.on(Events.ClientReady)` en vez de `client.once` [`packages/bot/src/discord/client.ts:25`] — reconexiones ahora loguean el ready de vuelta.
- [x] [Review][Patch] Sincronizar shutdown con `connectWithRetry` [`packages/bot/src/discord/reconnect.ts:38,56,61`] — se pasa `AbortSignal` desde `AbortController` en main; el bucle comprueba `signal?.aborted` antes de cada iteración y sleep.
- [x] [Review][Patch] `console.error` con stack trace en catch global [`packages/bot/src/main.ts:115-118`] — ahora incluye `stack` junto al mensaje.

### Deferred

- [x] [Review][Defer] Redis offline queue retiene transacción DB [`packages/bot/src/persistence/persistMessage.ts`] — con `enableOfflineQueue: true` (default de node-redis), un `xAdd` durante una caída de Redis no rechaza inmediatamente, manteniendo abierta la transacción de Postgres y consumiendo una conexión del pool. Comportamiento preexistente de node-redis, no introducido por esta story.

## Second-pass review (2026-07-06)

Adversarial 3-layer pass (Blind Hunter · Edge Case Hunter · Acceptance Auditor) over the still-uncommitted working tree. Finds residuals of the first pass, new issues, and one critique of a prior patch.

### Decision needed (resolved by Borja 2026-07-06)

- [x] [Review][Decision → dismissed: keep as-is permanently — text-knowledge pipeline, attachment capture out of scope] Empty-content filter drops attachment/embed/sticker-only messages [`packages/bot/src/discord/handlers/messageCreate.ts:53-59`] — prior patch added `content.length === 0 → skip + warn` to detect a disabled MessageContent intent, but Discord delivers `content===''` for legitimate image/sticker/embed-only messages even with the intent ON. Those are dropped (no INSERT, no XADD) and each emits a misleading "intent may be disabled" warn (log spam in image-heavy channels). AC-2 lists no empty-content exception. Decide: keep dropping vs capture attachment-bearing messages vs distinguish "all empty" (intent off) from "this one empty".
- [x] [Review][Decision → dismissed: keep retry-forever — already escalates to error logs after 5 attempts] Non-transient login errors retried forever [`packages/bot/src/discord/reconnect.ts:57-72`] — `connectWithRetry` treats every `login()` rejection as transient. `TokenInvalid` / `DisallowedIntents` (revoked token, privileged intent turned off) are permanent; the loop backs off (cap 5min) and retries indefinitely, so a hard config error looks like an outage and the container never crash-loops to signal the Operator (it does escalate to `error` logs after 5 attempts). Decide: fail-fast/exit(1) on known-permanent auth errors vs current retry-forever.
- [x] [Review][Decision → patch P4] Behaviour on a failed INITIAL Redis connect [`packages/bot/src/main.ts:42-50`] — the fire-and-forget `redis.connect().catch(()=>{})` swallows a persistent failure. **Borja's call: fail-fast at boot** — if Redis is unreachable at startup, log `error` and `exit(1)` so Compose restarts the container (reverses the "continue-degraded" half of the earlier await-patch). See patch P4 below.

### Patch — P4 (from decision)

- [x] [Review][Patch] ✅ APPLIED — Fail-fast when the initial Redis connect fails [`packages/bot/src/main.ts:42-50`] — replaced the `catch → continue + fire-and-forget retry` with `logger.error(...) + process.exit(1)`, so an unreachable Redis at boot crash-loops the container (Compose restarts) instead of running degraded.

### Patch

- [x] [Review][Patch] ✅ APPLIED — `redis.quit()` not awaited during shutdown [`packages/bot/src/main.ts:87`] — prior patch changed `destroy()`→`quit()` but left it fire-and-forget; `process.exit(0)` in the `finally` could fire before `quit()` flushed an in-flight XADD. Now `await`ed, bounded by a 5s `Promise.race` (mirrors `db.$client.end()`). `test-helpers.ts:34` keeps `destroy()` (fine for forced test teardown — both methods exist in redis@6).
- [x] [Review][Patch] ✅ APPLIED — Backoff `sleep` is not abortable [`packages/bot/src/discord/reconnect.ts:71`] — the `await sleep(delay)` (up to 300s) was a bare timer with no signal wiring. Added `waitOrAbort(sleep(delay), signal)` which resolves immediately on abort; the loop-top check then returns. Injectable `sleep` and delay assertions preserved (tests without a signal are unchanged).
- [x] [Review][Patch] ✅ APPLIED — Pre-`try` guards could leak an unhandled rejection [`packages/bot/src/discord/handlers/messageCreate.ts:35-59`] — the channel/bot/empty-content guards ran *before* the `try`, so a malformed/partial message could throw synchronously and hit `unhandledRejection → exit(1)`. The whole handler body is now inside one `try/catch` (log key renamed `failed to persist message` → `failed to handle message`; test updated), making the "never rejects" contract true.

### Deferred

- [x] [Review][Defer] XADD publishes before the DB COMMIT [`packages/bot/src/persistence/persistMessage.ts:65-74`] — the `xAdd` runs inside the tx callback but against the non-transactional Redis client, so the event is durable in Redis before the Postgres COMMIT lands. The documented tradeoff only covers the reverse (commit-fails-after-XADD). For Story 3.3: ensure the Indexer reads `content` from the event itself (it carries all fields) or tolerates a transient row-not-found by not ACKing.
- [x] [Review][Defer] INSERT has no `onConflict` — Gateway re-delivery logs a false persistence error [`packages/bot/src/persistence/persistMessage.ts:51-61`] — on a RESUME/reconnect Discord may re-deliver a `messageCreate`; the PK-duplicate INSERT aborts the tx and logs `error: failed to persist message` although the row+event already exist. `onConflictDoNothing` would make the producer idempotent and silence the false alert (uncommon path — defer).
- [x] [Review][Defer] Post-boot Gateway recovery fully delegated to discord.js [`packages/bot/src/main.ts:108-112`, `reconnect.ts:82-92`] — `connectWithRetry` runs once at boot; AC-4's reset-on-successful-reconnect and escalate-after-5 are only exercised on the initial login path (unit test drives reset via a fresh call production never makes). If discord.js exhausts its own retries after boot, nothing escalates to `error` or exits and the bot sits idle. Matches the story's documented design; revisit as an observability enhancement.

## Third-pass review (2026-07-06) — verifying the 2nd-pass patches

Re-ran the 3 adversarial layers over the patched tree. Acceptance Auditor: no AC regressions; the 4 patches are consistent with the ACs (2 strengthen them). But the Edge Case Hunter — **checking the vendored `@redis/client@6.1.0` source** — found that patch **P4 is dead code**, plus two small regressions the P1/P2 patches introduced.

### Patch (fix regressions from the 2nd pass)

- [x] [Review][Patch] ✅ APPLIED (R1) — **P4 fail-fast never fired — `connect()` can't reject at boot** [`packages/bot/src/main.ts:42-50`] — the shared factory sets `reconnectStrategy: (retries) => Math.min(retries*50, 2000)`, which always returns a number, so `@redis/client` retries the initial connect forever and `connect()` stayed *pending* on a boot outage — the `catch`/`exit(1)` was unreachable and the bot hung (opposite of the decision, verified against the vendored `@redis/client@6.1.0` source). **Fixed:** the initial connect is now bounded by a 10s `Promise.race` timeout; on timeout → `logger.error` + `exit(1)`, before any Gateway I/O (AD-8 preserved). Borja's call: fixed 10s, not configurable.
- [x] [Review][Patch] ✅ APPLIED (R3) — Late-rejecting `redis.quit()` could flip shutdown to exit(1) [`packages/bot/src/main.ts`] — `.catch(() => undefined)` now attached to the raced `quit()` and `db.$client.end()`, so a late rejection after losing the race can't surface as `unhandledRejection → exit(1)`.
- [x] [Review][Patch] ✅ APPLIED (R2) — `client.destroy()` was unbounded in shutdown [`packages/bot/src/main.ts`] — now wrapped in a 5s `Promise.race` timeout like `quit()`/`end()`, so a hung Gateway socket can't block the exit until SIGKILL.
- [x] [Review][Patch] ✅ APPLIED (R4) — `waitOrAbort` wrapped promise had no rejection handler [`packages/bot/src/discord/reconnect.ts`] — `void wait.then(done, done)` now resolves on either settle, so a rejecting `sleep` can't stall the loop or leak an unhandledRejection.

### Deferred (3rd pass)

- [x] [Review][Defer] `process.exit()` immediately after `logger.error` can truncate the final log line on a pipe [`main.ts` fatal paths: boot Redis fail, `uncaughtException`, `unhandledRejection`] — `console.error` to a pipe (Docker) is async, so the diagnostic line can be dropped before exit. Pre-existing, project-wide pattern (backend does the same); fix as a shared observability change, not piecemeal here.
- [x] [Review][Defer] Postgres transaction held open across the Redis XADD round-trip [`persistMessage.ts`] — same root as the already-deferred offline-queue item: XADD inside the tx keeps a pg connection inside `BEGIN` for the Redis round-trip; Redis latency → pool exhaustion. A transactional-outbox would fix both this and the publish-before-commit window. Deferred (architectural).
- [x] [Review][Defer] Thread messages don't match a configured parent channel [`messageCreate.ts`] — `message.channelId` for a thread is the thread's own id, not the parent's, so thread messages are skipped even when the parent is enabled. Likely intended for 3.1; document and revisit if thread ingestion is wanted.
