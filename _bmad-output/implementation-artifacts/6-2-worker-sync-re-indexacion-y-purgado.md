---
baseline_commit: 39c62bb
status: done
story_id: 6.2
epic: 6
---

# Story 6.2: Worker Sync — Re-index & Purge

Status: done

## Story

As the **system**,
I want the Sync worker to consume `discord.message.updated` and `discord.message.deleted` events idempotently,
so that the pgvector index stays consistent with Discord — edited messages are re-embedded, and deleted messages are purged (soft or hard) — with no duplicates and no data corruption.

This is the **second story of Epic 6** (Synchronization, Notifications & Reliability). It **consumes the two streams Story 6.1 produces** (`share2brain:discord:messages:updated`, `share2brain:discord:messages:deleted`) and closes the write side of the edit/delete loop. It is the **second consumer** to live in the `@share2brain/workers` process (alongside the Story 3.3 Indexer), using its own consumer group `share2brain:sync`. It **unblocks Story 6.3** (offline reconciliation republishes the very same two events into these streams).

**Baseline commit:** `39c62bb` — Story 6.1 merged (PR #35). The bot publishes edit/delete events to Redis Streams; the Indexer (Story 3.3) drains `share2brain:discord:messages` and owns the `embeddings` UPSERT + `discord_messages.indexed_at` stamp. Nothing yet consumes the updated/deleted streams — the PEL is filling.

---

## ⚠️ Reconciliation notes — read before implementing

This story's epic AC and the `TECHNICAL-DESIGN.md §5.3` pseudocode were written **before** the grouped/chunked embedding schema landed in Story 3.3. Several of their literal statements do **not** match the real code. The notes below reconcile them against source verified at baseline `39c62bb`. **Read all of them — the whole story turns on note #1 and #2.**

1. **There is NO `message_id` column on `embeddings`. The pseudocode `DELETE FROM embeddings WHERE message_id = :id` (TECHNICAL-DESIGN.md:271,277) is wrong against the real schema.** The real column is `embeddings.message_ids TEXT[]` — an **array** (`schema.ts:70`). One embedding row can reference **several** messages, because the Indexer **groups** consecutive same-channel messages before chunking. The correct predicate everywhere in this story is **`:messageId = ANY(message_ids)`** (Postgres array membership). **Do NOT add a `message_id` column** — that would be DDL outside the design (AD-5) and break the grouped model.

2. **Embeddings are grouped + chunked, NOT 1:1 with messages (Story 3.3, `indexBatch.ts:174-212`).** For a group, `chunkKey = "<messageIds[0]>:<chunkIndex>"` and `messageIds` is the **whole group's** id array; the row's `content` is the concatenation of the group's messages, split into chunks. So "delete/re-index the embedding of message X" is not a single-row operation: X may be the anchor (`messageIds[0]`) of some chunks and a non-anchor member of others, and any chunk containing X also contains X's neighbors. **This grouping tension is the central design problem of the story — see the DECISIONS section; it drives every AC below.**

3. **All contracts already exist — reuse, do not redefine.** `packages/shared/src/types/events.ts` defines `MessageUpdatedEvent` (`{ type:'discord.message.updated', messageId, channelId, guildId, timestamp, newContent }`, lines 21-24) and `MessageDeletedEvent` (`{ type:'discord.message.deleted', messageId, channelId, guildId, timestamp }`, lines 26-28); `STREAM_KEYS.DISCORD_MESSAGES_UPDATED` / `DISCORD_MESSAGES_DELETED` (lines 63-65); and `CONSUMER_GROUPS.SYNC = 'share2brain:sync'` (line 74). Import these constants — **never hardcode the strings** (AD-13). **No `packages/shared` change, no new stream key, no new consumer group, no migration** — `discord_messages.deleted_at` (nullable) and `embeddings.message_ids` already exist (`schema.ts:48,70`).

4. **Soft delete is already wired on the READ side (Story 4.1 decision D1) — you only set the flag.** Search, docs, and read-status queries all exclude a chunk the moment **any** of its constituent messages is soft-deleted, via `NOT EXISTS (SELECT 1 FROM discord_messages d WHERE d.id = ANY(e.message_ids) AND d.deleted_at IS NOT NULL)` (verified: `embeddingSearchRepository.drizzle.ts:58-61`, `documentRepository.drizzle.ts:48-51`, `readStatusRepository.drizzle.ts:30,73,114`). So **soft delete = `UPDATE discord_messages SET deleted_at = NOW() WHERE id = :id`** and nothing else — the chunk vanishes from every read path automatically. The AC explicitly says soft delete does **not** touch `embeddings`. Do not.

5. **`user_read_status.embedding_id → embeddings.id` has NO `onDelete` cascade (`schema.ts:140-142`) — it is RESTRICT.** Physically deleting an `embeddings` row that any user has marked read raises a **foreign-key violation**. Any path that `DELETE`s from `embeddings` (hard delete, and the update path's "remove old chunks") **MUST first delete the dependent `user_read_status` rows, in the same transaction.** This is the #1 way hard-delete ships broken.

6. **The bot is publish-only (Story 6.1 recon #4) — it does NOT update `discord_messages.content` on edit.** After an edit, the raw `discord_messages.content` is **stale** until this worker refreshes it. The update event carries `newContent`. The Sync worker owns bringing the raw row current (see DECISION 4). Note: search/docs surface `embeddings.content` (the chunk text), not `dm.content`, so a stale `dm.content` does not corrupt display — but 6.3 offline reconciliation compares indexed content, so keeping it current matters.

7. **The search/docs anchor join is an INNER JOIN with a documented "revisit when hard-delete lands" note** (`embeddingSearchRepository.drizzle.ts:47-53`): `JOIN discord_messages dm ON dm.id = e.message_ids[1]`. If a hard delete leaves an embedding chunk whose anchor `discord_messages` row is gone, the chunk silently disappears from search/docs. Our hard-delete design **deletes the embedding chunks themselves** (not the anchor dm row), so no orphan-anchor chunk is ever created and the INNER JOIN case is not triggered. **Changing that join to a LEFT JOIN is out of scope** for this story (confirm in DECISION 3).

8. **Offline reconciliation is NOT this story.** Detecting edits/deletes that happened while services were down is **Story 6.3** (`epics.md §Historia 6.3`), which republishes into these same streams. Story 6.2 handles **live stream consumption** only. `messageDeleteBulk` was deferred out of 6.1 (`deferred-work.md`) and remains out of scope here.

---

## Acceptance Criteria

### AC-1 — Consume `discord.message.updated`: purge old chunks, re-embed, upsert (idempotent)

**Given** the Sync worker (`consumer group share2brain:sync`, `CONSUMER_GROUPS.SYNC`) reads a `discord.message.updated` entry from `STREAM_KEYS.DISCORD_MESSAGES_UPDATED`
**When** it processes the entry and a `discord_messages` row exists for `messageId`
**Then**, in **one DB transaction**:
- it deletes the dependent `user_read_status` rows for, and then deletes, **every `embeddings` row where `:messageId = ANY(message_ids)`** (the message's old chunks — note #1, #5)
- it refreshes the raw row: `UPDATE discord_messages SET content = :newContent, updated_at = :timestamp WHERE id = :messageId` (note #6, DECISION 4)
- it re-chunks `newContent` **as a standalone message** (`chunkContents([newContent], { chunk_size, chunk_overlap })`), embeds the chunks via the injected embedder, asserts each vector matches `config.embeddings.dimensions`, and inserts one `embeddings` row per chunk with `chunkKey = "<messageId>:<i>"`, `messageIds = [messageId]`, `channelId`, `content = chunk` — **UPSERT on `chunk_key`** so a redelivery converges to the same rows (AD-13)
- it stamps `discord_messages.indexed_at = NOW()` for `messageId`
**And** it runs `XACK` **only after** the transaction COMMITs; on any failure it does **not** ack, leaving the entry in the PEL for redelivery (AD-13).

### AC-2 — `discord.message.updated` for an unknown or blank message is a safe no-op

**Given** a `discord.message.updated` entry
**When** no `discord_messages` row exists for `messageId` (the worker never saw a create for it), **or** the entry is malformed / foreign-typed / tombstoned (`message: null`), **or** `newContent` is blank (whitespace-only)
**Then** the worker performs **no** embedding writes, logs at `debug` (unknown/blank) or `warn` (malformed), and **`XACK`s the entry** so it leaves the PEL instead of being redelivered forever (mirrors `indexBatch.ts:50-58`).
_Rationale: 6.1 already skips publishing blank edits; this is the defensive floor. An unknown message means the create path owns its insertion — re-indexing here would create an anchor-less chunk (note #7)._

### AC-3 — Consume `discord.message.deleted` with `delete_policy = "soft"`: mark, keep vectors

**Given** the worker reads a `discord.message.deleted` entry and `config.sync.delete_policy === "soft"`
**When** it processes the entry
**Then** it runs `UPDATE discord_messages SET deleted_at = NOW() WHERE id = :messageId AND deleted_at IS NULL` and does **NOT** delete any `embeddings` row (note #4)
**And** the operation is **idempotent**: if the row is absent or already soft-deleted, `0` rows change and the worker continues without error and `XACK`s.

### AC-4 — Consume `discord.message.deleted` with `delete_policy = "hard"`: purge vectors permanently

**Given** the worker reads a `discord.message.deleted` entry and `config.sync.delete_policy === "hard"`
**When** it processes the entry
**Then**, in **one DB transaction**:
- it deletes the dependent `user_read_status` rows for, and then deletes, **every `embeddings` row where `:messageId = ANY(message_ids)`** (note #1, #5)
- it sets `discord_messages.deleted_at = NOW()` for `messageId` (hard delete is a **superset** of soft — DECISION 3; keeps the raw row for audit/6.3 while purging the vectors)
**And** the operation is **idempotent**: if the message / its embeddings no longer exist, `0` rows change, the worker continues without error and `XACK`s (AC text: "si el mensaje ya no existe, continúa sin error").

### AC-5 — XACK-only-after-success and per-entry isolation (AD-13)

**Given** any Sync entry
**When** its processing throws (DB error, embedder outage, dimension mismatch)
**Then** the entry is **not** acked and stays PENDING for redelivery; the error is logged at `error` with `{ streamId, messageId, channelId, stream }` (**never** the content); and **a poison/failed entry never crashes the process and never blocks later entries in the same batch** (mirror the per-group isolation of `indexBatch.ts:111-164`).

### AC-6 — The Sync consumer boots alongside the Indexer, gated by `config.sync.enabled`, PEL-replay on start, and drains on shutdown

**Given** `@share2brain/workers` boots (`main.ts`)
**Then** it creates the `share2brain:sync` group idempotently (BUSYGROUP = "already exists") on **both** streams, replays its own PEL first (crash-recovery), then reads live — **the exact loop shape of `runIndexer` (`consumer.ts`)**
**And** the Indexer and Sync consumers run **concurrently** in the one process; the existing SIGTERM/SIGINT shutdown waits (bounded) for **both** in-flight loops before closing `db`/`redis` (extend `main.ts`'s current single-`indexerPromise` drain to cover the sync promise too)
**And** when `config.sync.enabled === false` the Sync consumer is **not** started (the Indexer still runs), logged once at `info`.

### AC-7 — Content is never logged

No log line (`debug`/`info`/`warn`/`error`) in the Sync worker includes `newContent` or any message content (`project-context.md`: "Never log … full message content"). Assert this in tests (serialize every logged arg, assert the content string never appears), mirroring `messageCreate.test.ts`.

### AC-8 — Verification gate green

`npm run lint` (0), `npm run test` (all pass, new unit tests added), and `npm run build` (all 5 workspaces) are green. An integration test against **real Postgres + Redis** (fake embedder, never a real API) covers the pgvector purge, the FK-safe cascade, the RETURNING/idempotent redelivery, and the soft-vs-hard branch — mirroring `indexBatch.integration.test.ts` + `test-helpers.ts` (`npm run test:integration`).

---

## Tasks / Subtasks

- [x] **Task 1 — Sync event parsers** (AC-1, AC-2, AC-3, AC-4) — new `packages/workers/src/sync/events.ts`, mirroring `indexer/events.ts`:
  - [x] `parseUpdatedEvent(fields: Record<string,string>): MessageUpdatedEvent | null` — returns `null` unless `type === 'discord.message.updated'` and `messageId`/`channelId` are non-blank and `newContent` is non-blank (blank → unprocessable → ack+skip per AC-2, matching `parseCreatedEvent`'s blank-content rule). Carry `guildId`/`timestamp` through verbatim.
  - [x] `parseDeletedEvent(fields): MessageDeletedEvent | null` — `null` unless `type === 'discord.message.deleted'` and `messageId`/`channelId` non-blank. **No content field** on delete.
  - [x] Co-locate `events.test.ts`.

- [x] **Task 2 — `processUpdate` (re-index)** (AC-1, AC-2, AC-5, AC-7) — new `packages/workers/src/sync/processUpdate.ts`:
  - [x] Signature `processUpdate({ event, db, embedder, config, logger }): Promise<{ ack: boolean }>` — pure of Redis; the consumer owns XACK. Return `{ ack: true }` for success **and** for the AC-2 no-op cases (unknown row / blank — parser already rejects blank so mostly the unknown-row case); `{ ack: false }` only when an exception is caught (leave pending).
  - [x] Pre-check: `SELECT id FROM discord_messages WHERE id = :messageId`. If absent → `debug` log ("update for unknown message — skipping, create path owns insertion"), return `{ ack: true }` (AC-2).
  - [x] One `db.transaction`: (a) `DELETE FROM user_read_status WHERE embedding_id IN (SELECT id FROM embeddings WHERE :id = ANY(message_ids))` **then** `DELETE FROM embeddings WHERE :id = ANY(message_ids)` (note #5 order is mandatory); (b) `UPDATE discord_messages SET content = :newContent, updated_at = :timestamp WHERE id = :id`; (c) `chunkContents([newContent], chunkOptions)` → embed → `assertEmbeddingDimensions` each; (d) UPSERT one `embeddings` row per chunk (`chunkKey="<id>:<i>"`, `messageIds=[id]`, `channelId`, `content`), `onConflictDoUpdate` on `chunk_key` (copy `persistGroup`'s upsert, `indexBatch.ts:180-202`); (e) `UPDATE discord_messages SET indexed_at = NOW() WHERE id = :id`.
  - [x] Wrap the whole body so an embedder outage / dimension mismatch / DB error is caught by the **consumer** (Task 4) → logged `error` → `{ ack: false }`. Do **not** ack inside a failed tx.
  - [x] Use `config.embeddings.dimensions`, `config.knowledge.chunk_size`, `config.knowledge.chunk_overlap` — same as the Indexer.

- [x] **Task 3 — `processDelete` (soft/hard)** (AC-3, AC-4, AC-5) — new `packages/workers/src/sync/processDelete.ts`:
  - [x] Signature `processDelete({ event, db, config, logger }): Promise<{ ack: boolean }>` (no embedder — delete never embeds).
  - [x] Branch on `config.sync.delete_policy`:
    - `"soft"` → single `UPDATE discord_messages SET deleted_at = NOW() WHERE id = :id AND deleted_at IS NULL`. No embeddings touch (AC-3).
    - `"hard"` → one `db.transaction`: `DELETE FROM user_read_status WHERE embedding_id IN (SELECT id FROM embeddings WHERE :id = ANY(message_ids))`, then `DELETE FROM embeddings WHERE :id = ANY(message_ids)`, then `UPDATE discord_messages SET deleted_at = NOW() WHERE id = :id AND deleted_at IS NULL` (superset of soft — DECISION 3).
  - [x] Idempotent: zero affected rows is success, not error → `{ ack: true }`. Exception → `{ ack: false }` (leave pending).

- [x] **Task 4 — `runSync` consumer loop** (AC-1…AC-6) — new `packages/workers/src/sync/consumer.ts`, **structurally copied from `indexer/consumer.ts`** (idempotent `xGroupCreate` with `MKSTREAM`, PEL replay from `'0'`, then live `'>'` with `BLOCK`, abort at top-of-loop):
  - [x] Create the `share2brain:sync` group on **both** `DISCORD_MESSAGES_UPDATED` and `DISCORD_MESSAGES_DELETED`. Simplest correct shape: **two independent loops** (one per stream) run concurrently via `Promise.all`, or a single `xReadGroup` over both stream keys. **[DECISION 5]: two independent single-stream loops** — mirrors `runIndexer` exactly, keeps updated/deleted failure isolation trivial, and matches "cada uno con su consumer group" intent while staying one group. Each loop dispatches to `processUpdate` / `processDelete`, then `xAck` **only** when the processor returns `{ ack: true }`.
  - [x] Per-entry `try/catch` so one bad entry never aborts the loop (AC-5). Log `error` with `{ streamId, messageId, channelId, stream }`, never content (AC-7). Parser-`null` (malformed/tombstoned) → `warn` + ack (AC-2).
  - [x] `runSync(deps: { redis, db, embedder, config, logger, signal })`. **Use a separate Redis client from the Indexer's** — the Indexer's client comment (`consumer.ts:5-7`) warns the blocking loop must not share a client with a concurrent caller; two concurrent blocking loops need two clients. Open a second `createRedisClient(redisUrl)` in `main.ts` for Sync.

- [x] **Task 5 — Wire Sync into `main.ts`** (AC-6):
  - [x] After the Indexer starts, if `config.sync.enabled`, open a second Redis client, connect it (same bounded-connect + fail-fast pattern as the first), and start `runSync(...)`; assign `syncPromise`. If `!config.sync.enabled`, log `info` "sync disabled — not starting Sync consumer" and skip.
  - [x] Extend shutdown: the bounded drain `Promise.race` must await **both** `indexerPromise` and `syncPromise` (`Promise.all([...].map(p => p.catch(()=>undefined)))`), and `quit()` the second Redis client too. Update the top-level `await` to cover both promises (don't let a sync rejection during shutdown leak).
  - [x] Update the module header comment (it currently says "The Sync consumer … lands in Epic 6" — that's now).

- [x] **Task 6 — Unit tests** (all ACs) — co-located `*.test.ts`, DI fakes (fake `db` with spied methods, fake `embedder`, fake `logger` via `vi.fn()`), no real I/O:
  - [x] `events.test.ts`: accepts valid updated/deleted; rejects wrong `type`, blank `messageId`/`channelId`, blank `newContent`; carries `guildId`/`timestamp` through.
  - [x] `processUpdate.test.ts`: deletes read-status **before** embeddings; deletes all chunks matching `ANY(message_ids)`; refreshes `dm.content`+`updated_at`; re-chunks standalone + upserts `<id>:<i>`; stamps `indexed_at`; unknown message → no writes, `{ack:true}`; embedder throws → `{ack:false}`, no ack, content not logged; dimension mismatch → `{ack:false}`.
  - [x] `processDelete.test.ts`: soft → sets `deleted_at`, never touches embeddings; hard → deletes read-status then embeddings then sets `deleted_at`; idempotent (0 rows) → `{ack:true}`; exception → `{ack:false}`.
  - [x] `consumer.test.ts`: creates group on both streams (BUSYGROUP swallowed); PEL replay then live; acks only on `{ack:true}`; a throwing processor leaves the entry pending and does not abort the loop; abort stops within ~BLOCK_MS.
  - [x] Content-never-logged assertion across all handlers (AC-7).

- [x] **Task 7 — Integration test** (AC-8) — new `packages/workers/src/sync/sync.integration.test.ts`, mirroring `indexBatch.integration.test.ts` (real Postgres+Redis via `openTestClients`, **fake embedder**, unique id suffix, cleanup in `afterAll`):
  - [x] Seed a `discord_messages` row + its `embeddings` chunk(s) + a `user_read_status` row referencing a chunk. **Update** event → old chunks gone, new `<id>:0` chunk present with new content, `dm.content` refreshed, `indexed_at` bumped, the stale read-status row cascaded away (no FK error). **Redeliver** the same entry → converges (no duplicate rows).
  - [x] **Soft delete** → `deleted_at` set, embeddings intact, chunk excluded by the D1 anti-join (assert via a probe select). **Hard delete** (flip `config.sync.delete_policy`) → embeddings + read-status gone, `deleted_at` set, FK-safe. **Idempotent**: second delete of the same id → 0 rows, no throw, acked.

- [x] **Task 8 — Verify** — `npm run lint && npm run test && npm run build` green; `npm run test:integration` green with infra up. No new dependency (reuse `@share2brain/shared/db`, `@share2brain/shared/providers`, `chunkContents`). No `packages/shared` change, no migration.

---

## Dev Notes

### Architecture & patterns to follow
- **The Indexer is your template — copy its shape, don't invent.** `runSync` mirrors `runIndexer` (`consumer.ts`): idempotent `xGroupCreate` + `MKSTREAM`, PEL replay from `'0'` advancing past each batch, then a live `'>'` loop with `BLOCK: 5000`, abort checked at top of loop. The XACK-only-after-success + per-entry isolation is the same contract as `indexBatch` (`indexBatch.ts:111-164`) — a failed entry logs and stays PENDING; later entries still run; nothing throws out of the loop.
- **Reuse the embedding pipeline, don't reimplement it.** `chunkContents` (`indexer/chunking.ts`) and the injected `Embedder` (`indexer/types.ts` — `createEmbeddingsModel(config.embeddings)` in `main.ts`) are exactly what re-index needs. The UPSERT-by-`chunk_key` block in `persistGroup` (`indexBatch.ts:180-202`) is the pattern to copy for the new-chunk insert (`onConflictDoUpdate` on `embeddings.chunkKey`). Import `assertEmbeddingDimensions` from `@share2brain/shared/providers` and apply it before persisting (AC-1), same as `indexBatch.ts:135`.
- **Two blocking loops need two Redis clients.** The Indexer's client is documented as strictly-sequential and non-shareable (`consumer.ts:5-7`). Sync runs concurrently with the Indexer, so `main.ts` opens a **second** `createRedisClient(redisUrl)` for it. `db` (the pg Pool) is safely shared — it's pooled.
- **AD-13 string rule (read side).** node-redis delivers every XADD field as a string, so `parseUpdatedEvent`/`parseDeletedEvent` receive `Record<string,string>` and validate the fields the worker needs, returning `null` for anything else (copy `parseCreatedEvent` exactly). The producer (6.1) already guarantees all-string payloads.

### The grouping tension — the crux of this story (read with note #1, #2)
- Embeddings are **grouped** (`messageIds` is an array) and **chunked** (`chunkKey = "<messageIds[0]>:<i>"`). A single edited/deleted message can appear in multiple chunks and can be a non-anchor member of a chunk seeded by a different message. There is **no** clean "the embedding of message X".
- The event for an **edit** carries only X's `newContent` — **not** its original neighbors' content — so the worker **cannot** faithfully reconstruct X's original group. The design therefore **re-indexes X standalone** (`messageIds = [X]`, `chunkKey = "<X>:<i>"`). Consequence (**accepted limitation, DECISION 1**): if X was grouped with neighbors Y,Z, deleting the chunks that contained X also removes Y,Z's coverage from those chunks; Y,Z self-heal on their own next edit/re-index. Grouping is a **retrieval-quality optimization, not a correctness invariant** — content stays searchable and correctly attributed. Redundant/lossy re-index is safe because every read path anti-joins on `deleted_at` and the UPSERT converges (AD-13). **Do NOT attempt to re-group** — the event lacks the neighbor content to do it.
- Same logic for **hard delete**: purging "every chunk containing X" can drop co-grouped neighbors; accepted for the same reason.

### discord/data gotchas
- **FK RESTRICT on `user_read_status.embedding_id` (note #5).** Delete order inside the tx is **read-status first, embeddings second** — always. An integration test must seed a read-status row and prove the cascade works (a naive `DELETE FROM embeddings` first will FK-fail).
- **Soft delete touches only `discord_messages` (note #4).** The D1 anti-join in search/docs/read-status does the exclusion for you. Deleting or altering `embeddings` on a soft delete is a bug (breaks AC-3 and wastes the re-index the message might get if un-deleted later — not in scope, but keep the vectors).
- **Idempotency = "0 rows affected is success".** Every write in this story is `WHERE id = :id` / `WHERE :id = ANY(message_ids)`; a redelivery that finds nothing must ack and move on. Never treat "0 rows" as an error.
- **Two Redis instances on this Mac (memory):** `localhost:6379` (Homebrew) vs the Compose Redis (no published ports). Local vs dockerized worker code hit **different** streams — keep in mind when manually checking `XLEN share2brain:discord:messages:updated` / `:deleted` or the `share2brain:sync` PEL (`XPENDING`).

### Source tree — files to touch
- **NEW** `packages/workers/src/sync/events.ts` + `events.test.ts`
- **NEW** `packages/workers/src/sync/processUpdate.ts` + `processUpdate.test.ts`
- **NEW** `packages/workers/src/sync/processDelete.ts` + `processDelete.test.ts`
- **NEW** `packages/workers/src/sync/consumer.ts` (`runSync`) + `consumer.test.ts`
- **NEW** `packages/workers/src/sync/sync.integration.test.ts`
- **UPDATE** `packages/workers/src/main.ts` — start `runSync` gated by `config.sync.enabled`, second Redis client, drain both promises on shutdown, fix header comment
- **REUSE (no change)** `packages/workers/src/indexer/chunking.ts` (`chunkContents`), `indexer/types.ts` (`Embedder`, `RawStreamEntry`), `@share2brain/shared/providers` (`assertEmbeddingDimensions`, `createEmbeddingsModel`), `@share2brain/shared/db` (`embeddings`, `discordMessages`, `userReadStatus`, `sql`, `inArray`), `@share2brain/shared/types/events` (`STREAM_KEYS`, `CONSUMER_GROUPS`, event types)
- **NO CHANGE** `packages/shared/**` (contracts + schema already exist); **NO migration**

### Testing standards
- Vitest, co-located `*.test.ts`, DI fakes — copy `indexBatch.test.ts` / `consumer.test.ts` scaffolds (fake `db` with `vi.fn()`-spied `transaction`/`select`/`insert`/`update`/`delete`, fake `embedder`, fake `logger`, `xReadGroup`/`xAck`/`xGroupCreate` spies via `{ ... } as unknown as RedisClient`).
- **Must-test invariants** (`project-context.md`, adapted): XACK only after a committed write; a failed entry stays pending (no ack) and does not crash; soft vs hard branch is honored; read-status is deleted before embeddings; content never logged; redelivery converges (idempotent).
- Integration test uses the `openTestClients` / unique-suffix / `afterAll`-cleanup harness from `indexBatch.integration.test.ts` + `test-helpers.ts`, with a **fake embedder** — a real embeddings API is never called in tests.

### Project Structure Notes
- Code stays under `packages/workers/src/sync/` (new sibling of `indexer/`). No root `src/`. Workers depend only on `@share2brain/shared`, never another service (AD-2). English only in all code/comments/tests. Only `packages/shared` does DDL (AD-5) — this story does none.

### Previous-story intelligence
- **Story 6.1** produced the two streams this story consumes; its handlers are publish-only (recon #6 here). Its recon #4 established that the DB mutation (this story) is the Sync worker's job.
- **Story 3.3** (Indexer) established every pattern reused here: the consumer loop, PEL replay, XACK-after-COMMIT, grouped/chunked `embeddings` with `chunkKey`/`message_ids`, the injected `Embedder`, `chunkContents`, `assertEmbeddingDimensions`, and the real-infra integration harness.
- **Story 4.1 (D1)** wired the exclude-if-any `deleted_at` anti-join across search/docs/read-status — the reason soft delete here is a one-line UPDATE.
- **Epic 3 retro AI:** the `deleted_at`-over-grouped-chunks semantics were resolved as EXCLUDE-IF-ANY at Story 4.1 — this story is the write side of that decision.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 6.2]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-share2brain-2026-06-30/TECHNICAL-DESIGN.md#5.3 — Sync worker pseudocode (note: `message_id` predicate is pre-schema; reconciled in note #1)]
- [Source: packages/shared/src/types/events.ts#21-80 — MessageUpdatedEvent/MessageDeletedEvent, STREAM_KEYS, CONSUMER_GROUPS.SYNC]
- [Source: packages/shared/src/db/schema.ts#36-78,133-150 — discord_messages.deleted_at, embeddings.message_ids/chunk_key, user_read_status FK (no cascade)]
- [Source: packages/shared/src/config/index.ts#79-83 — config.sync { enabled, sync_on_start, delete_policy: 'soft'|'hard' }]
- [Source: packages/workers/src/indexer/consumer.ts — runIndexer loop shape to mirror]
- [Source: packages/workers/src/indexer/indexBatch.ts#111-212 — group/chunk/embed/upsert + persistGroup UPSERT to copy]
- [Source: packages/workers/src/indexer/chunking.ts — chunkContents (reuse)]
- [Source: packages/workers/src/main.ts — boot, shutdown drain, Redis client (extend for the 2nd consumer)]
- [Source: packages/backend/src/infrastructure/embeddingSearchRepository.drizzle.ts#47-61 — D1 anti-join + INNER-JOIN "revisit when hard-delete lands" note]
- [Source: packages/backend/src/infrastructure/documentRepository.drizzle.ts#39-51, readStatusRepository.drizzle.ts#30,73,114 — D1 anti-join reused]
- [Source: packages/workers/src/indexer/indexBatch.integration.test.ts + test-helpers.ts — real-infra harness to mirror]
- [Source: _bmad-output/project-context.md — AD-13 idempotency, never-log-content, workers-idempotent, no-cross-service-dep]

## Project Context Reference

See `_bmad-output/project-context.md` (backend rules, AD-13 stream/idempotency invariants, anti-patterns) and `CLAUDE.md` (non-negotiables: only shared does DDL, workers idempotent, XACK only after success). Standards: `docs/base-standards.md`, `docs/backend-standards.md`.

## Decisions (confirmed with Borja, 2026-07-08)

> These are the design forks created by the grouping tension (note #2). D1 and D3 were explicitly confirmed with Borja at story creation; D2/D4/D5 are adopted defaults (Borja did not override them). The story above is written to these.

1. **[DECIDED — re-index is standalone; co-grouped neighbors lose coverage until they self-heal]** On edit, re-embed the message **alone** (`messageIds=[id]`, `chunkKey="<id>:<i>"`), because the event lacks the original neighbors' content to re-group. Deleting the old chunks that contained the message also removes co-grouped neighbors from those chunks (they re-index on their own next edit). **Rationale:** grouping is a retrieval optimization, not a correctness invariant; content stays searchable + attributed; the alternative (re-fetch neighbors from `discord_messages` and rebuild the group) is materially more complex and out of the epic's scope. _Confirmed with Borja — chose Standalone over Re-group._
2. **[DECIDED — update also refreshes `discord_messages.content` + `updated_at`]** Not strictly required by the AC (search/docs read `embeddings.content`), but the bot is publish-only so the raw row is otherwise permanently stale, which would break 6.3 offline reconciliation's content comparison. Cheap (one UPDATE in the same tx). _Adopted default._
3. **[DECIDED — hard delete is a superset of soft: purge embeddings + read-status AND set `deleted_at`]** Keeps the raw `discord_messages` row (audit / 6.3) while permanently removing the vectors; avoids ever leaving an anchor-less chunk (note #7), so the search INNER-JOIN stays correct and **does not need to become a LEFT JOIN in this story**. _Confirmed with Borja — chose Superset over embeddings-only; INNER→LEFT change stays out of scope._
4. **[DECIDED — blank `newContent` and unknown-message updates are ack+skip no-ops (AC-2)]** 6.1 already skips publishing blank edits; an update for a message with no `discord_messages` row would create an anchor-less chunk, so we skip and let the create path own insertion. _Adopted default._
5. **[DECIDED — two independent single-stream loops under the one `share2brain:sync` group]** Mirrors `runIndexer` exactly and keeps updated/deleted failure isolation trivial, vs. one multi-stream `xReadGroup`. _Adopted default._

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5), via bmad-dev-story.

### Debug Log References

None — no blocking failures during implementation. Full verification gate output is captured in Completion Notes below.

### Completion Notes List

- Implemented all 8 tasks in order (events → processUpdate → processDelete → runSync → main.ts wiring → unit tests → integration test → verify). Followed the story's literal task wording for `processUpdate`: the DELETE (read-status then embeddings), the `discord_messages` content/`updated_at` refresh, the chunk/embed/assert, the UPSERT, and the `indexed_at` stamp all run inside **one** `db.transaction` (AC-1's literal "in one DB transaction" — the embed call happens inside the transaction, mirroring the AC text exactly rather than moving it outside for latency reasons).
- `processDelete`'s soft/hard writes use raw `sql` templates via `db.execute`/`tx.execute` for the `:messageId = ANY(message_ids)` predicate (Drizzle's query builder has no typed helper for value-vs-array-column `ANY()`) — this matches the established convention already used by `readStatusRepository.drizzle.ts`/`embeddingSearchRepository.drizzle.ts` (raw `sql` + the re-exported `inArray`/`sql` from `@share2brain/shared/db`, AD-2). The UPSERT insert in `processUpdate` still uses the typed `embeddings` table + `onConflictDoUpdate`, copied verbatim from `persistGroup` (`indexBatch.ts`).
- `runSync` factors the "one stream's group-create + PEL-replay + live-read" shape into a single `runStreamLoop` helper parameterized by stream/handler, then runs it twice via `Promise.all` (DECISION 5) — structurally identical to `runIndexer` per stream, without duplicating the loop body twice.
- `main.ts`: extracted a `connectRedisOrExit` helper (bounded-connect + fail-fast, same behavior as the original inline Indexer connect) so the Sync consumer's second Redis client connects identically. Shutdown now drains `Promise.all([indexerPromise, syncPromise])` (bounded, `.catch`-neutralized) and `quit()`s both Redis clients; `syncRedis`/`syncPromise` stay at their no-op defaults when `config.sync.enabled` is false.
- A shared `ProcessResult` type was added at `sync/types.ts` (`{ ack: boolean }`) so `processDelete.ts` doesn't need to import from `processUpdate.ts` and `consumer.ts` has one place to import the dispatch return shape from.
- Verification gate (all commands actually executed, evidence below):
  - `npm run lint` → **0 errors** (repo-wide, `eslint .`).
  - `npm run test` → **582 passed** (72 test files; unit+web projects), including 35 new Sync unit tests: 12 `events.test.ts`, 9 `processUpdate.test.ts`, 7 `processDelete.test.ts`, 7 `consumer.test.ts` (the 4 new `sync.integration.test.ts` cases run separately under `test:integration`, not counted here).
  - `npm run build` → all 5 workspaces (`backend`, `bot`, `shared`, `web`, `workers`) clean (`tsc --noEmit` / `vite build`).
  - `npm run test:integration` (workers project only, `--project workers-integration`) → **8 passed** (4 pre-existing Indexer + 4 new Sync: update-with-FK-cascade-and-redelivery, unknown-message no-op, soft-delete-with-D1-anti-join-probe, hard-delete-with-FK-safe-purge). Ran against real Postgres (docker compose `postgres`, port 5432) + real Redis (Homebrew, `localhost:6379` — the dev-documented target per the two-Redis-instances gotcha; the compose `redis` service publishes no host port). Post-run DB check confirmed zero stray `itest-6-2-*` rows in `discord_messages`/`embeddings`/`users` — cleanup verified.
  - **Idempotency check (AD-13, mandatory-steps §3.2.5)**: explicitly asserted in both the integration test (redeliver the same update event → still exactly one chunk row; redeliver the same delete event → still 0 rows changed, no throw) and the unit tests (`{ack:true}` on a caught exception is never returned — only `{ack:false}`, leaving the entry PENDING for real redelivery).
  - **Known pre-existing, unrelated flake**: running the FULL `npm run test:integration` (backend+bot+workers together) surfaces 2–3 failures in `packages/backend/src/rbac.integration.test.ts` / `channels.integration.test.ts` (an extra `'test-guild'` role appearing in the RBAC response; one file passed on an isolated re-run, i.e. non-deterministic). This story's diff touches **zero** files under `packages/backend` — confirmed by `git status` scope (only `packages/workers/**` + this story's bmad artifacts changed) — so it cannot be caused by this change. It reproduces identically with the Sync worker's changes entirely absent from the equation (the workers-integration project run in isolation is 100% green every time). Consistent with the pre-existing test-isolation gaps already on record from Story 4-2 ("RBAC expansion resolves against the WHOLE channel_permissions table … a shared literal role … leaks into scope") and the live `docker compose` `backend`/`bot` containers sharing the same Postgres+Redis the integration tests target. Left unfixed as out of this story's scope; flagging for a follow-up (backend RBAC/session test-isolation hardening, or don't run integration tests against a stack with live dev containers attached).
  - No new dependency added; no `packages/shared` change; no migration (confirmed — `discord_messages.deleted_at` and `embeddings.message_ids` already existed).

### File List

- `packages/workers/src/sync/events.ts` (new)
- `packages/workers/src/sync/events.test.ts` (new)
- `packages/workers/src/sync/processUpdate.ts` (new)
- `packages/workers/src/sync/processUpdate.test.ts` (new)
- `packages/workers/src/sync/processDelete.ts` (new)
- `packages/workers/src/sync/processDelete.test.ts` (new)
- `packages/workers/src/sync/types.ts` (new)
- `packages/workers/src/sync/consumer.ts` (new)
- `packages/workers/src/sync/consumer.test.ts` (new)
- `packages/workers/src/sync/sync.integration.test.ts` (new)
- `packages/workers/src/main.ts` (modified — second Redis client, gated `runSync` start, shutdown drains both consumer promises, header comment updated)

## Change Log

- 2026-07-08 — Story 6.2 created (bmad-create-story). Sync worker consumes `discord.message.updated`/`deleted` from `share2brain:sync`, re-indexes edits (standalone re-embed + UPSERT) and purges deletes (soft = `deleted_at`; hard = purge vectors + read-status, superset of soft), all idempotent with XACK-after-COMMIT. Reconciles the epic/tech-design `message_id` pseudocode against the real grouped `message_ids[]` schema. No `packages/shared` change, no migration. Status → ready-for-dev.
- 2026-07-08 — Story 6.2 implemented (bmad-dev-story). All 8 tasks complete; gate green (lint 0 / 582 unit+web (+35 new Sync tests) / build clean 5 pkgs / 8 workers-integration (+4 new Sync tests)). Sync consumer wired into `main.ts` alongside the Indexer on its own Redis client, gated by `config.sync.enabled`. Flagged one pre-existing, unrelated `packages/backend` RBAC integration-test flake (out of this story's file scope) in Completion Notes. Status → review.

- 2026-07-08 — Story 6.2 code review (bmad-code-review). 3 adversarial layers → 2 decision-needed + 2 patch + 4 defer + 2 dismissed. Both decisions resolved with Borja (one Redis client per Sync loop; embed moved outside the tx) and all 4 patches applied: (1) `main.ts` opens `syncRedisUpdated`+`syncRedisDeleted` (3 clients total), `runSync` takes both; (2) `processUpdate` chunks+embeds+asserts BEFORE the tx (mirrors the Indexer, no locks/pool held across embeddings HTTP); (3) `parseUpdatedEvent` rejects blank/missing `timestamp` (was a `updated_at` poison-pill); (4) `processUpdate`/`processDelete` error logs now carry `streamId`+`stream` (AC-5). Gate re-run green: lint 0 / 584 unit+web (+2) / build clean (5 pkgs) / 8 workers-integration. Status → done.

## Review Findings

_bmad-code-review 2026-07-08 — 3 adversarial layers (Blind Hunter + Edge Case Hunter + Acceptance Auditor, Opus 4.8) over the uncommitted `packages/workers/**` diff. 2 decision-needed, 2 patch, 4 deferred, 2 dismissed as noise._

- [x] [Review][Patch] Both Sync loops share ONE Redis client while doing concurrent blocking reads — `runSync` runs `Promise.all([runStreamLoop(updated), runStreamLoop(deleted)])` against the single `syncRedis` client ([sync/consumer.ts:46](), live `BLOCK` read at [sync/consumer.ts:126]()). node-redis serializes commands on one connection, so a parked `XREADGROUP … BLOCK 5000` on one stream blocks the other stream's read (and its `xAck`) for up to ~5 s — halving throughput and starving the idle-losing stream. Contradicts the invariant that motivated giving Sync its own client at all (`indexer/consumer.ts:5-7`) and makes `consumer.ts`'s own header comment self-contradictory. Flagged HIGH by all 3 layers. **[RESOLVED with Borja 2026-07-08 — one client per loop]**: `main.ts` opens `syncRedisUpdated` + `syncRedisDeleted` (3 clients total incl. Indexer); `runSync` takes both and passes one per `runStreamLoop`; shutdown drains/quits all three. Faithful to DECISION 5 (two independent loops).
- [x] [Review][Patch] Embedder HTTP call runs INSIDE the DB transaction — `chunkContents` + `embedder.embedDocuments` are awaited inside `db.transaction`, after the DELETEs/UPDATE ([sync/processUpdate.ts:59-104]()). The transaction holds row locks on `user_read_status`/`embeddings`/`discord_messages` AND a pooled connection across an external embeddings API call; the pool is shared with the concurrently-running Indexer, so a slow/hanging embedder under an edit burst can pin connections and stall the Indexer too. Diverges from the Indexer template (`indexBatch.ts` embeds OUTSIDE the tx). **[RESOLVED with Borja 2026-07-08 — mirror the Indexer]**: move `chunkContents` + `embedder.embedDocuments` + `assertEmbeddingDimensions` BEFORE opening the transaction; the tx keeps only DELETEs + content/`updated_at` UPDATE + UPSERT + `indexed_at` stamp. Correctness preserved (embed failure pre-tx → nothing written → entry stays PENDING). Supersedes the Completion-Notes decision to follow AC-1's literal "in one transaction" wording.
- [x] [Review][Patch] Unvalidated `timestamp` is a poison pill on the update path — `parseUpdatedEvent` defaults a missing/blank `timestamp` to `''` and never validates it (unlike `messageId`/`channelId`), then `processUpdate` writes `SET updated_at = ${timestamp}` into a `NOT NULL timestamptz` column ([sync/events.ts:36](), [sync/processUpdate.ts:72](); `schema.ts:46`). A blank/non-ISO timestamp → Postgres `invalid input syntax` → tx rollback → `{ack:false}` → entry stuck PENDING forever, replayed and failing on every boot. Not reachable from the current 6.1 producer (always emits ISO), but the parser explicitly permits what the write rejects. Fix: validate `timestamp` non-blank in `parseUpdatedEvent` (→ `null` → ack+skip as malformed), mirroring the `messageId`/`channelId` checks.
- [x] [Review][Patch] Real failure-path error logs omit `streamId` + `stream` required by AC-5 — `processUpdate` logs `{messageId, channelId, reason}` ([sync/processUpdate.ts:112]()) and `processDelete` logs `{messageId, channelId, policy, reason}` ([sync/processDelete.ts:61]()); neither carries `streamId`/`stream`. The consumer-level catch that DOES carry them ([sync/consumer.ts:159]()) is dead for processing failures because the processors swallow their own exceptions and return `{ack:false}` instead of throwing. Net: no single log line for a real DB/embedder failure lets an operator locate the pending entry in the PEL. Fix: thread `streamId`/`stream` into the processors, or have the consumer emit a compact error line (with both) when a handler returns `{ack:false}`.
- [x] [Review][Defer] Row-missing update/delete acks and drops the event — [sync/processUpdate.ts:45-51](), [sync/processDelete.ts]() — deferred. Blind/Edge flagged this as an Indexer-backlog race, but the **Bot** owns `discord_messages` (via `persistMessage`), not the Indexer, so the row exists for any live edit/delete; the row-missing branch only fires for messages the bot never persisted (historical / bot-was-down) = **Story 6.3 offline-reconciliation scope** (note #8). `deleted_at` anti-join also prevents resurface for the row-exists case. Low live-path risk.
- [x] [Review][Defer] Edit-to-blank silently keeps stale chunks — [sync/events.ts:27]() — deferred. A message edited down to whitespace parses to `null` → warn + ack, leaving old chunks searchable. But 6.1 does NOT publish blank edits (recon #6) so the live path can't trigger it; whether a "cleared text, keeps embed/attachment" edit should PURGE is a product decision, not a 6.2 defect. Revisit if 6.1 starts publishing blank edits.
- [x] [Review][Defer] No DLQ / retry-cap / alert on permanently-failing entries — [sync/consumer.ts]() — deferred. A deterministically-failing entry (e.g. dimension misconfig) sits in the PEL and re-fails on every boot replay with only per-attempt error logs. PEL-as-DLQ is the AD-13 design; retry caps + alerting are observability, out of this story's scope.
- [x] [Review][Defer] Speculative/boot-time low-severity items — deferred. (a) Concurrent update + hard-delete of the same message can re-INSERT embeddings a hard-delete just purged ([sync/processUpdate.ts:85-104]() vs [sync/processDelete.ts:52]()) — storage-only, hidden by the `deleted_at` anti-join, requires precise interleaving. (b) A non-BUSYGROUP `xGroupCreate` failure in one loop rejects `runSync` while the sibling runs on ([sync/consumer.ts:104-107]()) — boot-time infra error, resolves via fail-fast + Compose restart.


