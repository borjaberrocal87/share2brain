---
baseline_commit: 3fa5e35be66399c3fab65913200ea50f031671bb
---

# Story OPS-1: PEL-Safe Stream Trimming (Redis Streams Retention)

<!-- Post-roadmap operational-backlog story (P1.1). NOT part of a formal epic —
     Borja chose an explicit operational backlog over a hardening epic at the
     Epic 6 retrospective (2026-07-08). Numbered `ops-N` to stay outside the
     epic sequence. Source: _bmad-output/implementation-artifacts/operational-backlog.md#P1.1 -->

Status: done

## Story

As the operator of a long-running self-hosted Share2Brain deployment,
I want every Redis Stream to be bounded in size without ever dropping an unprocessed entry,
so that a long-lived instance does not grow Redis memory without limit while at-least-once delivery (AD-13) stays intact.

---

## ⚠️ Reconciliation & design notes — read before implementing

1. **This is the third time this work has been deferred.** Epic 3 AI#4 → Epic 5 retro → Epic 6 retro. Story 6.1 added two new *unbounded* streams (`:updated`, `:deleted`) on top of the original `share2brain:discord:messages`, which is what finally elevated it. There is no "next epic" to punt to again.

2. **A naive `MAXLEN` on `xAdd` is UNSAFE and is explicitly rejected here.** Redis `XADD … MAXLEN`/`XTRIM … MAXLEN` (approximate or exact) trims the oldest entries **by count, with no awareness of the Pending Entries List (PEL)**. If any consumer group falls behind by more than the cap, its **unacked (pending) entries get trimmed and are lost** — a direct violation of AD-13's at-least-once guarantee and the whole point of `XACK`-only-after-success. Do **not** add `MAXLEN` to any producer's `xAdd`.

3. **The correct primitive is `XTRIM … MINID` at a PEL-safe floor.** For each stream, compute the oldest entry ID that is *still needed by any consumer group* and trim strictly below it. An entry older than that floor has been delivered to **and acked by** every group, so removing it is safe. This is the mandatory core (AC-1).

4. **Producers are NOT touched.** All four `xAdd` call sites (`persistMessage.ts:91`, `backfiller.ts:257`, `messageUpdate.ts:125`, `messageDelete.ts:55`) stay exactly as they are — bare `xAdd(key, '*', event)`. Centralizing all trim logic in one loop keeps it testable and avoids touching the transactional `persistMessage` path. This is a deliberate divergence from the operational-backlog's shorthand "bounded xAdd/XTRIM" wording: **XTRIM-in-a-dedicated-loop, not bounded-xAdd.**

5. **The trimmer needs its OWN Redis client.** The Indexer and Sync consumers each park on a blocking `XREADGROUP … BLOCK 5000` on their own client; node-redis serializes commands per connection, so the trimmer's `XINFO`/`XPENDING`/`XTRIM` would queue behind a parked read. This is the exact lesson from Story 6.2's review (one client per concurrent loop). Give the trimmer a dedicated client.

6. **A permanently-dead consumer defeats the PEL-safe floor.** If a group is down forever, its pending floor never advances and the stream still grows unbounded. So an **optional absolute ceiling** backstops it (AC-2): a configurable `streams.max_len` that, when set and exceeded, forces a `MAXLEN` trim **and logs a `warn`** — because hitting it means an entry was dropped below the pending floor (a dead/stuck-consumer alarm). Default: OFF (`null`) so normal operation relies solely on the PEL-safe floor.

7. **Streams with zero consumer groups.** `share2brain:knowledge:events` has no consumer today (the Notifier consumer is deferred). With no group there is no PEL to protect, so it is trimmed by the `max_len` backstop only (or left alone if `max_len` is null). Document: if the Notifier consumer is ever built, its group must be created **before** relying on PEL-safe trimming for that stream.

8. **This is a `@share2brain/workers` concern.** The trimmer is a long-lived periodic loop that belongs alongside the Indexer/Sync consumers — same package, same `main.ts` lifecycle, same graceful-shutdown drain (Story 6.4). It is NOT a bot or backend concern.

---

## Acceptance Criteria

### AC-1 — PEL-safe periodic trim on every consumed stream (mandatory core)

**Given** the trimmer runs on its interval against `share2brain:discord:messages` (group `share2brain:indexer`), `share2brain:discord:messages:updated` and `share2brain:discord:messages:deleted` (group `share2brain:sync`)
**When** it processes a stream
**Then** for each consumer group on that stream it computes the oldest still-needed entry ID = `min(oldest-pending-id if the group has pending entries, else the group's last-delivered-id)`
**And** the stream's safe floor = the minimum of those per-group values across all groups
**And** it issues `XTRIM <stream> MINID <floor>` so that only entries strictly older than the floor (delivered AND acked by every group) are removed
**And** it NEVER removes an entry that is pending in any group or not yet delivered to any group

### AC-2 — Optional absolute ceiling backstops a dead/stuck consumer

**Given** `config.streams.max_len` is set to a number `N`
**When** after the PEL-safe trim a stream still has more than `N` entries (a consumer group is stuck/dead and its pending floor is not advancing)
**Then** the trimmer issues `XTRIM <stream> MAXLEN ~ N` to cap memory
**And** it emits a single `logger.warn` naming the stream, the length, and that the ceiling forced a trim that may have dropped pending entries (dead-consumer alarm)
**And** when `config.streams.max_len` is `null` the backstop is skipped entirely (PEL-safe floor is the only bound)

### AC-3 — Gated, and a no-op when disabled

**Given** `config.streams.trim_enabled` is `false`
**When** the workers process boots
**Then** the trimmer loop is not started, no Redis client is opened for it, and behavior is identical to today (unbounded)
**And** when `trim_enabled` is `true` the loop starts on its own dedicated Redis client and runs every `config.streams.trim_interval_ms`

### AC-4 — Per-stream and per-tick isolation; never crashes the process

**Given** one stream's trim throws (e.g. a transient Redis error, or `XINFO GROUPS` on a not-yet-created stream)
**When** the tick runs
**Then** the failure is caught, logged at `error` with the stream key, and the other streams in the same tick still get trimmed
**And** a failing tick never rejects the loop or crashes the process; the next interval tick runs normally
**And** a stream that does not exist yet (no producer has written to it) is treated as a no-op, not an error

### AC-5 — Drains cleanly on shutdown (Story 6.4 parity)

**Given** the process receives `SIGTERM`/`SIGINT`
**When** graceful shutdown begins
**Then** the trimmer loop observes the abort signal, stops before the next tick, and its dedicated Redis client is `quit()` within the bounded shutdown window
**And** this is wired into the existing `main.ts` shutdown drain without altering the Indexer/Sync drain logic (note #8, 6.4 note-#8 style constraint)

### AC-6 — Content is never logged

**Given** any trimmer log line
**When** it is written
**Then** it contains only stream keys, group names, entry IDs, counts and timestamps — never message content (project-context never-log-content rule; consistent with 6.1–6.4)

### AC-7 — Verification gate green

**Given** the implementation is complete
**When** the gate runs
**Then** `npm run lint` = 0, `npm run test` green (with new unit tests), `npm run build` clean across all 5 packages, and `npm run test:integration` (workers project) green including a new integration test that proves, against real Redis, that (a) an acked-by-all-groups old entry IS trimmed and (b) a pending (unacked) entry is NOT trimmed even when it is the oldest.

---

## Tasks / Subtasks

- [x] **Task 1 — Config schema (`packages/shared`).** Add a top-level `streams` block to `Share2BrainConfigSchema` (`packages/shared/src/config/index.ts`): `{ trim_enabled: z.boolean(), trim_interval_ms: z.number(), max_len: z.number().nullable() }`. Behavior only (YAML), no secrets. Confirm backward-compat: existing configs without the block must still parse *iff* you make `streams` `.optional()` with a sensible default, OR add the block to `Share2Brain.config.yml`/`.example` in Task 5 (decide per note D1). Add tests to `config/index.test.ts` (present, absent-if-optional, `max_len: null`).
- [x] **Task 2 — `streamTrimmer.ts` (`packages/workers/src/trim/`).** Pure, dependency-injected factory `createStreamTrimmer({ redis, logger, config })` exposing a `runTrimLoop(signal)`:
  - `computeSafeFloor(redis, stream)`: `xInfoGroups(stream)` → for each group, `xPending(stream, group)` summary; per-group needed-id = pending `firstId` if `pending > 0` else the group's `lastDeliveredId`; stream floor = `min` across groups (BigInt-compare the `<ms>-<seq>` snowflake-style stream IDs, NOT string-compare — mirror the `toIdKey`/BigInt ordering trap from Story 6.3's `reconcile.ts`). Return `null` when the stream has no groups.
  - `trimStream(stream)`: if floor is non-null → `xTrim(stream, 'MINID', floor)`; then if `config.streams.max_len` set and `xLen(stream) > max_len` → `xTrim(stream, 'MAXLEN', max_len, { strategyModifier: '~' })` + `warn`.
  - `runTrimLoop`: every `trim_interval_ms`, `for` each of the 3 Discord streams (+ optionally `KNOWLEDGE_EVENTS` for the max_len-only path) call `trimStream` inside a try/catch (AC-4), checking `signal.aborted` at the top of each tick (AC-5). Use an abortable wait between ticks (reuse the `waitOrAbort` pattern from `offlineSync.ts`).
- [x] **Task 3 — Wire into `main.ts` (`packages/workers`).** Gated by `config.streams?.trim_enabled`: open a dedicated Redis client via the existing `connectRedisOrExit` helper (added in 6.2), start `runTrimLoop(shutdownSignal)`, add its promise to the shutdown `Promise.all` drain and `quit()` its client. Do NOT touch the Indexer/Sync drain bodies (note #8). When disabled, no client, no loop (AC-3).
- [x] **Task 4 — Unit tests (`streamTrimmer.test.ts`).** Fakes for `xInfoGroups`/`xPending`/`xTrim`/`xLen` (`vi.fn()`), asserting: floor = min across two groups; pending `firstId` wins over `lastDeliveredId`; `MINID` trim called with the exact floor; no-groups stream → no MINID trim; `max_len` backstop fires only when `xLen > max_len` and emits exactly one `warn`; `max_len: null` → no backstop; a throwing `xTrim` for one stream is caught and the next stream still trims; abort before a tick stops the loop; BigInt ordering (an 18-digit vs 19-digit ID floor) is correct. Prove each test discriminates (revert-and-fail — Epic 5 rule).
- [x] **Task 5 — `Share2Brain.config.yml` + `.example`.** Add the `streams` block (`trim_enabled: true`, `trim_interval_ms: 300000`, `max_len: null` as shipped defaults — see note D2). Verify `loadConfig()` parses both files (watch `interpolateEnv` — no `${VAR}` needed here since these are plain numbers/booleans; the 6.4 comment-substitution gotcha does not apply, but keep the block credential-free).
- [x] **Task 6 — Integration test (`streamTrimmer.integration.test.ts`, workers project).** Against real Redis (Homebrew `localhost:6379` — the two-Redis-instances gotcha): create a stream + group, XADD several entries, read+ack some, leave one oldest entry pending; run one trim tick; assert the acked-old entries are gone (`xLen`/`xRange`) and the pending entry survives. Add a second case: two groups at different positions → floor = the laggier group. Run-unique stream keys (`itest-ops1-${salt}`) + own-id cleanup (Epic 4 run-unique-isolation rule).
- [x] **Task 7 — Verify gate (AC-7).** Run all four commands, paste real evidence in Completion Notes.

---

## Dev Notes

### Architecture & patterns to follow
- **The trimmer mirrors the consumer loop shape** (`indexer/consumer.ts`, `sync/consumer.ts`): dependency-injected, an abort-checked `while` loop, whole body defensive, wired in `main.ts` with a bounded shutdown drain. Copy that structure. The difference: it does **not** `XREADGROUP`/`BLOCK` — it does short periodic admin commands (`XINFO GROUPS`, `XPENDING`, `XTRIM`, `XLEN`) and sleeps between ticks.
- **Its own Redis client** (note #5). Reuse `connectRedisOrExit` from `packages/workers/src/main.ts` (extracted in 6.2) for identical bounded-connect + fail-fast behavior.
- **Import `STREAM_KEYS`/`CONSUMER_GROUPS`** from `@share2brain/shared/types/events` — never hardcode the stream/group strings (AD-13). The streams to trim: `DISCORD_MESSAGES`, `DISCORD_MESSAGES_UPDATED`, `DISCORD_MESSAGES_DELETED` (+ `KNOWLEDGE_EVENTS` max_len-only).

### The PEL-safe floor — the crux of this story (read with notes #2, #3)
- Stream IDs are `<millisecondsTime>-<sequence>`. Comparing them requires splitting on `-` and comparing `(BigInt(ms), BigInt(seq))` lexicographically — a plain string compare is wrong once the ms part changes digit count (the exact BigInt-ordering trap Story 6.3's `reconcile.ts` exists to cover). Write a `compareStreamIds(a, b)` helper and unit-test it.
- `XPENDING <stream> <group>` (summary form, node-redis `xPending(key, group)`) returns `{ pending, firstId, lastId, consumers }`. `firstId` is the oldest un-acked entry ID for that group — the floor contribution when `pending > 0`.
- `XINFO GROUPS <stream>` (node-redis `xInfoGroups(key)`) returns each group's `lastDeliveredId` — the floor contribution when the group has zero pending (everything delivered is acked; nothing older is needed).
- **`XTRIM … MINID <id>` removes entries with ID `< id`** (the floor entry itself is kept). That is exactly the safe boundary: the floor is either the oldest pending entry (must keep) or the last-delivered id (resume point, keep).

### node-redis API (verify exact signatures against the installed version)
- The repo uses **node-redis** (not ioredis) — see `packages/bot/src/persistence/persistMessage.ts` (`redis.xAdd(key,'*',obj)`) and `workers/src/indexer/consumer.ts` (`xGroupCreate`, `xReadGroup`, `xAck`). Confirm the trim/inspect method names and argument order against the version in `package-lock.json` before relying on them: `xInfoGroups`, `xPending`, `xTrim`, `xLen`, `xRange`. Some accept `{ strategyModifier: '~' }` for approximate trims; MINID here should be **exact** (not `~`) so the floor is honored precisely.

### Source tree — files to touch
- **NEW** `packages/workers/src/trim/streamTrimmer.ts` + `streamTrimmer.test.ts` + `streamTrimmer.integration.test.ts`
- **UPDATE** `packages/workers/src/main.ts` — gated dedicated client + `runTrimLoop` + shutdown drain (additive; do not touch Indexer/Sync drain bodies)
- **UPDATE** `packages/shared/src/config/index.ts` + `config/index.test.ts` — `streams` block
- **UPDATE** `Share2Brain.config.yml` + `Share2Brain.config.yml.example` — `streams` block
- **NO CHANGE** producers (`persistMessage.ts`, `backfiller.ts`, `messageUpdate.ts`, `messageDelete.ts`), `@share2brain/shared` event contracts, DB schema (no migration)

### Testing standards
- Vitest, co-located `*.test.ts`, dependency-injected fakes (copy `sync/consumer.test.ts` scaffold). Integration test under the `workers-integration` project, real Redis, run-unique keys + own-id cleanup. Assert content is never logged. Every regression test must fail if its fix is reverted (Epic 5 "a test that lies" rule).

### Previous-story intelligence
- **Story 6.2** — established the second workers consumer, the `connectRedisOrExit` helper, one-client-per-loop (note #5), and the shutdown `Promise.all` drain. The trimmer is the third loop; follow the same wiring.
- **Story 6.3** — the BigInt stream-ID ordering trap (`reconcile.ts` `toIdKey`) and run-unique integration-test ids. Reuse both.
- **Story 6.4** — graceful shutdown + `stop_grace_period`. The trimmer's drain must fit inside the workers grace window (currently 35s — raised in 6.4 review). The trimmer's tick is short and its `quit()` is bounded, so it adds negligible drain time; confirm it does not push the worst case past 35s.
- **Redis gotcha (memory):** two Redis instances on this Mac — `localhost:6379` (Homebrew) vs the Compose Redis (no published ports). Integration tests target Homebrew `localhost:6379`; manual `XLEN`/`XINFO` checks must hit the same instance the code does.

### References
- [Source: _bmad-output/implementation-artifacts/operational-backlog.md#P1.1]
- [Source: _bmad-output/implementation-artifacts/epic-6-retro-2026-07-08.md#5 — Action Item 2]
- [Source: packages/shared/src/types/events.ts#57-83 — STREAM_KEYS, CONSUMER_GROUPS]
- [Source: packages/workers/src/indexer/consumer.ts — loop shape, xGroupCreate/xReadGroup/xAck, BLOCK]
- [Source: packages/workers/src/sync/consumer.ts#1-12 — one-client-per-loop header comment]
- [Source: packages/workers/src/main.ts — connectRedisOrExit, shutdown Promise.all drain]
- [Source: packages/bot/src/sync/reconcile.ts — BigInt stream-id ordering (toIdKey)]
- [Source: packages/shared/src/config/index.ts#85-113 — where the `streams` block goes]

## Project Context Reference

See `_bmad-output/project-context.md` (backend rules, AD-13 stream invariants, never-log-content, workers idempotent) and `CLAUDE.md` (non-negotiables: behavior in YAML, secrets in `.env`; workers depend only on `@share2brain/shared`, AD-2). Standards: `docs/base-standards.md`, `docs/backend-standards.md`.

## Decisions (confirmed with Borja, 2026-07-08)

- **D1 — [DECIDED, recommended] `streams` config is `.optional()` with in-code defaults** (`trim_enabled: true`, `trim_interval_ms: 300000`, `max_len: null`) so existing/other configs keep parsing without edit, while the block is still shipped in `Share2Brain.config.yml`/`.example`. Mirrors how `notifications` was made optional in 6.4.
- **D2 — [DECIDED by Borja] Shipped defaults = PEL-safe, no ceiling:** `trim_enabled: true`, `trim_interval_ms: 300000` (5 min), **`max_len: null`**. The PEL-safe `MINID` floor is the only bound; no lossy absolute ceiling ships by default. Consequence (accepted): a permanently-dead consumer means unbounded growth for its stream — rare, and visible in logs; an operator can set a non-null `max_len` to opt into the backstop. The `max_len` backstop path (AC-2) must still be **implemented**, just defaulted off.
- **D3 — [DECIDED, recommended] Trim `KNOWLEDGE_EVENTS` via the `max_len`-only path** (skipped while `max_len` is null, i.e. skipped by default per D2), documented — never PEL-trimmed since it has no consumer group (Notifier deferred). If the Notifier consumer is ever built, create its group before relying on PEL-safe trim for that stream.

## Dev Agent Record

### Agent Model Used

Claude Opus 4.8 (bmad-dev-story)

### Debug Log References

None — implementation went green per task; only one lint fix (`prefer-const` on the abortable-sleep timer).

### Completion Notes List

- **Design as specified: a PEL-safe `XTRIM … MINID` trimmer, NOT `MAXLEN` on `xAdd`.** New `packages/workers/src/trim/streamTrimmer.ts` — a third long-lived loop alongside the Indexer/Sync consumers, on its **own** Redis client. Producers untouched, no migration, no `@share2brain/shared` contract change (only the Zod config schema gained an optional `streams` block).
- **`computeSafeFloor`** enumerates a stream's groups via `xInfoGroups`; per group the needed id = the oldest pending id (`xPending().firstId`) when `pending > 0`, else the group's `last-delivered-id`; the stream floor = the minimum across groups. `trimStream` then `XTRIM MINID <floor>` (removes only strictly-older, already-acked entries; keeps the floor entry) and, when `max_len` is set and exceeded, the optional `MAXLEN ~` backstop (warn if the stream has groups = stuck-consumer alarm; info if it has none, e.g. `KNOWLEDGE_EVENTS`).
- **Real node-redis 6.1.0 gotcha found & handled:** `xInfoGroups` types `last-delivered-id` as `NumberReply`, but the RESP value is a stream-id **string** (`"<ms>-<seq>"`). Coerced with `String()` (identity if already a string) — documented inline. Would have been a silent type-lie otherwise.
- **BigInt stream-id ordering** (`compareStreamIds`) mirrors Story 6.3's `toIdKey` trap: split on `-`, compare `(BigInt(ms), BigInt(seq))` — a plain string compare mis-orders ids across a millisecond digit-count change. Unit-tested with an 18-vs-19-digit case.
- **D2 honored:** shipped defaults are `trim_enabled: true`, `trim_interval_ms: 300000`, `max_len: null` (PEL-safe floor only; no lossy ceiling by default). The `max_len` backstop path is fully implemented, just defaulted off. `resolveStreamsConfig` supplies these defaults in code so a config omitting the block still works (D1).
- **`main.ts` wiring is additive** (note #8): gated by `resolveStreamsConfig(config).enabled`, opens a dedicated `trimRedis` via the existing `connectRedisOrExit` helper (6.2), starts `runStreamTrimmer`, adds `trimmerPromise` to the shutdown `Promise.all` drain and `quitRedisBounded`s the client. The Indexer/Sync drain bodies are untouched. Worst-case drain unchanged in practice (the trimmer's tick is short admin commands; its `quit()` is bounded 5s and races inside the existing 7s loop-drain window → does not push workers past the 35s `stop_grace_period`).
- **Verification gate (all commands actually executed):**
  - `npm run lint` → **0 errors** (`eslint .`).
  - `npm run test` → **666 passed** (78 files; unit+web), incl. ~23 new streamTrimmer unit tests + 3 new config tests.
  - `npm run build` → all 5 workspaces clean (`tsc --noEmit` backend/bot/shared/workers, `vite build` web).
  - `npx vitest run --project workers-integration` → **11 passed** (4 Indexer + 4 Sync + **3 new trim** integration tests) against real Redis (Homebrew `localhost:6379` per the two-Redis-instances gotcha). The key case proves an acked+old entry is trimmed while the **oldest-but-pending (unacked)** entry survives — the PEL-safe guarantee, empirically discriminating (a `MAXLEN` implementation would fail it). A second case proves the laggier of two groups governs the floor; a third proves a non-existent stream is a no-op.
  - `loadConfig()` run against **both** the shipped `Share2Brain.config.yml` and `Share2Brain.config.yml.example` → both parse with the `streams` block (guards against the 6.4 `interpolateEnv` class of failure; the block is credential-free so no `${VAR}` risk).
- No new dependency; no migration; no DDL. Only `packages/shared`'s config Zod schema changed (validation, not persisted data).

### File List

**New:**
- `packages/workers/src/trim/streamTrimmer.ts`
- `packages/workers/src/trim/streamTrimmer.test.ts`
- `packages/workers/src/trim/streamTrimmer.integration.test.ts`

**Modified:**
- `packages/shared/src/config/index.ts` (optional `streams` block in `Share2BrainConfigSchema`)
- `packages/shared/src/config/index.test.ts` (+3 tests; `streams` undefined assertion in the valid case)
- `packages/workers/src/main.ts` (gated dedicated trim client + `runStreamTrimmer` + shutdown drain — additive)
- `Share2Brain.config.yml` (new `streams` block; gitignored operator copy)
- `Share2Brain.config.yml.example` (same `streams` block; tracked template)

## Change Log

- 2026-07-08 — Story OPS-1 created (bmad-create-story) from operational-backlog P1.1, picked up immediately after the Epic 6 retro. First post-roadmap operational story; numbered `ops-N` to stay outside the epic sequence (Borja chose an explicit backlog over a hardening epic). Design: a PEL-safe `XTRIM … MINID` trimmer as a third long-lived loop in `@share2brain/workers` on its own Redis client, with an optional `max_len` ceiling backstop for dead consumers; producers untouched (bare `xAdd`), no migration, config-gated. Status → ready-for-dev.
## Review Findings

_bmad-code-review 2026-07-08 — 3 adversarial layers (Blind Hunter + Edge Case Hunter + Acceptance Auditor, Opus 4.8) over the uncommitted OPS-1 diff. All three converged that the PRODUCTION code is sound: node-redis 6.1.0 contracts verified against source (`xInfoGroups` rejects with "no such key"; `last-delivered-id` is a stream-id string; `xPending` returns non-null `firstId` when `pending>0`; `XTRIM MINID` is inclusive-floor), the PEL-safe floor is genuinely never above any pending id, abort/shutdown paths are clean, no listener leak. Acceptance Auditor: all AC-1…AC-7 + D1/D2/D3 + note #4 (producers untouched) + AD-2/AD-13 fully met. Findings are test-quality, config ergonomics, and doc-precision. 6 patch, 2 dismissed._

- [x] [Review][Patch] **Integration tests don't discriminate `firstId` vs `last-delivered-id`** [packages/workers/src/trim/streamTrimmer.integration.test.ts] — both real-Redis cases arrange the oldest *pending* entry to coincide with `last-delivered-id`, so a regression using `last-delivered` instead of `xPending.firstId` would still pass. The file header CLAIMS to prove "never removes an entry still pending even when older than last-delivered," but that requires an OUT-OF-ORDER ack (read e1,e2,e3 → ack e2+e3 → e1 pending → correct floor=e1; a last-delivered bug computes e3 and trims the unacked e1). Only the fake-based unit test discriminates this. Fix: add a real-Redis out-of-order-ack case. (Edge; the AD-13-critical gap; Epic-5 "a test that lies" rule.)
- [x] [Review][Patch] **Partial `streams` config block is a hard boot failure, contradicting the "in-code defaults" claim** [packages/shared/src/config/index.ts] — the three fields are all *required* inside the optional object, so `streams:\n  trim_enabled: false` throws `ConfigError` (trim_interval_ms/max_len Required). Meanwhile `resolveStreamsConfig`'s per-field `?? default` is dead code except when the whole block is absent. Fix: make the three fields `.optional()` (matching resolveStreamsConfig's intent) + a partial-block config test. (Edge.)
- [x] [Review][Patch] **Fail-OPEN fallback when `pending>0` but `xPending.firstId` is null** [packages/workers/src/trim/streamTrimmer.ts:computeSafeFloor] — the fallback uses `lastDelivered` (the HIGHEST delivered id), so if that branch were ever reached, `XTRIM MINID lastDelivered` would drop all pending entries but one. Edge confirmed it's unreachable (Redis guarantees non-null firstId when pending>0), but the direction is a latent footgun in the one module whose whole job is delete-conservatism. Fix: fall back to `'0-0'` (fail-safe → skip trim) instead of `lastDelivered`. (Blind; mirrors Story 6.3's fail-open→fail-safe patch.)
- [x] [Review][Patch] **`max_len` is an approximate (`~`) cap, documented as an "absolute ceiling"; warn re-fires every tick when the `~` trim can't evict a partial node** [packages/workers/src/trim/streamTrimmer.ts + Share2Brain.config.yml(.example) + config schema comment] — with `strategyModifier: '~'` Redis only evicts whole macro-nodes, so length can persist above `max_len` and the "exceeded max_len" warn re-fires every tick with `removed: 0`. Fix: reword "absolute ceiling" → "approximate (~) ceiling" in all comments, and gate the warn/info on `removed > 0` to avoid per-tick log spam. (Blind + Edge.)
- [x] [Review][Patch] **`KNOWLEDGE_EVENTS` is unbounded under the recommended default (`max_len: null`); the "bounds every stream" wording overstates** [packages/workers/src/trim/streamTrimmer.ts header + config comments] — it has no consumer group (Notifier deferred) so the PEL-safe path skips it, and with `max_len: null` the backstop skips it too → never trimmed. By design (D3) and low volume (one backfill event per bot boot), so no behavior change; fix the wording to not claim "every stream" and document the no-consumer-group exemption. (Blind + Edge.)
- [x] [Review][Patch] **Duplicate "stream trimmer starting" log** [packages/workers/src/main.ts + streamTrimmer.ts] — `main.ts` logs it, then `runStreamTrimmer` logs it again with context. Remove the `main.ts` line. (All 3 layers, trivial.)

_Dismissed (2):_
- _main.ts early-return on trimmer connect failure leaks resources (Blind, Low) — **false positive**. `connectRedisOrExit` returns `false` ONLY when `shuttingDown` is already true (a real failure calls `process.exit(1)`); `trimRedis` is assigned before the `return`, so the SIGTERM `shutdown()` closure quits it. Same pattern as the existing sync-client setup._
- _No abort check between the sequential awaits inside a single `trimStream` (Blind, Low) — acceptable. `trimStream` is a handful of short admin round-trips, bounded by the existing 7s shutdown drain race; abort is checked between every stream and before each sleep._

**All 6 patches applied 2026-07-08.** (P1) new real-Redis out-of-order-ack integration case (read e1-e4, ack e1/e3/e4, e2 pending → asserts `[e2,e3,e4]` remain; a last-delivered bug would drop the pending e2) — now discriminates firstId-vs-last-delivered against real Redis, not just in the fake unit test. (P2) the three `streams` fields are now `.optional()` so a partial block (e.g. just `trim_enabled: false`) parses; +1 partial-block config test. (P3) `computeSafeFloor` fails SAFE (`'0-0'`) instead of `lastDelivered` when `pending>0` but `firstId` is null. (P4) `max_len` reworded to "approximate (~) ceiling" in module + schema + both YAML files; the warn/info now only fires when `removed > 0` (no per-tick spam when `~` can't evict a partial node); +1 unit test. (P5) module header + config comments no longer claim "every stream" and document the no-consumer-group (`KNOWLEDGE_EVENTS`) exemption. (P6) removed the duplicate `main.ts` "stream trimmer starting" log. **Gate re-run green: lint 0 / 668 unit+web (+2) / build clean (5 pkgs) / 12 workers-integration (+1 new). Status → done.**

- 2026-07-08 — Story OPS-1 implemented (bmad-dev-story) → status **review**. All 7 tasks complete. New `packages/workers/src/trim/streamTrimmer.ts` (+ unit + integration tests); optional `streams` block in the shared config schema (D1 optional-with-defaults; D2 shipped defaults `trim_enabled: true` / `300000` / `max_len: null`); additive `main.ts` wiring (dedicated client, gated, drained). Real node-redis 6.1.0 gotcha handled: `last-delivered-id` typed `NumberReply` but is a stream-id string → `String()` coercion. Gate green: lint 0 / 666 unit+web (+26) / build clean (5 pkgs) / 11 workers-integration (+3 new, real Redis — pending entry provably survives the trim) / both shipped config files parse via `loadConfig()`. No migration, no `@share2brain/shared` contract change (config schema only). Status → review.
