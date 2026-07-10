---
baseline_commit: 71e84cc
status: done
story_id: 6.3
epic: 6
---

# Story 6.3: Startup Sync & Offline Reconciliation

Status: done

## Story

As the **system**,
I want the **bot** to detect edits and deletes that happened on Discord while it was offline — and republish them as `discord.message.updated` / `discord.message.deleted` events — so that the pgvector index becomes consistent with Discord again after a restart or crash, not just for changes that arrive live.

This is the **third story of Epic 6** (Synchronization, Notifications & Reliability). Story 6.1 made the bot publish **live** edits/deletes; Story 6.2 made the Sync worker **consume** those two streams (re-index / purge). But a change that happens while the bot process is **down** produces no Gateway event and is lost forever. This story closes that gap: on startup, **after the historical backfill of new messages completes** (Story 3.2 / FR2), the bot walks each enabled channel's recent messages, diffs them against what it already has persisted, and **republishes into the very same `share2brain:discord:messages:{updated,deleted}` streams** — so the existing 6.2 Sync worker does the actual DB mutation + re-embed. The bot stays **publish-only** (it writes no DB rows here).

**Baseline commit:** `71e84cc` — Story 6.2 merged (PR #36). The Sync worker consumes both edit/delete streams and owns the `embeddings` UPSERT / soft-hard delete + `discord_messages.content`/`deleted_at` mutation. The live edit/delete path (6.1 → 6.2) is complete. Nothing yet detects changes that happened while the bot was offline — that is this story.

---

## ⚠️ Reconciliation notes — read before implementing

The epic AC for 6.3 and `TECHNICAL-DESIGN.md` were written against a `last_seen_message_id` **column** that does not exist, and before the grouped/chunked embedding model landed. The notes below reconcile them against source verified at baseline `71e84cc`. **Read all of them — notes #1, #2 and #6 are load-bearing.**

1. **There is NO `last_seen_message_id` column (AD-5 — decided in Story 3.1). The epic's "usa `last_seen_message_id` como punto de partida" is a derived concept, not a stored field.** The bot already derives the per-channel anchor as *"the newest persisted message by `created_at`"* via `getChannelCursor(db, channelId)` (`backfill/cursor.ts`). **Reuse it verbatim** as the offline-sync anchor (`last_seen`). Do **not** add a column — that is DDL outside the design (AD-5). A `null` cursor means the channel has no persisted rows → nothing to reconcile → skip (the backfill *initial* path owns first-time ingestion of that channel).

2. **This story is PUBLISH-ONLY — the bot writes NO DB rows here.** It re-fetches Discord state, diffs against persisted rows (read-only `SELECT`), and `XADD`s `discord.message.updated` / `discord.message.deleted` events. The DB mutation (re-embed, soft/hard delete, `discord_messages.content`/`deleted_at`/`indexed_at` writes) is **the Sync worker's job (Story 6.2)**, reached asynchronously through the streams. This preserves the bot's write ownership (Bot→`discord_messages` on ingest; here it doesn't even write — it publishes). **Reuse the Story 6.1 handlers `handleMessageUpdate` / `handleMessageDelete` as the publish path** (note #3) — do not re-implement event construction or `XADD`.

3. **All contracts already exist — reuse, do not redefine.** `packages/shared/src/types/events.ts` defines `MessageUpdatedEvent` (`{ type:'discord.message.updated', messageId, channelId, guildId, timestamp, newContent }`), `MessageDeletedEvent` (`{ type:'discord.message.deleted', messageId, channelId, guildId, timestamp }`), `STREAM_KEYS.DISCORD_MESSAGES_UPDATED` / `DISCORD_MESSAGES_DELETED`, and `CONSUMER_GROUPS.SYNC`. The **6.1 handlers** already build these events (`Record<keyof …Event, string>`) and `XADD` them. **No `packages/shared` change, no new stream key, no new consumer group, no migration** — `discord_messages` (with `content`, `updated_at`, `deleted_at`) and both streams already exist.

4. **Edit detection = content diff (confirmed with Borja, DECISION 2).** A message was edited offline **iff** Discord's current `message.content` differs from the persisted `discord_messages.content`. The 6.2 Sync worker refreshes `discord_messages.content` on every *live* edit (6.2 DECISION 2), so the persisted content is the last-known-good baseline — a message only ever *created* (never edited) diffs to equal → no republish. **Do NOT use `editedTimestamp` vs `updated_at`** — fragile to clock skew and to what wrote `updated_at`. Content diff is definitive.

5. **Delete detection is destructive under `delete_policy = "hard"` — be conservative (DECISION 3).** A false-positive delete permanently purges an embedding when the worker is in `hard` mode. So a persisted message is concluded *deleted-offline* **only** when ALL of these hold: (a) the channel's Discord re-fetch **completed without error** this run; (b) the message's id is **within the fully-covered fetched id-range** `[oldestFetchedId, lastSeen]` (`id >= oldestFetchedId`, BigInt compare — note #7); (c) the message is **absent** from the fetched set; (d) the persisted row is **not already** `deleted_at IS NOT NULL`. If the channel walk threw at any point → **skip that channel's delete detection entirely** this run (edits already published are safe/idempotent; deletes are the risky ones). Never conclude a delete below the fetched window (we simply didn't look that far).

6. **Reconciliation depth = `backfill.limit` (confirmed with Borja, DECISION 1).** Per channel, re-fetch the most recent `config.discord.backfill.limit` messages from Discord (walking backward from `last_seen`), and diff against the most-recent-`limit` persisted rows. Reusing `backfill.limit` means **no `@share2brain/shared` config change**. Edits/deletes older than that window are out of scope for a single boot (the epic says "mensajes **recientes**", "limitar el rango", "no saturar la API"). Document this bound explicitly (AC-7) — a silent cap reads as "reconciled everything" when it didn't.

7. **BigInt id comparison, never string (Story 3.1/3.2 trap).** Snowflakes are variable-length TEXT (18 digits pre-2022, 19 after); lexicographic compare mis-orders them. `oldestFetchedId` and the "id >= oldestFetchedId" range test MUST parse ids as `BigInt` with the same `/^\d+$/`-guard discipline used in `backfill/pages.ts` (`sortAscendingById`). Reuse that pattern; do not string-compare ids.

8. **The Sync worker (6.2) already handles the *unknown-message* edge for us.** 6.2's `processUpdate` skips an update for a message it has no `discord_messages` row for (create path owns insertion), and both delete branches are idempotent (`0 rows changed` = success). So a redundant/racy republish from this story is **safe** — the worker converges (AD-13). We do NOT need to be exact; we need to be *conservative on deletes* (note #5) and *complete on edits within the window*.

9. **This story naturally catches `messageDeleteBulk`.** Bulk moderation purges were deferred out of 6.1 (`deferred-work.md`) — those messages never got a live `messageDelete` event. Offline reconciliation detects them (absent from the Discord re-fetch, present in DB) within the reconciliation window. This is a documented *benefit*, not a new scope item — do not add a `messageDeleteBulk` Gateway listener here (still deferred).

10. **Sequencing (epic AC "cuando completa el backfill").** Offline sync runs **after** the historical backfill promise settles, sequentially per channel, sharing the same Discord REST budget/throttle. Chain it onto `backfillPromise` in `main.ts` (note the current backfill is fire-and-forget and non-blocking) so the existing bounded shutdown drain covers it too.

---

## Acceptance Criteria

### AC-1 — On startup, after backfill completes, run offline sync per enabled channel (sequential)

**Given** the bot has booted, logged in to the Gateway, and its historical backfill (Story 3.2) has settled
**And** `config.sync.enabled === true` **and** `config.sync.sync_on_start === true`
**When** offline sync runs
**Then** it iterates **only enabled channels** (`isChannelEnabled`), **one channel at a time** (never in parallel — "no saturar la API de Discord"), throttling page fetches with the same abortable `waitOrAbort(sleep(INTER_PAGE_DELAY_MS))` pause the backfill uses
**And** it resolves each channel's `last_seen` anchor via `getChannelCursor(db, channelId)`; a **null** cursor (no persisted rows) → skip that channel (log `debug`, "no persisted messages — nothing to reconcile")
**And** the whole offline-sync run is **non-blocking** (chained after `backfillPromise`) and **never crashes the process** — a whole-run failure is caught and logged at `error`, exactly like the backfill catch in `main.ts`.

### AC-2 — Offline sync is gated OFF unless both `sync.enabled` and `sync.sync_on_start` are true

**Given** the bot boots
**When** `config.sync.enabled === false` **or** `config.sync.sync_on_start === false`
**Then** offline sync is **not** started, logged once at `info` ("offline sync disabled — skipping startup reconciliation"), and the bot boots normally (backfill + live ingestion unaffected).
_Rationale: republishing into the sync streams is pointless when nothing consumes them (`sync.enabled=false`), and `sync_on_start` is the operator's explicit opt-in for the startup pass._

### AC-3 — Detect messages EDITED offline → republish `discord.message.updated`

**Given** a channel's `last_seen` cursor is non-null and its Discord re-fetch (up to `backfill.limit`, walking backward from `last_seen`) completed
**When** a persisted, non-deleted `discord_messages` row's id is present in the fetched Discord set **and** the fetched message's `content` **differs** from the persisted `content` (note #4)
**Then** the bot calls `handleMessageUpdate(<the fetched discord.js Message>, { config, redis, logger })` (the Story 6.1 publish path) — which re-applies the enabled/bot/`editedAt`/empty-content guards and `XADD`s a `discord.message.updated` event with `newContent = message.content` to `STREAM_KEYS.DISCORD_MESSAGES_UPDATED`
**And** identical content (never edited, or the live edit was already synced) publishes **nothing**.

### AC-4 — Detect messages DELETED offline → republish `discord.message.deleted` (conservatively)

**Given** a channel's Discord re-fetch **completed without error** and covered the id-range `[oldestFetchedId, last_seen]`
**When** a persisted, **non-deleted** (`deleted_at IS NULL`) `discord_messages` row's id is **absent** from the fetched set **and** its id is `>= oldestFetchedId` (BigInt compare — note #5, #7)
**Then** the bot calls `handleMessageDelete({ id, channelId, guildId }, { config, redis, logger })` (the Story 6.1 publish path) — which `XADD`s a `discord.message.deleted` event to `STREAM_KEYS.DISCORD_MESSAGES_DELETED`
**And** a persisted row whose id is `< oldestFetchedId` (below the covered window) is **never** concluded deleted
**And** if the channel's re-fetch **threw** at any point, that channel's delete detection is **skipped entirely** this run (note #5) — only edits already published stand (they are idempotent).

### AC-5 — Per-channel isolation; one bad channel never aborts the run or crashes the bot

**Given** offline sync is iterating channels
**When** any channel's fetch/compare/publish throws (unknown/inaccessible channel id, non-text channel, mid-fetch REST error, DB read error)
**Then** that channel logs **one** `error` line (`{ channelId, error }`, never content) and the loop **continues to the next channel** — mirroring `runBackfill`'s per-channel try/catch (AC-5 of Story 3.2)
**And** the run respects the shutdown `AbortSignal`: it checks `signal.aborted` at channel boundaries and before each page fetch, and stops cleanly (no completion side effects) when aborted.

### AC-6 — Idempotent & redelivery-safe (AD-13)

**Given** offline sync republishes an edit or delete that the live path (or a prior boot) already handled
**When** the 6.2 Sync worker consumes the republished event
**Then** convergence holds: an already-synced edit re-embeds to the **same** `chunkKey` rows (UPSERT), and a delete of an already-deleted / already-purged message changes **0 rows** without error (verified by 6.2). This story therefore **does not** attempt exactness — a redundant republish is a safe no-op — but it **must** honor the delete-conservatism of AC-4 so a `hard` policy never purges a still-live message.

### AC-7 — Bounded window is logged, not silent

**Given** offline sync completes a channel
**Then** it logs at `info` a per-channel summary `{ channelId, editsPublished, deletesPublished, reconciled: <count compared>, windowCapped: <boolean — true if the walk hit backfill.limit before reaching head-of-history> }`, so an operator can see that reconciliation covered a **bounded recent window** (note #6) and not the whole channel history. No log line includes message content (AC-8).

### AC-8 — Content is never logged

No log line (`debug`/`info`/`warn`/`error`) in the offline-sync path includes message content (`newContent`, persisted `content`, or fetched `content`) (`project-context.md`: "Never log … full message content"). Assert this in tests (serialize every logged arg, assert no content string appears), mirroring `messageUpdate.test.ts` / `messageCreate.test.ts`.

### AC-9 — Verification gate green

`npm run lint` (0), `npm run test` (all pass, new unit tests added), and `npm run build` (all 5 workspaces) are green. An integration test against **real Postgres + Redis** (Discord faked at the client boundary, never a real Gateway/REST call) covers: an offline **edit** → `discord.message.updated` lands on the stream with the new content; an offline **delete** (message absent from the re-fetch) → `discord.message.deleted` lands; an **unchanged** message and a message **below the window** → nothing published; a **null-cursor** channel → skipped. Mirror `backfill.integration.test.ts` + `test-helpers.ts` (`npm run test:integration`).

---

## Tasks / Subtasks

- [x] **Task 1 — Pure reconciliation diff** (AC-3, AC-4, AC-7) — new `packages/bot/src/sync/reconcile.ts` + `reconcile.test.ts`:
  - [x] Export a **pure** function `diffChannel(input: { persisted: PersistedRow[]; fetched: FetchedMessage[]; lastSeen: string }): { edits: FetchedMessage[]; deletes: PersistedRow[]; reconciled: number }` where `PersistedRow = { id: string; content: string }` (non-deleted rows only — caller pre-filters `deleted_at IS NULL`) and `FetchedMessage` is the narrow current-Discord slice (`{ id, channelId, guildId, content, editedAt, author, partial:false, fetch }`, i.e. assignable to `UpdatableMessage`).
  - [x] Compute `oldestFetchedId` = min id in `fetched` by **BigInt** (reuse the `/^\d+$/`-guarded parse from `backfill/pages.ts` — extract a tiny `toIdKey(id): bigint | null` helper into a shared spot, or inline the same discipline; do NOT string-compare, note #7). Build a `Set<string>` of fetched ids.
  - [x] **Edits**: for each `fetched` message whose id is in the persisted map and whose `content !== persisted.content` → push the fetched message to `edits` (note #4). (Content-diff only; the handler applies the empty/bot/editedAt guards downstream.)
  - [x] **Deletes**: for each `persisted` row **absent** from the fetched id-set **and** with `BigInt(id) >= oldestFetchedId` → push to `deletes` (note #5). Skip rows below `oldestFetchedId`.
  - [x] `reconciled` = number of persisted rows compared. No I/O, no logging in this module.

- [x] **Task 2 — Channel re-fetch adapter + bounded backward walk** (AC-1, AC-3, AC-4, AC-5) — in `packages/bot/src/sync/offlineSync.ts`:
  - [x] Resolve the channel via `client.channels.fetch(channelId)`; `null` → throw "channel not found (unknown id or bot lacks access)"; `!isTextBased()` → throw "channel is not text-based" (mirror `runBackfill`). The per-channel try/catch (Task 3) turns these into a skipped channel.
  - [x] Walk **backward from `last_seen`** collecting up to `backfill.limit` current messages: reuse the same `channel.messages.fetch({ limit: 100, cache: false, before })` adapter shape as `runBackfill`'s `fetchPage`, seeded with `before = <last_seen>` (so we reconcile the window at/below the anchor, not the freshly-backfilled tail above it — note #1, #6). Keep each fetched item as an `UpdatableMessage`-assignable slice (retain `partial:false` and the real `fetch` bound method so `handleMessageUpdate` accepts it directly). Track `windowCapped` = "hit `limit` before a short (`< 100`) page".
  - [x] Check `signal.aborted` before each page fetch; throttle between pages with `waitOrAbort(sleep(INTER_PAGE_DELAY_MS), signal)` (import `INTER_PAGE_DELAY_MS`/the throttle pattern from `backfill/backfiller.ts`, or re-declare one shared constant — do not invent a second cadence).
  - [x] Load persisted rows for the channel (read-only): `SELECT id, content FROM discord_messages WHERE channel_id = :ch AND deleted_at IS NULL ORDER BY created_at DESC LIMIT :limit` (bounded to `backfill.limit`, rides `idx_discord_messages_channel`). Use `db.execute(sql\`…\`)` + `@share2brain/shared/db` `sql` (AD-2 re-export), mirroring `cursor.ts`.

- [x] **Task 3 — `runOfflineSync` orchestrator** (AC-1, AC-2, AC-5, AC-7, AC-8) — `packages/bot/src/sync/offlineSync.ts`:
  - [x] Signature `runOfflineSync(deps: { client, config, db, redis, logger, signal, sleep? }): Promise<void>` (mirror `BackfillDeps`; `sleep` injectable for tests).
  - [x] For each **enabled** channel, sequentially (respect `signal.aborted` at the top of each iteration): resolve `last_seen = await getChannelCursor(db, channelId)`; `null` → `debug` skip. Else run Task 2's fetch + persisted load, then `diffChannel(...)`.
  - [x] Publish via the **6.1 handlers**: for each edit → `await handleMessageUpdate(fetchedMessage, { config, redis, logger })`; for each delete → `await handleMessageDelete({ id, channelId, guildId: <row.guildId or config.discord.guild_id> }, { config, redis, logger })`. Both never throw (6.1 contract). Count `editsPublished`/`deletesPublished` from the number of handler calls made.
  - [x] **Delete conservatism (note #5):** only run the delete branch of `diffChannel` when the channel's re-fetch completed without error. Wrap the fetch/compare in the per-channel try/catch; on any throw, log one `error` and `continue` — no deletes for that channel this run.
  - [x] Per-channel `info` summary (AC-7): `{ channelId, editsPublished, deletesPublished, reconciled, windowCapped }`. Never log content (AC-8).
  - [x] Whole-run resilience: the function itself never rejects for a single bad channel; the caller (`main.ts`) still `.catch`es a structural failure.

- [x] **Task 4 — Wire into `main.ts`** (AC-1, AC-2, AC-10-sequencing):
  - [x] After the backfill block, chain offline sync onto the backfill promise so it runs **after** backfill settles and is covered by the existing bounded shutdown drain (the `Promise.race([backfillPromise, 5s])`). Concretely: reassign `backfillPromise = backfillPromise.then(() => config.sync.enabled && config.sync.sync_on_start ? runOfflineSync({ client, config, db, redis, logger, signal: shutdownSignal.signal }) : undefined).catch(err => logger.error('unexpected offline sync failure', { error: … }))`, OR add a sibling `syncPromise` chained after `backfillPromise` and add it to the shutdown race. Keep the existing backfill `.catch` intact.
  - [x] Gate: when `!(config.sync.enabled && config.sync.sync_on_start)` → log once at `info` "offline sync disabled — skipping startup reconciliation" and do not call `runOfflineSync` (AC-2).
  - [x] Do **not** block Gateway login or live ingestion on offline sync (it is best-effort, non-blocking — same posture as backfill).

- [x] **Task 5 — Unit tests** (all ACs) — co-located, DI fakes, no real I/O:
  - [x] `reconcile.test.ts`: edit detected on content diff; no edit on equal content; delete detected for absent id within window; NO delete for absent id **below** `oldestFetchedId`; NO delete for a fetched (present) id; BigInt ordering across 18- vs 19-digit snowflakes; empty `fetched` → no deletes concluded (oldestFetchedId undefined → window empty).
  - [x] `offlineSync.test.ts` (fake `client.channels.fetch`/`channel.messages.fetch`, fake `db.execute`, spied `redis.xAdd` via the real handlers or spied handler deps, fake `logger`): null cursor → channel skipped, no fetch; disabled channel skipped; sequential order (channel B not fetched before channel A resolves); a channel fetch throwing → `error` logged, next channel still processed, **no deletes** published for the failed channel; abort at a channel boundary stops the loop; per-channel `info` summary emitted with `windowCapped`; content never appears in any logged arg (AC-8).
  - [x] Assert the publish path calls `handleMessageUpdate` with a full (non-partial) message and `handleMessageDelete` with `{ id, channelId, guildId }`.

- [x] **Task 6 — Integration test** (AC-9) — new `packages/bot/src/sync/offlineSync.integration.test.ts`, mirroring `backfill.integration.test.ts` (real Postgres+Redis via `openTestClients`, Discord **faked** at the client boundary, unique `itest-6-3-<ts>` id suffix, `afterAll` cleanup of rows + stream entries):
  - [x] Seed `discord_messages` rows for a test channel (varied ids incl. an 18- and 19-digit snowflake). Fake `channel.messages.fetch` to return: one row with **changed** content (→ expect `discord.message.updated` with new content on `DISCORD_MESSAGES_UPDATED`), one row **unchanged** (→ nothing), and **omit** one seeded row (→ expect `discord.message.deleted` on `DISCORD_MESSAGES_DELETED`, since it's within the fetched window and absent). Seed one row **older than** the oldest fetched id (→ assert **no** delete for it). Seed a channel with **no rows** (→ null cursor → skipped, no fetch).
  - [x] Assert the exact string fields of the landed events (`type`, `messageId`, `channelId`, `guildId`, `timestamp`, `newContent` for updates), read back with `xRange`/`xRead`. Confirm no DB write happened from the bot (persisted rows unchanged — 6.2 is not running in this test).

- [x] **Task 7 — Verify** — `npm run lint && npm run test && npm run build` green; `npm run test:integration` green with infra up (`docker compose up -d postgres redis`). No new dependency (reuse discord.js, `@share2brain/shared/db`, `@share2brain/shared/redis`, `@share2brain/shared/types/events`, the 6.1 handlers, `getChannelCursor`, `waitOrAbort`). No `packages/shared` change, no migration. Paste the full gate output into the Dev Agent Record. Explicitly assert the **idempotency** invariant (AD-13, mandatory-steps §3.2.5): a redundant republish is a safe no-op (cross-reference 6.2's convergence).

---

## Dev Notes

### Architecture & patterns to follow
- **`runBackfill` is your template — copy its shape, don't invent.** Per-channel try/catch with `continue` on failure (AC-5); sequential channels; abortable `waitOrAbort(sleep(INTER_PAGE_DELAY_MS), signal)` throttle between page fetches (`backfill/backfiller.ts:116,130-135`); the `channel.messages.fetch({ limit: 100, cache: false, before })` adapter (`backfiller.ts:157-168`); `signal.aborted` checks at channel + page boundaries. Offline sync is the same *driver* over the same REST budget, just diffing instead of inserting.
- **Reuse the 6.1 handlers as the publish path (note #2, #3).** `handleMessageUpdate(newMessage: UpdatableMessage, { config, redis, logger })` (`discord/handlers/messageUpdate.ts`) already: guards `isChannelEnabled` → resolves a partial (a no-op here, our fetched message is full) → skips bot authors when `ignore_bots` → skips `editedAt === null` → skips empty content → builds the `Record<keyof MessageUpdatedEvent,string>` event with `timestamp = editedAt.toISOString()` and `newContent = message.content` → `XADD`s → never throws. `handleMessageDelete({ id, channelId, guildId }, { config, redis, logger })` (`discord/handlers/messageDelete.ts`) guards the channel and `XADD`s with `timestamp = receipt time`. **Passing the freshly-fetched full discord.js `Message` to `handleMessageUpdate` is the whole point** — it satisfies `UpdatableMessage` (has `partial`, `fetch`, `author`, `editedAt`) and re-applies all the live-edit guards for free.
- **Derive `last_seen` with the existing cursor (note #1).** `getChannelCursor(db, channelId)` (`backfill/cursor.ts`) returns the newest-persisted id (by `created_at desc limit 1`) or `null`. It **throws** (does not return null) on a driver/type contract break — let that throw bubble into the per-channel catch (skip the channel this run), consistent with `main.ts:76-89`.
- **BigInt id discipline (note #7).** Copy the `/^\d+$/`-guarded `BigInt(id)` parse from `sortAscendingById` (`backfill/pages.ts:37-62`). `BigInt('')`/`BigInt('  ')` return `0n` (a wrongly-minimal key) — require an all-digit string first. Consider extracting a `toIdKey(id: string): bigint | null` helper (a tiny new export in `sync/reconcile.ts` or a shared bot util) rather than duplicating the regex in three places.

### The reconciliation window — what it does and does NOT cover (read with note #5, #6)
- Per boot, offline sync reconciles the **most recent `backfill.limit` messages** of each enabled channel — a **bounded recent window**, not the whole history. Edits/deletes older than that window are **not** detected this boot (accepted, epic-sanctioned: "mensajes recientes", "no saturar la API"). `windowCapped` (AC-7) surfaces when the cap was hit.
- **Deletes are only concluded inside the fully-covered window** `[oldestFetchedId, last_seen]` and only when the channel walk completed cleanly (note #5). This is the single most important correctness rule of the story: under `delete_policy = "hard"`, a false delete permanently purges a vector. When in doubt, do **not** publish a delete — a genuinely-deleted message that fell outside the window will be caught on a later boot or must be handled by a future full-reconcile story.
- **Redundant republishes are safe (note #8, AC-6).** The 6.2 worker's edit UPSERT converges by `chunkKey` and its delete is idempotent (`0 rows` = success). A live edit that 6.2 hasn't finished processing when offline sync reads the (still-stale) `discord_messages.content` may cause a redundant `updated` republish — harmless. Do not add locks/coordination for this.

### discord/data gotchas
- **Anchor the backward walk at `last_seen`, not the present.** Messages *newer* than `last_seen` were just inserted by this boot's backfill gap fetch — their content is already current, so reconciling them is wasted REST calls. Seed the walk with `before = last_seen` to reconcile only the window at/below the anchor (note #1, #6).
- **`MessageContent` intent off → every fetched message has empty `content`.** That would diff as "edited" against non-empty persisted content and flood the update stream — but `handleMessageUpdate`'s empty-content guard **skips + warns** each, so no bad re-index reaches 6.2. The result is warn-spam, not corruption. The intent is validated ON (Epic 3 spike); acceptable floor.
- **`channel.messages.fetch` with `before` returns newest-first, ≤100 per page.** A page shorter than 100 means head-of-history was reached (so `windowCapped = false` and the delete window extends to channel start). Track this exactly like `latestPages`/`gapPages` (`backfill/pages.ts:34-35,81,113`).
- **Two Redis instances on this Mac (memory):** `localhost:6379` (Homebrew) vs the Compose Redis (no published ports). Local vs dockerized bot code hit **different** streams — keep in mind when manually checking `XLEN share2brain:discord:messages:updated` / `:deleted` after a local run.

### Source tree — files to touch
- **NEW** `packages/bot/src/sync/reconcile.ts` (pure `diffChannel` + `toIdKey`) + `reconcile.test.ts`
- **NEW** `packages/bot/src/sync/offlineSync.ts` (`runOfflineSync` orchestrator + channel re-fetch/persisted-load) + `offlineSync.test.ts`
- **NEW** `packages/bot/src/sync/offlineSync.integration.test.ts`
- **UPDATE** `packages/bot/src/main.ts` — chain `runOfflineSync` after `backfillPromise`, gated by `config.sync.enabled && config.sync.sync_on_start`, covered by the existing shutdown drain
- **REUSE (no change)** `packages/bot/src/discord/handlers/messageUpdate.ts` (`handleMessageUpdate`, `UpdatableMessage`), `messageDelete.ts` (`handleMessageDelete`, `DeletableMessage`), `channelGuard.ts` (`isChannelEnabled`), `backfill/cursor.ts` (`getChannelCursor`), `backfill/backfiller.ts` (`INTER_PAGE_DELAY_MS` cadence), `backfill/pages.ts` (BigInt-parse discipline), `discord/reconnect.ts` (`waitOrAbort`), `@share2brain/shared/db` (`sql`, `Database`), `@share2brain/shared/types/events` (`STREAM_KEYS` via the handlers), `test-helpers.ts` (`openTestClients`)
- **NO CHANGE** `packages/shared/**` (contracts + schema already exist); **NO migration**

### Testing standards
- Vitest, co-located `*.test.ts`, DI fakes — copy the `backfiller.test.ts` / `backfill.integration.test.ts` scaffolds (fake `client` with `channels.fetch`→`{ isTextBased, messages.fetch }`, fake `db.execute`, spied `redis.xAdd`, fake `logger` via `() => undefined`, `sleep` injected). No real network/Gateway ever — Discord is faked at the client boundary; the embeddings/LLM APIs are not involved (the bot does not embed).
- **Must-test invariants** (`project-context.md`, adapted): edit-on-content-diff only; delete only inside the covered window and only on a clean walk; per-channel isolation (one bad channel doesn't abort the run); content never logged; sequential channel order; abort stops cleanly; idempotency/redundant-republish is a safe no-op (cross-reference 6.2).
- Integration test uses the `openTestClients` / unique-suffix / `afterAll`-cleanup harness from `backfill.integration.test.ts`; assert the exact string fields of the landed stream events and that the bot wrote no DB rows.

### Project Structure Notes
- Code stays under `packages/bot/src/sync/` (new sibling of `backfill/`). No root `src/`. The bot depends only on `@share2brain/shared`, never another service (AD-2) — in particular it does **not** import `@share2brain/workers` even though it produces events that worker consumes. English only in all code/comments/tests. Only `packages/shared` does DDL (AD-5) — this story does none.

### Previous-story intelligence
- **Story 6.1** produced the two streams and the `handleMessageUpdate` / `handleMessageDelete` handlers this story reuses as its publish path; established Partials (`Partials.Message/Channel`) so uncached fetches hydrate, and the "publish-only, never write DB, never throw" contract. Runtime gotcha it recorded (memory): a partial `messageUpdate` has a null author until `fetch()` — not an issue here because we fetch full messages via `channel.messages.fetch`.
- **Story 6.2** consumes what this story republishes: `processUpdate` re-indexes standalone + UPSERTs by `chunkKey`; `processDelete` soft/hard, idempotent (`0 rows` = success); the unknown-message update is an ack+skip no-op. Its `deferred-work.md` note explicitly parks the "row-missing / bulk-delete / offline change" cases as **6.3 scope** — this is that story.
- **Story 3.1/3.2** established: no `last_seen_message_id` column → derived cursor (`getChannelCursor`); BigInt (never lexicographic) snowflake ordering (`pages.ts`); sequential-channel + abortable-throttle backfill posture; per-channel error isolation; the fire-and-forget `backfillPromise` in `main.ts` that this story chains onto.
- **Story 4.1 (D1)** wired the exclude-if-any `deleted_at` anti-join across search/docs/read-status — the reason a soft-deleted message never resurfaces even if reconciliation redundantly re-publishes.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 6.3]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-share2brain-2026-06-30/TECHNICAL-DESIGN.md#5.3, #"Backfill al arrancar" flowchart (note: `last_seen_message_id` is a DERIVED cursor, not a column — reconciled in note #1)]
- [Source: packages/bot/src/discord/handlers/messageUpdate.ts, messageDelete.ts — the 6.1 publish path reused verbatim (note #2, #3)]
- [Source: packages/bot/src/backfill/cursor.ts — getChannelCursor = derived `last_seen` anchor (note #1)]
- [Source: packages/bot/src/backfill/backfiller.ts#106-236 — per-channel sequential + abortable throttle + fetchPage adapter to mirror]
- [Source: packages/bot/src/backfill/pages.ts#37-62 — BigInt id-parse discipline to reuse (note #7)]
- [Source: packages/bot/src/discord/reconnect.ts#37 — waitOrAbort(wait, signal)]
- [Source: packages/bot/src/main.ts#197-218 — backfillPromise chain + bounded shutdown drain to extend (note #10)]
- [Source: packages/shared/src/config/index.ts#79-83 — config.sync { enabled, sync_on_start, delete_policy }]
- [Source: packages/shared/src/types/events.ts#21-68 — MessageUpdatedEvent/MessageDeletedEvent, STREAM_KEYS.DISCORD_MESSAGES_{UPDATED,DELETED}]
- [Source: packages/shared/src/db/schema.ts#36-54 — discord_messages(content, updated_at, deleted_at), idx_discord_messages_channel]
- [Source: packages/workers/src/sync/processUpdate.ts, processDelete.ts — the 6.2 consumers that make redundant republishes safe (AC-6, note #8)]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md — row-missing/bulk-delete/offline items parked as 6.3 scope (note #9)]
- [Source: packages/bot/src/backfill/backfill.integration.test.ts + test-helpers.ts — real-infra harness to mirror]
- [Source: _bmad-output/project-context.md — AD-13 idempotency, never-log-content, publish-only bot, no-cross-service-dep]

## Project Context Reference

See `_bmad-output/project-context.md` (backend rules, AD-13 stream/idempotency invariants, publish-only-bot, anti-patterns) and `CLAUDE.md` (non-negotiables: only shared does DDL, XACK only after success on the consumer side, no cross-service imports). Standards: `docs/base-standards.md`, `docs/backend-standards.md`.

## Decisions (confirmed with Borja, 2026-07-08)

> The two genuine design forks were confirmed with Borja at story creation; the rest are adopted defaults derived from the established Epic 3/6 patterns.

1. **[DECIDED — reconciliation depth reuses `config.discord.backfill.limit`]** Per channel, reconcile the most recent `backfill.limit` messages (walk Discord backward from `last_seen`, diff against the most-recent-`limit` persisted rows). **Rationale:** the epic mandates a bounded recent window ("mensajes recientes", "limitar el rango", "no saturar la API"); reusing `backfill.limit` avoids any `@share2brain/shared` config/schema change and keeps one REST budget. _Confirmed with Borja — chose reuse-backfill.limit over a new `sync.reconcile_limit` config and over whole-history._
2. **[DECIDED — edit detection by content diff]** A message is edited-offline iff Discord's current `content` differs from `discord_messages.content` (which 6.2 keeps current on live edits). **Rationale:** definitive and robust to clock skew, unlike an `editedTimestamp` vs `updated_at` comparison. The 6.1 handler's empty-content guard neutralizes the intent-off false-positive case. _Confirmed with Borja — chose content-diff over editedAt-timestamp._
3. **[ADOPTED — deletes are conservative: only inside the fully-covered, cleanly-walked window]** A persisted, non-deleted row is concluded deleted-offline only when its id is `>= oldestFetchedId`, absent from a channel re-fetch that completed without error (note #5). **Rationale:** under `delete_policy = "hard"` a false delete permanently purges a vector; bias toward under-deleting (a missed delete self-heals on a later boot; a wrong hard-delete is data loss). _Adopted default._
4. **[ADOPTED — publish-only, reuse the 6.1 handlers]** Offline sync writes no DB rows; it re-fetches, diffs (read-only), and calls `handleMessageUpdate`/`handleMessageDelete` to `XADD` into the sync streams, letting the 6.2 worker do the mutation. **Rationale:** preserves the bot's publish-only contract and avoids duplicating event construction / guards. _Adopted default._
5. **[ADOPTED — gate on `sync.enabled && sync.sync_on_start`, run after backfill, non-blocking]** Republishing is pointless when nothing consumes (`sync.enabled=false`); `sync_on_start` is the operator opt-in for the startup pass. Chained after `backfillPromise` and covered by the existing bounded shutdown drain. _Adopted default._

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5)

### Debug Log References

Verification gate (2026-07-08), all commands run from repo root:

```
$ npm run lint
> eslint .
(0 errors)

$ npm run test
> vitest run --project unit --project web --passWithNoTests
 Test Files  74 passed (74)
      Tests  604 passed (604)

$ npm run build
> npm run build --workspaces --if-present
@share2brain/backend  tsc --noEmit  (clean)
@share2brain/bot      tsc --noEmit  (clean)
@share2brain/shared   tsc --noEmit  (clean)
@share2brain/web      vite build    (clean, dist/ emitted)
@share2brain/workers  tsc --noEmit  (clean)

$ npm run test:integration
> vitest run --project backend-integration --project bot-integration --project workers-integration
 bot-integration:      3 files, 9 tests passed (incl. offlineSync.integration.test.ts: 3/3)
 workers-integration:  passed (unchanged by this story)
 backend-integration:  1 PRE-EXISTING failure in rbac.integration.test.ts (2 tests) — same
   flake already flagged in Story 6.2's Completion Notes ("test-guild" role leaking into
   /api/auth/roles assertions). packages/backend was NOT touched by this story (confirmed:
   `git diff --stat main -- packages/backend/` is empty on this branch). Reproduces in
   isolation on main, independent of this story's changes. Not blocking.
```

### Completion Notes List

- Bot-side, publish-only offline reconciliation implemented exactly as scoped: `diffChannel`
  (pure, `packages/bot/src/sync/reconcile.ts`) diffs persisted `discord_messages` rows against
  a freshly re-fetched Discord window; `runOfflineSync` (`packages/bot/src/sync/offlineSync.ts`)
  drives the per-channel backward walk from the derived `getChannelCursor` anchor and republishes
  via the reused Story 6.1 handlers (`handleMessageUpdate`/`handleMessageDelete`) — no DB write,
  no new `packages/shared` contract, no migration.
- **Found and fixed a boundary bug during integration testing**: the anchor (`last_seen`) row is
  structurally excluded from the Discord re-fetch (`before` is exclusive of it), but it is still
  the newest row in the persisted set. The original `diffChannel` comparison (`rowKey > lastSeenKey`
  → skip) let the anchor's exact id slip through as "absent and within window", which would have
  concluded a false delete for the newest message every single boot. Fixed by changing the guard
  to `rowKey >= lastSeenKey` and added a dedicated regression test
  (`reconcile.test.ts`: "should NOT report a delete for the lastSeen anchor id itself").
- **Found and fixed a test-isolation defect (not a product bug)**: the integration test's first
  draft hardcoded literal snowflake ids (`999999999999999999`, `1000000000000000001`…) that
  collide with `backfill.integration.test.ts`'s own hardcoded fixture ids. Running both suites
  together raced their `afterAll` id-scoped cleanups and caused cross-suite failures (one suite's
  row was deleted mid-run by the other's cleanup). Fixed by deriving every id from a per-run salt
  (`String(Date.now()).slice(-8)`) embedded in the digit string while preserving the 18-vs-19-digit
  BigInt-ordering trap the test exists to cover. This generalizes the Epic 4 retro item on
  run-unique test isolation to bot-package integration tests.
- Idempotency (AD-13, AC-6) is explicitly asserted: a third integration test re-runs
  `runOfflineSync` against the identical fixture/persisted state and asserts it resolves cleanly
  (no throw) and republishes the same edit/delete without corrupting persisted state — the
  convergence itself (UPSERT by `chunkKey`, 0-row idempotent delete) is the Story 6.2 worker's
  contract, verified there; this story only guarantees a redundant republish is safe to emit.
- No new dependency, no `packages/shared` change, no migration — matches the story's Dev Notes
  exactly.

### File List

- `packages/bot/src/sync/reconcile.ts` (new)
- `packages/bot/src/sync/reconcile.test.ts` (new)
- `packages/bot/src/sync/offlineSync.ts` (new)
- `packages/bot/src/sync/offlineSync.test.ts` (new)
- `packages/bot/src/sync/offlineSync.integration.test.ts` (new)
- `packages/bot/src/main.ts` (updated — chained `runOfflineSync` after `backfillPromise`, gated by `config.sync.enabled && config.sync.sync_on_start`)

## Change Log

- 2026-07-08 — Story 6.3 created (bmad-create-story). Bot startup offline reconciliation: after backfill, walk each enabled channel's recent `backfill.limit` messages, diff against persisted `discord_messages` (content-diff = edit; absent-within-window = delete, conservative), and republish `discord.message.updated`/`deleted` via the reused 6.1 handlers into the streams the 6.2 Sync worker consumes. Publish-only (no bot DB write), gated by `sync.enabled && sync.sync_on_start`, sequential per channel, chained after `backfillPromise`. Reconciles the epic's non-existent `last_seen_message_id` column against the derived `getChannelCursor` anchor and the grouped-embedding model. No `@share2brain/shared` change, no migration. Status → ready-for-dev.
- 2026-07-08 — Story 6.3 implemented (bmad-dev-story). New `packages/bot/src/sync/{reconcile,offlineSync}.ts` + unit + integration tests; `main.ts` wiring. Fixed a real boundary bug found during integration testing: the `last_seen` anchor row is excluded from the Discord re-fetch (`before` is exclusive) but is still the newest persisted row, so the original delete-window guard would have concluded a false delete for it every boot — tightened `rowKey > lastSeenKey` to `rowKey >= lastSeenKey` and added a regression test. Also fixed a test-isolation defect (hardcoded snowflake ids collided with `backfill.integration.test.ts`'s fixtures under parallel execution) by deriving run-unique ids. Gate green: lint 0 / 604 unit+web (+22) / build clean (5 pkgs) / bot-integration 9/9 (incl. offlineSync 3/3, idempotency asserted). One pre-existing, unrelated backend RBAC integration flake noted (not blocking, `packages/backend` untouched). Status → review.

## Review Findings

_bmad-code-review 2026-07-08 — 3 adversarial layers (Blind Hunter + Edge Case Hunter + Acceptance Auditor), all findings verified against source. Consensus: the load-bearing delete-conservatism invariant (AC-4 / note #5) genuinely holds — no path publishes a false-positive delete; abort-before-diff, empty-fetch, below-window, and anchor-exclusion guards all confirmed correct. No Critical/High defects. Findings below are Low-severity._

- [x] [Review][Patch] `windowCapped` mis-reports at the page/limit boundary [`packages/bot/src/sync/offlineSync.ts:90-97`] — on a short (<100) page where `collected.length > limit`, `windowCapped` is hardcoded `false`, so the AC-7 summary falsely claims full head-of-history coverage when `backfill.limit` actually truncated older messages. Observability-only (does NOT gate deletes/publishing). Reachable only when `backfill.limit < 100` (default 1000 → unreachable). **FIXED:** short-page branch now sets `windowCapped = collected.length > limit`; +2 regression tests (short page overshoots limit → true; short page within limit → false).
- [x] [Review][Patch] Abort during the inter-page throttle fires one extra REST fetch [`packages/bot/src/sync/offlineSync.ts:72-77`] — AC-5 requires an `signal.aborted` check "before each page fetch", but `waitOrAbort` resolves (never rejects) on abort, so an abort landing mid-throttle falls straight into `channel.messages.fetch` with no re-check (one wasted page per in-progress channel on shutdown). Results are discarded by the `:146` post-walk check, so no publish/correctness leak — but it deviates from AC-5 and from the `runBackfill` template (throttle-at-end-of-loop). **FIXED:** the `signal.aborted` check moved to AFTER the throttle (before the fetch); +1 regression test (abort injected during the throttle → only one page fetched, no persisted-load, no publish) — closes the AC-5/AC-9 test-gap.
- [x] [Review][Patch] Fail-open delete guard when the anchor cursor isn't BigInt-parseable [`packages/bot/src/sync/reconcile.ts:83`] — if `toIdKey(lastSeen)` returns `null`, the `rowKey >= lastSeenKey` anchor-exclusion guard is skipped entirely, so the anchor row (absent by construction, `>= oldestFetchedId`) would be concluded deleted → a false hard-purge under `delete_policy=hard`. Unreachable today (`getChannelCursor` returns a numeric snowflake), but it is a fail-open in the one module whose whole purpose is delete-conservatism. **FIXED:** `diffChannel` now `continue`s (concludes no deletes) when `lastSeenKey === null`; +1 regression test.
**Round 2 (2026-07-08 — re-review of the 3 round-1 patches AS NEW CODE, diff-isolated against reconstructed pre-patch snapshots; Blind Hunter + Edge Case Hunter, Epic 3 retro AI#1 convention).** Both layers converged: **all 3 production patches are clean — zero regressions.** Verified by path-trace: (P2 abort) every `channel.messages.fetch` — including the first page and the already-aborted case — is still guarded, and an abort mid-throttle now breaks before the extra fetch; (P1 windowCapped) `collected.length > limit` is correct at every short-page boundary (`< / == / >` limit), and the asymmetry vs. the full-page `>= limit` branch is intentional; (P3 fail-safe) the early `continue` lives in the delete branch only, so edit detection is untouched, and the simplified `rowKey >= lastSeenKey` is only reached when `lastSeenKey` is non-null. Empirically the 2 discriminating regression tests fail against the pre-patch snapshot (abort → 2 fetches; fail-safe → row published as a delete). 1 test-quality finding: the `windowCapped=false` test is non-discriminating for P2 (pre-patch also returned `false` for `collected <= limit`) — **dismissed** as a legitimate forward-regression guard for the not-capped path (the `windowCapped=true` test is P2's discriminator). 1 improvement applied: **strengthened** the P3 fail-safe test to also assert `result.edits` still fires with an unparseable anchor — directly proving the guard suppresses deletes but not edits. Gate re-run: lint 0 / 608 unit+web (unchanged count, 1 assertion strengthened) / build clean. Convergence reached — round 3 not warranted.

- [x] [Review][Defer] Offline edit to the newest (anchor) message is never detected [`packages/bot/src/sync/offlineSync.ts:68`] — deferred, documented design consequence. The walk seeds `before: lastSeen` (exclusive), so the anchor row is never re-fetched; if it was edited during downtime and no newer message arrived to displace it, that edit is missed on this and every subsequent boot for a quiet channel. Deliberate per notes #1/#6; candidate for a future full-reconcile story.
