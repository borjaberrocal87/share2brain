---
baseline_commit: d9d05f20488cb6af0f837304069b0a4c522e8a0f
---

# Story 9.4: bot + shared — Capture `author_name` in `discord_messages`

Status: done

## Story

As a community member viewing the Statistics view,
I want the Bot to capture each message author's visible display name at ingestion time,
so that the upcoming "Top 5 usuarios más activos" section (Story 9.5) can show real names instead of raw Discord snowflakes.

> Approved via `bmad-correct-course` (2026-07-10, `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10-topusers.md`). Promoted from Story 9.1 review decision D9. **No new FR** — part of the Statistics view (FR24), respects FR25. Binding sequence: **9.4 → 9.5 → (9.2 render, 9.3 e2e)**.

## Scope (what this story is and is NOT)

- **IS:** nullable column `discord_messages.author_name` (DDL in shared, AD-5) + the Bot capturing the author's visible name on the **create** ingestion path and the **edit** ingestion path (Epic 6 handlers), plus the minimal Sync-worker persistence the edit path requires (see D1).
- **IS NOT:** no SQL backfill of existing rows (they stay `NULL` forever unless the message is edited post-deploy); no `topUsers` contract/query/endpoint (that is 9.5); no `COALESCE` resolution anywhere (9.5); no web render (9.2); no e2e (9.3); no `api-spec.yml` change (verified: the spec nowhere references `discord_messages`; `topUsers` lands in the spec with 9.5).
- Downstream contract this story enables (do not implement here): 9.5 resolves `authorName = COALESCE(dm.author_name, u.username, dm.author_id)` joining `users.discord_id = discord_messages.author_id`.
- **Reversal notice:** Story 3.1 ratified "`discord_messages` has NO `author_name` column — the epic's INSERT list was stale, insert only columns that exist". This story deliberately reverses half of that: the column now exists and the INSERT must carry it.

## Acceptance Criteria

1. **AC1 — Schema + migration (shared, AD-5).** `packages/shared/src/db/schema.ts` `discordMessages` gains `authorName: text('author_name')` (nullable, no default, no index). Migration generated with `npx drizzle-kit generate` (lands as `packages/shared/src/db/migrations/0005_*.sql` + `meta/0005_snapshot.json` + journal entry — **never hand-edited**), applied locally with `npx drizzle-kit migrate` and verified in psql (`\d discord_messages`) **before** any dependent code. Existing rows read back `NULL`.
2. **AC2 — Create path capture (bot).** `persistMessage` writes `authorName` from the message author's visible name (D2) in its existing single-transaction INSERT. Because live `messageCreate` and the backfill/gap-fill (`backfiller.ts` → `persistWithRetry` → `persistMessage`) share this path, both capture the name with the same one change to `IngestibleMessage` + the backfill `fetchPage` mapping. `onConflictDoNothing` semantics unchanged: an already-persisted row is **never** retro-updated by the create path (this is the "no backfill" guarantee, ratified — do not "fix" it).
3. **AC3 — Edit path capture (bot + shared + workers, D1).** `MessageUpdatedEvent` (in `packages/shared/src/types/events.ts`) gains a wire-optional `authorName?: string`. The bot's `messageUpdate` handler includes it in the XADD event, read from the **hydrated** message (post-`fetch()`). The Sync worker (`parseUpdatedEvent` + `processUpdate`) persists it inside its **existing** step-6 `UPDATE discord_messages` transaction: `SET author_name` only when a non-empty `authorName` arrived; a missing/empty field leaves the column untouched (legacy in-flight events and defensive blanks must not null-out or blank-out a stored name). `MessageCreatedEvent` is **unchanged** (the Indexer never writes author data; the bot writes the row directly).
4. **AC4 — Partial/delete safety (6.1 gotcha preserved).** The name is read only **after** the existing partial-`fetch()` guard in `messageUpdate.ts` — a partial arriving with `author: null` must not throw (existing test invariant stays green). `messageDelete` is untouched (its payload guarantees no author). Startup offline reconciliation (6.3) inherits the edit capture automatically by reusing `handleMessageUpdate` — no new code in `offlineSync.ts`/`reconcile.ts` beyond type-slice compatibility.
5. **AC5 — Tests.** Unit: bot capture on create (insert values include `authorName`) and on edit (event includes `authorName` from the fetched message); workers `processUpdate` sets `author_name` when present and skips it when absent/empty. Integration: `persistMessage.integration.test.ts` asserts the persisted `author_name`; `sync.integration.test.ts` asserts the edit refresh. All pre-existing exact-shape assertions updated (see Test Impact map). Idempotency invariants preserved: double-delivery → 1 row + 1 event; failed processing leaves the entry un-ACKed. **Author names are never logged** (same posture as the content-never-logged convention; existing log lines keep logging only ids/lengths).
6. **AC6 — Gate + docs sync.** `npm run lint` → `npm run test` → `npm run build` → `npm run test:integration` all green, outputs pasted (integration per §3.2: `docker compose up -d postgres redis`, migrations applied, **app containers stopped** — `docker compose stop bot backend workers`). §3.3 (endpoint) and §3.4 (e2e) explicitly N/A — no endpoint, no UI. Docs synced in-story (this list is definitive, already grep-verified — do not hunt further): `docs/data-model.md` §1 `discord_messages` field list (+ the one-liner "The Bot is the only writer" gets a Sync-worker caveat while you're there); `docs/context/TECHNICAL-DESIGN.md` §8 (~line 619, the only doc reproducing `MessageUpdatedEvent` verbatim) **and** §6 "Modelo de datos" mermaid ERD (~lines 415-425, enumerates every `discord_messages` column). `docs/backend-standards.md` has `newContent` hits (~278-279) but they are an **unrelated DDD entity example — do not touch**; `ARCHITECTURE-SPINE.md` AD-13 lists only minimum fields — an optional field changes nothing there. No `api-spec.yml` change (PRD's legacy draft DDL at PRD.md:733 already contains `author_name` — no action).

## Tasks / Subtasks

- [x] Task 1 — shared: schema + migration (AC1)
  - [x] Add `authorName: text('author_name'),` to `discordMessages` in `packages/shared/src/db/schema.ts` (after `authorId`, comment it `// nullable — visible display name captured at ingestion (9.4); old rows stay NULL`)
  - [x] `npx drizzle-kit generate` from repo root (config `drizzle.config.ts` is at root; no live DB needed) → verify `0005_*.sql` is exactly `ALTER TABLE "discord_messages" ADD COLUMN "author_name" text;`
  - [x] `docker compose up -d postgres redis` → `npx drizzle-kit migrate` → `\d discord_messages` in psql shows the nullable column; existing rows `NULL`
- [x] Task 2 — shared: event contract (AC3)
  - [x] `packages/shared/src/types/events.ts`: add `authorName?: string;` to `MessageUpdatedEvent` with a comment: wire-optional for legacy in-flight events; producers always send it (AD-13 all-string values). Leave `MessageCreatedEvent` untouched.
- [x] Task 3 — bot: create path (AC2)
  - [x] `packages/bot/src/persistence/persistMessage.ts`: extend `IngestibleMessage.author` to `{ id: string; bot: boolean; displayName: string }` and add `authorName: message.author.displayName,` to the `.values({...})`. Do NOT add it to the create-event XADD payload.
  - [x] `packages/bot/src/backfill/backfiller.ts` `fetchPage` mapping (~line 157-168): add `displayName: m.author.displayName` to the `author` slice (REST-fetched messages have a real `User`; `member` is typically null there — irrelevant under D2)
- [x] Task 4 — bot: edit path (AC3, AC4)
  - [x] `packages/bot/src/discord/handlers/messageUpdate.ts`: extend `UpdatableMessage.author` with `displayName: string`; add `authorName: message.author.displayName,` to the event object — note the producer type is `Record<keyof MessageUpdatedEvent, string>`, so TypeScript will force the new key everywhere the event is built (that is desired). Read it from the post-fetch hydrated message, exactly where `author.bot` is read today.
  - [x] Confirm 6.3 compatibility compiles untouched: `offlineSync.ts` feeds real discord.js `Message`s (structurally assignable — `User#displayName` exists, discord.js 14.26.4) into `handleMessageUpdate`; `reconcile.ts` `FetchedMessage = UpdatableMessage` picks the field up by aliasing. `tsc --noEmit` (via `npm run lint`/build) is the proof, zero casts — if a cast becomes necessary, stop and re-read D2.
- [x] Task 5 — workers: sync persistence (AC3)
  - [x] `packages/workers/src/sync/events.ts` `parseUpdatedEvent`: carry `authorName` through as optional — normalize absent/empty to `undefined` (do not default to `''` like content-ish fields; `''` must never reach the UPDATE)
  - [x] `packages/workers/src/sync/processUpdate.ts` (~line 157-161): when `authorName` is defined, include `author_name = ${authorName}` in the existing `UPDATE discord_messages SET content, updated_at` statement (same transaction, same idempotency; when undefined, emit the exact current SQL)
- [x] Task 6 — tests (AC5) — see Test Impact map in Dev Notes; tests-first for the pure logic (parse/normalize), test-after acceptable for adapter glue per backend-standards
- [x] Task 7 — docs + gate (AC6)
  - [x] Sync `docs/data-model.md` §1 (+ "only writer" caveat) and TECHNICAL-DESIGN §8 event interface + §6 ERD — the definitive list from AC6; backend-standards/spine confirmed no-change
  - [x] Run the full gate; paste outputs; state §3.3/§3.4 skips explicitly
  - [x] Commit slices: `feat(shared): …` (schema + migration + event type — contract changes are shared-scoped even when a consumer motivates them; additive/optional → **no `!`**), `feat(bot): …`, `feat(workers): …`, `docs(repo): …`. Branch `feat/9-4-author-name-capture` off up-to-date `main`. PR, never auto-merge → `bmad-code-review`.

### Review Findings

_Code review 2026-07-10 (bmad-code-review, 3 adversarial layers @ Opus — Blind Hunter / Edge Case Hunter / Acceptance Auditor). Auditor: 0 AC/D violations (AC1–AC6 + D1–D6 all verified). Result: 0 decision-needed, 0 patch, 1 defer (Low), 5 dismissed._

- [x] [Review][Defer] Edit-path producer trusts the fetched message is fully hydrated — no runtime guard on `author.displayName` before it reaches `xAdd` [`packages/bot/src/discord/handlers/messageUpdate.ts:124`] — deferred, pre-existing. If `displayName` were ever runtime-`undefined`/non-string, `xAdd` would reject and the whole edit (content included) is dropped by the outer catch. Unreachable under discord.js 14.26.4 (`User#displayName` = `globalName ?? username`, non-null on a hydrated author) and rides on the SAME accepted hydration assumption as the existing `author.bot` read on the identical post-`fetch()` path. Deliberately NOT patched: the codebase convention is "producer trusts discord.js types, consumer validates at the stream trust boundary" (`parseUpdatedEvent` already normalizes absent/blank → `undefined`), and hardening only `displayName` (not `newContent`/`guildId`, equally trusted) would be inconsistent. Revisit only as a whole-producer stream-write hardening decision.

- [x] [Review][Defer] Out-of-order / stale edit redelivery can regress a stored `author_name` (and `content`/`updated_at`) [`packages/workers/src/sync/processUpdate.ts:159-165`] — deferred, pre-existing. The step-6 `UPDATE` has no `WHERE updated_at <= ${timestamp}` monotonicity guard, so if an older edit event is replayed AFTER a newer one committed (failed→reclaimed from the PEL, or two scaled Sync workers interleaving), the older display name overwrites the newer. The `authorName !== undefined` guard prevents *blanking* but not *reverting*. **NOT new logic** — `content`/`updated_at` already ride the identical unguarded last-write-wins overwrite (pre-existing 6.2/7.3 behavior); this story merely extends the same staleness window to the new column. Raised independently by Blind Hunter + Edge Case Hunter (re-run). Fixing it means a monotonicity guard on the whole UPDATE — a Sync-worker concern, out of scope for a 9.4 author_name story.

_Re-run 2026-07-10 (identical diff, extra scrutiny): Auditor re-confirmed 0 AC/D/AD violations (each test file + docs opened, not just the diff; migration byte-exact incl. no trailing newline; AD-2/AD-13 honored). Added the out-of-order defer above; 9 further findings dismissed — the Blind Hunter's two Mediums were verified false positives against source: (a) the "`Record<keyof T,string>` forces the key" comment is accurate — the producer IS typed that way at `messageUpdate.ts:117` (Blind lacked source); (b) `authorName: undefined` compiles fine — `exactOptionalPropertyTypes` is unset repo-wide (default false), and the gate is green. Also dismissed: the "production adapter absent" worry (structural slices — real discord.js Messages are assignable, tsc green), unit-test substring-match weakness + `sqlText` empty-fragment (ratified `s.includes` convention; the real SQL correctness is proven by the `sync.integration.test.ts` DB-row assertion), MessageCreatedEvent asymmetry (AC3-mandated), and two contrived seed/coverage nits._

**Dismissed (verified false positives / spec-sanctioned):** (1) create-path stores `displayName` verbatim without trim — insert has no stored name to blank-overwrite (`onConflictDoNothing`) and `username` is never empty, so the update-path normalization's concern (D3) does not apply to a fresh INSERT; (2) "every edit overwrites `author_name`" — ratified D4 (newer display name = newer truth), confirmed deliberate by the reporting layer itself; (3) historical rows stay `NULL` — ratified D5 "no backfill" + planned 9.5 `COALESCE`, by design; (4) rename without a content edit not captured — ratified D5 explicitly ("accepted, consistent with no-backfill"); (5) a literal `''` passed directly to `processUpdate` would blank the column — not reachable, the only production caller is `parseUpdatedEvent`, which guarantees `undefined` for blanks, so D3 holds.

## Dev Notes

### The write topology (read this before touching anything)

The epic sentence "el Bot la escribe en los handlers de create y edit" is **imprecise about the edit half** — the real topology, verified in source:

- **CREATE:** the Bot itself INSERTs the `discord_messages` row, atomically with the XADD, in one Drizzle transaction — `packages/bot/src/persistence/persistMessage.ts:69-101` (`onConflictDoNothing`; 0 rows → no event; every XADD value a string). The Indexer worker **never inserts** into `discord_messages`; it only stamps `indexed_at` (`packages/workers/src/indexer/indexBatch.ts:89-93`) and treats a missing row as "bot COMMIT not landed" (leaves un-ACKed). So the create capture is a `persistMessage` change; the Indexer is untouched.
- **EDIT:** the Bot handler is **publish-only** (`messageUpdate.ts` deps are `{config, redis, logger}` — no db). The Sync worker does the write: `packages/workers/src/sync/processUpdate.ts:157-161` `UPDATE discord_messages SET content = …, updated_at = …` inside its step-6 transaction, XACK after COMMIT (AD-13). Hence D1.
- **BACKFILL (3.2) & OFFLINE SYNC (6.3):** there are only TWO producers of these event shapes in production code — `persistMessage.ts` (created) and `messageUpdate.ts` (updated). Backfill maps discord.js Messages to `IngestibleMessage` (`backfiller.ts:157-168`) and calls `persistMessage`; offline sync calls `handleMessageUpdate` with real fetched Messages (`offlineSync.ts:165-167`). Extend the two slices and both auxiliary paths ride along for free.
- **DELETE:** no author exists on the payload (`DeletableMessage = { id, channelId, guildId }`; a partial delete guarantees only `id`+`channelId`) — out of scope by construction.

### Ratified defaults (flag every one in review; Borja may veto)

- **D1 — Edit-path persistence goes through the event + Sync worker,** not a direct Bot UPDATE. Rationale: preserves the 6.1 publish-only handler contract (no db dep in `messageUpdate`), reuses the Sync worker's existing UPDATE transaction + idempotency, and 6.3 inherits it verbatim. Cost: the story touches `workers` (small) although the epic labels it "bot + shared" — the SCP's test note ("unit del parseo/escritura en el Bot") predates discovering the publish-only topology. The literal alternative (Bot writes DB on edit) matches the spine's State-Ownership row ("`discord_messages` owner: bot") but that row is already de-facto loose (Sync updates content/updated_at/indexed_at/deleted_at today) and would fork the write path for the same column.
- **D2 — Visible name = `message.author.displayName`** (discord.js 14.26.4: `User#displayName` ⇒ `globalName ?? username`, always a non-null string). **NOT** `member.displayName` (server nickname): `Message#member` is often `null` on REST-fetched pages (backfill and offline sync fetch with `cache: false`) and on uncached gateway events, so nickname capture would be nondeterministic — the same author would get different names depending on which path ingested the message. Global display name is path-consistent. Epic wording "(username/displayName)" is satisfied: `displayName` falls back to `username` by definition.
- **D3 — Wire encoding:** `authorName?: string` optional on the **interface** (consumer tolerates legacy events parked in the stream from before deploy), while producers keep building `Record<keyof MessageUpdatedEvent, string>` — `Record` over `keyof` makes even optional keys required, so the compiler forces every new producer to send it. Consumer normalizes absent/`''` → `undefined` → column untouched. Never write `''` and never overwrite a stored name with an empty value.
- **D4 — Edits DO refresh an existing `author_name`** (a newer display name is newer truth). The create path never does (AC2, `onConflictDoNothing`).
- **D5 — "No backfill" scope:** no retro-population of existing rows by any mechanism in this story. New messages (live + gap-fill backfill) carry the name; old rows converge only if edited. An offline **name change without a content edit** is NOT detected (offline sync diffs content only, `offlineSync.ts:154-156`) — accepted, consistent with no-backfill.
- **D6 — PII posture:** author names never appear in log lines (extend the "content never logged" convention; keep logging ids/`contentLength` only). Tests that serialize logged args and assert content absence are the pattern to mirror if you add any log.

### Current state of every file you will modify

| File | Today | Change |
| --- | --- | --- |
| `packages/shared/src/db/schema.ts:38-55` | `discordMessages`: id/channelId/guildId/authorId/content notNull text, createdAt/updatedAt notNull timestamptz, indexedAt/deletedAt nullable, index `idx_discord_messages_channel(channel_id, created_at DESC)` | +1 nullable text col after `authorId`; index untouched |
| `packages/shared/src/types/events.ts:15-24` | `MessageCreatedEvent {type, content, authorId}`, `MessageUpdatedEvent {type, newContent}` (both extend `StreamEvent {messageId, channelId, guildId, timestamp}`); header comment: deliberately TS interfaces, NOT Zod (internal stream shapes, not HTTP bodies — do not "fix" this) | +`authorName?: string` on Updated only |
| `packages/bot/src/persistence/persistMessage.ts` | `IngestibleMessage.author = {id, bot}` (line 37-46); tx: INSERT `.values({id, channelId, guildId, authorId, content, createdAt, updatedAt: editedAt ?? createdAt})` `.onConflictDoNothing().returning()`; 0 rows → skip XADD | +`displayName` in slice; +`authorName` in `.values()`; XADD payload unchanged |
| `packages/bot/src/backfill/backfiller.ts:157-168` | `fetchPage` maps fetched Messages → `IngestibleMessage` incl. `author: {id: m.author.id, bot: m.author.bot}` | +`displayName: m.author.displayName` |
| `packages/bot/src/discord/handlers/messageUpdate.ts` | Guard order (post-6.1-review, DO NOT reorder): channel-enabled skip → **if `partial`, `await fetch()`** (reject → debug skip) → `author.bot` / empty-content guards on the hydrated message → build `Record<keyof MessageUpdatedEvent, string>` event → XADD `hivly:discord:messages:updated`; whole body try/catch, never throws, content never logged | +`displayName` in `UpdatableMessage.author`; +`authorName` in the event object |
| `packages/workers/src/sync/events.ts:24-46` | `parseUpdatedEvent` gates on `messageId`/`channelId`/`timestamp`, carries other fields with permissive defaults; extra fields ignored (forward-compatible — no versioning machinery exists or is needed) | parse optional `authorName`, empty→`undefined` |
| `packages/workers/src/sync/processUpdate.ts:157-161,191` | step-6 tx: DELETE read-status → DELETE embeddings → `UPDATE discord_messages SET content, updated_at` → UPSERT new embeddings → `UPDATE … SET indexed_at = now()`; XACK after COMMIT | conditionally extend the first UPDATE with `author_name` |
| `packages/bot/src/sync/{offlineSync,reconcile}.ts` | 6.3 publish-only reads (`SELECT id, content …`); reuses `handleMessageUpdate` with real fetched Messages; `FetchedMessage = UpdatableMessage` | expected ZERO code change — compile-check only |

Blast radius of the nullable column elsewhere: **none breaks** — every reader uses explicit column lists. Notably `packages/backend/src/infrastructure/{embeddingSearchRepository,documentRepository}.drizzle.ts` already ship the stub `dm.author_id AS "authorName" -- D2: no display name persisted yet` — that COALESCE upgrade is **9.5's, leave it alone**. `packages/backend/src/e2e/seed.ts` explicit-column insert also untouched (9.3 extends it).

### Test Impact map (AC5)

Exact-shape assertions that WILL break and must be updated (not deleted):

- `packages/bot/src/discord/handlers/messageUpdate.test.ts` — event `toEqual` (~lines 58-76) gains `authorName`; the `message(overrides)` factory (~29-41) gains `author.displayName` **and so do the four inline whole-object `author:` overrides at ~99, 107, 126, 136** (they replace the entire author object). Add: "publishes the authorName of the FETCHED message" (mirror the existing partial-fetch test at ~112-121); keep green: "does not throw when a partial arrives with a null author" (~135).
- `packages/bot/src/persistence/persistMessage.test.ts` — insert-values `toMatchObject` (~98-117) gains `authorName`; the exact XADD-fields `toEqual` (~60-85) must stay **unchanged** (create event not extended — a failing expectation here means you extended the wrong thing).
- **Compile-only fixture breaks (TS errors, not assertion failures — fix the fixtures, NEVER weaken the slice types):** `packages/bot/src/discord/handlers/messageCreate.test.ts` (`message()` factory ~31-40, author literal ~37, inline overrides ~95 and ~104) and `packages/bot/src/sync/reconcile.test.ts` (`fetchedMessage()` author literal ~14).
- `packages/bot/src/backfill/backfiller.test.ts` + `packages/bot/src/sync/offlineSync.test.ts` — `author: {id, bot}` literals gain `displayName`.
- `packages/bot/src/persistence/persistMessage.integration.test.ts` — explicit-column SELECT (~66-67) + row assertions: add `author_name`.
- `packages/bot/src/backfill/backfill.integration.test.ts` — the fake client cast (`as unknown as Client`, ~101) means no compile break, but the fixture author (~89) lacks `displayName` → the backfilled row would silently persist `NULL`. Add `displayName` to the fixture AND assert the persisted `author_name`, so the backfill create-path capture has integration evidence.
- `packages/workers/src/sync/events.test.ts` — existing `toEqual` (~16) stays green (`toEqual` ignores `undefined` keys), but the new parse normalization (absent/`''` → `undefined`) gets its unit cases HERE, not only in `processUpdate.test.ts`.
- `packages/bot/src/sync/offlineSync.integration.test.ts` — asserts the **exact string fields** of landed update events → gains `authorName`.
- `packages/workers/src/sync/processUpdate.test.ts` — mirror the existing `'should refresh discord_messages.content and updated_at'` (~434-447, matches SQL via `s.includes(...)`): new cases "sets author_name when the event carries it" / "leaves author_name out of the UPDATE when absent or empty".
- `packages/workers/src/sync/sync.integration.test.ts` — seed insert is explicit-column (fine); extend the edit assertion (`select content, updated_at …` ~207) with `author_name`.

Conventions: Vitest, co-located `*.test.ts` / `*.integration.test.ts`; unit tests never open real connections (plain-object messages matching the structural slices, `{ xAdd } as unknown as RedisClient`, fake `db.transaction` recording values); `describe('[Component] — [method]')`, "should … when …", AAA, `vi.clearAllMocks()` in `beforeEach`. Integration: real PG+Redis, **suffix-unique ids AND role names**, ids derived from a per-run salt (hardcoded snowflakes collided across suites in 6.3), cleanup own rows in FK order, stop app containers first (OPS-2 guard only catches foreign-address writers). Known flake: `rbac.integration.test.ts` is load-sensitive — rerun before blaming your diff.

### Architecture constraints (verbatim anchors)

- **AD-5:** all DDL in `packages/shared/src/db/schema.ts`, migrations via drizzle-kit, no service does DDL. **AD-2:** bot/workers import only `@hivly/shared`. **AD-9:** the compose `migrator` service applies migrations in deployments; never manual in prod. **AD-13:** stream keys/groups fixed (`hivly:discord:messages:updated` → group `hivly:sync`); minimum fields `messageId, channelId, guildId, timestamp`; **every XADD value must be a string**; XACK only after success. Producers/consumers reference `STREAM_KEYS`/`CONSUMER_GROUPS` constants, never literals.
- Commit-scope rule (base-standards §8): schema/contract changes are scoped `shared` even when a consumer motivated them; additive nullable column + optional event field = **no** breaking-change marker.
- Language: all code/comments/tests/commits in English (Spanish conversation never changes that).

### Manual verification gotchas (from 9.1/6.x)

Two Redis instances on this Mac: Homebrew owns `localhost:6379`; the compose Redis publishes **no ports** — local `npm run dev` processes and dockerized services hit **different streams**. For an end-to-end smoke (optional; integration tests are the required evidence): real test guild `1498305407159107735` (channels `general` `1498305410942369908`, `modelos` `1498779601030086707`), restore state after. `HIVLY_CONFIG_PATH=<repo-root>/Hivly.config.yml` when running a workspace dev server from a subdir.

### Project Structure Notes

- All bot code under `packages/bot/src/`, workers under `packages/workers/src/`, DDL + event types under `packages/shared/src/` — no root `src/`, no cross-service imports (AD-2). Files touched are UPDATEs only; **zero new files** except the generated migration artifacts.
- Migration naming is drizzle-random (`0005_<codename>.sql`) — do not rename it.

### References

- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10-topusers.md §4.1, §5]
- [Source: _bmad-output/planning-artifacts/epics.md §Épico 9 — Historia 9.4 + Top-5 blockquote]
- [Source: docs/context/ARCHITECTURE-SPINE.md AD-2, AD-5, AD-9, AD-13, State Ownership]
- [Source: docs/context/TECHNICAL-DESIGN.md §5.2, §5.3 (Sync step 6), §7, §8]
- [Source: docs/data-model.md §1 discord_messages, §3 users]
- [Source: docs/bmad-story-mandatory-steps.md §2, §3.1, §3.2, §3.5]
- [Source: _bmad-output/implementation-artifacts/6-1-…, 3-1-…, 3-2-…, 6-3-… (handler topology, partial-fetch gotcha, test patterns)]
- [Source: _bmad-output/implementation-artifacts/9-1-… (D9 genesis, migration playbook, integration-test conventions)]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5)

### Debug Log References

- `npx drizzle-kit generate` → `packages/shared/src/db/migrations/0005_concerned_caretaker.sql` = exactly `ALTER TABLE "discord_messages" ADD COLUMN "author_name" text;` (verified against AC1).
- `\d discord_messages` in psql confirmed the nullable `author_name text` column; `count(*)=71` / `count(author_name)=0` confirmed existing rows stay `NULL`.
- Initial `tsc --noEmit` on `@hivly/bot` surfaced exactly the compile-only fixture breaks anticipated by the story's Test Impact map (14 errors across `messageCreate.test.ts`, `messageUpdate.test.ts`, `persistMessage.test.ts`, `persistMessage.integration.test.ts`, `offlineSync.test.ts`, `offlineSync.integration.test.ts`, `reconcile.test.ts`) — all fixed by adding `displayName` to the `author` literal, never by weakening the slice types. Re-run: 0 errors.
- `npm run typecheck -w @hivly/workers` was clean both before and after (the new event field is optional).
- `processUpdate.test.ts`'s `sqlText()` helper only unwrapped the top-level `sql` tagged template's `queryChunks`; the new conditional `author_name` clause interpolates a nested `sql` fragment, which appeared as `[object Object]` until `sqlText()` was made to recurse into any chunk that itself carries `queryChunks`. Fixed in the test helper (not production code) — no behavior change, `processUpdate.ts`'s conditional SQL fragment composition already worked correctly against the real driver (proven by the `sync.integration.test.ts` runs against real Postgres).
- Integration gate first run: 1 flaky failure (`readStatus.integration.test.ts` → `ECONNRESET`, unrelated to this story — no backend files touched). Rerun: 127/127 green, confirming the known load-sensitivity flake called out in the story's Dev Notes.

### Completion Notes List

- AC1: nullable `author_name` column added to `discordMessages`; migration `0005_concerned_caretaker.sql` generated (never hand-edited) and applied; verified via psql that existing rows read back `NULL`.
- AC2: `persistMessage.ts`'s create-path INSERT now carries `authorName` from `message.author.displayName`; `IngestibleMessage.author` extended with `displayName`; `backfiller.ts`'s `fetchPage` mapping extended identically so live create and backfill/gap-fill share the one change. Create-event XADD payload intentionally left untouched (create event never carries `authorName`).
- AC3: `MessageUpdatedEvent` gained wire-optional `authorName?: string` (D3 — consumers tolerate legacy in-flight events; the `Record<keyof T, string>` producer pattern still forces every producer to send it). `messageUpdate.ts` reads `displayName` from the hydrated (post-`fetch()`) message and includes it in the XADD payload. `parseUpdatedEvent` normalizes absent/blank → `undefined` (never `''`). `processUpdate.ts` conditionally appends `author_name = ${authorName}` to its existing step-6 `UPDATE discord_messages` only when the value is defined — a missing/empty name leaves the stored value untouched (verified by both a unit test asserting the SQL text and an integration test asserting the DB row after an edit that omits `authorName`). `MessageCreatedEvent` deliberately unchanged.
- AC4: the `displayName` read in `messageUpdate.ts` sits at the same point as the existing `author.bot` read — after the partial-fetch guard — so the null-author-on-raw-partial invariant (6.1 gotcha) is preserved untouched; the existing "does not throw" test stays green. `offlineSync.ts`/`reconcile.ts` needed zero code changes — `tsc --noEmit` is the proof (real discord.js `Message` is structurally assignable; `FetchedMessage = UpdatableMessage` picks up the field by aliasing).
- AC5: all Test Impact map items updated — 14 compile-only fixture fixes, 2 exact-shape `toEqual` extensions (messageUpdate create-event unchanged, update-event gains `authorName`), 1 new unit test (`publishes the authorName of the FETCHED message`), 3 new `parseUpdatedEvent` unit cases (carries through / defaults absent / defaults blank), 2 new `processUpdate` unit cases (sets when present / omits when absent), and 4 integration assertions extended (`persistMessage.integration.test.ts` author_name column; `backfill.integration.test.ts` persisted author_name; `offlineSync.integration.test.ts` exact-field authorName; `sync.integration.test.ts` edit-refreshes-authorName + absent-authorName-preserves-stored-value). No log line anywhere serializes `authorName`.
- AC6: docs synced (`docs/data-model.md` §1 field list + write-ownership row + ERD; `docs/context/TECHNICAL-DESIGN.md` §8 event interface + §6 ERD). `backend-standards.md`/`ARCHITECTURE-SPINE.md` confirmed no-change per the story's pre-verified grep. §3.3 (endpoint) and §3.4 (e2e) N/A — no endpoint, no UI touched. Full gate green (see Change Log for exact counts); app containers were already stopped from a prior session, confirmed via `docker compose ps -a` before running integration tests.

### File List

- `packages/shared/src/db/schema.ts` (modified — `authorName` column)
- `packages/shared/src/db/migrations/0005_concerned_caretaker.sql` (new — generated)
- `packages/shared/src/db/migrations/meta/0005_snapshot.json` (new — generated)
- `packages/shared/src/db/migrations/meta/_journal.json` (modified — generated)
- `packages/shared/src/types/events.ts` (modified — `MessageUpdatedEvent.authorName?`)
- `packages/bot/src/persistence/persistMessage.ts` (modified — create-path capture)
- `packages/bot/src/persistence/persistMessage.test.ts` (modified)
- `packages/bot/src/persistence/persistMessage.integration.test.ts` (modified)
- `packages/bot/src/backfill/backfiller.ts` (modified — backfill create-path capture)
- `packages/bot/src/backfill/backfiller.test.ts` (modified)
- `packages/bot/src/backfill/backfill.integration.test.ts` (modified)
- `packages/bot/src/discord/handlers/messageUpdate.ts` (modified — edit-path capture)
- `packages/bot/src/discord/handlers/messageUpdate.test.ts` (modified)
- `packages/bot/src/discord/handlers/messageCreate.test.ts` (modified — compile-only fixture fix)
- `packages/bot/src/sync/offlineSync.test.ts` (modified — compile-only fixture fix)
- `packages/bot/src/sync/offlineSync.integration.test.ts` (modified)
- `packages/bot/src/sync/reconcile.test.ts` (modified — compile-only fixture fix)
- `packages/workers/src/sync/events.ts` (modified — `parseUpdatedEvent` normalization)
- `packages/workers/src/sync/events.test.ts` (modified)
- `packages/workers/src/sync/processUpdate.ts` (modified — conditional `author_name` UPDATE)
- `packages/workers/src/sync/processUpdate.test.ts` (modified)
- `packages/workers/src/sync/sync.integration.test.ts` (modified)
- `docs/data-model.md` (modified — docs sync)
- `docs/context/TECHNICAL-DESIGN.md` (modified — docs sync)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified — status tracking)

## Change Log

- 2026-07-10 — Implemented Story 9.4 end-to-end on branch `feat/9-4-author-name-capture`: nullable `discord_messages.author_name` (schema + migration `0005_concerned_caretaker`), bot create-path capture (`persistMessage.ts` + `backfiller.ts`), bot edit-path capture (`messageUpdate.ts` + wire-optional `MessageUpdatedEvent.authorName`), Sync worker persistence (`events.ts` normalization + `processUpdate.ts` conditional `UPDATE`). 14 compile-only test-fixture fixes + 8 new/extended test cases (unit + integration) per the Test Impact map. Docs synced (`data-model.md`, `TECHNICAL-DESIGN.md`). Gate green: lint 0 / 869 unit+web (+6) / build clean (5 pkgs) / 127 integration (1 unrelated flake on rerun, `readStatus.integration.test.ts` ECONNRESET — no backend files touched by this story). Status → review.
