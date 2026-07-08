---
baseline_commit: 0ff1133
status: done
story_id: 6.1
epic: 6
---

# Story 6.1: Bot — Real-time Edit & Delete Detection

Status: done

## Story

As the **system**,
I want the Discord bot to publish `messageUpdate` and `messageDelete` events to Redis Streams,
so that the Sync worker (Story 6.2) can keep the pgvector index consistent with Discord.

This is the **first story of Epic 6** (Synchronization, Notifications & Reliability). It **unblocks Story 6.2** (Sync worker: re-index on update, purge on delete), which consumes the two streams this story produces. It **completes the deferral from Story 3.1** — see `3-1-...md` §Reconciliation note #8: "implement `messageCreate` fully; defer `messageUpdate`/`messageDelete` registration to Story 6.1."

**Baseline commit:** `0ff1133` — Epic 5 closed; `epic-6: backlog` (flipped to `in-progress` by this story's creation). The bot (`packages/bot`) already connects to the Gateway, runs backfill, and handles `messageCreate` end-to-end.

---

## ⚠️ Reconciliation notes — read before implementing

The stream contracts and keys this story needs **already exist** in `@hivly/shared`. Do **not** invent new ones. Verified against source at baseline `0ff1133`:

1. **Event types already exist — reuse them, don't redefine.** `packages/shared/src/types/events.ts:21-28` defines `MessageUpdatedEvent` (`{ type: 'discord.message.updated', messageId, channelId, guildId, timestamp, newContent }`) and `MessageDeletedEvent` (`{ type: 'discord.message.deleted', messageId, channelId, guildId, timestamp }`). Both extend `StreamEvent` (`messageId, channelId, guildId, timestamp`). Defining a DB table or event/schema outside `packages/shared` is a hard anti-pattern (`project-context.md` §anti-patterns).

2. **Epic field names ≠ contract field names. Map, do not add fields.** The epic (`epics.md` §Historia 6.1) writes the updated payload as `{ messageId, channelId, newContent, editedAt }` and the deleted payload as `{ messageId, channelId, deletedAt }`. The **real contract uses `timestamp`** (ISO 8601 UTC) as the mandatory time field, plus the mandatory `guildId`. **[DECISION]:** map `editedAt → timestamp` and `deletedAt → timestamp`; add `guildId`. Do **not** add extra `editedAt`/`deletedAt` keys — that would diverge from the AD-13 contract every Discord event carries (`project-context.md` §backend-framework-rules).

3. **Stream keys are fixed invariants — import them.** Publish to `STREAM_KEYS.DISCORD_MESSAGES_UPDATED` (`'hivly:discord:messages:updated'`) and `STREAM_KEYS.DISCORD_MESSAGES_DELETED` (`'hivly:discord:messages:deleted'`) from `@hivly/shared/types/events` (`events.ts:59-68`). Never hardcode the strings (AD-13).

4. **The bot does NOT write the DB on update/delete.** Unlike `messageCreate` (which INSERTs + XADDs atomically in one transaction — `persistMessage.ts`), this story is **publish-only**. The DB mutation (delete old embedding, re-index / soft-or-hard delete) is the **Sync worker's** job in Story 6.2 (`TECHNICAL-DESIGN.md` §5.3). So there is **no transaction** here — just a single `xAdd`. `delete_policy` (soft/hard) lives in `config.sync.delete_policy` and is a **6.2 concern, not 6.1** — the bot never reads it.

5. **`messageUpdate`/`messageDelete` for uncached messages require `Partials`.** discord.js v14 (`^14.26.4`) does **not** emit these events for messages absent from its cache **unless** the `Client` is created with `partials: [Partials.Message, Partials.Channel]`. AC-2 explicitly requires publishing a delete **even when the bot never saw the original message** — that is impossible without `Partials.Message`. This story **UPDATEs `createDiscordClient`** (`packages/bot/src/discord/client.ts`) to add the `partials` option. The `GuildMessages` intent (already present) is sufficient for the events themselves; **no new intent is needed.**

6. **`ignore_bots` lives at `config.discord.backfill.ignore_bots`** (`config/index.ts:39-43`), reused as the live bot-author filter (same as `messageCreate` — `messageCreate.ts:46`). There is no top-level `discord.ignore_bots`.

7. **Offline reconciliation is NOT in this story.** Detecting edits/deletes that happened while the bot was offline is **Story 6.3** (`epics.md` §Historia 6.3). Story 6.1 handles **live Gateway events only**.

---

## Acceptance Criteria

### AC-1 — `messageUpdate` in an enabled channel publishes `discord.message.updated`

**Given** a `messageUpdate` event fires for a message whose `channelId` is in `config.discord.channels` with `enabled: true`
**And** (when `config.discord.backfill.ignore_bots === true`) the author is not a bot
**When** the bot handles it
**Then** it publishes to `STREAM_KEYS.DISCORD_MESSAGES_UPDATED` a `MessageUpdatedEvent`:
- `type` = `'discord.message.updated'`
- `messageId` = `message.id` (snowflake string)
- `channelId` = `message.channelId`
- `guildId` = `message.guildId ?? config.discord.guild_id`
- `timestamp` = the edit time as ISO 8601 UTC (`editedAt.toISOString()`, falling back to `new Date().toISOString()` if `editedAt` is null)
- `newContent` = the updated message content
**And** every field value passed to `xAdd` is a **string** (AD-13).

### AC-2 — `messageDelete` in an enabled channel publishes `discord.message.deleted`, even uncached

**Given** a `messageDelete` event fires for a message whose `channelId` is in `config.discord.channels` with `enabled: true`
**When** the bot handles it
**Then** it publishes to `STREAM_KEYS.DISCORD_MESSAGES_DELETED` a `MessageDeletedEvent`:
- `type` = `'discord.message.deleted'`
- `messageId` = `message.id`
- `channelId` = `message.channelId`
- `guildId` = `message.guildId ?? config.discord.guild_id`
- `timestamp` = `new Date().toISOString()` (Discord provides no delete timestamp; use receipt time)
**And** the event is published **even when the bot never cached the original message** (the delete `message` may be a discord.js **partial** carrying only `id` + `channelId`). The handler must not depend on `content`, `author`, or a non-null `guildId`.

### AC-3 — Out-of-scope events are ignored silently

**Given** a `messageUpdate` or `messageDelete` event
**When** the channel is **not configured or not `enabled`**, OR (for `messageUpdate` only, when `ignore_bots === true`) the author **is a bot**
**Then** the bot publishes nothing and logs at `debug` (an expected skip is not an error).

### AC-4 — A handler failure never crashes the process

**Given** `xAdd` (or a partial `fetch()`) throws
**When** either handler runs
**Then** the error is logged at `error` with `{ messageId, channelId }` and the handler resolves without throwing — a transient Redis/Gateway failure must never surface as an `unhandledRejection` → `exit(1)` (same contract as `handleMessageCreate`, `messageCreate.ts:71-77`).

### AC-5 — Listeners are registered and the client receives partials

**Given** the bot boots
**Then** `createDiscordClient` creates the `Client` with `partials: [Partials.Message, Partials.Channel]`
**And** `main.ts` registers `Events.MessageUpdate → handleMessageUpdate` and `Events.MessageDelete → handleMessageDelete`, each wrapped in `void handleX(...)` so a rejection can never leak (mirrors the existing `Events.MessageCreate` binding, `main.ts:108-112`).

### AC-6 — Content is never logged

No log line (`debug`/`info`/`error`) in either handler includes the full `newContent` or original message content (`project-context.md`: "Never log … full message content").

---

## Tasks / Subtasks

- [x] **Task 1 — Extract the shared channel-enabled guard** (AC-1, AC-2, AC-3)
  - [x] `isChannelEnabled` is currently private in `messageCreate.ts:21-24`. Extract it to `packages/bot/src/discord/handlers/channelGuard.ts` (pure: `(channels, channelId) => boolean`) and reuse it from all three handlers. Refactor `messageCreate.ts` to import it (behavior-preserving — keep its unit tests green).

- [x] **Task 2 — `handleMessageUpdate`** (AC-1, AC-3, AC-4, AC-6)
  - [x] New file `packages/bot/src/discord/handlers/messageUpdate.ts`. Define a narrow structural `UpdatableMessage` interface (mirror `IngestibleMessage` in `persistMessage.ts:37-46`): `{ id, channelId, guildId: string | null, content: string, editedAt: Date | null, author: { id: string; bot: boolean }, partial: boolean, fetch(): Promise<UpdatableMessage> }`. The real discord.js `Message` is structurally assignable.
  - [x] Signature: `handleMessageUpdate(newMessage, deps)` where `deps = { config, redis, logger }` (no `db` — publish-only). Wrap the whole body in `try/catch` → log `error`, never throw (copy the AC-4 pattern from `messageCreate.ts`).
  - [x] Guards, in order (**corrected in code review** — fetch must precede the author check, see Review Findings): (a) skip if channel not enabled → `debug`; (b) if `newMessage.partial`, `await newMessage.fetch()` to resolve `content`/`editedAt`/`author` (a raw partial can have a null `author`) — if `fetch()` throws (message deleted between edit and fetch), log `debug` and return, a `messageDelete` will follow; (c) skip if `ignore_bots && author.bot` (on the **fetched** message) → `debug`.
  - [x] **Defensive content-change guard [DECISION]:** Discord fires `messageUpdate` for non-content changes too (link-embed resolution, pins). Skip (`debug`) when the content did not actually change — the simplest reliable signal available here is: publish only when `editedAt` is non-null (a genuine user content edit sets it; embed-load updates do not). Do not over-engineer an old-vs-new diff (the old message is usually uncached). A redundant publish is safe anyway — the Sync worker re-index is idempotent (AD-13) — so bias toward publishing when unsure.
  - [x] Build the `MessageUpdatedEvent` (all string values), `xAdd(STREAM_KEYS.DISCORD_MESSAGES_UPDATED, '*', event)`. `guildId = message.guildId ?? config.discord.guild_id`.

- [x] **Task 3 — `handleMessageDelete`** (AC-2, AC-3, AC-4)
  - [x] New file `packages/bot/src/discord/handlers/messageDelete.ts`. Narrow interface `DeletableMessage = { id: string; channelId: string; guildId: string | null }` — **no** `content`/`author` (unavailable on a partial).
  - [x] Signature: `handleMessageDelete(message, deps)`, `deps = { config, redis, logger }`. Wrap in `try/catch` → `error`, never throw.
  - [x] Guard: skip if channel not enabled → `debug`. **Do not** filter bot authors (author unknown on a partial; AC-2 requires publishing regardless — the worker's delete is idempotent for never-indexed messages).
  - [x] Build `MessageDeletedEvent` with `timestamp = new Date().toISOString()`, `guildId = message.guildId ?? config.discord.guild_id`, `xAdd(STREAM_KEYS.DISCORD_MESSAGES_DELETED, '*', event)`.

- [x] **Task 4 — Wire up the client + listeners** (AC-5)
  - [x] `client.ts`: import `Partials`, add `partials: [Partials.Message, Partials.Channel]` to the `new Client({...})` options. Update the module comment.
  - [x] `main.ts`: register `client.on(Events.MessageUpdate, (_old, newMsg) => void handleMessageUpdate(newMsg, { config, redis, logger }))` and `client.on(Events.MessageDelete, (msg) => void handleMessageDelete(msg, { config, redis, logger }))`, next to the existing `MessageCreate` binding.

- [x] **Task 5 — Unit tests** (all ACs) — mirror `messageCreate.test.ts` (mock `redis.xAdd`, fake logger, `Partial<...>` message factory):
  - [x] `messageUpdate.test.ts`: publishes correct event on enabled channel; correct stream key + all-string fields + `type`; skips disabled/unconfigured channel (no `xAdd`, `debug` logged); skips bot author when `ignore_bots`; publishes bot author when `!ignore_bots`; calls `fetch()` when `partial` and uses fetched content; skips (no throw) when `fetch()` rejects; skips when `editedAt` is null (embed-load guard); logs `error` and does not throw when `xAdd` rejects; `newContent` never appears in any log.
  - [x] `messageDelete.test.ts`: publishes correct event on enabled channel (correct key, all-string fields, `type`); **publishes for a partial message with only `id`+`channelId`** (guildId falls back to `config.discord.guild_id`); skips disabled/unconfigured channel; does **not** filter bot authors; logs `error` and does not throw when `xAdd` rejects.
  - [x] `channelGuard.test.ts` (or fold into existing): enabled / disabled / unconfigured.

- [x] **Task 6 — Verify** — `npm run lint && npm run test && npm run build` all green. No new dependency. No changes under `packages/shared` (contracts already exist).

---

### Review Findings (bmad-code-review, 2026-07-08)

- [x] [Review][Patch] **No empty-content guard on `messageUpdate` (asymmetry with `messageCreate`)** — FIXED (Borja chose to add the symmetric guard). `messageCreate.ts:52-58` skips + `warn`s on empty content; `messageUpdate` now mirrors it (`messageUpdate.ts`, after the editedAt guard): an empty/whitespace-only resolved content skips + `warn`s instead of publishing `newContent: ''`, so the Sync worker (6.2) never re-indexes a real doc to empty (MessageContent-intent-off failure mode). New test: "skips and warns when the resolved content is empty". Sources: edge.
- [x] [Review][Patch] **`messageUpdate` bot-author guard dereferenced `author` before the partial `fetch()`** [packages/bot/src/discord/handlers/messageUpdate.ts] — FIXED. The `ignore_bots && author.bot` check ran BEFORE the partial `fetch()`; on an uncached partial edit (the exact case `Partials.Message` was added for, AC-5/Recon #5) discord.js can deliver `author` as `null` → `TypeError` → caught → logged `error` → edit silently dropped. Fix: `fetch()` now runs FIRST, and the bot-author + editedAt + empty-content guards run against the hydrated `message`. Task 2's documented guard order and the module header comment updated to match. New tests: "applies the bot-author guard to the FETCHED message" + "does not throw when a partial arrives with a null author". All 3 review layers flagged this. Sources: blind+edge+auditor.

**Verification after fixes:** `npm run lint` 0 · `npm run test` 545 passed (68 files, +3 new) · `npm run build` clean (5 workspaces).

**Second review round (2026-07-08):** re-ran the adversarial layers on the patched handler. ✅ Clean — both fixes confirmed correct, no new defect, no blocking issue. Residuals were all cosmetic (dead `editedAt ?? new Date()` fallback, which matches AC-1's literal text; edit-to-attachment-only not published, inherited from `messageCreate` design). Closed the one worthwhile gap: added `''`-branch + partial-resolves-to-empty tests. Final: `npm run test` 547 passed (+2), build clean.

---

## Dev Notes

### Architecture & patterns to follow
- **Reuse the `messageCreate` shape.** `handleMessageUpdate`/`handleMessageDelete` are the direct siblings of `handleMessageCreate` (`packages/bot/src/discord/handlers/messageCreate.ts`): dependency-injected, pure guard logic, whole body in a `try/catch` that logs at `error` and never throws (AC-4 / the `void handleX(...)` binding in `main.ts`). Copy that structure; do not invent a new error strategy.
- **Publish-only, no transaction.** `persistMessage.ts` wraps INSERT + XADD in a Drizzle transaction *because* it writes the DB. These handlers do **not** write the DB, so there is no transaction — a bare `redis.xAdd(...)` is correct and simplest. (Reconciliation #4.)
- **The event contracts are done.** `MessageUpdatedEvent` / `MessageDeletedEvent` / `STREAM_KEYS` already exist in `packages/shared/src/types/events.ts`. Import and populate them; changing `packages/shared` is out of scope for this story.
- **AD-13 string rule.** Every value handed to `xAdd` must be a string. `messageId`/`channelId`/`guildId` are already snowflake strings; `timestamp` = `.toISOString()`; `type` is a literal; `newContent` is a string. Mirror the `Record<keyof T, string>` pattern used in the backfill publisher (`backfiller.ts:245-257`) if you want compile-time enforcement.

### discord.js v14 (`^14.26.4`) gotchas — the crux of this story
- **`Partials` is mandatory for uncached events.** Without `partials: [Partials.Message, Partials.Channel]` on the `Client`, discord.js **silently drops** `messageUpdate`/`messageDelete` for any message not in its in-memory cache — which is most of them after a restart. This is the single most common way this feature ships broken. (Reconciliation #5, AC-5.)
- **`Events.MessageUpdate` callback is `(oldMessage, newMessage)`.** Use `newMessage`. `Events.MessageDelete` is `(message)`.
- **Partials carry almost nothing.** A partial delete `message` guarantees only `id` and `channelId`; `guildId`, `content`, `author` may be `null`/absent. Hence `DeletableMessage` omits `content`/`author`, and the delete handler cannot filter bots (AC-2). For update, `newMessage.partial` may be true — `await newMessage.fetch()` to hydrate `content`/`editedAt`; `fetch()` **rejects** if the message was deleted meanwhile (catch → skip).
- **`messageUpdate` is noisy.** It fires on embed resolution and pin changes, not just user edits. The `editedAt`-non-null guard (Task 2) filters most false positives; the idempotent Sync worker absorbs any that slip through. `messageDeleteBulk` (Discord bulk purge) is a **separate** event and is **out of scope** — the epic specifies `messageDelete` only.

### Source tree — files to touch
- **NEW** `packages/bot/src/discord/handlers/messageUpdate.ts` + `messageUpdate.test.ts`
- **NEW** `packages/bot/src/discord/handlers/messageDelete.ts` + `messageDelete.test.ts`
- **NEW** `packages/bot/src/discord/handlers/channelGuard.ts` + test (extracted from `messageCreate.ts`)
- **UPDATE** `packages/bot/src/discord/client.ts` — add `partials`
- **UPDATE** `packages/bot/src/main.ts` — register the two listeners
- **UPDATE** `packages/bot/src/discord/handlers/messageCreate.ts` — import the extracted `isChannelEnabled` (keep its tests green)
- **NO CHANGE** `packages/shared/**` — contracts already exist

### Testing standards
- Vitest, co-located `*.test.ts`, dependency-injected fakes — copy `messageCreate.test.ts` verbatim as the scaffold (fake logger via `vi.fn()`, `xAdd` spy via `{ xAdd } as unknown as RedisClient`, a `message(overrides)` factory).
- **Must-test invariants** (`project-context.md` §67, adapted): the produced event fields are all strings; the correct stream key is used; a skip publishes nothing; a failed publish leaves the process alive (no throw). Also assert content is never logged (copy the `messageCreate.test.ts:130-140` serialization check).

### Project Structure Notes
- Handlers stay under `packages/bot/src/discord/handlers/` (established in Story 3.1). No root `src/`. The bot depends only on `@hivly/shared`, never another service (AD-2). English only in all code/comments/tests (`project-context.md`).

### Previous-story intelligence
- **Story 3.1** established the handler pattern, the local `logger.ts`, the shared `createRedisClient`, and (note #8) explicitly deferred `messageUpdate`/`messageDelete` to this story.
- **Story 3.2** amplified an accepted at-least-once duplicate-event trade-off (`persistMessage.ts:18-25`); the same philosophy applies here — publish liberally, let the idempotent consumer dedupe (AD-13). This is why the update content-change guard biases toward publishing.
- **Redis gotcha (memory):** two Redis instances exist on this Mac — `localhost:6379` (Homebrew) vs the Compose Redis (no published ports). Local vs dockerized bot code hit different streams. Keep this in mind when manually verifying `XADD`/`XLEN` against `hivly:discord:messages:updated`/`:deleted`.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 6.1]
- [Source: packages/shared/src/types/events.ts#21-80 — MessageUpdatedEvent, MessageDeletedEvent, STREAM_KEYS, CONSUMER_GROUPS]
- [Source: packages/bot/src/discord/handlers/messageCreate.ts — handler pattern, guards, error-swallowing]
- [Source: packages/bot/src/persistence/persistMessage.ts#37-104 — IngestibleMessage shape, guildId fallback, xAdd field mapping]
- [Source: packages/bot/src/discord/client.ts — createDiscordClient (add partials)]
- [Source: packages/bot/src/main.ts#97-112 — listener registration pattern]
- [Source: packages/bot/src/backfill/backfiller.ts#245-257 — Record<keyof T, string> xAdd pattern]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-hivly-2026-06-30/TECHNICAL-DESIGN.md#5.3 — Sync worker consumes these streams (Story 6.2)]
- [Source: _bmad-output/project-context.md — AD-13 stream invariants, never-log-content, workers idempotent]

## Project Context Reference

See `_bmad-output/project-context.md` (backend rules, AD-13 stream invariants, anti-patterns) and `CLAUDE.md` (non-negotiables). Standards: `docs/base-standards.md`, `docs/backend-standards.md`.

## Decisions (confirmed with Borja, 2026-07-08)

1. **[DECIDED — Reconciliation #2]** Map epic's `editedAt`/`deletedAt` onto the contract's mandatory `timestamp` (+ `guildId`); **do not** add extra keys. The `MessageUpdatedEvent`/`MessageDeletedEvent` contracts in `@hivly/shared` are authoritative; no `packages/shared` changes.
2. **[DECIDED — Task 2]** The update handler **filters `messageUpdate` noise by publishing only when `editedAt` is non-null** (real user edit), biasing toward publishing when unsure and relying on the idempotent Sync worker to absorb any false positives. NOT publishing unconditionally.
3. **[DECIDED]** `messageDeleteBulk` (moderation bulk-purge) is **out of scope** — Story 6.1 handles `messageDelete` only. Tracked as a follow-up in `_bmad-output/implementation-artifacts/deferred-work.md`.

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (bmad-dev-story)

### Debug Log References

None — implementation went green on the first pass for each task (lint 0 / tests pass / build clean), no debugging loop required.

### Completion Notes List

- Extracted `isChannelEnabled` from `messageCreate.ts` into a new pure `channelGuard.ts` (`(channels, channelId) => boolean`); `messageCreate.ts` now imports it, behavior-preserving, its existing unit tests untouched and still green.
- `handleMessageUpdate` implements the exact guard order from Dev Notes: channel-enabled → bot-author (`ignore_bots`) → partial `fetch()` (catch → debug skip, a delete will follow) → `editedAt === null` skip (filters Discord's non-content `messageUpdate` noise — embed resolution, pins). Publish-only (no `db`, no transaction) per Reconciliation #4.
- `handleMessageDelete` intentionally has **no** bot-author guard — the delete `message` is often a partial exposing only `id`/`channelId`, so `DeletableMessage` omits `content`/`author` entirely (AC-2).
- `xAdd` payloads are typed `Record<keyof T, string>` (not the plain event interface) in both new handlers — the interface has no index signature so TypeScript rejects it directly against `RedisArgument`'s `Record<string, RedisArgument>` target; mirrors the existing pattern in `backfiller.ts:245`.
- `createDiscordClient` now creates the `Client` with `partials: [Partials.Message, Partials.Channel]` — verified via `tsc --noEmit` that discord.js's real `Message`/`PartialMessage` types are structurally assignable to the new `UpdatableMessage`/`DeletableMessage` interfaces (including the recursive `fetch(): Promise<UpdatableMessage>` signature) with zero casts needed at the `main.ts` call sites.
- No new dependencies, no `packages/shared` changes (contracts already existed), no DB migration.
- Full gate re-run clean: `npm run lint` 0 errors; `npm run test` 542/542 passed (68 files, +28 new: channelGuard 3, messageCreate unchanged 8, messageUpdate 11, messageDelete 6); `npm run build` clean across all 5 workspaces (`tsc --noEmit` backend/bot/shared/workers, `vite build` web).

### File List

**New:**
- `packages/bot/src/discord/handlers/channelGuard.ts`
- `packages/bot/src/discord/handlers/channelGuard.test.ts`
- `packages/bot/src/discord/handlers/messageUpdate.ts`
- `packages/bot/src/discord/handlers/messageUpdate.test.ts`
- `packages/bot/src/discord/handlers/messageDelete.ts`
- `packages/bot/src/discord/handlers/messageDelete.test.ts`

**Modified:**
- `packages/bot/src/discord/handlers/messageCreate.ts` (imports extracted `isChannelEnabled` instead of the private local copy)
- `packages/bot/src/discord/client.ts` (adds `partials: [Partials.Message, Partials.Channel]`)
- `packages/bot/src/main.ts` (registers `Events.MessageUpdate` / `Events.MessageDelete` listeners)

## Change Log

- 2026-07-08 — Story 6.1 implemented (bmad-dev-story). Bot publishes `discord.message.updated`/`discord.message.deleted` to their Redis Streams on live Gateway edit/delete events, with `Partials` enabled so uncached messages are covered. Publish-only — no DB write, no `packages/shared` change. Status → review.
