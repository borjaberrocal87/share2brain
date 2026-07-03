---
baseline_commit: 55845f2
---

# Story 1.2: Implement packages/shared — the domain kernel

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer of any service,
I want `packages/shared` to export the Drizzle schema, the API Zod schemas, `loadConfig()`, and the Redis Streams event types,
so that every service uses a single source of truth for data models, API contracts, and configuration.

## Acceptance Criteria

**AC1 — Drizzle schema defines all tables (and no `sessions` table)**
- **Given** `packages/shared/src/db/schema.ts`
- **When** it is reviewed
- **Then** it defines every table: `discord_messages`, `embeddings`, `users`, `user_roles_cache`, `channel_permissions`, `conversations`, `messages`, `user_read_status`
- **And** the `sessions` table is **NOT** defined (sessions live in Redis — AD-10)
- **And** running `npx drizzle-kit generate` produces SQL migration files in `packages/shared/src/db/migrations/`

**AC2 — `loadConfig()` returns a typed, validated config**
- **Given** a valid `Hivly.config.yml`
- **When** `loadConfig()` is called
- **Then** it returns a typed configuration object with every required field validated

**AC3 — `loadConfig()` fails fast on invalid config**
- **Given** a `Hivly.config.yml` with an invalid or missing field
- **When** any service calls `loadConfig()` at startup
- **Then** the process terminates with a descriptive error message **before** opening any network connection (AD-8)

**AC4 — SSE wire format is a discriminated union**
- **Given** `packages/shared/src/schemas/sse.ts`
- **When** it is reviewed
- **Then** it exports `SSEFrame` as a discriminated union: `token | citation | done | error`, with the correct fields per type

**AC5 — Redis Streams event types carry the mandatory fields**
- **Given** `packages/shared/src/types/events.ts`
- **When** it is reviewed
- **Then** it exports `MessageCreatedEvent`, `MessageUpdatedEvent`, `MessageDeletedEvent`, each carrying the mandatory fields `messageId`, `channelId`, `guildId`, `timestamp` (ISO 8601 UTC)

## Tasks / Subtasks

- [x] **Task 1 — Dependencies + subpath exports for `@hivly/shared`** (AC: 1, 2, 4, 5)
  - [x] Add runtime deps to `packages/shared/package.json`: `drizzle-orm@^0.45`, `zod@^4.4`, and a YAML parser `yaml@^2` (used by `loadConfig`). Add dev deps: `drizzle-kit@^0.31`.
  - [x] Add the Postgres driver Drizzle uses for its client type — `pg@^8` + `@types/pg` (dev). The `db/index.ts` client is a type-level export at this stage; no connection is opened by `shared` itself.
  - [x] **Extend the `exports` map** in `packages/shared/package.json` to expose subpath entrypoints as raw source (same source-exports pattern Story 1.1 chose — `types`+`default` → the `.ts` file, avoids `composite: true`). Story 1.1 deferred this ("`exports` field blocks future subpath entrypoints — add wildcard when sub-exporters land"); this story is when they land. The design imports via subpaths, so they MUST resolve:
    - `"."` → `./src/index.ts` (keep existing)
    - `"./db"` → `./src/db/index.ts`
    - `"./db/schema"` → `./src/db/schema.ts`
    - `"./schemas"` → `./src/schemas/index.ts`
    - `"./config"` → `./src/config/index.ts`
    - `"./types/events"` → `./src/types/events.ts`
  - [x] Run `npm install` at the root so the new deps resolve across workspaces (single lockfile).
- [x] **Task 2 — Drizzle schema: all 8 tables + indexes** (AC: 1)
  - [x] Create `packages/shared/src/db/schema.ts` defining all 8 tables from `data-model.md` (see Dev Notes for the exact field list). Use `pgTable` from `drizzle-orm/pg-core`. **Column names are `snake_case` in the DB, `camelCase` in TS** (Drizzle maps them).
  - [x] `embeddings.embedding` uses the pgvector column type: `vector('embedding', { dimensions: 1536 })` from `drizzle-orm/pg-core`.
  - [x] IDs: Discord entities (`discord_messages`, `channel_permissions`) use `text` snowflake PKs; own entities (`embeddings`, `users`, `conversations`, `messages`) use `uuid` PKs with `defaultRandom()`. Timestamps are `timestamp with time zone` (`timestamp(..., { withTimezone: true })`). Nullable where `data-model.md` marks them nullable (`indexed_at`, `deleted_at`, `category_id`, `avatar`).
  - [x] Array columns use `text('...').array()` (`message_ids`, `discord_roles`, `allowed_roles`). `messages.citations` is `jsonb`.
  - [x] Declare the critical indexes **in the schema** so `drizzle-kit generate` emits them: HNSW cosine on `embeddings.embedding` (`.using('hnsw', ...vector_cosine_ops)`), btree on `embeddings.channel_id`, `discord_messages(channel_id, created_at DESC)`, and the two `user_read_status` indexes. See Dev Notes for the exact index list.
  - [x] **Do NOT define a `sessions` table** (AD-10). Add a one-line comment stating sessions live in Redis so a future reader doesn't "helpfully" add it.
  - [x] Create `packages/shared/src/db/index.ts` exporting the Drizzle client factory/type and re-exporting the schema (per `backend-standards.md#Monorepo Structure`). It must not open a connection at import time.
- [x] **Task 3 — drizzle-kit config + pgvector extension + generate migrations** (AC: 1)
  - [x] Create `drizzle.config.ts` at the **repo root** (matches `backend-standards.md` globs). Use `defineConfig` from `drizzle-kit`: `dialect: 'postgresql'`, `schema: './packages/shared/src/db/schema.ts'`, `out: './packages/shared/src/db/migrations'`, `dbCredentials: { url: process.env.DATABASE_URL! }`. (`generate` does not need a live DB — `dbCredentials` is only consulted by `migrate`/`push`/`studio`.)
  - [x] **pgvector extension must exist before the tables migration runs.** `drizzle-kit generate` does NOT emit `CREATE EXTENSION`. Author a custom first migration: `npx drizzle-kit generate --custom --name enable_pgvector`, then write `CREATE EXTENSION IF NOT EXISTS vector;` into that generated custom file. Custom migrations are authored by us — this is **not** "hand-editing generated SQL" (that ban applies to auto-generated schema diffs). Ensure it sorts before the schema migration.
  - [x] Run `npx drizzle-kit generate` to emit the schema migration into `src/db/migrations/`. Commit the generated SQL + `meta/` journal. **Never hand-edit auto-generated schema SQL** — if it's wrong, fix `schema.ts` and regenerate.
- [x] **Task 4 — Zod API schemas** (AC: 4)
  - [x] Create `packages/shared/src/schemas/errors.ts` exporting `ErrorSchema = z.object({ error: z.string(), code: z.string() })` and `type ErrorResponse = z.infer<typeof ErrorSchema>` (AD-6, unified error shape).
  - [x] Create `packages/shared/src/schemas/sse.ts` exporting `SSEFrameSchema` as a `z.discriminatedUnion('type', [...])` with exactly the four variants + `type SSEFrame = z.infer<...>`. Fields per variant are in Dev Notes.
  - [x] Create `packages/shared/src/schemas/index.ts` barrel that re-exports `errors.ts` and `sse.ts` (so `@hivly/shared/schemas` resolves the whole contract surface, per `backend-standards.md` example import).
- [x] **Task 5 — Redis Streams event types** (AC: 5)
  - [x] Create `packages/shared/src/types/events.ts` with a `StreamEvent` base (`messageId`, `channelId`, `guildId`, `timestamp`) and the three events discriminated by `type` (`'discord.message.created' | 'discord.message.updated' | 'discord.message.deleted'`). Exact shape in Dev Notes. Also export a `DiscordStreamEvent` union of the three.
  - [x] Export the fixed stream-key / consumer-group constants as `UPPER_SNAKE_CASE` (or a `const` object) so producers/consumers never hardcode strings (AD-13 invariants). See Dev Notes.
- [x] **Task 6 — `loadConfig()` + config Zod schema** (AC: 2, 3)
  - [x] Create `packages/shared/src/config/index.ts` exporting `loadConfig(path?)` and the inferred `HivlyConfig` type. Behavior:
    1. Resolve the config path: arg → `process.env.HIVLY_CONFIG_PATH` → default `Hivly.config.yml` (cwd). In Compose it is mounted at `/app/Hivly.config.yml`.
    2. Read the file; parse YAML with `yaml`.
    3. **Interpolate `${ENV_VAR}` placeholders from `process.env`** (the YAML references secrets like `guild_id: "${DISCORD_GUILD_ID}"`). A referenced env var that is unset is a validation failure with a clear message.
    4. Validate the parsed object with a Zod schema mirroring `Hivly.config.yml.example` (all sections — see Dev Notes for the full shape).
    5. On any failure (missing file, bad YAML, failed Zod parse, unset `${VAR}`), throw/exit with a descriptive message. **Must happen before any network I/O** — `loadConfig` itself must not open DB/Redis/Discord connections.
  - [x] Design the schema so failures are descriptive: prefer `.parse()` and format `ZodError.issues` into a readable message (path + message per issue).
- [x] **Task 7 — Root barrel** (AC: 1, 2, 4, 5)
  - [x] Update `packages/shared/src/index.ts` to re-export the public surface (`./config`, `./schemas`, `./db`, `./types/events`) so `@hivly/shared` root imports still work, while keeping the existing exported version constant (its test `index.test.ts` must keep passing). Do not break the Story 1.1 semver test.
- [x] **Task 8 — Tests (tests-first for `loadConfig`)** (AC: 2, 3, 4, 5)
  - [x] `config/index.test.ts` (write red first — this is core/domain, AD-8): valid YAML fixture → returns typed object with expected values; missing required key → throws descriptive error; unset `${VAR}` → throws; malformed YAML → throws. Use temp fixture files or in-memory strings; mock `process.env` for interpolation cases. **No real network/DB.**
  - [x] `schemas/sse.test.ts`: each of the 4 `SSEFrame` variants parses; a bad `type` or missing field rejects.
  - [x] `types/events.test.ts` (or a `schemas` smoke): assert each event object satisfies its type and carries the 4 mandatory fields (a compile-time `satisfies` check + a runtime field assertion).
  - [x] Keep AAA structure and `should <behavior> when <condition>` names (`base-standards`/`project-context` testing rules).
- [x] **Task 9 — Verification gate** (AC: 1–5) — **the agent runs this, never the user**
  - [x] Run and paste output for: `npm install`, `npm run lint`, `npm run test`, `npm run build` (all green).
  - [x] Run `npx drizzle-kit generate` and confirm SQL migration files appear under `packages/shared/src/db/migrations/` (paste the file list). This does not require a running Postgres.
  - [x] Confirm cross-package resolution: a throwaway `import { loadConfig } from '@hivly/shared/config'` (and `'@hivly/shared/db/schema'`) from, e.g., `packages/backend/src` typechecks clean; remove the throwaway after verifying.

## Dev Notes

### What this story is (and is NOT)
This is the **kernel** story: it fills `packages/shared` with the real domain contracts every other service depends on — Drizzle schema, Zod API schemas, `loadConfig()`, and Redis Streams event types. It is still **library-only**: no Express app, no Discord client, no Redis/DB connection is opened, no Docker Compose. Docker Compose + the `/health` endpoint + the `migrator` service are **Story 1.3**. The Backend/Bot/Workers runtime that *uses* these contracts arrives in Epics 2–6. Keep `shared` free of any service runtime. [Source: epics.md#Historia 1.2 / 1.3; TECHNICAL-DESIGN.md#5.1]

### ⚠️ Scope correction — 8 tables, not 7
The epic AC lists **7** tables (omits `user_roles_cache`), but `data-model.md` and `TECHNICAL-DESIGN.md#6` both define **8** — `user_roles_cache` exists for TTL-cached RBAC lookups so RBAC doesn't hit the Discord API each request. **Implement all 8.** `data-model.md` is the authoritative data source. AC1 above has been corrected to include it. [Source: data-model.md#4; TECHNICAL-DESIGN.md#6 "La tabla `user_roles_cache` existe…"]

### Current repo state (verified)
- Branch is `main` — **branch first** (`git switch -c feat/1-2-shared-kernel`); never commit on `main`. Last commit `55845f2` (merge of Story 1.1). [Source: base-standards.md#Development Workflow]
- `packages/shared` currently has only `src/index.ts` (exports a `SHARED_VERSION` semver constant) + `src/index.test.ts` (semver-format test). `package.json` `exports` map has **only** `"."` → `./src/index.ts`. No deps declared yet. **You extend all of this.**
- Root `package.json` devDeps: `@types/node`, `eslint@^9`, `typescript@^6.0.3`, `typescript-eslint@^8.62.1`, `vitest@^4.1.9`. No `drizzle-*`, `zod`, `yaml`, `pg` yet.
- `Hivly.config.yml.example` and `.env.example` exist at repo root and are complete (Story 1.1). `.env.example` already lists `DATABASE_URL`, `POSTGRES_PASSWORD`, `REDIS_URL`, etc. — use it as the env contract; do not redefine.
- `build` and `typecheck` are both `tsc --noEmit` per package (scaffold decision from 1.1). Vitest runs via root `vitest run` (`--passWithNoTests` still on). Adding real deps is fine; keep `noEmit` (types resolve from source via the `exports` map).

### Non-negotiable architecture rules touched by this story
- **AD-5 — Drizzle is the only DB layer**: schema in `packages/shared/src/db/schema.ts`; migrations via `drizzle-kit` as explicit SQL. **No DDL anywhere else. Never hand-edit auto-generated schema SQL** (custom-authored migrations like the pgvector extension are the exception — those are yours to write). [Source: ARCHITECTURE-SPINE.md#AD-5; backend-standards.md#Database Patterns]
- **AD-6 — Zod contracts in shared**: every API request/response shape is a Zod schema in `packages/shared/src/schemas/`. `z.infer<>` for types — never hand-duplicate. [Source: backend-standards.md#AD-6]
- **AD-8 — centralized config**: `loadConfig()` validates YAML and aborts on invalid config **before any network I/O**. [Source: ARCHITECTURE-SPINE.md#AD-8; backend-standards.md]
- **AD-10 — sessions in Redis, no table**: never add a `sessions` table. [Source: data-model.md; TECHNICAL-DESIGN.md#6]
- **AD-13 — stream keys/groups are fixed invariants**; events carry `messageId`, `channelId`, `guildId`, `timestamp`. Idempotency (UPSERT on existing `embedding.id`) is a *worker* concern (Epic 3) — this story only defines the types/keys. [Source: TECHNICAL-DESIGN.md#8; backend-standards.md#Redis Streams Patterns]
- **AD-2 — shared imports nothing `@hivly/*`**: `shared` is the leaf; it must not import any sibling. [Source: project-context.md#Architecture boundaries]
- **English only**, `camelCase.ts` module files, `PascalCase` types, `UPPER_SNAKE_CASE` constants; avoid `any` (use `unknown` / Zod-inferred types). [Source: project-context.md#Code quality & naming]

### `packages/shared` target layout
```
packages/shared/src/
├── index.ts              # UPDATE — root barrel (re-export public surface + keep SHARED_VERSION)
├── index.test.ts         # KEEP — semver test must still pass
├── db/
│   ├── schema.ts         # NEW — Drizzle: all 8 tables + indexes (source of truth, AD-5)
│   ├── index.ts          # NEW — Drizzle client factory/type + schema re-export (no connection at import)
│   └── migrations/       # NEW — generated by drizzle-kit (SQL + meta/ journal)
├── schemas/
│   ├── errors.ts         # NEW — ErrorSchema { error, code }
│   ├── sse.ts            # NEW — SSEFrame discriminated union
│   └── index.ts          # NEW — barrel re-exporting errors + sse
├── config/
│   ├── index.ts          # NEW — loadConfig() + HivlyConfig Zod schema + ${ENV} interpolation
│   └── index.test.ts     # NEW — tests-first
└── types/
    └── events.ts         # NEW — StreamEvent + 3 message events + stream-key constants
# repo root:
drizzle.config.ts         # NEW — dialect postgresql, schema→shared, out→shared migrations
```
[Source: backend-standards.md#Monorepo Structure; TECHNICAL-DESIGN.md#4]

### Drizzle schema — exact tables & fields (from data-model.md#Model Descriptions)
DB column names `snake_case`; TS property names `camelCase`. Snowflakes = `text`; own IDs = `uuid` `defaultRandom()`; timestamps = `timestamp(..., { withTimezone: true })`.

1. **discord_messages** — PK `id` text (snowflake). `channel_id`, `guild_id`, `author_id` text; `content` text; `created_at`, `updated_at` ts; `indexed_at` ts **nullable**; `deleted_at` ts **nullable** (soft delete). Owner: bot.
2. **embeddings** — PK `id` uuid. `content` text; `embedding` **`vector({dimensions:1536})`**; `channel_id` text; `message_ids` `text[]`; `created_at` ts. Owner: workers.
3. **users** — PK `id` uuid. `discord_id` text **unique**; `username` text; `avatar` text **nullable**; `created_at` ts. Owner: backend.
4. **user_roles_cache** — `user_id` uuid FK→users.id; `discord_roles` `text[]`; `cached_at` ts; `expires_at` ts. (TTL via `access_control.role_cache_ttl`.) Owner: backend.
5. **channel_permissions** — PK `channel_id` text (snowflake). `name` text; `allowed_roles` `text[]`; `category_id` text **nullable**. Owner: backend (upsert from config at startup).
6. **conversations** — PK `id` uuid. `user_id` uuid FK→users.id; `created_at`, `updated_at` ts. Owner: backend.
7. **messages** — PK `id` uuid. `conversation_id` uuid FK→conversations.id; `role` text (`'user' | 'assistant' | 'system'` — model as a `text` column, optionally with an enum/check); `content` text; `citations` **`jsonb`** (array of {channel, author, date}); `created_at` ts. Owner: backend.
8. **user_read_status** — `user_id` uuid FK→users.id; `embedding_id` uuid FK→embeddings.id; `read_at` ts. (Composite PK on (`user_id`,`embedding_id`) is the natural key.) Owner: backend.

**Indexes to declare in schema.ts** (so `generate` emits them) [Source: data-model.md#Critical Indexes]:
```sql
idx_embeddings_vector          -- HNSW (embedding vector_cosine_ops)
idx_embeddings_channel         -- btree embeddings(channel_id)          ← the RBAC filter (AD-12)
idx_discord_messages_channel   -- discord_messages(channel_id, created_at DESC)
idx_user_read_status_user      -- user_read_status(user_id)
idx_user_read_status_embedding -- user_read_status(embedding_id)
```
Drizzle HNSW pattern (drizzle-orm 0.45): `index('idx_embeddings_vector').using('hnsw', table.embedding.op('vector_cosine_ops'))`.

### pgvector — the gotcha that will bite you
- The `vector` column needs `CREATE EXTENSION vector` to exist **before** the `embeddings` table migration runs. `drizzle-kit generate` will NOT add it. Create a custom migration first: `npx drizzle-kit generate --custom --name enable_pgvector` → write `CREATE EXTENSION IF NOT EXISTS vector;`. Verify it sorts before the schema migration in the journal.
- Image is `pgvector/pgvector:pg17` (0.8.2). You are not running the DB in this story — only generating SQL — so no container needed for AC1. [Source: project-context.md#Technology Stack; TECHNICAL-DESIGN.md#14]

### SSEFrame — exact shape (schemas/sse.ts) [Source: TECHNICAL-DESIGN.md#12]
```typescript
export const SSEFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('token'),    content: z.string() }),
  z.object({ type: z.literal('citation'), channel: z.string(), author: z.string(), date: z.string() }),
  z.object({ type: z.literal('done'),     conversationId: z.string() }),
  z.object({ type: z.literal('error'),    code: z.string(), message: z.string() }),
])
export type SSEFrame = z.infer<typeof SSEFrameSchema>
```

### Redis Streams events — exact shape (types/events.ts) [Source: TECHNICAL-DESIGN.md#8]
```typescript
export interface StreamEvent {
  messageId: string   // Discord snowflake
  channelId: string
  guildId: string
  timestamp: string   // ISO 8601 UTC
}
export interface MessageCreatedEvent extends StreamEvent {
  type: 'discord.message.created'; content: string; authorId: string
}
export interface MessageUpdatedEvent extends StreamEvent {
  type: 'discord.message.updated'; newContent: string
}
export interface MessageDeletedEvent extends StreamEvent {
  type: 'discord.message.deleted'
}
export type DiscordStreamEvent =
  MessageCreatedEvent | MessageUpdatedEvent | MessageDeletedEvent
```
Fixed stream keys / consumer groups (AD-13 invariants) [Source: TECHNICAL-DESIGN.md#8; backend-standards.md#Redis Streams Patterns] — export as constants:
```
hivly:discord:messages          → group hivly:indexer   (workers/indexer)
hivly:discord:messages:updated  → group hivly:sync      (workers/sync)
hivly:discord:messages:deleted  → group hivly:sync      (workers/sync)
hivly:knowledge:events          → group hivly:notifier  (deferred, Epic 6)
```
Design defines events as TS interfaces (they are internal stream contracts, not HTTP API shapes — so they live in `types/`, not `schemas/`). Optionally back them with Zod for runtime validation at worker consume time — **not required by this story**; leave a hook, don't build it now.

### `loadConfig()` — config schema shape (config/index.ts) [Source: Hivly.config.yml.example; TECHNICAL-DESIGN.md#13]
Mirror the example YAML section-for-section. Required top-level keys and notable fields:
- `version` (string)
- `discord`: `guild_id` (string), `channels[]` `{ id, name, enabled }`, `backfill { enabled, limit, ignore_bots }`
- `agent`: `{ provider, model, temperature, max_iterations, memory_window }`
- `knowledge`: `{ chunk_size, chunk_overlap, grouping_window, embedding_model }`
- `sync`: `{ enabled, sync_on_start, delete_policy: 'soft' | 'hard' }`
- `access_control`: `{ enabled, default_policy: 'deny' | 'allow', role_cache_ttl, channel_permissions[] { channel_id, name, allowed_roles[] } }`
- `read_tracking`: `{ enabled, auto_mark_read_on_click }`
- `observability`: `{ sentry_dsn, log_level: 'debug'|'info'|'warn'|'error' }`
- `security`: `{ rate_limit { window_ms, max_requests }, allowed_origins[] }`

Behavior requirements:
- **`${ENV_VAR}` interpolation**: values like `"${DISCORD_GUILD_ID}"`, `"${SENTRY_DSN}"`, `"${FRONTEND_URL}"` are substituted from `process.env` before/at validation. An unset referenced var → descriptive failure. (Secrets stay in `.env`; behavior stays in YAML — never merge the two.)
- Use `snake_case` keys in the schema to match the YAML exactly (YAML is authored by operators). Expose the inferred `HivlyConfig` type.
- Fail fast: missing file → clear error; bad YAML → clear error; Zod failure → format `error.issues` (path + message) into one readable string; **no connections opened**.
- Path resolution: arg → `HIVLY_CONFIG_PATH` env → `Hivly.config.yml` in cwd (Compose mounts it at `/app/Hivly.config.yml`).

### Stack / versions (pin per these) [Source: TECHNICAL-DESIGN.md#15; project-context.md]
`drizzle-orm@0.45` + `drizzle-kit@0.31` · `zod@4.4` (v4 API — `z.discriminatedUnion`, `z.infer`, `error.issues`; differs from v3 in spots) · `yaml@2` for YAML parsing · `pg@8` driver (Drizzle node-postgres) · Node 24 · TS 6.0 strict. Never `:latest`. Zod-inferred types over hand-written duplicates.

### Previous story intelligence (Story 1.1) [Source: 1-1-*.md#Completion Notes]
- **Source-exports resolution is the established pattern**: `@hivly/shared` exports raw `.ts` from `exports`/`types` (no `composite:true`, no prebuild). Extend the `exports` map for subpaths the same way — do NOT switch to project references or declaration emit.
- `build` == `typecheck` == `tsc --noEmit` at this stage — keep it; real build artifacts come later.
- ESLint 9 flat config with the AD-2 cross-service ban is live; `shared` has no ban block (it imports no sibling) — keep it that way.
- Root test script uses `--passWithNoTests`; deferred removal until real tests exist across all packages. This story adds real tests to `shared`, so `shared`'s suite will now be non-empty.
- `.env.example` is tracked (gitignore negation `!.env.example`); `**/dist/` ignored; `.npmrc` has `engine-strict=true`.

### Git intelligence
Recent commits: `55845f2` (merge Story 1.1 PR #1), `ff2e5f9` fix semver regex, `5a606fe` scaffold monorepo, `2f2f240` initial. History confirms: single lockfile at root, Conventional Commits with `(shared)`/`(repo)` scopes, one commit per slice. Follow the same — e.g. `feat(shared): add drizzle schema for all domain tables`, `feat(shared): add loadConfig with env interpolation`, `feat(shared): add sse + event contracts`. Mark no breaking changes (this is additive).

### Testing standards [Source: project-context.md#Testing rules; backend-standards.md#Testing]
- Vitest, co-located `*.test.ts`, AAA, `should <behavior> when <condition>` names.
- **Tests-first for `loadConfig`** (core/domain per AD-8): red → green. Schema/type files can test-after.
- No real network/DB in unit tests — `loadConfig` reads local fixtures; mock `process.env` for interpolation. Integration tests against real Postgres+pgvector are a *later* concern (they belong where SQL behavior is exercised — search/indexer, Epics 3–4), not here.

### Project Structure Notes
- Layout matches `backend-standards.md#Monorepo Structure` and `TECHNICAL-DESIGN.md#4` exactly. Only variance vs. the epic AC: **8 tables not 7** (documented above; `data-model.md` wins).
- `drizzle.config.ts` at repo root (per `backend-standards.md` globs), pointing into `packages/shared`. Do not create a root `src/`. Do not add Dockerfiles / `docker-compose.yml` / the `migrator` service (Story 1.3).
- Subpath `exports` must be added to `packages/shared/package.json` — this was explicitly deferred by Story 1.1 and is a prerequisite for the design's `@hivly/shared/config` etc. import style.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 1.2: Implementar packages/shared — el kernel de dominio]
- [Source: docs/data-model.md#Model Descriptions, #Critical Indexes, #Write Ownership]
- [Source: docs/context/TECHNICAL-DESIGN.md#5.1 packages/shared, #6 Modelo de datos, #8 Sistema de eventos, #12 Streaming SSE, #13 Configuración, #15 Stack]
- [Source: docs/context/ARCHITECTURE-SPINE.md#AD-2, #AD-5, #AD-6, #AD-8, #AD-10, #AD-13]
- [Source: docs/backend-standards.md#Monorepo Structure, #Database Patterns, #Redis Streams Patterns, #Testing]
- [Source: Hivly.config.yml.example (full config surface); .env.example (secret contract)]
- [Source: _bmad-output/implementation-artifacts/1-1-inicializar-el-repositorio-y-la-estructura-del-monorepo.md#Completion Notes, #Deferred]
- [Source: _bmad-output/project-context.md — Contracts live only in shared, Language/TypeScript, Testing rules, Code quality & naming]

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m] (Claude Opus 4.8, 1M context) — bmad-dev-story workflow.

### Debug Log References

- `npm install` — added 35 packages (drizzle-orm 0.45.2, drizzle-kit 0.31.10, zod 4.4.3, yaml 2.9.0, pg 8.22.0, @types/pg).
- `npx drizzle-kit generate --custom --name enable_pgvector` → `0000_enable_pgvector.sql` (wrote `CREATE EXTENSION IF NOT EXISTS vector;`).
- `npx drizzle-kit generate` → `0001_tough_skrulls.sql` (8 tables, all indexes, FKs). Journal orders 0000 before 0001.
- Verification gate (all green): `npm run lint` (clean), `npm run test` (4 files, 20 tests passed), `npm run build` (tsc --noEmit clean across all 5 workspaces).
- Cross-package resolution: throwaway `import` of `@hivly/shared/{config,db/schema,schemas,types/events}` from `packages/backend/src` typechecked clean, then removed.

### Completion Notes List

- **AC1** — `db/schema.ts` defines all **8** tables (`discord_messages`, `embeddings`, `users`, `user_roles_cache`, `channel_permissions`, `conversations`, `messages`, `user_read_status`). No `sessions` table (AD-10, comment added). `drizzle-kit generate` emits SQL under `packages/shared/src/db/migrations/`. Generated SQL confirmed correct: `vector(1536)`, HNSW `vector_cosine_ops` index, `idx_embeddings_channel` (RBAC filter), `discord_messages(channel_id, created_at DESC)`, both `user_read_status` indexes, unique `discord_id`, composite PK on `user_read_status(user_id, embedding_id)`, and all FKs.
- **AC2/AC3** — `config/loadConfig()` reads YAML, interpolates `${ENV_VAR}` from `process.env`, validates with Zod (`HivlyConfigSchema` mirrors `Hivly.config.yml.example`, snake_case keys). Throws a descriptive `ConfigError` on missing file / bad YAML / unset `${VAR}` / Zod failure (issues formatted as `path: message`). No network I/O. Tests-first (red → green), 6 cases.
- **AC4** — `schemas/sse.ts` exports `SSEFrameSchema` as `z.discriminatedUnion('type', …)` with `token | citation | done | error` and `SSEFrame` type.
- **AD-6** — `schemas/errors.ts` exports `ErrorSchema { error, code }` + `ErrorResponse`.
- **AC5** — `types/events.ts` exports `StreamEvent` base + `MessageCreated/Updated/Deleted` events (each with `messageId`, `channelId`, `guildId`, `timestamp`), `DiscordStreamEvent` union, and fixed `STREAM_KEYS` / `CONSUMER_GROUPS` constants (AD-13).
- **Subpath exports** — `packages/shared/package.json` `exports` extended to `.`, `./db`, `./db/schema`, `./schemas`, `./config`, `./types/events` (source-exports pattern from Story 1.1; no `composite`/prebuild). Root barrel re-exports the full surface while keeping `PACKAGE_NAME` / `SHARED_KERNEL_VERSION` so the Story 1.1 semver test still passes.
- **Deferred (Story 1.3)** — no Docker Compose, `/health`, or `migrator` service; `shared` opens no DB/Redis/Discord connection (`createDatabase()` is a lazy factory — `new Pool()` does not dial until first query).

### File List

**Added**
- `packages/shared/src/db/schema.ts`
- `packages/shared/src/db/index.ts`
- `packages/shared/src/db/migrations/0000_enable_pgvector.sql`
- `packages/shared/src/db/migrations/0001_tough_skrulls.sql`
- `packages/shared/src/db/migrations/meta/_journal.json`
- `packages/shared/src/db/migrations/meta/0000_snapshot.json`
- `packages/shared/src/db/migrations/meta/0001_snapshot.json`
- `packages/shared/src/schemas/errors.ts`
- `packages/shared/src/schemas/sse.ts`
- `packages/shared/src/schemas/sse.test.ts`
- `packages/shared/src/schemas/index.ts`
- `packages/shared/src/config/index.ts`
- `packages/shared/src/config/index.test.ts`
- `packages/shared/src/types/events.ts`
- `packages/shared/src/types/events.test.ts`
- `drizzle.config.ts`

**Modified**
- `packages/shared/package.json` (deps + subpath `exports`)
- `packages/shared/src/index.ts` (root barrel re-exports)
- `package-lock.json` (new dependencies)

## Change Log

| Date | Change |
|---|---|
| 2026-07-03 | Implemented Story 1.2 — `packages/shared` domain kernel: Drizzle schema (8 tables + indexes + migrations), `loadConfig()` with `${ENV}` interpolation and Zod validation, SSE + error Zod contracts, Redis Streams event types + fixed stream constants, subpath `exports`. Verification gate green (lint/test/build). Status → review. |
