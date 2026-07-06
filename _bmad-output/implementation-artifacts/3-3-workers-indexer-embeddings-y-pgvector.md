---
baseline_commit: 40fb5e0
status: review
story_id: 3.3
epic: 3
---

# Story 3.3: Workers — Indexer (embeddings and pgvector)

Status: review

## Story

As a **community member**,
I want Discord messages to be transformed into semantic search vectors,
so that I can find relevant knowledge with natural-language queries.

This is the **fourth and final story of Epic 3** (Knowledge Indexing Pipeline), after 3.0 (provider config, `done`), 3.1 (Gateway + live ingestion, `done`) and 3.2 (backfill, `done`). It turns `packages/workers` from a placeholder into the first real Redis Streams **consumer**: it drains `hivly:discord:messages` (fed by 3.1/3.2), generates embeddings with the 3.0 provider factory, and upserts into pgvector. It closes FR5 and unblocks Epic 4 (search reads what this story writes).

**Baseline commit:** `40fb5e0` — Story 3.2 merged. The bot publishes `MessageCreatedEvent`s (live + backfill, idempotent producer); `packages/workers/src/main.ts` is a 29-line placeholder (loadConfig + keep-alive). **No consumer-group code (`xReadGroup`/`xGroupCreate`/`xAck`) exists anywhere in the repo yet.**

---

## ⚠️ Reconciliation notes — read before implementing

The epic AC (`epics.md` §Historia 3.3) and `TECHNICAL-DESIGN.md` §5.3/§7 leave four design gaps that this story resolves. Verified against the real source at baseline `40fb5e0`:

1. **"UPSERT into `embeddings`" has no conflict target today.** `embeddings.id` is a random-default UUID and the table has **no unique key** — a literal `onConflictDoNothing` can never fire and duplicates WOULD be created on redelivery. This story adds a deterministic **`chunk_key` text column + unique index** to the schema (`shared` scope, AD-5 — only shared does DDL): `chunk_key = "<firstMessageId>:<chunkIndex>"` (message snowflakes are globally unique, so the channel is implicit). Upsert = `onConflictDoUpdate({ target: embeddings.chunkKey, set: {...} })`. **[DECIDED with Borja, 2026-07-06]**
2. **Dimension mismatch is live and blocking: config says 4096, the deployed DB says 1536.** `Hivly.config.yml` has `embeddings.dimensions: 4096` (qwen3-embedding), but the committed migration `0001_tough_skrulls.sql` created `vector(1536)` + the HNSW index. First insert would fail. Worse: **pgvector 0.8 cannot build an HNSW/ivfflat index on `vector` columns wider than 2000 dims** (halfvec caps at 4000 — still < 4096), so "just migrate to 4096" silently loses the vector index. Recommended: set `embeddings.dimensions: 1536` — qwen3-embedding supports Matryoshka custom output dims and the factory already passes `dimensions` through; verify with `npx tsx --env-file=.env spike/embeddings-factory.ts` before generating the migration. **[DECIDED with Borja, 2026-07-06]: `dimensions: 1536`.** The spike verification is still the FIRST dev step (Task 1) — if the endpoint does not honor 1536, STOP and escalate back to Borja before generating any migration.
3. **`grouping_window` semantics are deferred to this story** (TECHNICAL-DESIGN §17: "Batching del Indexer — lógica exacta de grouping_window — el config fija los parámetros"). The config comment says `grouping_window: 10 # consecutive same-channel messages grouped before chunking` → it is a **message count**, not a time window. Resolved semantics: within one `XREADGROUP` batch, partition entries by `channelId` preserving stream order, and cap each group at `grouping_window` messages. Pure, deterministic function of the batch. **[DECIDED with Borja, 2026-07-06]**
4. **`chunk_size` is "tokens" but there is no tokenizer for qwen3-embedding.** Use `RecursiveCharacterTextSplitter` from `@langchain/textsplitters` (v1.0.1, peer-compatible with `@langchain/core` 1.2) with a `lengthFunction` of `Math.ceil(text.length / 4)` — the standard ~4-chars-per-token heuristic — so `chunk_size: 500` / `chunk_overlap: 50` keep their configured meaning approximately. Discord messages are short; most groups will produce exactly one chunk. **[DECIDED with Borja, 2026-07-06]**
5. **Read `content` from the event itself, and tolerate a missing `discord_messages` row without ACK.** Standing directive from the 3.1 review (`deferred-work.md` §3-1): the bot's XADD fires inside the tx callback *before* COMMIT, so an event can be durable in Redis a beat before (or, on a COMMIT failure, without) its row. The event carries `content` + `authorId` — never re-read content from the DB. If the row is missing at processing time, leave that entry **pending (no XACK)**; it will be retried and the row will have landed.
6. **The producer can emit duplicate events for one message.** Documented in `persistMessage.ts` (3.2's `persistWithRetry` amplifies a narrow COMMIT race to up to 3 duplicate events) with the explicit note *"revisit if Story 3.3's Indexer turns out not to dedupe by messageId in practice"* (`persistMessage.ts:25`). Dedup is therefore mandatory: before grouping, look up the batch's `messageId`s in `discord_messages`; rows with `indexed_at IS NOT NULL` → **XACK immediately and skip** (already indexed).
7. **node-redis (v6.1.0, the pinned client) specifics** — see Dev Notes for exact signatures: `xReadGroup` returns `null` on BLOCK timeout; `xGroupCreate` **rejects with BUSYGROUP when the group exists** (must be caught — that is the "create if not exists" of the AC); a blocking read stalls every command queued behind it on the same connection, and the worker's loop is strictly sequential (read → process → ack → read), so **one dedicated client is fine** — just don't share it with anything concurrent.
8. **Crash-restart replay:** a consumer re-reads *its own* PEL by calling `XREADGROUP` with an explicit id (`'0'`) instead of `'>'`. On boot, drain pending entries first (advancing the read id past each batch — re-reading `'0'` after a failed entry would loop forever), then switch to `'>'` for live reads. Entries that fail during replay stay in the PEL for the next restart. SPINE §Deferred assigns the retry-max/`MAXLEN`/DLQ policy decision **to this story** — the decision made here is: PEL-as-DLQ, no retry-max, no `MAXLEN` (the stream grows unbounded until a trimming policy arrives — acceptable at self-hosted scale, recorded in Task 10).

---

## Acceptance Criteria

### AC-1 — Boot, consumer group, and replay-then-live loop

**Given** the workers service starting with a valid `Hivly.config.yml`
**When** `main.ts` boots
**Then** it runs `loadConfig()` before any I/O (AD-8), connects Postgres + Redis, and **fail-fasts the Redis connect with a 10 s `Promise.race` → `exit(1)`** (node-redis `reconnectStrategy` never rejects — same pattern as `packages/bot/src/main.ts`)
**And** it creates the consumer group idempotently: `xGroupCreate(STREAM_KEYS.DISCORD_MESSAGES, CONSUMER_GROUPS.INDEXER, '0', { MKSTREAM: true })`, treating a BUSYGROUP rejection as success
**And** it first drains its own PEL (`xReadGroup` with explicit id, starting at `'0'`, advancing past each batch) and then reads live with `xReadGroup(CONSUMER_GROUPS.INDEXER, 'consumer-1', { key: STREAM_KEYS.DISCORD_MESSAGES, id: '>' }, { COUNT: 10, BLOCK: 5000 })`, looping on `null` (BLOCK timeout)
**And** `uncaughtException`/`unhandledRejection` handlers log and `exit(1)` (Epic 2 retro hardening commitment for 3.3).

### AC-2 — Grouping, chunking, and embedding

**Given** a batch of entries read from the stream
**When** the Indexer processes it
**Then** it parses each entry's flat string field map, accepting only `type === 'discord.message.created'` with non-empty `messageId`/`channelId`/`content` (malformed or foreign-typed entries → `warn` + XACK — they can never succeed and must not clog the PEL)
**And** it resolves dedup state with **one query** over the batch's ids: rows with `indexed_at IS NOT NULL` → XACK + skip; ids with **no row** → leave pending (no XACK, reconciliation note 5); the rest proceed
**And** it partitions the remaining entries by `channelId` (stream order preserved) into groups of at most `knowledge.grouping_window` messages, concatenates each group's `content`s with `'\n'`, and splits with `RecursiveCharacterTextSplitter` (`chunkSize: knowledge.chunk_size`, `chunkOverlap: knowledge.chunk_overlap`, approx-token `lengthFunction`)
**And** it embeds each group's chunks with **one** `embedDocuments(chunks)` call on the model from `createEmbeddingsModel(config.embeddings)`.

### AC-3 — Dimension guard (protects AD-13 and the fixed vector column)

**Given** vectors returned by the provider
**When** any vector fails `assertEmbeddingDimensions(vector, config.embeddings.dimensions)` (exported by `@hivly/shared/providers`; its docstring names this exact story)
**Then** the group is **not persisted**, its entries are **not XACKed** (they stay pending for redelivery), one `error` is logged with `{ channelId, expected, actual }`, and the loop continues with the next group.

### AC-4 — Idempotent persistence (UPSERT, never plain INSERT)

**Given** the embedded chunks of a group
**When** they are stored
**Then** one Drizzle transaction per group: upsert every chunk into `embeddings` with `onConflictDoUpdate({ target: embeddings.chunkKey, set: { content, embedding, channelId, messageIds } })` where `chunkKey = "<group.messageIds[0]>:<chunkIndex>"`
**And** in the same tx, `UPDATE discord_messages SET indexed_at = now() WHERE id IN (group ids) RETURNING id`
**And** only entries whose id came back from the RETURNING are XACKed after the tx commits — a message whose row is still missing stays pending.

### AC-5 — ACK discipline and at-least-once idempotency (AD-13)

**Given** successful processing of an entry
**Then** `xAck(STREAM_KEYS.DISCORD_MESSAGES, CONSUMER_GROUPS.INDEXER, entryId)` runs **after** the tx commit — never before
**And Given** any failure (embedding call, dimension guard, DB error), the affected entries are NOT acked, the error is logged, and the consumer keeps processing subsequent groups/batches — a poison entry never crashes the process
**And Given** the same message delivered twice (redelivery or producer duplicate), the second pass either skips it via the `indexed_at` dedup check or lands on the same `chunk_key`s — `SELECT count(*)` on `embeddings` is unchanged, no error raised.

### AC-6 — Graceful shutdown

**Given** SIGTERM/SIGINT
**When** the worker is mid-loop (possibly parked in a BLOCK 5000 read)
**Then** an abort flag stops the loop at the next iteration boundary (≤ ~5 s), the in-flight batch finishes or is abandoned **without acking unfinished entries**, and teardown is bounded and `.catch`-neutralized like the bot's: `redis.quit()` raced at 5 s, `db.$client.end()` at 10 s, then `exit(0)`.

### AC-7 — Green verification gate

- `npm run lint` — 0 errors/warnings.
- `npm run test` — all green, incl. new unit tests (parsing, dedup partition, grouping, chunking, guard-fail → no-ack, consumer loop with fake redis) — see Task 9.
- `npm run test:integration` — new `workers-integration` project against **real** Postgres + Redis (fake embeddings model, deterministic vectors — never a real API in tests): end-to-end batch → `embeddings` rows + `indexed_at` stamped + PEL drained; redelivery → no duplicates; failing embedder → entry stays pending un-acked; BUSYGROUP tolerated on second boot.
- `npm run build` — all 5 workspaces clean.
- **Manual smoke** (real embeddings endpoint): docker bot+workers containers stopped; run bot and workers locally (they share the Homebrew Redis on `localhost:6379` and the compose Postgres on `127.0.0.1:5432` — see Env gotcha in Dev Notes); post a message in `general` (`1498305410942369908`) → within seconds a row lands in `embeddings` (correct dims, `chunk_key`, `channel_id`), `discord_messages.indexed_at` is stamped, `XPENDING hivly:discord:messages hivly:indexer` shows 0; restart the worker → nothing re-indexed (dedup); stop the endpoint (or break the key) → entry stays pending, worker keeps running, restore → replay drains it.

---

## Tasks / Subtasks

- [x] **Task 0 — Open Questions #1–#4 RESOLVED with Borja (2026-07-06)**: dimensions → **1536**; `chunk_key` unique column + `onConflictDoUpdate` → **yes**; grouping → **per-batch by-channel partition capped at `grouping_window`**; chunking → **approx-token `ceil(chars/4)`**. Remaining gate: Task 1's spike run must confirm the endpoint honors `dimensions: 1536` — on failure, stop and escalate.
- [x] **Task 1 — Schema: `chunk_key` + migration** (AC: 4) — `shared` scope
  - [x] **First**: run `npx tsx --env-file=.env spike/embeddings-factory.ts` with `Hivly.config.yml` set to `dimensions: 1536` — confirm the endpoint returns real 1536-dim vectors (MRL). If not, STOP and escalate to Borja. → ✅ VALIDATED: vector length 1536, L2 norm 1.0, non-zero components (endpoint honors MRL).
  - [x] `packages/shared/src/db/schema.ts`: add `chunkKey: text('chunk_key').notNull()` to `embeddings` + `uniqueIndex('idx_embeddings_chunk_key').on(table.chunkKey)`. Table is empty in every deployment — `notNull` without default is safe.
  - [x] Applied `dimensions: 1536` to the (gitignored) real `Hivly.config.yml` before `npx drizzle-kit generate`. `.example` already said 1536 — unchanged. Generated `0002_lush_fabian_cortez.sql` reviewed by hand: adds only the column + unique index (vector stays 1536, HNSW untouched).
  - [x] OQ#1 landed on 1536 (≤2000) → HNSW index kept; no drop needed.
  - [x] **Applied the migration** via `DATABASE_URL=… npx drizzle-kit migrate` against the local compose Postgres; verified `\d embeddings` shows `chunk_key text NOT NULL` + `idx_embeddings_chunk_key UNIQUE` + intact `vector(1536)` HNSW index. (Also re-exported `inArray` from `packages/shared/src/db/index.ts` for Task 6.)
- [x] **Task 2 — Workers package scaffolding** (AC: 7)
  - [x] `packages/workers/package.json`: added `@langchain/textsplitters@^1.0.1` + `redis@^6.1.0` (mirror bot's direct-redis dep for type resolution) and ran root `npm install` (lockfile updated; textsplitters@1.0.1 present). No per-package test scripts.
  - [x] `packages/workers/vitest.config.ts`: `workers-integration` project (include `src/**/*.integration.test.ts`, timeouts 15 000).
  - [x] Root `vitest.config.ts`: added `./packages/workers/vitest.config.ts`. Root `package.json`: added `--project workers-integration` to `test:integration`.
  - [x] `packages/workers/src/logger.ts`: bot's `createLogger` shape with `[workers]` prefix.
  - [x] `packages/workers/src/test-helpers.ts`: mirrors `packages/bot/src/test-helpers.ts` — imports only `@hivly/shared`.
- [x] **Task 3 — Event parsing (pure)** (AC: 2)
  - [x] `packages/workers/src/indexer/events.ts`: `parseCreatedEvent` validates type + non-empty `messageId`/`channelId`/`content` (content carried un-trimmed; the chunker owns trimming). No Zod.
- [x] **Task 4 — Dedup partition + grouping (pure, tests-first)** (AC: 2)
  - [x] `packages/workers/src/indexer/grouping.ts`: `partitionByIndexState` → `{ ackNow, pending, toProcess }`; `groupByChannel` → ordered per-channel groups capped at `grouping_window` (window coerced ≥1). Shared shapes in `indexer/types.ts`.
- [x] **Task 5 — Chunking (pure, tests-first)** (AC: 2)
  - [x] `packages/workers/src/indexer/chunking.ts`: `RecursiveCharacterTextSplitter` with approx-token `lengthFunction` (`ceil(len/4)`); joins contents with `'\n'`; `[]` for empty input, ≥1 chunk otherwise.
- [x] **Task 6 — Batch orchestrator** (AC: 2–5)
  - [x] `packages/workers/src/indexer/indexBatch.ts`: parse (malformed→ack) → one dedup SELECT → partition → group → per group chunk → `embedDocuments` → `assertEmbeddingDimensions` guard → one tx (upsert by `chunk_key` + stamp `indexed_at … RETURNING id`) → ack only RETURNING-confirmed ids + the ackNow set. Per-group try/catch isolates failures.
- [x] **Task 7 — Consumer loop** (AC: 1, 5, 6)
  - [x] `packages/workers/src/indexer/consumer.ts`: `runIndexer(...)` — BUSYGROUP-tolerant group create, PEL replay from `'0'` (advance past each batch, stop on empty), live `'>'` loop `COUNT 10 BLOCK 5000` (`null`→continue), `xAck` per returned id, `signal.aborted` checked at every loop top. Injectable deps; `redis` typed as `RedisClient` (fakes cast `as unknown as RedisClient`, matching bot test convention).
- [x] **Task 8 — `main.ts` rewrite** (AC: 1, 6)
  - [x] Full rewrite mirroring `packages/bot/src/main.ts`: `loadConfig` → `createLogger` → `requireEnv` (local copy) → `createDatabase`/`createRedisClient` + 10 s fail-fast connect race → `createEmbeddingsModel` → uncaught handlers → SIGTERM/SIGINT bounded shutdown (abort → await loop bounded 7 s → `redis.quit()` 5 s → `db.$client.end()` 10 s, `.catch`-neutralized) → `await runIndexer(...)`. Signal handlers registered **before** the loop.
- [x] **Task 9 — Tests** (AC: 7) — tests-first for the pipeline core
  - [x] Unit (38 tests across events/grouping/chunking/indexBatch/consumer): parsing valid/malformed/foreign/whitespace; partition indexed→ack / missing→pending / fresh→process; grouping order+window+overflow; chunking single/long/approx-token; indexBatch guard-throw→no-ack / embed-throw isolation / RETURNING-miss / ackNow / malformed→ack; consumer BUSYGROUP tolerated / replay advances+stops / null loops / ack-only-returned / abort exits.
  - [x] Integration (real PG + Redis, fake embedder): event-content embedded (not DB content) + dims/channel/message_ids + `indexed_at` stamped + PEL drained; redelivery (dedup) and forced `chunk_key` UPSERT → count unchanged; failing embedder → `XPENDING=1` + no row + `indexed_at` null; duplicate `xGroupCreate` → BUSYGROUP.
- [x] **Task 10 — Docs + deferred-work touch** (AC: 7)
  - [x] Stream tables in SPINE / TECHNICAL-DESIGN / backend-standards: `hivly:indexer` consumer marked active/live since 3.3. SPINE §Deferred: retry/DLQ + Indexer-batching items marked **resolved in Story 3.3**.
  - [x] `deferred-work.md`: 3-1 "Indexer reads content / tolerates row-not-found" note struck through as resolved; new §"Decisions & deferrals from Story 3.3" records PEL-as-DLQ (no retry-max, no `MAXLEN`), stream-trimming still deferred, and the accepted stale-chunk crash-window corner.
- [x] **Task 11 — Verification gate** (AC: 7)
  - [x] `npm run lint` 0 · `npm run test` 203 (30 files) · `npm run build` clean (5 workspaces) · `npm run test:integration` 22 (6 files). Manual smoke on the REAL embeddings endpoint: seeded #general event → 1536-dim embeddings row + `chunk_key`/`channel_id`/`message_ids` + `indexed_at` stamped + `XPENDING hivly:indexer`=0; re-XADD same id → count stays 1 (dedup, no re-embed). Branch `feat/3-3-workers-indexer-pgvector`; PR next; hand off to `bmad-code-review`.

---

## Dev Notes

### Source tree to create/touch

```
packages/shared/src/db/schema.ts               # UPDATE — chunk_key column + unique index on embeddings
packages/shared/src/db/migrations/0002_*.sql   # NEW — generated (chunk_key; dimensions per OQ#1)
Hivly.config.yml / Hivly.config.yml.example    # UPDATE only if OQ#1 changes dimensions
packages/workers/package.json                  # UPDATE — @langchain/textsplitters, test scripts
packages/workers/vitest.config.ts              # NEW — workers-integration project
packages/workers/src/
├── main.ts                                    # UPDATE — full rewrite of the placeholder
├── logger.ts                                  # NEW — [workers] logger (mirror bot)
├── test-helpers.ts                            # NEW — real PG+Redis test clients (mirror bot)
└── indexer/                                   # NEW
    ├── events.ts                              # parse flat stream fields → MessageCreatedEvent
    ├── grouping.ts                            # pure: dedup partition + by-channel grouping
    ├── chunking.ts                            # pure: splitter wrapper (approx-token length)
    ├── indexBatch.ts                          # orchestrator: partition → embed → tx upsert+stamp → ack ids
    └── consumer.ts                            # group create, PEL replay, live XREADGROUP loop
packages/workers/src/**/*.test.ts              # NEW — co-located unit tests
packages/workers/src/**/*.integration.test.ts  # NEW — real PG + Redis
vitest.config.ts                               # UPDATE — register workers project
package.json (root)                            # UPDATE — test:integration += workers-integration
```

*No changes* to `docker-compose.yml` (the workers service, env vars `DATABASE_URL`/`REDIS_URL`/`EMBEDDINGS_*`, config mount and `depends_on: migrator` already exist), to `packages/bot|backend|web`, or to `types/events.ts` (`MessageCreatedEvent`, `STREAM_KEYS`, `CONSUMER_GROUPS` already exist — **import them, never hardcode strings**, AD-13).

### Current state of the files being modified (baseline `40fb5e0`)

- **`packages/workers/src/main.ts`** (29 lines) — placeholder: `loadConfig()`, `console.log`, SIGTERM/SIGINT → `exit(0)`, `setInterval` keep-alive. Everything is replaced; keep only the try/catch-around-main + `[workers] fatal:` convention.
- **`packages/shared/src/db/schema.ts`** — `embeddings` at lines 56–70: `id` uuid random PK, `content`, `embedding vector(EMBEDDING_DIMENSIONS)`, `channelId` (AD-12 filter), `messageIds text[]`, `createdAt`, HNSW cosine index + channel btree. `EMBEDDING_DIMENSIONS = readEmbeddingDimensions()` at module load (generate-time YAML reader, default 1536, no Zod). `discord_messages.indexedAt` (line 47) is nullable, commented "set by the Indexer" — this story is that Indexer.
- **Root `vitest.config.ts`** — Vitest 4 `test.projects`: `unit` glob + web + backend + bot configs. Add the workers config entry beside bot's.
- **`packages/workers/package.json`** — scripts `dev/start/typecheck/build` only; sole dep `@hivly/shared`. `Dockerfile` copies manifests + `npm ci` → a new dep flows into the image without Dockerfile changes.

### Reference: consumer loop skeleton (node-redis v6 — exact shapes)

```ts
import { STREAM_KEYS, CONSUMER_GROUPS } from '@hivly/shared/types/events';

const CONSUMER = 'consumer-1'; // per epic AC; single-consumer group
const COUNT = 10;
const BLOCK_MS = 5000;

// Idempotent group creation — BUSYGROUP rejection means "already exists".
try {
  await redis.xGroupCreate(STREAM_KEYS.DISCORD_MESSAGES, CONSUMER_GROUPS.INDEXER, '0', { MKSTREAM: true });
} catch (err) {
  if (!(err instanceof Error) || !err.message.startsWith('BUSYGROUP')) throw err;
}

// PEL replay (crash recovery): explicit id returns OUR pending entries > id.
// Advance past each batch — re-reading '0' after a failure would spin forever.
let replayId = '0';
for (;;) {
  if (signal.aborted) return;
  const res = await redis.xReadGroup(CONSUMER_GROUPS.INDEXER, CONSUMER,
    { key: STREAM_KEYS.DISCORD_MESSAGES, id: replayId }, { COUNT });
  const msgs = res?.[0]?.messages ?? [];          // Array<{ id, message: Record<string,string> }>
  if (msgs.length === 0) break;
  const { ackIds } = await indexBatch({ entries: msgs, ... });
  for (const id of ackIds) await redis.xAck(STREAM_KEYS.DISCORD_MESSAGES, CONSUMER_GROUPS.INDEXER, id);
  replayId = msgs[msgs.length - 1].id;            // move past this batch, acked or not
}

// Live loop. xReadGroup returns null on BLOCK timeout — just loop.
while (!signal.aborted) {
  const res = await redis.xReadGroup(CONSUMER_GROUPS.INDEXER, CONSUMER,
    { key: STREAM_KEYS.DISCORD_MESSAGES, id: '>' }, { COUNT, BLOCK: BLOCK_MS });
  if (!res) continue;
  /* …same indexBatch + xAck as above… */
}
```

- `xAck` returns the number of ids actually removed from the PEL (0 = already acked — harmless).
- One dedicated Redis client for the worker is enough: the loop is strictly sequential, so nothing queues behind the blocking read. Do not share this client with concurrent callers.
- node-redis v6 has a 5 s default command timeout that applies only to commands **not yet written** to the socket — an in-flight `BLOCK 5000` is safe. Keep `BLOCK` at 5000 per the AC; don't be tempted by `BLOCK 0`.

### Reference: idempotent persist (Task 6) — exact shape

```ts
// One tx per group. chunkKey makes redelivery converge instead of duplicate.
const ackable = await db.transaction(async (tx) => {
  for (const [i, chunk] of chunks.entries()) {
    await tx.insert(embeddings).values({
      chunkKey: `${group.messageIds[0]}:${i}`,
      content: chunk.text,
      embedding: chunk.vector,                   // number[] — drizzle vector accepts it directly
      channelId: group.channelId,
      messageIds: group.messageIds,
    }).onConflictDoUpdate({
      target: embeddings.chunkKey,
      set: {
        content: sql`excluded.content`,
        embedding: sql`excluded.embedding`,
        channelId: sql`excluded.channel_id`,
        messageIds: sql`excluded.message_ids`,
      },
    });
  }
  const stamped = await tx.update(discordMessages)
    .set({ indexedAt: sql`now()` })
    .where(inArray(discordMessages.id, group.messageIds))
    .returning({ id: discordMessages.id });
  return new Set(stamped.map((r) => r.id));      // only these ids may be acked
});
```

- `sql` is already re-exported by `@hivly/shared/db`; **re-export `inArray` from `packages/shared/src/db/index.ts` too** (one line, same pattern as the existing `arrayOverlaps` re-export) — workers must not depend on `drizzle-orm` directly (AD-2 spirit; mirror how the bot consumes `sql`).
- Guard `messageIds.length > 0` before `inArray` (it throws on empty arrays).
- Why RETURNING-gated acks: a row that hasn't COMMITted on the bot side yet (XADD-before-COMMIT race) simply isn't stamped; its entry stays pending and the next delivery attempt finds the row. Entries acked ⊆ entries stamped — that IS the AD-13 "XACK only after success" invariant, made concrete.
- Redelivery corner: if a crash lands between the tx and the acks, the replay re-processes the same PEL entries; grouping is deterministic on that input, so chunks land on the same `chunk_key`s (conflict-update, no dupes). If a *later, different* batch composition regroups an unstamped message, its chunks key off a different first-id — the `indexed_at` dedup check is what prevents that from ever happening to already-stamped messages, and unstamped ones are by definition not yet indexed. A stale extra chunk is only reachable through a crash inside this narrow window and is overwritten/ignored at query time by similarity — accepted, do not build compensation for it.

### Guardrails (ARCHITECTURE-SPINE AD-*)

- **AD-1/AD-2** — all service code in `packages/workers`; imports only `@hivly/shared/*` subpaths (`/db`, `/redis`, `/providers`, `/types/events`, root for `loadConfig`). `@hivly/shared/providers` is deliberately NOT in the root barrel (it pulls LangChain) — use the subpath.
- **AD-5** — the `chunk_key` DDL lives in `packages/shared/src/db/schema.ts` + generated migration. Workers define no tables.
- **AD-8** — `loadConfig()` first in `main.ts`; invalid YAML aborts before any connection.
- **AD-13** — stream key + group via `STREAM_KEYS`/`CONSUMER_GROUPS` constants; `XACK` only after commit; no-ack on failure; UPSERT for at-least-once. This story is the invariant's first consumer-side implementation — the reference for Epic 6's Sync worker.
- **Write ownership** — workers own `embeddings` (all columns) and exactly one column of `discord_messages`: `indexed_at`. Never touch `content`/`deleted_at`/anything else (sanctioned in data-model.md + schema comment).
- **Sync is Epic 6** — do not consume `hivly:discord:messages:updated/deleted`, do not create `hivly:sync`, do not add a `sync/` folder. `/health`'s `indexer: "pending"` component also stays as-is (backend wiring is a later story).
- **Logging** — never log message `content` or API keys; log `contentLength`, counts, ids.

### Env gotcha (from 3.2's smoke — documented for this story's smoke)

`localhost:6379` on this Mac is a **Homebrew** Redis; the compose Redis publishes **no host ports**. Locally-run services and the integration tests (test-helpers default `redis://127.0.0.1:6379`) use the Homebrew instance, while dockerized services use the compose one — **they are different stream universes**. For the AC-7 smoke, stop the docker `bot` and `workers` containers and run both locally so they share the Homebrew Redis; Postgres is shared either way (compose publishes `127.0.0.1:5432`).

### Testing standards

Vitest, co-located `*.test.ts`, AAA, names `should <behavior> when <condition>`. **Tests-first for the pipeline core** — `backend-standards.md` names "the Indexer pipeline" explicitly (grouping, chunking, partition logic red → green). Adapter glue (consumer loop wiring, main.ts) may test after. Unit tests mock db/redis/embedder — never a real connection; integration hits real PG + Redis via the new workers `test-helpers.ts` (mirror bot's) and a **fake embedder** (deterministic `number[]` of the configured dims — a real embeddings API is never called in any test). Always cover the two Hivly-mandated cases: **idempotency** (re-delivered event → no duplicate `embeddings` rows) and **failure leaves the entry un-ACKed** (visible via `XPENDING`). Epic 2 retro action item: integration tests against real Redis Streams (consumer group, XREADGROUP, XACK-after-success) + real pgvector are part of this story's DoD.

### Project Structure Notes

- `indexer/` folder beside a future `sync/` (Epic 6) matches the architecture tree (`packages/workers/src/{main.ts,indexer/,sync/}`) and the bot's light adapter-grouping style. Pure logic (`grouping.ts`, `chunking.ts`, `events.ts`) split from orchestration (`indexBatch.ts`, `consumer.ts`) for testability — the same `computeDelay`-vs-`connectWithRetry` split 3.1/3.2 used.
- The schema/`inArray` re-export changes are scoped `shared` in their own commit (`feat(shared): …`) per project-context ("a change to the schema … is scoped shared even if a consumer motivated it").

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Historia 3.3] — epic ACs (expanded above); FR5; AR8/AR13.
- [Source: docs/context/TECHNICAL-DESIGN.md §5.3, §7 (pipeline sequence), §8 (streams table), §17 (grouping_window deferred-to-story)] — pipeline stages, `COUNT 10 BLOCK 5000`, PEL-as-DLQ.
- [Source: docs/context/ARCHITECTURE-SPINE.md AD-1/2/5/8/13 + §Deferred] — retry-max/MAXLEN/DLQ policy deliberately open.
- [Source: packages/shared/src/types/events.ts] — `MessageCreatedEvent`, `STREAM_KEYS.DISCORD_MESSAGES`, `CONSUMER_GROUPS.INDEXER`.
- [Source: packages/shared/src/providers/index.ts#assertEmbeddingDimensions] — the guard whose docstring names this story; `createEmbeddingsModel` (`encodingFormat: 'float'` is load-bearing — see Previous Story Intelligence).
- [Source: packages/shared/src/db/schema.ts#embeddings, #discordMessages] — current columns; `indexed_at` comment.
- [Source: packages/shared/src/db/migrations/0001_tough_skrulls.sql] — deployed `vector(1536)` + HNSW (the OQ#1 mismatch).
- [Source: packages/bot/src/main.ts] — boot/hardening/bounded-shutdown pattern to mirror; 10 s Redis fail-fast race rationale.
- [Source: packages/bot/src/test-helpers.ts + packages/bot/vitest.config.ts] — integration-project pattern to mirror.
- [Source: _bmad-output/implementation-artifacts/deferred-work.md §3-1] — "Indexer reads content from the event / tolerates row-not-found without ACK" (resolved here).
- Web (verified 2026-07-06): node-redis v6.1.0 `xReadGroup` returns `Array<{name, messages:[{id, message: Record<string,string>}]}> | null` (null on BLOCK timeout); `xGroupCreate` rejects BUSYGROUP; explicit-id reads replay own PEL (BLOCK/NOACK ignored when id ≠ `'>'`); blocking reads stall the shared connection ([node-redis commands source](https://github.com/redis/node-redis/tree/master/packages/client/lib/commands), [redis.io XREADGROUP](https://redis.io/docs/latest/commands/xreadgroup/)). `@langchain/textsplitters@1.0.1` peer `@langchain/core ^1.0.0`; `lengthFunction` supports custom (async) counters. Drizzle 0.45 `onConflictDoUpdate({ target, set })` with `sql`excluded.<col>``; `vector` columns accept `number[]`; `inArray` throws on `[]`. pgvector 0.8: HNSW/ivfflat index max **2000 dims** on `vector` (halfvec 4000).

---

## Previous Story Intelligence

**Stories 3.0–3.2 (all done, 2026-07-06) built everything this story consumes:**

- **3.0 (providers):** `createEmbeddingsModel` exists and is battle-tested against Borja's real endpoint (LiteLLM proxy, qwen3-embedding, provider `custom`). **Scar:** the OpenAI SDK silently requests base64 encoding that LiteLLM ignores, producing corrupt all-zero 1024-dim vectors — fixed by `encodingFormat: 'float'` in the factory. Do not re-wrap or reconfigure the factory; `assertEmbeddingDimensions` caught that exact corruption, which is why AC-3 is non-negotiable. Manual verification path: `npx tsx --env-file=.env spike/embeddings-factory.ts` (note: `spike/embeddings.ts` is STALE — don't use it).
- **3.1/3.2 (producer):** `persistMessage` is idempotent but can still emit **duplicate events** (documented COMMIT-after-XADD race, amplified ≤3 by retry) and events can precede their row — both explicitly deferred to *this* story's dedup + no-ack-on-missing-row (reconciliation notes 5–6). The producer always publishes all-string flat fields with `timestamp = createdAt.toISOString()`.
- **Review scars to inherit (4 passes on 3.2):** every shutdown await bounded by `Promise.race` + `.catch`-neutralized; signal-abort checked at *every* loop top (inner loops too — two separate 3.2 patches existed because it wasn't); register SIGTERM/SIGINT handlers **early**, before long-running boot work (3.2 deferred finding — don't repeat it); malformed input (empty/whitespace ids or content) validated explicitly (`BigInt('')` class of bug); counts/logs must distinguish "processed" from "aborted mid-run"; distinguishable error messages per failure mode.
- **Patterns to reuse, not reinvent:** bot's `main.ts` boot/hardening/shutdown skeleton, `createLogger` shape, injectable-deps + fake-driven unit tests, `test-helpers.ts` + per-service integration vitest project, all-string `Record<keyof T, string>` stream payload typing.
- **Config:** `knowledge.{chunk_size: 500, chunk_overlap: 50, grouping_window: 10}` and the full `embeddings` block already exist and are validated — **this story adds zero config keys and zero env vars.**

---

## Definition of Done

1. All 7 ACs green, including the full-pipeline smoke with the real embeddings endpoint (AC-7).
2. Unit + integration coverage per Task 9 — including the two mandated cases: idempotent redelivery (no duplicate `embeddings` rows) and failure-leaves-entry-pending (`XPENDING` visible).
3. `npm run lint && npm run test && npm run build` + `npm run test:integration` all green — output pasted in the Dev Agent Record (never mark an AC done without evidence).
4. Schema change confined to `packages/shared` (AD-5); no cross-service imports (AD-2); stream constants imported (AD-13); no secrets/content in logs; English-only code and commits; commits split `shared` vs `workers` scope.
5. Docs stream tables updated (consumer live); `deferred-work.md` 3-1 Indexer note marked resolved; retry-max/MAXLEN/DLQ recorded as still deferred.
6. Branch `feat/3-3-workers-indexer-pgvector`, PR opened (what/why), hand off to `bmad-code-review`.

---

## Open Questions — ALL RESOLVED (Borja, 2026-07-06)

1. **Embedding dimensions — the migration blocker.** — ✅ **RESOLVED: `embeddings.dimensions: 1536`.** Config said `4096` but the deployed DB column is `vector(1536)` with an HNSW index, and **pgvector cannot index >2000 dims** (halfvec caps at 4000 < 4096). qwen3-embedding supports Matryoshka custom output dims and the factory already passes `dimensions`. Gate: Task 1 verifies with the 3.0 spike script against the real endpoint **before** generating the migration; if the endpoint does not honor 1536, stop and escalate.
2. **Idempotency via `chunk_key` unique column** (`"<firstMessageId>:<chunkIndex>"`, `onConflictDoUpdate`) — ✅ **RESOLVED: yes.** A `shared` schema change + migration; the only way "UPSERT no crea duplicados" (epic AC) is actually implementable, and Epic 6's Sync re-index will reuse it.
3. **`grouping_window` semantics** — ✅ **RESOLVED: per-batch by-channel partition** (stream order preserved), groups capped at `grouping_window` messages. A literal "strictly consecutive in the interleaved stream" reading would almost never group in a multi-channel guild.
4. **Chunk size unit** — ✅ **RESOLVED: approx-token `lengthFunction`** (`ceil(chars/4)`) on `RecursiveCharacterTextSplitter`, keeping `chunk_size: 500` ≈ 500 tokens. No tiktoken vocab exists for qwen3-embedding.

---

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (bmad-dev-story, 2026-07-06)

### Debug Log References

- **Task 1 spike gate** — `npx tsx --env-file=.env spike/embeddings-factory.ts` with `dimensions: 1536`: `vector length = 1536`, L2 norm 1.0, non-zero components → endpoint honors MRL. Gate passed; migration generated with 1536 (no HNSW drop needed).
- **Migration 0002** — `drizzle-kit generate` emitted only `ADD COLUMN chunk_key` + `CREATE UNIQUE INDEX idx_embeddings_chunk_key`; applied via `drizzle-kit migrate`; `\d embeddings` confirmed column + unique index + intact `vector(1536)` HNSW.
- **Verification gate** — lint 0 · unit 203/203 · build 5/5 clean · integration 22/22.
- **Manual smoke (real endpoint)** — seeded #general event → embeddings row `dims=1536`, `chunk_key=<id>:0`, `indexed_at` stamped, `XPENDING hivly:indexer`=0; redelivery of same id → count unchanged (dedup), content not re-embedded.

### Completion Notes List

- Schema change (`chunk_key` + unique index) + `inArray` re-export committed in a separate `shared`-scoped commit (AD-5); workers never import `drizzle-orm` directly.
- Pipeline split into pure stages (`events`/`grouping`/`chunking`, deterministic on redelivery) and I/O orchestration (`indexBatch`/`consumer`), mirroring the bot's `computeDelay` vs `connectWithRetry` split.
- AD-13 made concrete: ids are XACKed only from the stamp `RETURNING` set (∪ already-indexed ∪ malformed); a missing row stays pending, a failing embed/guard/DB error leaves the group pending, malformed/foreign entries are ACKed so they don't clog the PEL.
- Content is read from the stream event, never re-read from the DB row (reconciliation note 5) — proven in the integration test (seeded DB content marker never surfaces in `embeddings.content`).
- Retry/DLQ decision recorded (PEL-as-DLQ, no retry-max, no `MAXLEN`); stream trimming remains deferred. `dimensions` in the gitignored real `Hivly.config.yml` set to 1536 (the committed `.example` already said 1536).

### File List

**shared (schema commit):**
- `packages/shared/src/db/schema.ts` (M — `chunk_key` column + `idx_embeddings_chunk_key` unique index)
- `packages/shared/src/db/index.ts` (M — re-export `inArray`)
- `packages/shared/src/db/migrations/0002_lush_fabian_cortez.sql` (A)
- `packages/shared/src/db/migrations/meta/0002_snapshot.json` (A), `.../meta/_journal.json` (M)

**workers:**
- `packages/workers/package.json` (M — `@langchain/textsplitters`, `redis` deps)
- `packages/workers/vitest.config.ts` (A)
- `packages/workers/src/main.ts` (M — full rewrite)
- `packages/workers/src/logger.ts` (A)
- `packages/workers/src/test-helpers.ts` (A)
- `packages/workers/src/indexer/events.ts` (A), `grouping.ts` (A), `chunking.ts` (A), `indexBatch.ts` (A), `consumer.ts` (A), `types.ts` (A)
- `packages/workers/src/indexer/events.test.ts` (A), `grouping.test.ts` (A), `chunking.test.ts` (A), `indexBatch.test.ts` (A), `consumer.test.ts` (A), `indexBatch.integration.test.ts` (A)

**root / docs:**
- `vitest.config.ts` (M — register workers project), `package.json` (M — `test:integration` += workers)
- `docs/context/ARCHITECTURE-SPINE.md` (M), `docs/context/TECHNICAL-DESIGN.md` (M), `docs/backend-standards.md` (M)
- `_bmad-output/implementation-artifacts/deferred-work.md` (M)

## Change Log

| Date | Change |
|---|---|
| 2026-07-06 | Story created (bmad-create-story): comprehensive context from epics.md §3.3, TECHNICAL-DESIGN §5.3/§7/§17, baseline code at `40fb5e0` (placeholder main.ts, schema, providers, events, bot patterns), 3.0–3.2 learnings + deferred-work directives, and web-verified node-redis v6 / textsplitters / drizzle-upsert / pgvector-index-limit facts. 4 open questions (dimensions, chunk_key, grouping semantics, token heuristic) flagged for Borja. Status → ready-for-dev. |
| 2026-07-06 | All 4 open questions resolved with Borja: `dimensions: 1536` (MRL, spike-gated in Task 1), `chunk_key` unique column + `onConflictDoUpdate`, per-batch by-channel grouping capped at `grouping_window`, approx-token chunking (`ceil(chars/4)`). Story fully unblocked for dev. |
| 2026-07-06 | Implemented (bmad-dev-story): schema `chunk_key` + migration 0002 (spike-confirmed 1536); workers Indexer (`events`/`grouping`/`chunking`/`indexBatch`/`consumer`/`main` rewrite) + logger/test-helpers/vitest project; 38 unit + 4 integration tests; docs stream tables + SPINE deferred items + deferred-work updated. Gate green (lint 0 / 203 unit / build 5 clean / 22 integration) + real-endpoint smoke passed. Status → review. |
