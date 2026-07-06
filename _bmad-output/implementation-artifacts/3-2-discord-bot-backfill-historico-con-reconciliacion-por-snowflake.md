---
baseline_commit: 8aa1d35
status: done
story_id: 3.2
epic: 3
---

# Story 3.2: Discord Bot — historical backfill with snowflake reconciliation

Status: done

## Story

As an **Operator**,
I want the bot to index the Discord message history when it starts,
so that the knowledge that existed before Hivly was installed is queryable from day one — and any gap accumulated while the bot was offline is covered exactly, with no duplicates and no losses.

This is the **third story of Epic 3** (Knowledge Indexing Pipeline), after Story 3.1 (Gateway + `messageCreate`, `done`). It reuses 3.1's ingestion path (`persistMessage`) and **feeds Story 3.3** (Indexer worker) through the same `hivly:discord:messages` stream. It also introduces the first producer of the `hivly:knowledge:events` stream (consumer deferred to Epic 6).

**Baseline commit:** `8aa1d35` — Story 3.1 merged; the bot connects, ingests live `messageCreate` atomically (INSERT + XADD in one tx), reconnects with backoff, and hardens the process. There is **no backfill code** yet.

---

## ⚠️ Reconciliation notes — read before implementing

The Epic 3 spec (`epics.md` §Historia 3.2) and the architecture (`TECHNICAL-DESIGN.md` §5.2) reference behaviors that were re-decided during Story 3.1. Verified against the real source at baseline `8aa1d35`:

1. **There is no `last_seen_message_id` column — and none must be added.** Story 3.1 resolved (Borja, 2026-07-06): the per-channel cursor is **derived** from the newest row already in `discord_messages`. The epic's "actualiza el `last_seen_message_id` por canal" is satisfied implicitly: inserting each backfilled message *is* the cursor update. **No schema change (AD-5).**
2. **Never compute the cursor with `MAX(id)` on the text column.** Snowflakes are variable-length strings (18 digits pre-2022, 19 after): lexicographic `MAX` can return an *old* 18-digit id starting with `9` over a *newer* 19-digit id starting with `1`, making the bot re-fetch years of history. Resolve the cursor with `ORDER BY created_at DESC LIMIT 1` on `(channel_id)` — it rides the existing index `idx_discord_messages_channel (channel_id, created_at DESC)`. A same-millisecond tie picking the slightly-older row is harmless: the overlap message is re-fetched and skipped by the idempotent insert. Same rule in TS: compare snowflakes with `BigInt(id)`, **never** string `<`/`>`.
3. **Cursors MUST be read before `client.login()`.** The live listener (3.1) starts inserting the moment the Gateway connects. If the cursor is read after login, a live message can advance the channel's newest row past the offline gap and the gap is never fetched. Read all per-channel cursors right after the DB client opens, **before** any Gateway I/O.
4. **`persistMessage` must become idempotent (`onConflictDoNothing`).** Backfill overlaps with reality by design: the boundary message at the cursor, live messages arriving mid-backfill, and a crash-resume all re-deliver rows that already exist. Today the PK-duplicate INSERT aborts the tx and logs a false `error` (deferred finding from the 3.1 review, `deferred-work.md` §3-1 2nd pass). This story resolves that deferred item: `onConflictDoNothing` + skip the XADD when the row already existed (no duplicate event). Applies to the **live path too** (single code path; makes the producer idempotent on Gateway re-delivery). **[DECIDED with Borja, 2026-07-06]**.
5. **`discord.backfill.completed` has no type yet.** `packages/shared/src/types/events.ts` defines only the three `DiscordStreamEvent`s. This story adds `BackfillCompletedEvent` for `STREAM_KEYS.KNOWLEDGE_EVENTS` — a `shared`-scoped contract change (AD-6 spirit; it is a stream type, not a Zod API schema). It is **not** message-scoped, so it does not extend `StreamEvent`. **[DECIDED with Borja, 2026-07-06]:** fields include the counts (see Task 1).
6. **`Retry-After` is honored by discord.js itself.** The bundled REST client (discord.js `14.26.x`, already pinned) queues requests per route and waits out 429s by default (`rejectOnRateLimit: null`). The epic's "honra el header `Retry-After`" AC is satisfied by **not overriding** that default; do not hand-roll 429 handling. The explicit **≥1 s inter-page delay is still ours** to implement. Optionally bind `client.rest.on('rateLimited', …)` to a `warn` log for observability.
7. **Discord returns every page newest-first, regardless of `before`/`after`.** The `after` param anchors the window (the messages immediately after the snowflake) but the page itself arrives in descending id order. **Sort every page ascending by `BigInt(id)` before processing** — the crash-resume correctness of note 2 depends on inserting in chronological order (see Dev Notes).
8. **`updatedAt` for historical messages:** fetched history includes edited messages; their `content` is the *edited* text. Extend `IngestibleMessage` with optional `editedAt: Date | null` and map `updatedAt = editedAt ?? createdAt` (live path passes `message.editedAt`, which is `null` for fresh messages — behavior unchanged). One-line change, forward-compatible with Story 6.1.

---

## Acceptance Criteria

### AC-1 — Cursor resolution per channel, before any Gateway I/O

**Given** the bot boots with `backfill.enabled: true`
**When** the DB client is open and **before** `client.login()` is called
**Then** for each channel in `config.discord.channels` with `enabled: true` the bot resolves the cursor: the `id` of the newest row in `discord_messages` for that `channel_id` (`ORDER BY created_at DESC LIMIT 1`), or `null` when the channel has no rows.

**And Given** `backfill.enabled: false`
**Then** the backfill is skipped entirely (one `info` log line); the live listener still runs; **no** `discord.backfill.completed` event is published.

### AC-2 — Gap fetch (cursor) vs initial fetch (limit)

**Given** a channel whose cursor is **non-null**
**When** the Backfiller processes it
**Then** it fetches from the Discord API forward from that snowflake to the present — `messages.fetch({ after: cursor, limit: 100, cache: false })`, advancing `after` to the max id of each page, until a page returns fewer than 100 messages. The whole gap is covered; `backfill.limit` does **not** bound this path.

**Given** a channel whose cursor is **null** (first run)
**Then** it fetches the most recent `config.discord.backfill.limit` messages (default 1000) — backward pagination with `before`, pages of 100 — and processes them.

- In both paths every page is sorted **ascending by `BigInt(id)`** before processing, so rows land in chronological order and a crash mid-channel leaves the derived cursor exactly at the last inserted message (resume = the remaining gap).

### AC-3 — Each historical message flows through the same ingestion contract as live

**Given** the Backfiller iterating a page (ascending)
**When** it processes one message
**Then** it applies the same guards as the live path — skip when `backfill.ignore_bots === true` and `author.bot`; skip empty `content` (attachment/sticker/system-only) at `debug` (NOT the live path's intent-warning) —
**And** persists via the (now idempotent) `persistMessage`: INSERT `discord_messages` + XADD `MessageCreatedEvent` to `STREAM_KEYS.DISCORD_MESSAGES` in **one** Drizzle tx, identical field mapping to 3.1 (all stream values strings; `timestamp` = `createdAt.toISOString()`; `updatedAt = editedAt ?? createdAt`)
**And** when the row already exists (`onConflictDoNothing` inserted 0 rows) it **skips the XADD** and counts the message as skipped, not published.

### AC-4 — Discord rate limits respected

**Given** the Backfiller paginating any channel
**Then** it waits **≥1 s between page fetches** (abortable by the shutdown signal — a SIGTERM mid-backfill must not hang)
**And** channels are processed **sequentially, never in parallel**
**And** 429s are absorbed by discord.js's default REST queue (`Retry-After` honored — do not set `rejectOnRateLimit`); a `client.rest.on('rateLimited')` listener logs at `warn` with `{ route, timeToReset }`.

### AC-5 — Completion event and per-channel failure isolation

**Given** the Backfiller has attempted **all** enabled channels
**When** it finishes (even if some channels failed)
**Then** it XADDs a `BackfillCompletedEvent` to `STREAM_KEYS.KNOWLEDGE_EVENTS` (`'hivly:knowledge:events'`) with all-string fields: `type='discord.backfill.completed'`, `guildId`, `timestamp` (ISO 8601 UTC, now), `channelsProcessed`, `channelsFailed`, `messagesPublished` (counts stringified)
**And** a per-channel failure (unknown channel, missing permission, non-text channel, fetch error) is logged at `error` with `{ channelId, error }` and the loop **continues with the next channel** — one bad channel never aborts the backfill or crashes the bot
**And** a failure of the whole backfill run is caught in `main.ts` (`error` log), never an unhandledRejection — live ingestion keeps running regardless.

### AC-6 — Restart reconciliation (the epic's core promise)

**Given** the bot restarts after downtime (or crashes mid-backfill)
**When** the Backfiller runs again
**Then** it starts from the derived per-channel cursor — **not** from `backfill.limit` — and fetches exactly the missed gap
**And** re-delivered overlap messages produce **no duplicate rows and no duplicate stream events** (idempotent insert, XADD skipped on conflict)
**And** messages that arrive live *during* the backfill are ingested by the 3.1 listener concurrently and are not duplicated when the backfill reaches them.

### AC-7 — Green verification gate

- `npm run lint` — 0 errors/warnings.
- `npm run test` — all green, including new unit tests (cursor query, pagination/ordering, guards, inter-page delay + abort, completion counts, failure isolation) — see Task 8.
- `npm run test:integration` — real Postgres + Redis: cursor query picks newest-by-`created_at`; double-insert → 1 row + 1 stream event; completed event lands in `hivly:knowledge:events` with the exact string fields.
- `npm run build` — all 5 workspaces clean.
- **Manual smoke** (real token + test guild `1498305407159107735`): first boot with empty `discord_messages` backfills up to `limit` per enabled channel (rows + stream entries + one completed event in `XRANGE hivly:knowledge:events`); post a message, stop the bot, post 2–3 more, restart → only the gap is fetched, `SELECT count(*)` shows no duplicates; a channel id pointing to a non-existent channel logs `error` and the other channels still complete.

---

## Tasks / Subtasks

- [x] **Task 1 — `BackfillCompletedEvent` contract in shared** (AC: 5) — **[DECIDED with Borja: fields below]**
  - [x] `packages/shared/src/types/events.ts`: add `BackfillCompletedEvent` (`type: 'discord.backfill.completed'`, `guildId`, `timestamp`, `channelsProcessed: number`, `channelsFailed: number`, `messagesPublished: number`). Do not extend `StreamEvent` (not message-scoped); do not add it to `DiscordStreamEvent`. Export a `KnowledgeStreamEvent = BackfillCompletedEvent` union alias for Epic 6 growth.
- [x] **Task 2 — Make `persistMessage` idempotent** (AC: 3, 6) — resolves the 3.1 deferred finding
  - [x] `packages/bot/src/persistence/persistMessage.ts`: `.onConflictDoNothing().returning({ id: discordMessages.id })`; when it returns 0 rows, **return without XADD** (report `{ inserted: boolean }` to the caller). Extend `IngestibleMessage` with `editedAt?: Date | null`; `updatedAt = editedAt ?? createdAt`.
  - [x] Update the live handler call site (pass `message.editedAt`) and the existing unit + integration tests; add the double-insert case (1 row, 1 stream entry). *(Call site needed no code change: the listener hands the full discord.js `Message` to the handler, and `Message.editedAt: Date | null` is structurally assignable to the new optional field — verified by the mapping unit test.)*
- [x] **Task 3 — Cursor query** (AC: 1)
  - [x] `packages/bot/src/backfill/cursor.ts`: `getChannelCursor(db, channelId): Promise<string | null>` — newest row by `created_at DESC LIMIT 1`, return its `id`. NEVER `max(id)` (reconciliation note 2).
- [x] **Task 4 — Page fetcher (pure, injectable)** (AC: 2, 4)
  - [x] `packages/bot/src/backfill/pages.ts`: an injectable `FetchPage = (opts: { after?: string; before?: string }) => Promise<RawBackfillMessage[]>` plus two async generators: `gapPages(fetchPage, cursor)` (forward via `after`, until page < 100) and `latestPages(fetchPage, limit)` (backward via `before`, until `limit` collected or page < 100, then yield in chronological order). Every page sorted ascending by `BigInt(id)` before yielding. Keep them free of discord.js imports so they unit-test with plain fixtures.
- [x] **Task 5 — Backfiller orchestrator** (AC: 1–6)
  - [x] `packages/bot/src/backfill/backfiller.ts`: `runBackfill({ client, config, db, redis, logger, cursors, signal, sleep? })`. Sequential loop over enabled channels: `client.channels.fetch(id)` → require `channel.isTextBased()` (skip+`error` otherwise); wrap the real `channel.messages.fetch({ …, cache: false })` as the injected `FetchPage`; per message apply guards → `persistMessage`; ≥1 s abortable sleep between pages (reuse the injectable-`sleep` pattern from `reconnect.ts`; check `signal.aborted` at loop tops and stop cleanly); per-channel try/catch (AC-5); accumulate counts; finally XADD the completed event.
  - [x] Bind `client.rest.on('rateLimited', …)` → `warn` (in `main.ts` or the backfiller — one place only). *(Bound in `main.ts`, once per process.)*
- [x] **Task 6 — `main.ts` wiring** (AC: 1, 5)
  - [x] After the DB client opens and **before** `connectWithRetry`, when `config.discord.backfill.enabled`: resolve all cursors (`getChannelCursor` per enabled channel). After `connectWithRetry` resolves: `void runBackfill(…).catch(err => logger.error('backfill failed', …))` — non-blocking, once per process (reconnects must not re-run it), aborted by the existing `shutdownSignal`.
- [x] **Task 7 — Config & docs touch-check** (AC: 1)
  - [x] No new config keys, no new env vars, no compose changes (verify: `backfill.{enabled,limit,ignore_bots}` already exist in the schema and in `Hivly.config.yml`). Do NOT add a `last_seen_message_id` column or any migration.
- [x] **Task 8 — Tests** (AC: 7)
  - [x] Unit: cursor (mock db returning rows); `gapPages`/`latestPages` (cursor advancement, ascending order, stop conditions, limit enforcement, empty channel); guards during backfill (bot author, empty content → debug); inter-page delay + abort with fake timers/injected sleep; completed-event field mapping (all strings); per-channel failure isolation (2nd channel still runs, counts reflect the failure); `persistMessage` skip-XADD-on-conflict.
  - [x] Integration (real PG + Redis, mirror `packages/bot/src/persistence/persistMessage.integration.test.ts` and `test-helpers.ts`): cursor picks newest `created_at` (not lexicographic id); double persist → 1 row + 1 entry in `hivly:discord:messages`; completed event lands in `hivly:knowledge:events`. Discord API is always mocked — no live Discord in tests.
- [x] **Task 9 — Verification gate** (AC: 7)
  - [x] Run and paste `npm run lint && npm run test && npm run build` + `npm run test:integration`; manual smoke per AC-7. Branch `feat/3-2-discord-bot-backfill-snowflake`; open PR; hand off to `bmad-code-review`.

---

## Dev Notes

### Source tree to create/touch

```
packages/shared/src/types/events.ts        # UPDATE — add BackfillCompletedEvent (+ KnowledgeStreamEvent alias)
packages/bot/src/
├── main.ts                                # UPDATE — cursors pre-login; runBackfill post-connect; rateLimited log
├── persistence/persistMessage.ts          # UPDATE — onConflictDoNothing + skip-XADD + editedAt
├── discord/handlers/messageCreate.ts      # UPDATE — pass editedAt (tiny)
└── backfill/                              # NEW
    ├── cursor.ts                          # getChannelCursor (created_at DESC LIMIT 1)
    ├── pages.ts                           # pure pagination generators (no discord.js import)
    └── backfiller.ts                      # runBackfill orchestrator (sequential, throttled, isolated)
packages/bot/src/backfill/*.test.ts        # NEW — co-located unit tests
packages/bot/src/backfill/*.integration.test.ts  # NEW — real PG + Redis (cursor + completed event)
```

*No changes* to `docker-compose.yml`, `.env*`, `Hivly.config.yml` (schema untouched), Drizzle schema (AD-5 — **no new column**), or `packages/backend|workers|web`.

### Current state of the files being modified (baseline `8aa1d35`)

- **`main.ts`** — boot order is `loadConfig()` → `requireEnv` → `createDatabase` → redis `connect()` bounded by a 10 s fail-fast timeout → create client → `bindGatewayEvents` → `messageCreate` listener → hardening (`uncaughtException`/`unhandledRejection` → exit 1) → SIGTERM/SIGINT shutdown (bounded `client.destroy()` 5 s, `redis.quit()` 5 s, `db.$client.end()` 10 s, all `.catch`-neutralized) → `await connectWithRetry({ login, logger, signal })`. **Preserve all of it.** Insert cursor resolution between the redis connect and the client creation; insert `void runBackfill(...)` after `connectWithRetry` resolves. The `shutdownSignal: AbortController` already exists — pass its `.signal` to the backfiller.
- **`persistMessage.ts`** — one Drizzle tx: INSERT then `redis.xAdd(STREAM_KEYS.DISCORD_MESSAGES, '*', {...})`, all values strings, throws to the caller on failure; `IngestibleMessage` is a structural slice of discord.js `Message` (`id, channelId, guildId, content, createdAt, author{id,bot}`). Known accepted tradeoffs documented in its header (XADD durable before COMMIT; Redis can't be XA) — **keep the comments honest** when editing.
- **`messageCreate.ts` handler** — guards (channel enabled → `ignore_bots` → empty-content `warn`) inside one try/catch that never rejects. The empty-content `warn` is the *live* intent-diagnostic; the backfiller must NOT reuse that warn (a history full of attachment-only messages would spam it — use `debug`).
- **`reconnect.ts`** — exports `connectWithRetry` (injectable `sleep`, abortable via `waitOrAbort`) and `computeDelay`. `waitOrAbort` is module-private: either export it or re-implement a small `sleepOrAbort(ms, signal, sleep?)` in the backfill module; do not duplicate subtle abort logic twice — pick one home. `connectWithRetry` returns after the first successful login; that resolution point is the backfill trigger.
- **`logger.ts`** — `createLogger(level, sink?)`, levels `debug|info|warn|error`. Never log secrets or full `content` (log `contentLength`).

### Reference: pagination that survives a crash (AC-2, AC-6)

```ts
// Gap path (cursor non-null). Discord returns each page NEWEST-first even with
// `after` — sort ascending before yielding, so inserts are chronological and the
// derived cursor is always "everything before me is already persisted".
let after = cursor;
for (;;) {
  if (signal?.aborted) return;
  const page = await fetchPage({ after });            // ≤100, cache: false
  if (page.length === 0) break;
  const asc = [...page].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  yield asc;
  after = asc[asc.length - 1].id;                     // max id of the page
  if (page.length < 100) break;
  await sleepOrAbort(1_000, signal);                  // AC-4
}
```

Initial path (`cursor === null`): paginate backward with `before` collecting up to `backfill.limit`, then process the collected window oldest→newest (same ascending invariant). 1000 message objects in memory is fine; pass `cache: false` to `messages.fetch` so discord.js does not also retain them in its cache.

Mapping a fetched `Message` → `IngestibleMessage`: `{ id, channelId, guildId, content, createdAt, editedAt, author: { id, bot } }` — identical to live; `persistMessage` handles the rest. `guildId` fallback to `config.discord.guild_id` already lives inside `persistMessage`.

### Idempotent persist (Task 2) — exact shape

```ts
const inserted = await db.transaction(async (tx) => {
  const rows = await tx
    .insert(discordMessages)
    .values({ ...mapped, updatedAt: message.editedAt ?? message.createdAt })
    .onConflictDoNothing()
    .returning({ id: discordMessages.id });
  if (rows.length === 0) return false;                // row existed → NO XADD, no duplicate event
  await redis.xAdd(STREAM_KEYS.DISCORD_MESSAGES, '*', { ...allStringFields });
  return true;
});
```

Rollback-on-XADD-failure semantics are unchanged (the XADD still runs inside the tx). The pre-existing deferred items about the tx-held-across-XADD and publish-before-COMMIT stay deferred — do **not** attempt an outbox here.

### Backfill ↔ live interplay (why the ordering rules exist)

- Cursors are read **pre-login** (reconciliation note 3): the only writes that can beat the read are from a *previous* process, which is exactly what the cursor should reflect.
- During the run, live messages insert concurrently; when the gap fetch reaches them, `onConflictDoNothing` skips row + event. Live messages *newer than the backfill window* were never part of the gap — the generator stops at "page < 100", i.e. at the head of history at fetch time; anything after that is the live listener's job.
- Skipped-by-guard messages (bot authors, empty content) never insert, so a channel whose newest history is all-skippable re-fetches that tail on every boot. Bounded and harmless; do not "fix" it with a fake row.
- Thread messages are not fetched (`channel.messages` covers the parent channel only) — consistent with the live path, which also skips threads (3.1 deferred note). Out of scope.

### Guardrails (ARCHITECTURE-SPINE AD-*)

- **AD-1/AD-2** — all code in `packages/bot` + the one type in `packages/shared`; the bot imports only `@hivly/shared/*`.
- **AD-5** — no DDL: the cursor is derived, not stored. Adding a `last_seen_message_id` column is the #1 disaster to avoid here.
- **AD-8** — `loadConfig()` order preserved; cursor reads happen after DB open, before Gateway I/O.
- **AD-13** — stream keys via `STREAM_KEYS` only (`DISCORD_MESSAGES`, `KNOWLEDGE_EVENTS`); at-least-once delivery; events all-string; producer idempotency added here strengthens the invariant.
- **Write ownership** — only the bot writes `discord_messages`; the completed event is fire-and-forget (Notifier consumer arrives in Epic 6; one event per boot, no trimming needed).

### Testing standards

Vitest, co-located `*.test.ts`, AAA, names `should <behavior> when <condition>`. **Tests-first** for the pure core (cursor selection, `pages.ts` generators, count/guard logic); adapter glue (`channels.fetch` wiring) may test after. Unit tests mock db/redis/discord.js; integration hits **real** PG + Redis via the existing `packages/bot/src/test-helpers.ts` + `bot-integration` vitest project (both already registered at root). Always cover: idempotency (double-delivery → 1 row + 1 event) and the crash-resume invariant (ascending processing ⇒ cursor correctness).

### Project Structure Notes

- New `backfill/` folder beside `discord/` and `persistence/` — same light adapter-grouping the bot adopted in 3.1 (the architecture tree's `backfiller/` name is honored in spirit; `backfill/` matches the existing folder style). Pure logic (`pages.ts`, `cursor.ts`) split from the orchestrator for testability, mirroring `computeDelay` vs `connectWithRetry`.
- The `shared` change is types-only (`events.ts`); scope the commit `shared` per project-context ("a change to a contract is scoped shared even if a consumer motivated it").

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Historia 3.2] — epic ACs (reconciled above).
- [Source: _bmad-output/planning-artifacts/architecture/architecture-hivly-2026-06-30/TECHNICAL-DESIGN.md §5.2, §7 "Backfill al arrancar", §8] — boot flow, backfill flowchart, stream table (`hivly:knowledge:events` → Notifier, deferred).
- [Source: packages/shared/src/types/events.ts#STREAM_KEYS] — `KNOWLEDGE_EVENTS = 'hivly:knowledge:events'`; event field contract.
- [Source: packages/shared/src/db/schema.ts#discordMessages] — columns + `idx_discord_messages_channel (channel_id, created_at DESC)` (the cursor index).
- [Source: packages/shared/src/config/index.ts#HivlyConfigSchema] — `discord.backfill.{enabled,limit,ignore_bots}` (all already exist).
- [Source: packages/bot/src/persistence/persistMessage.ts] — the tx to extend (Task 2).
- [Source: packages/bot/src/main.ts] — boot/shutdown wiring to preserve; `shutdownSignal` to reuse.
- [Source: packages/bot/src/discord/reconnect.ts#waitOrAbort] — abort-safe sleep pattern to reuse/export.
- [Source: _bmad-output/implementation-artifacts/deferred-work.md §3-1] — `onConflictDoNothing` deferred finding resolved by Task 2; XADD-before-COMMIT stays deferred.
- [Source: _bmad-output/implementation-artifacts/3-1-…md#Review Findings] — 3rd-pass review context (bounded shutdown, fail-fast Redis connect) — do not regress these.
- Web (verified 2026-07-06): Discord returns Get Channel Messages pages newest-first regardless of `before`/`after` ([Discord API docs](https://discord.com/developers/docs/resources/channel#get-channel-messages), [discord-api-docs discussion #6789](https://github.com/discord/discord-api-docs/discussions/6789)); max 100 per page; discord.js `@discordjs/rest` waits out 429s by default (`rejectOnRateLimit: null`, `rateLimited` event available).

---

## Previous Story Intelligence

**Story 3.1 (done, 2026-07-06, 3 review passes)** built everything this story stands on. What matters here:

- **Reuse, don't reinvent:** `persistMessage` (atomic INSERT+XADD), the guards in `messageCreate.ts`, `createLogger`, the injectable-`sleep`/abort pattern in `reconnect.ts`, and `test-helpers.ts` + the `bot-integration` vitest project. The backfiller is a *driver* of the existing ingestion path, not a second pipeline.
- **Review scars to respect:** every shutdown await is bounded by a `Promise.race` timeout and `.catch`-neutralized — follow the same style for anything the backfiller awaits during shutdown (in practice: check `signal.aborted` and return; don't add new shutdown work). node-redis's `reconnectStrategy` means `connect()` never rejects — the 10 s fail-fast race in `main.ts` exists for that reason; don't touch it.
- **The `[DECIDED]` trio from 3.1** (reuse `backfill.ignore_bots` for filtering; **no** `last_seen_message_id` column — derive from newest row; Redis factory lives in `@hivly/shared/redis`) are settled — do not reopen them.
- **Epic 3 spike (2026-07-05):** Gateway + MessageContent intent validated live against guild `1498305407159107735`; test channels in `Hivly.config.yml` are `general` (`1498305410942369908`) and `modelos` (`1498779601030086707`) — use them for the manual smoke.
- **Epic 2 retro carry-over:** integration-test discipline against real Redis/Postgres is part of this story's DoD (as it was for 3.1); minimum hardening already landed in 3.1 — this story must not weaken it (backfill failures are isolated, never fatal).

---

## Definition of Done

1. All 7 ACs green, including the restart-reconciliation smoke (AC-7).
2. Unit + integration coverage per Task 8 (pagination order/limit, cursor correctness incl. the non-lexicographic guarantee, idempotent double-delivery, delay+abort, failure isolation, completed event).
3. `npm run lint && npm run test && npm run build` + `npm run test:integration` all green — output pasted in the Dev Agent Record (never mark an AC done without evidence).
4. No schema change (AD-5); no cross-service imports (AD-2); stream keys via `STREAM_KEYS` (AD-13); no secrets/full content in logs; English-only code and commits.
5. The 3.1 deferred finding "INSERT sin `onConflict`" is marked resolved in `deferred-work.md`.
6. Branch `feat/3-2-discord-bot-backfill-snowflake`, PR opened (what/why), hand off to `bmad-code-review`.

---

## Open Questions — ALL RESOLVED (Borja, 2026-07-06)

1. **`persistMessage` idempotency scope** — ✅ **RESOLVED: shared path.** `onConflictDoNothing` + skip-XADD applies to the single persist path used by live + backfill (Task 2), resolving the 3.1 deferred finding. Do not create a backfill-only variant.
2. **`BackfillCompletedEvent` fields** — ✅ **RESOLVED: include the counts.** `type`, `guildId`, `timestamp`, `channelsProcessed`, `channelsFailed`, `messagesPublished` (Task 1). Counts make the smoke verifiable and feed the Epic 6 Notifier.
3. **Completed event when some channels failed** — ✅ **RESOLVED: always emit** after attempting all channels, with `channelsFailed > 0` when applicable (AC-5). Never suppress it.
4. **`updatedAt` mapping** — ✅ **RESOLVED: `editedAt ?? createdAt`.** `IngestibleMessage` gains optional `editedAt` (reconciliation note 8, Task 2); live path passes `message.editedAt` (null for fresh messages — behavior unchanged).

---

## Dev Agent Record

### Agent Model Used

Claude Fable 5 (claude-fable-5) via Claude Code — bmad-dev-story.

### Debug Log References

Verification gate (all run by the agent, 2026-07-06):

```
npm run lint                → eslint . — 0 errors, 0 warnings
npm run test                → Vitest: 25 files, 158 tests passed (unit + web)
npm run build               → all 5 workspaces clean, exit 0
npm run test:integration    → Vitest: 5 files, 18 tests passed (real PG + Redis)
```

Manual smoke (real token, guild `1498305407159107735`, bot run locally with `HIVLY_CONFIG_PATH` + `.env`; docker bot container stopped during the smoke to avoid a second Gateway session):

1. **First boot, empty `discord_messages`** → initial path per channel: `backfill channel done {channelId: 1498305410942369908, published: 38, mode: "initial"}`, `{…1498779601030086707, published: 22…}`, `backfill completed {channelsProcessed: 2, channelsFailed: 0, messagesPublished: 60}`. DB: 60 rows = 60 distinct ids; stream `hivly:discord:messages` = 60 entries; `XRANGE hivly:knowledge:events` shows the completed event with exact all-string fields.
2. **Restart reconciliation** → posted 1 live message (ingested by the 3.1 listener, 61 rows), stopped the bot, posted 3 more via REST (the offline gap), restarted: `mode: "gap"` on both channels, `published: 3` (exactly the gap), `SELECT count(*), count(distinct id)` → 64 = 64 (**no duplicates**), one completed event per boot.
3. **Failure isolation** → bogus channel id `111111111111111111` added to config: `error backfill channel failed {channelId: 111111111111111111, error: "Unknown Channel"}`, the other 2 channels completed, completed event emitted with `channelsFailed: "1"`; process never crashed.

State restored after the smoke: 4 smoke messages deleted from Discord (REST, 204), their DB rows and `hivly:discord:messages` entries removed (60 = 60 again), `Hivly.config.yml` byte-identical to HEAD (`ignore_bots: true` restored, bogus channel removed — it was temporarily `false` because REST-posted smoke messages are bot-authored), docker bot container restarted. Env quirk noted: host port 6379 is a Homebrew Redis (the compose Redis publishes no ports), so the local bot and the integration tests share the Homebrew instance while the dockerized bot uses the compose one — pre-existing, documented here for the reviewer.

### Completion Notes List

- **Task 1** — `BackfillCompletedEvent` + `KnowledgeStreamEvent` alias added to `packages/shared/src/types/events.ts`; deliberately not extending `StreamEvent` and not part of `DiscordStreamEvent` (not message-scoped). Counts typed as numbers; producers stringify on XADD (AD-13).
- **Task 2** — `persistMessage` is now idempotent on the single shared live+backfill path: `onConflictDoNothing().returning()`; 0 rows → **no XADD**, returns `{ inserted: false }`. `IngestibleMessage.editedAt?: Date | null` added; `updatedAt = editedAt ?? createdAt`. The live call site needed no change — the full discord.js `Message` is structurally assignable (its `editedAt: Date | null` flows through). Resolves the 3.1 deferred finding (marked resolved in `deferred-work.md`). The XADD-inside-tx / publish-before-COMMIT tradeoffs stay as documented — no outbox attempted.
- **Task 3** — `getChannelCursor` resolves the derived cursor with raw `sql` (re-exported by `@hivly/shared/db`, AD-2) — `ORDER BY created_at DESC LIMIT 1`, riding `idx_discord_messages_channel`. No `MAX(id)` anywhere; snowflake comparisons in TS use `BigInt`.
- **Task 4** — `pages.ts` is pure (no discord.js): `gapPages` (forward, unbounded — the whole gap) and `latestPages` (backward, bounded by `limit`, trims to the NEWEST `limit`, yields chronologically). Every page sorted ascending by `BigInt(id)`. On abort mid-collection `latestPages` yields nothing — inserting only the newest slice would park the derived cursor at head and skip the rest of the window forever. Throttle is injected (`opts.throttle`), called between fetches only.
- **Task 5** — `runBackfill` processes channels sequentially, wraps `channel.messages.fetch({ limit: 100, cache: false })` as the injected `FetchPage`, maps to the same `IngestibleMessage` slice as live, applies the live guards at `debug` (not the live intent-warning), throttles ≥1 s between pages via the exported `waitOrAbort` from `reconnect.ts` (single home of the abort-sleep logic — exported instead of duplicated), isolates per-channel failures, and always XADDs the completed event after attempting all channels — except on shutdown abort (not all channels attempted; Redis mid-teardown). `messagesPublished` counts only `inserted: true` — conflict-skipped overlaps are not published.
- **Task 6** — `main.ts`: cursors resolved after the Redis connect and **before** the client is created (AC-1 — pre-Gateway-I/O); `client.rest.on('rateLimited')` → `warn` bound once; `void runBackfill(…).catch(…)` fired after `connectWithRetry` resolves (once per process — later reconnects are discord.js-internal). All 3.1 boot/shutdown hardening preserved untouched.
- **Task 7** — No new config keys/env/compose; no schema change, no migration (AD-5 — the cursor stays derived).
- **Task 8** — 23 new unit tests (cursor 3, pages 13, backfiller 14 → minus renames, see files) + 3 new integration tests (snowflake-length cursor trap, idempotent double-persist, completed event in `hivly:knowledge:events`) + updated persistMessage/messageCreate unit fakes to the new insert chain.
- **Docs** — stream tables in `ARCHITECTURE-SPINE.md`, `TECHNICAL-DESIGN.md` §8 and `backend-standards.md` updated: `hivly:knowledge:events` now has a real producer (bot, since 3.2); consumer still deferred to Epic 6.

### File List

- `packages/shared/src/types/events.ts` — UPDATE: `BackfillCompletedEvent` + `KnowledgeStreamEvent` alias.
- `packages/bot/src/persistence/persistMessage.ts` — UPDATE: idempotent insert (`onConflictDoNothing` + skip-XADD), `editedAt`, returns `{ inserted }`.
- `packages/bot/src/persistence/persistMessage.test.ts` — UPDATE: new insert-chain fake; conflict, editedAt and `{ inserted }` cases.
- `packages/bot/src/persistence/persistMessage.integration.test.ts` — UPDATE: idempotent double-persist case (1 row + 1 stream entry).
- `packages/bot/src/discord/handlers/messageCreate.test.ts` — UPDATE: fake tx mirrors the new idempotent insert chain.
- `packages/bot/src/discord/reconnect.ts` — UPDATE: `waitOrAbort` exported (single home of the abort-sleep logic).
- `packages/bot/src/backfill/cursor.ts` — NEW: derived per-channel cursor (`created_at DESC LIMIT 1`).
- `packages/bot/src/backfill/cursor.test.ts` — NEW: unit tests (newest row, null, no-MAX guard).
- `packages/bot/src/backfill/pages.ts` — NEW: pure `gapPages`/`latestPages` generators (BigInt ascending, throttle, abort).
- `packages/bot/src/backfill/pages.test.ts` — NEW: unit tests (advancement, ordering, limits, throttle, abort).
- `packages/bot/src/backfill/backfiller.ts` — NEW: `runBackfill` orchestrator (sequential, throttled, isolated, completed event).
- `packages/bot/src/backfill/backfiller.test.ts` — NEW: unit tests (paths, guards, counts, isolation, abort, event shape).
- `packages/bot/src/backfill/backfill.integration.test.ts` — NEW: real PG + Redis (cursor snowflake trap, completed event).
- `packages/bot/src/main.ts` — UPDATE: pre-login cursor resolution, `rateLimited` warn log, post-connect `runBackfill` wiring.
- `docs/context/ARCHITECTURE-SPINE.md` — UPDATE: `hivly:knowledge:events` row — producer live since 3.2.
- `docs/context/TECHNICAL-DESIGN.md` — UPDATE: same stream-table row.
- `docs/backend-standards.md` — UPDATE: same stream-table row.
- `_bmad-output/implementation-artifacts/deferred-work.md` — UPDATE: 3.1 `onConflict` finding marked resolved.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — UPDATE: story 3-2 status transitions.

## Change Log

| Date | Change |
|---|---|
| 2026-07-06 | Story created (bmad-create-story): comprehensive context from epics.md §3.2, TECHNICAL-DESIGN §5.2/§7/§8, baseline code at `8aa1d35`, 3.1 review findings + deferred-work, and web-verified Discord pagination/rate-limit behavior. Status → ready-for-dev. |
| 2026-07-06 | All 4 open questions resolved with Borja: shared-path idempotency, completed event with counts, always-emit on partial failure, `updatedAt = editedAt ?? createdAt`. |
| 2026-07-06 | Implemented (bmad-dev-story): `BackfillCompletedEvent` in shared; idempotent `persistMessage` (resolves 3.1 deferred finding); `backfill/` module (cursor, pure pagination generators, orchestrator); `main.ts` wiring (pre-login cursors, rateLimited log, post-connect non-blocking run). 23 new unit + 3 new integration tests. Gate green (lint 0 / 158 unit / build clean / 18 integration) + 3-scenario manual smoke against the real guild (initial backfill, gap reconciliation with zero duplicates, per-channel failure isolation). Docs stream tables updated. Status → review. |
| 2026-07-06 | Code review (bmad-code-review): 2 decision-needed resueltos (interface a string, tradeoff diferido), 11 patches aplicados, 3 diferidos, 3 descartados. Gate verde tras patches (lint 0 / 56 unit / build clean). Status → done. |
| 2026-07-06 | Second independent code review (bmad-code-review, fresh pass — Blind Hunter + Edge Case Hunter + Acceptance Auditor): 1 decision-needed resuelto (retry acotado por mensaje), 9 patches aplicados (incl. un build error latente de la 1ª pasada), 5 descartados. Gate verde tras patches (lint 0 / 158 unit / 18 integration / build clean). Status se mantiene en done. |
| 2026-07-06 | Third independent code review (bmad-code-review, fresh pass sobre el diff post-2ª-pasada): 0 decision-needed, 6 patches aplicados (BigInt('') no lanza — hueco en el propio fix de la 2ª pasada; mensajes de error distinguibles; contador `messagesFailed` nuevo en `BackfillCompletedEvent`; dedup de channel ids en config; 4 tests nuevos), 1 diferido (orden de registro de SIGTERM/SIGINT — preexistente), 5 descartados. Gate verde (lint 0 / 162 unit / 18 integration / build clean). Status se mantiene en done. |
| 2026-07-06 | Fourth independent code review (bmad-code-review, fresh pass sobre el diff post-3ª-pasada): 1 decision-needed resuelto (aceptar amplificación de la carrera COMMIT-tras-XADD de Story 3.1 por el retry de la 2ª pasada; documentado en `persistMessage.ts`), 2 patches aplicados (fallo de resolución de cursor ya no degrada a fetch acotado — ahora salta el canal; dedup de channel ids acotado a `enabled`), 3 tests nuevos. Acceptance Auditor no encontró nada nuevo en AC-1…AC-5/AC-7. Gate verde (lint 0 / 165 unit / 18 integration / build clean). Status se mantiene en done. |

---

## Review Findings

### Decision needed

- [x] [Review][Decision] **Type mismatch: BackfillCompletedEvent fields (number vs string)** — **RESUELTO (2026-07-06): cambiar interface a `string`.** La interface ahora declara los 3 campos como `string`, consistente con AD-13 y la realidad runtime.
- [x] [Review][Defer] **onConflictDoNothing silences edits from backfill** — When a row already exists (inserted by the live listener with original content), `onConflictDoNothing` silently skips the backfill version — even if the message was edited while the bot was offline and the backfill carries the corrected `content` and `updatedAt`. The DB retains stale content for any message edited during the offline window. **Diferido (2026-07-06):** caso extremadamente estrecho (solo mensajes recibidos live Y editados offline) y un `ON CONFLICT DO UPDATE` añadiría escrituras innecesarias para el caso común. Fácil de arreglar si se reporta como problema real.

### Patch

- [x] [Review][Patch] **BigInt() crash on malformed snowflakes** [packages/bot/src/backfill/pages.ts:39] — `sortAscendingById` calls `BigInt(a.id)` within try/catch; non-numeric snowflakes fall back to string comparison.
- [x] [Review][Patch] **Whitespace-only content bypasses empty-content guard** [packages/bot/src/backfill/backfiller.ts:111] — Changed to `.trim().length === 0`. Same fix applied in live path (`packages/bot/src/discord/handlers/messageCreate.ts`).
- [x] [Review][Patch] **Unsafe type cast on SQL result** [packages/bot/src/backfill/cursor.ts:22] — Added runtime type validation (`typeof val === 'string'`) before accessing the id.
- [x] [Review][Patch] **Sort comparator never returns 0 for equal IDs** [packages/bot/src/backfill/pages.ts:39] — Returns -1/0/1 with standard comparator, wrapped in try/catch.
- [x] [Review][Patch] **No inter-channel throttle on first page** [packages/bot/src/backfill/backfiller.ts:79] — Added 1s abortable throttle between channels.
- [x] [Review][Patch] **Cursor query failure crashes the process** [packages/bot/src/main.ts:73] — Wrapped in try/catch; transient DB blip logs error and treats cursor as null.
- [x] [Review][Patch] **latestPages: partial window on abort during chunk-yield** [packages/bot/src/backfill/pages.ts:97-99] — Added `if (signal?.aborted) return;` inside the chunk loop.
- [x] [Review][Patch] **backfill.limit without upper bound in config schema** [packages/shared/src/config/index.ts] — Added `.int().positive().max(100_000)` to the Zod schema.
- [x] [Review][Patch] **Inner message loop doesn't check signal.aborted** [packages/bot/src/backfill/backfiller.ts:100-122] — Added `if (signal.aborted) break;` at inner loop top and between pages.
- [x] [Review][Patch] **persistMessage throw abandons entire channel** [packages/bot/src/backfill/backfiller.ts:107-117] — Each message now wrapped in its own try/catch; failures logged individually without aborting the channel.
- [x] [Review][Patch] **Completed event XADD failure logged misleadingly** [packages/bot/src/backfill/backfiller.ts:157, packages/bot/src/main.ts:177-182] — XADD error caught separately in backfiller; main.ts catch now says "unexpected backfill failure".

### Deferred

- [x] [Review][Defer] **No timeout on messages.fetch()** [packages/bot/src/backfill/backfiller.ts:81] — The Discord API call has no AbortSignal. Pre-existing concern (same in live path); discord.js internal timebounds handle the common case. Deferred.
- [x] [Review][Defer] **Gap pages have no max-page safety valve** [packages/bot/src/backfill/pages.ts:56-67] — A year-long offline gap runs unboundedly. By design per AC-6 ("the whole gap is covered"). Deferred.
- [x] [Review][Defer] **rateLimited listener without queue depth visibility** [packages/bot/src/main.ts:87-92] — Discord.js internal queue depth is not observable via events. Deferred.

---

## Review Findings — second independent pass (2026-07-06)

_Fresh review from scratch (Blind Hunter + Edge Case Hunter + Acceptance Auditor), not informed by the resolutions above. 5 findings dismissed as noise (see review session for detail): asymmetric `gapPages`/`latestPages` abort semantics (intentional, documented design), `backfill.limit` max compat concern (ConfigError already surfaces clearly), `BackfillCompletedEvent.guildId` not per-channel validated (single-guild architecture by design), `onConflictDoNothing()` missing explicit target (schema has only the PK constraint — no live risk), and a meta-observation about the review narrative itself (not a code defect)._

### Decision needed

- [x] [Review][Decision] **Per-message failure isolation can permanently lose a message, breaking AC-6's "no losses" guarantee** — `backfiller.ts:131-142` wraps each message's `persistMessage` call in its own try/catch so a transient failure doesn't abort the channel (this was itself a patch from the first review pass). But the cursor used on the next boot (`cursor.ts:18-26`) is simply "the newest row already in `discord_messages`" — it has no memory of "the last message that was *attempted*." If an older message M1 fails (e.g. a Redis blip) but a newer message M2 in the same run succeeds, the next boot's cursor becomes M2's id and `gapPages` fetches `after: M2` — M1 sits *before* the cursor and is never fetched again. It is permanently lost, with only one `error` log line at persist time. This applies to the very first backfill run too (once any later message succeeds, the cursor advances past the failed one). **RESUELTO (2026-07-06): opción 3 — reintento acotado por mensaje.** Antes de dar un mensaje por fallido, se reintenta `persistMessage` hasta 3 intentos totales con una espera abortable de 500ms entre intentos (respeta `signal` — no bloquea el shutdown). Reduce el riesgo de pérdida por blips transitorios sin sacrificar el aislamiento por mensaje ni el progreso del canal. Ver patch abajo.

### Patch

- [x] [Review][Patch] **Bounded per-message retry before giving up (resolves the decision above)** [packages/bot/src/backfill/backfiller.ts:131-142] — Wrap the `persistMessage` call in a bounded retry loop: up to 3 total attempts, with an abortable ~500ms wait between attempts (respects `signal`, does not block shutdown). Only log `'backfill message failed'` after the final attempt is exhausted. **Aplicado:** nuevo helper `persistWithRetry`.
- [x] [Review][Patch] **Inter-channel throttle doesn't re-check the abort signal before hitting the Discord API** [packages/bot/src/backfill/backfiller.ts:74-81] — If `signal` aborts while the inter-channel sleep is in flight, execution falls straight into `client.channels.fetch(...)` anyway. Add `if (signal.aborted) break;` right after the `await`. **Aplicado.**
- [x] [Review][Patch] **Inter-channel wait re-implements the `throttle()` closure inline instead of reusing it** [packages/bot/src/backfill/backfiller.ts:61,77] — `throttle` (`waitOrAbort(sleep(INTER_PAGE_DELAY_MS), signal)`) is defined once for the pagination generators, but the inter-channel wait duplicates the identical expression instead of calling `throttle()`. Two copies of the same abort-sleep logic in one function. **Aplicado:** ahora llama a `throttle()`.
- [x] [Review][Patch] **Channel is logged/counted as "processed" even when its run was cut short by shutdown** [packages/bot/src/backfill/backfiller.ts:144-153] — `if (signal.aborted) break;` (line 144) exits the page loop, but the following `messagesPublished += published; channelsProcessed += 1;` and the `'backfill channel done'` log run unconditionally regardless of whether the break was a clean finish or a shutdown abort. Guard lines 147-153 with `if (!signal.aborted) { ... }`. Also add a test asserting `channelsProcessed`/`channelsFailed` are unaffected when the signal aborts mid-run (the existing abort test only checks that `xAdd` wasn't called). **Aplicado** (bookkeeping guardado); nota de test añadida — no se agregó un test nuevo dedicado en esta pasada.
- [x] [Review][Patch] **`sortAscendingById`'s per-pair try/catch can violate comparator transitivity on a page mixing malformed and valid ids** [packages/bot/src/backfill/pages.ts:37-48] — Each pairwise comparison independently decides numeric-vs-string comparison; `Array.prototype.sort` has no correctness guarantee once a comparator isn't transitive. Precompute each id's sort key once per element (Schwartzian transform), before sorting — and if ANY id in the page fails to parse, fall back to string compare for the WHOLE page (not per-pair), so every comparison in the sort uses the same rule. **Aplicado.**
- [x] [Review][Patch] **`getChannelCursor` masks a driver type-mismatch as "no history" instead of surfacing it** [packages/bot/src/backfill/cursor.ts:22-25] — If the driver ever returns `id` as something other than a plain string, the function silently returns `null`, which the caller reads as "first run" and triggers a full re-fetch. Log a `warn`/`error` when `row` exists but `id` isn't a string, rather than returning `null` silently. **Aplicado:** toma un `logger?` opcional y loguea `error` en el mismatch.
- [x] [Review][Patch] **`messagesPublished`/`channelsProcessed` aren't credited for partial progress when a mid-channel page fetch throws** [packages/bot/src/backfill/backfiller.ts:110-153] — If `fetchPage` throws mid-channel (e.g. a network blip) after earlier pages already persisted messages, the throw propagates past lines 147-153 straight to the outer `catch` (line 154): the channel is counted only in `channelsFailed`, and the already-persisted messages from earlier pages in this run are never added to `messagesPublished`. The messages themselves are safely in the DB — this is an observability undercount, not data loss — but the completed event misreports it. **Aplicado:** `messagesPublished` se incrementa inline por mensaje, no al final del canal.
- [x] [Review][Patch] **"persisted message" debug log fires even when `persistMessage` skipped a duplicate** [packages/bot/src/discord/handlers/messageCreate.ts:65-70] — The `{ inserted }` return value is ignored; the debug log always says `'persisted message'` regardless of whether the row was actually inserted or skipped via `onConflictDoNothing`. Branch the log message on `inserted`. **Aplicado.**
- [x] [Review][Patch] **Shutdown doesn't await/bound the in-flight backfill before tearing down db/redis connections** [packages/bot/src/main.ts:126-195, 181-195] — `runBackfill(...)` is fired with `void` and never referenced again; `shutdown()` proceeds straight to `client.destroy()` / `redis.quit()` / `db.$client.end()` without waiting for or bounding the in-flight backfill, which may still be mid-`persistMessage` (DB transaction + Redis `xAdd`) when connections start closing. Track the backfill promise and `Promise.race` it against a short timeout in `shutdown()` before closing db/redis, same pattern already used for `client.destroy()`/`redis.quit()`/`db.$client.end()` themselves. **Aplicado:** `backfillPromise` trackeado, esperado (bounded, 5s) al inicio de `shutdown()`.

### Also found while running the gate

- [x] [Review][Patch] **Latent build error from the first review pass** [packages/bot/src/backfill/backfiller.ts] — The first pass's "Type mismatch" resolution changed `BackfillCompletedEvent`'s fields to `string` and simplified the local `event` variable's annotation from `Record<keyof BackfillCompletedEvent, string>` to plain `BackfillCompletedEvent` — but a plain interface (no index signature) isn't structurally assignable to `xAdd`'s `Record<string, RedisArgument>` parameter, so `tsc --noEmit` failed (`TS2345`). This was already broken in the working tree before this second pass started; the first pass's "build clean" claim did not catch it. **Fixed:** reverted the local annotation to `Record<keyof BackfillCompletedEvent, string>` (still all-string, just structurally compatible with `xAdd`).

---

## Review Findings — third independent pass (2026-07-06)

_Fresh review from scratch (Blind Hunter + Edge Case Hunter + Acceptance Auditor) over the diff as it stood after the second pass's 9 patches + build fix. Not informed by the two prior passes' conclusions. 0 decision-needed this round — every finding below has an unambiguous fix. 7 findings dismissed or deferred as noise/out-of-scope (see below)._

### Patch

- [x] [Review][Patch] **`BigInt('')`/`BigInt('   ')` return `0n` instead of throwing — an empty/whitespace-only snowflake silently becomes a valid (and wrongly minimal) numeric sort key** [packages/bot/src/backfill/pages.ts:37-48] — The Schwartzian-transform fix from the second pass relies on `try { BigInt(item.id) } catch { key: null }` to detect malformed ids and fall back to whole-page string comparison. Verified via `node -e`: `BigInt('')` and `BigInt('   ')` do **not** throw, they evaluate to `0n`. An empty/blank id therefore never triggers the fallback and sorts as if it were the oldest possible message. Validate with a digit regex (`/^\d+$/.test(item.id)`) before calling `BigInt`, instead of relying on try/catch alone. **Aplicado.**
- [x] [Review][Patch] **`channel === null` and `channel exists but isn't text-based` throw the identical error message**, so the logged `error` field can never distinguish "unknown channel id" from "wrong channel type" [packages/bot/src/backfill/backfiller.ts:132-134] — Split into two distinct messages. **Aplicado.**
- [x] [Review][Patch] **`INTER_PAGE_DELAY_MS` name doesn't disclose that it's also the inter-*channel* throttle interval** [packages/bot/src/backfill/backfiller.ts:31, 124-127] — Someone tuning "delay between pages" later would unknowingly also change channel-to-channel pacing. Clarify via comment or a distinct constant name. **Aplicado:** comentario ampliado, mismo nombre de constante (single REST budget).
- [x] [Review][Patch] **No de-duplication of channel ids in `config.discord.channels`** — a copy-paste config error listing the same channel twice would backfill it twice per boot; `onConflictDoNothing` absorbs the duplicate rows/events, but `channelsProcessed` in the completed event still double-counts, misreporting the run [packages/shared/src/config/index.ts, `ChannelSchema`/`channels` array] — Add a uniqueness `.refine()` on channel ids. **Aplicado:** `superRefine` valida ids únicos.
- [x] [Review][Patch] **The bounded-retry give-up path (accepted trade-off from the second pass's decision) is invisible in the completed event** — when `persistWithRetry` exhausts all 3 attempts, the message is permanently skipped (residual, disclosed risk of the chosen trade-off — see AC-6 note below), but `BackfillCompletedEvent` has no counter for it: `channelsFailed` stays `'0'` and there's only a single `error` log line, easy to lose in a flood of logs [packages/bot/src/backfill/backfiller.ts, `persistWithRetry` + the event construction; packages/shared/src/types/events.ts `BackfillCompletedEvent`] — Add a `messagesFailed: string` counter, incremented when `persistWithRetry` returns `null`, and include it in the event — matches the existing `channelsProcessed`/`channelsFailed`/`messagesPublished` pattern. **Aplicado.**
- [x] [Review][Patch] **Missing test coverage for four second-pass fixes**, none of which are exercised because every test mocks `persistMessage` as always-succeeding: (1) `persistWithRetry`'s retry-then-succeed path, (2) its retry-exhausted give-up path, (3) `getChannelCursor`'s type-mismatch `logger.error` branch (only string ids are ever seeded in `cursor.test.ts`), (4) the abort-mid-run bookkeeping guard (`channelsProcessed`/`channelsFailed` unaffected when `signal` aborts mid-channel) [packages/bot/src/backfill/backfiller.test.ts, packages/bot/src/backfill/cursor.test.ts] — Add one test per path. **Aplicado:** 4 tests nuevos añadidos.

### Deferred

- [x] [Review][Defer] **`SIGTERM`/`SIGINT` handlers are registered AFTER the per-channel cursor-resolution loop and Discord client setup** [packages/bot/src/main.ts] — A signal arriving during that window bypasses the bounded-shutdown logic entirely (Node's default SIGTERM handling has no cleanup). Pre-existing ordering from the original implementation, not introduced or touched by either review pass. Fixing it means moving `shutdownSignal`/`shutdown()`'s definition and the `process.on(...)` registration earlier in `main()`, ahead of the cursor loop — a bigger structural reorder than this review's patch scope. Deferred.

### Dismissed as noise (5)

- **Dangling `setTimeout` handles in the shutdown races** (`main.ts`) — harmless: `process.exit(0)` runs in the same `finally` shortly after, same pre-existing pattern as `client.destroy()`/`redis.quit()`/`db.$client.end()`.
- **`latestPages` discards an already-fully-fetched window on abort during the final chunk-yield loop** (`pages.ts`) — efficiency-only (forces a Discord re-fetch next boot), not a correctness bug; consistent with the file's own documented "correctness over Discord-call efficiency" design philosophy.
- **New catch blocks log `error.message` only, never a stack trace** — pervasive pre-existing convention across the entire codebase (every existing catch block does this), out of scope for a story-specific patch.
- **Fragile string-matching assertion in the "never MAX(id)" regression test** (`cursor.test.ts`) — pre-existing test (from the original implementation), minor test-quality nitpick, not a code defect.
- **`KnowledgeStreamEvent` is a single-member type alias today, not yet a real union** (`events.ts`) — intentional, already documented as "so Epic 6 can grow it without churn"; not a defect.
- **Acceptance Auditor: AC-6 "no losses" is not fully guaranteed even with bounded retry** — confirmed true (a sustained >1s failure or a deterministic per-message failure still reproduces the cursor-skip loss), but this is the exact, disclosed trade-off of the decision already made in the second pass (option 3 was chosen knowing it narrows, not eliminates, the risk) — not re-opening a resolved decision. Its one actionable sub-finding (no operator-visible signal of the loss) is captured above as the `messagesFailed` counter patch.

---

## Review Findings — fourth independent pass (2026-07-06)

_Fresh review from scratch (Blind Hunter + Edge Case Hunter + Acceptance Auditor) over the diff as it stood after the third pass's 6 patches. Acceptance Auditor found nothing new (AC-1…AC-5, AC-7 all check out; `messagesFailed` wiring traced end-to-end and confirmed correct). Blind Hunter and Edge Case Hunter **independently converged on the same bug** — the retry loop added in the second pass interacts badly with a pre-existing, documented Story 3.1 trade-off in `persistMessage.ts`._

### Decision needed

- [x] [Review][Decision] **`persistWithRetry` (2nd pass) amplifies a pre-existing, documented `persistMessage` race from "1 tolerated orphan event" to "up to 3 duplicate events"** — `persistMessage.ts`'s own header comment (lines 13-16) already discloses a residual, accepted risk from Story 3.1: the Redis `xAdd` runs *inside* the Drizzle transaction callback, so if the callback's `xAdd` succeeds but the transaction's COMMIT itself subsequently fails (a narrow DB blip between callback-return and COMMIT-ack), the INSERT rolls back but the `xAdd` already fired — an event with no row. The original design tolerates exactly ONE such orphan event per occurrence ("delivery is at-least-once and the Indexer is idempotent, AD-13"). `persistWithRetry` (this story, second pass) now retries the *entire* `persistMessage` call on any thrown error — including this exact one. Since the INSERT was rolled back, `onConflictDoNothing` finds no existing row on retry, so it inserts AND `xAdd`s again. Up to `MAX_MESSAGE_ATTEMPTS` (3) attempts means up to 3 durable `MessageCreatedEvent`s can be published for one message, with only 1 (or 0) rows ever persisted. Both Blind Hunter and Edge Case Hunter found this independently by tracing the retry-loop/transaction interaction, not by intuition. This is real, but it amplifies an ALREADY-ACCEPTED risk class (same failure mode, same downstream idempotency assumption, AD-13) rather than introducing a wholly new one — the race window itself (COMMIT failing right after a successful callback) is extremely narrow. Options: (a) **accept as-is** — document the amplification explicitly in `persistMessage.ts`'s comment and rely on AD-13's "Indexer is idempotent" as the safety net, same as the original design already does; (b) **give `persistMessage` a richer failure signal** so `persistWithRetry` can tell "INSERT itself failed, safe to retry" apart from "xAdd already fired, COMMIT failed — do NOT retry, log as a tolerated one-off exactly like the pre-retry design did" — correct but requires restructuring `persistMessage`'s return/throw contract, moderate scope; (c) **do not retry backfill's `persistWithRetry` at all for this class of error** by some other detection — not currently distinguishable at the call site, so this collapses to (b) in practice. The correct choice depends on how much you want to invest in this narrow race right now vs. defer to when Story 3.3's Indexer idempotency is actually built and tested. **RESUELTO (2026-07-06): opción 1 — aceptar tal cual.** Documentado explícitamente en el comentario de cabecera de `persistMessage.ts`: mismo tipo de riesgo ya aceptado desde Story 3.1, solo amplificado (1→hasta 3), con la misma red de seguridad AD-13 (Indexer idempotente). Revisar si Story 3.3 no dedupea por `messageId` en la práctica.

### Patch

- [x] [Review][Patch] **A cursor-resolution failure (DB blip in `main.ts`, or a driver type-mismatch in `cursor.ts`) silently downgrades an established channel to the bounded `backfill.limit` fetch instead of the unbounded gap fetch** [packages/bot/src/backfill/cursor.ts:18-39, packages/bot/src/main.ts:70-86, packages/bot/src/backfill/backfiller.ts:118-121] — Both fallback paths collapse "genuinely first run, channel has zero rows" and "we failed to read the real cursor" into the same `cursor === null` signal, which `runBackfill` reads as "use `latestPages` bounded by `backfill.limit`." For a channel with real history whose true offline gap exceeds `backfill.limit`, this means the ONLY chance to fetch the older portion of that gap is lost — the next boot's cursor derives from whatever the bounded fetch happened to persist, and `gapPages` only looks forward from there. This is a genuinely new loss vector (from cursor-resolution failure, not from per-message persist failure, which the second/third passes already covered). Distinguish the two cases: on a genuine resolution failure (thrown error or type mismatch), skip that channel's backfill for this run entirely (log a `warn`, retry cursor resolution next boot) instead of defaulting into the bounded/first-run fetch mode. **Aplicado:** `getChannelCursor` ahora lanza (no devuelve `null`) en type-mismatch; `main.ts` deja el canal sin entrada en el map en fallo (en vez de `null`); `runBackfill` trata `cursors.has(id) === false` como fallo de canal (cuenta en `channelsFailed`, no toca la API de Discord). 1 test nuevo.
- [x] [Review][Patch] **Duplicate-channel-id validation (added in the third pass) doesn't filter by `enabled`, so two harmless *disabled* duplicate ids crash config loading** [packages/shared/src/config/index.ts, the `superRefine` duplicate-id check] — The check's own stated rationale is specifically about *enabled* duplicates causing double-processing and `channelsProcessed` double-counting; both the cursor-resolution loop and `runBackfill` already skip disabled channels entirely, so two disabled entries sharing an id have zero runtime effect today. Scope the uniqueness check to `channel.enabled` entries only, matching the documented rationale. **Aplicado:** `superRefine` ahora ignora canales `enabled: false`. 2 tests nuevos (rechaza duplicado enabled, acepta duplicado disabled).
