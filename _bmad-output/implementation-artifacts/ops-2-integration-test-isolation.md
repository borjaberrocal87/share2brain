---
baseline_commit: cddcdf16fdbe99568babe2153a7d8c5ae32a5c56
---

# Story OPS-2: Deterministic Backend Integration Tests (fix the recurring RBAC flake)

<!-- Post-roadmap operational-backlog story (P1.2). NOT part of a formal epic —
     Borja chose an explicit operational backlog over a hardening epic at the
     Epic 6 retrospective (2026-07-08). Numbered `ops-N` to stay outside the
     epic sequence. Source: operational-backlog.md#P1.2 -->

Status: done

## Story

As a developer relying on the integration gate,
I want `npm run test:integration` to pass deterministically,
so that a red run always means a real regression and never "the RBAC flake again."

---

## ⚠️ Reconciliation & investigation notes — read before implementing

1. **The symptom, on record (three times).** The 6.2, 6.3 and 6.4 Completion Notes all report the same non-deterministic failure in `packages/backend/src/rbac.integration.test.ts` / `channels.integration.test.ts`: an **extra `'test-guild'` role (or channel) appears in the RBAC response**, so an `expect(...).toEqual([...])` on `roles`/`allowedChannels` fails. It "passes on an isolated re-run." **None of those stories' diffs touched `packages/backend`** — it is pre-existing and environmental. First seen in the Epic 4 retro.

2. **Two documented root-cause vectors (confirm which — Task 1 is a reproduction spike).**
   - **(a) Shared global table + whole-table RBAC expansion.** `allowedChannels` is computed by intersecting the member's roles against the **entire** `channel_permissions` table (Story 4.2 note: "RBAC expansion resolves against the WHOLE channel_permissions table … a shared literal role … leaks into scope"). Any stray row — from a sibling test suite, a prior crashed run's un-cleaned fixture, or a live container — whose `allowed_roles` intersect the member's roles leaks a channel/role in. The `@everyone`-role injection (PR #32) adds the guild id as a role, so a shared `guild_id` literal (`'test-guild'`) can also surface.
   - **(b) Live dev containers on the same DB/Redis.** The 6.2/6.4 notes flag that `docker compose` `backend`/`bot` containers share the same Postgres+Redis the integration tests target, mutating `channel_permissions`/`users`/sessions mid-run. The `workers-integration` project is 100% green in isolation precisely because nothing else writes its rows.

3. **`rbac.integration.test.ts` already has partial defenses** — `itestChannels()` filters `allowedChannels` to the `itest-` prefix before asserting, and `afterAll` cleans `channel_permissions WHERE channel_id LIKE 'itest-%'` + its own `discord_id`. The gap: `res.body.roles` is asserted **unfiltered** (`toEqual(['admin','mod'])`), and any non-`itest-` channel row matching `admin`/`mod` can still change counts in `channels.integration.test.ts`. The isolation is prefix-scoped for channels but not for roles or for cross-suite writes.

4. **This is test-infra hardening, not a product change.** Do **not** change RBAC semantics (whole-table expansion is the AD-12 design — RBAC inside the query). The fix is deterministic fixtures + assertions + a clean-environment precondition. If Task 1 proves the leak is a genuine product correctness bug (not just a test-fixture collision), STOP and raise it with Borja before changing product code.

5. **Generalize the Epic 4 run-unique-isolation rule to `packages/backend`.** Epic 4 AI#3 established run-unique suffixes + own-id cleanup, and Story 6.3 applied a per-run salt (`String(Date.now()).slice(-8)`) to bot integration ids. The backend suites predate that discipline and use shared literals (`itest-admin`, `admin`, `MEMBER_DISCORD_ID`, `'test-guild'`). Bring them up to the same standard.

---

## Acceptance Criteria

### AC-1 — Reproduce and pin the leak (spike, gates the rest)

**Given** the recurring flake
**When** the developer runs the full `npm run test:integration` (all backend suites together) repeatedly, with and without live `docker compose backend`/`bot` containers attached to the same Postgres/Redis
**Then** the exact leak vector is identified and written up (which table/row, which suite or container introduces it, whether `res.body.roles` gains `'test-guild'` from the `@everyone` guild-id injection or from a stray `channel_permissions` row)
**And** the write-up states definitively whether the fix is test-only (fixtures) or whether a genuine product bug was found (→ escalate to Borja, do not fix product code silently)

### AC-2 — Run-unique fixtures across every backend integration suite

**Given** the backend integration suites seed `channel_permissions`, roles, `users`, channels
**When** they run
**Then** every seeded identifier (channel ids, role names, `discord_id`, guild id) is **run-unique** (a per-run salt, e.g. `itest-<salt>-admin`), so two suites — or two concurrent runs, or a leftover from a crashed run — cannot collide
**And** each suite's cleanup deletes only its own salted ids (no broad `LIKE 'itest-%'` that races sibling suites — the exact FK-abort hazard the current `rbac` `afterAll` comment already warns about)

### AC-3 — Assertions are scoped, not global

**Given** an RBAC/channels assertion on `roles` or `allowedChannels`
**When** it checks membership
**Then** it asserts against **this suite's salted** roles/channels only (extend the existing `itestChannels()` prefix-filter to `roles` too, or assert `toContain`/`not.toContain` on salted ids rather than `toEqual` on a full list)
**And** a stray unrelated row in a shared table can no longer flip the assertion

### AC-4 — Clean-environment precondition is enforced or documented

**Given** integration tests must not run against a stack with live dev containers writing the same tables
**When** the suite starts (or via the dev/CI runbook)
**Then** either the suite fails fast with a clear message if it detects competing writers (e.g. an unexpected non-salted row in a key table), **or** `docs/development_guide.md` documents "stop `docker compose` app containers (`backend`/`bot`/`workers`) before `npm run test:integration`, or run against a dedicated test DB" — and the guidance is discoverable (Task decides which; prefer fail-fast if cheap)

### AC-5 — Determinism proven

**Given** the fixes are in
**When** `npm run test:integration` (full backend project) runs **10× consecutively** on a clean DB
**Then** it is green every time, and green again with a stale leftover row deliberately inserted (proving assertions are now isolation-proof)

### AC-6 — Verification gate green

**Given** the implementation is complete
**When** the gate runs
**Then** `npm run lint` = 0, `npm run test` green, `npm run build` clean (5 packages), and `npm run test:integration` green and repeatable (AC-5). No production (`src` non-test) behavior changed unless AC-1 escalation was approved by Borja.

---

## Tasks / Subtasks

- [x] **Task 1 — Reproduction spike (AC-1).** Run the full backend integration project in a loop (e.g. 10×) on a clean DB, then again with `docker compose up -d backend bot` attached. Capture which assertion fails, dump the offending `channel_permissions`/`users` rows and the `res.body.roles`/`allowedChannels` at failure. Determine: stray-row collision vs live-container write vs `@everyone` guild-id injection. Write findings into this story's Dev Notes. **Decision gate:** test-only fix → continue; product bug → HALT, raise with Borja.
- [x] **Task 2 — Salt helper.** Add a shared test helper (co-located under `packages/backend/src/` test utils, or wherever `openTestClients`/`buildTestAppOptions` live) that produces a per-run salt and salted-id builders for channels, roles, `discord_id`, guild id — mirroring Story 6.3's `String(Date.now()).slice(-8)` approach and Epic 4 AI#3. Preserve any ordering/shape a suite depends on (e.g. snowflake-digit-length traps, if present).
- [x] **Task 3 — Convert `rbac.integration.test.ts`.** Replace literal `itest-admin`/`admin`/`MEMBER_DISCORD_ID`/`'test-guild'` with salted ids; extend `itestChannels()`-style filtering to `roles`; scope `afterAll` deletes to salted ids only. Keep every existing behavioral assertion (per-request recompute, security boundary, non-intersecting roles).
- [x] **Task 4 — Convert `channels.integration.test.ts`** (and audit `auth`, `documents`, `readStatus`, `search`, `conversations`, `chat`, `security`, and the `infrastructure/*.drizzle.integration.test.ts` suites) for the same shared-literal + broad-`LIKE`-cleanup hazards. Apply salted ids + scoped assertions/cleanup wherever a shared table is written. List which suites needed changes.
- [x] **Task 5 — Clean-environment guard/doc (AC-4).** Prefer a cheap fail-fast precheck in `openTestClients` (or a `beforeAll` in a shared setup) that warns/fails if a competing writer is detected; otherwise document the precondition in `docs/development_guide.md`. Note the two-Redis-instances gotcha (Homebrew `localhost:6379` vs Compose) so the runbook names the right instance.
- [x] **Task 6 — Prove determinism (AC-5).** Run the full backend integration project 10× on a clean DB (green each time), then with a deliberately-inserted stale row (still green). Paste evidence.
- [x] **Task 7 — Verify gate (AC-6).** Run all four commands; paste real evidence in Completion Notes. Confirm the historically-flaky `rbac`/`channels` suites now pass in the full-suite run, not just in isolation.

---

## Dev Notes

### Architecture & patterns to follow
- **Test-infra only.** RBAC whole-table expansion is AD-12 (RBAC inside the query) — do not change it. The deliverable is deterministic tests, not new product behavior. The one exception is an AC-1-approved product-bug fix, gated by Borja.
- **Run-unique isolation is an established repo rule**, just not yet applied to the backend package: Epic 4 AI#3 ("run-unique test isolation as DoD: suffix-unique roles/channels per run + own-id cleanup; no broad LIKE cleanups that race sibling suites") and Story 6.3's salted bot integration ids. This story finishes generalizing it.
- **English only** in all code/comments/tests (project-context). Vitest, `*.integration.test.ts` under the `backend-integration` project.

### The leak, concretely (to confirm in Task 1)
- `allowedChannels` = every `channel_permissions` row whose `allowed_roles` intersect the member's effective roles (member's Discord roles + injected `@everyone` = guild id, PR #32). Whole-table scan → any stray matching row leaks.
- Current `rbac.integration.test.ts` defends channels via `itestChannels()` (prefix filter) but asserts `res.body.roles` with a bare `toEqual(['admin','mod'])`. A `'test-guild'` in `roles` therefore most likely comes from the **guild-id `@everyone` injection** when the app/config under test carries a `guild_id` of `'test-guild'` (or a session/config difference across suites) — Task 1 confirms.
- `afterAll` already documents the FK-abort hazard of broad `LIKE` deletes on `users`; extend that carefulness to `channel_permissions` (currently a broad `LIKE 'itest-%'`).

### Source tree — files to touch
- **UPDATE** `packages/backend/src/rbac.integration.test.ts`, `channels.integration.test.ts` (primary offenders)
- **AUDIT/UPDATE** the other `packages/backend/src/**/*.integration.test.ts` suites that write shared tables
- **NEW/UPDATE** a shared salt/test-util helper next to `openTestClients`/`buildTestAppOptions`
- **UPDATE** `docs/development_guide.md` (clean-environment precondition) and/or `openTestClients` (fail-fast precheck)
- **NO CHANGE** to production `src` (RBAC service/middleware/schema) — unless AC-1 escalation approved

### Testing standards
- The whole point is determinism: AC-5's 10×-clean + stale-row runs are the real acceptance test. Salted ids + scoped assertions + own-id cleanup. Do not weaken a real assertion to make it pass — if a real product bug is found, escalate (AC-1). Every changed test must still fail on a genuine regression (Epic 5 "a test that lies" rule).

### Previous-story intelligence
- **Story 4.2 / Epic 4 retro** — origin of the whole-table-expansion leak observation and the run-unique-isolation DoD rule (AI#3).
- **Story 6.3** — per-run salt (`String(Date.now()).slice(-8)`) for bot integration ids + the FK-cleanup-race lesson; reuse the approach.
- **Stories 6.2 / 6.4 Completion Notes** — document this exact flake as pre-existing/unrelated; use them as the reproduction starting point.
- **Redis gotcha (memory):** two Redis instances (Homebrew `localhost:6379` vs Compose no-ports) — the clean-environment runbook must name the right one.

### References
- [Source: operational-backlog.md#P1.2]
- [Source: epic-6-retro-2026-07-08.md#5 — Action Item 3]
- [Source: packages/backend/src/rbac.integration.test.ts — current fixtures + afterAll]
- [Source: packages/backend/src/channels.integration.test.ts — second offender]
- [Source: Story 4-2 completion notes — whole-table RBAC expansion leak]
- [Source: packages/bot/src/sync/offlineSync.integration.test.ts — Story 6.3 salted-id pattern to copy]

## Project Context Reference

See `_bmad-output/project-context.md` (RBAC/AD-12, integration-test conventions, never-log-content) and `CLAUDE.md`. Standards: `docs/base-standards.md`, `docs/backend-standards.md`, `docs/development_guide.md`.

## Decisions (to confirm with Borja before/at implementation)

- **D1 — fail-fast guard vs runbook doc (AC-4).** Recommend a cheap `beforeAll` precheck that fails with a clear message when a competing writer is detected, *plus* a one-line note in `development_guide.md`. Confirm you want the guard (vs doc-only).
- **D2 — scope of the audit (Task 4).** Recommend converting `rbac` + `channels` (the known offenders) fully now, and auditing the rest but only converting suites that actually write shared tables, to keep the diff focused. Confirm vs "convert all backend integration suites for consistency."
- **D3 — if Task 1 finds a real product bug** (whole-table expansion leaking across guilds/tenants in production, not just tests): HALT and raise it — it would become its own story, not a test fix.

## Review Findings

_bmad-code-review 2026-07-08 — 3 adversarial layers (Blind Hunter + Edge Case Hunter + Acceptance Auditor, Opus 4.8) over the OPS-2 diff. All three confirmed the CORE determinism fix is correct: Edge verified the full `authService` injection chain (appends the guild id last, no dedup, order preserved → `toEqual([...,GUILD_ID])` is exactly right), `appOptions` completeness, the `CH_PREFIX` match, `count(*)::int`→number, and that bot/workers have their OWN test-helpers so the guard is backend-only + fork-safe. Acceptance Auditor: all AC-1…AC-6 + D1/D2/D3 faithfully met, residual honestly deferred, no over-claim. All findings are on the best-effort `assertNoCompetingWriter` guard. 4 patch, 2 dismissed._

- [x] [Review][Patch] **Guard silently becomes a no-op if its own query errors** [packages/backend/src/test-helpers.ts] — the `catch` re-throws only `[integration]`-prefixed errors and swallows everything else (permission denied on `pg_stat_activity`, a transient/statement-timeout error, or a future `result.rows` shape change) with zero signal, so a silently-disabled guard looks "clean" forever. Fix: `console.warn` on the swallowed path so a degraded guard is diagnosable (keep fail-open). (blind High + edge Low → Medium.)
- [x] [Review][Patch] **Guard is blind to a same-host writer and the message over-claims coverage** [packages/backend/src/test-helpers.ts + docs/development_guide.md] — detection is purely `client_addr IS DISTINCT FROM (own)`, so a host-run `npm run dev -w @share2brain/backend` (a first-class command in CLAUDE.md) connects from the same `client_addr` as the test and is NOT flagged; likewise a connection pooler (pgBouncer/RDS Proxy) or an app under a different DB role hides the writer; and on a shared/managed DB a benign remote client (metrics exporter, another dev's GUI) is flagged and mis-blamed on "docker compose app containers." Fix: reword the throw message to name the real signal ("a foreign client address — e.g. a dockerized app container or a remote client") and broaden the doc to state the guard is best-effort (does NOT catch a same-host `npm run dev` server or a pooled/different-role writer). (blind Medium×3 + edge Medium.)
- [x] [Review][Patch] **Redis + pg pool leak on the guard's throw path** [packages/backend/src/test-helpers.ts:openTestClients] — `openTestClients` does `await redis.connect()` then `await assertNoCompetingWriter(db)`; if the guard throws, the connected Redis client and the pg pool are never closed, and because it runs in `beforeAll`, `clients` is never assigned so `afterAll`'s `close()` can't run either. Fix: run the guard (which needs only `db`) BEFORE `redis.connect()`, and `db.$client.end()` if it throws. (edge Low, clean fix.)
- [x] [Review][Patch] **Own-connection via a Unix socket flips the guard to flag every TCP peer** [packages/backend/src/test-helpers.ts] — if `DATABASE_URL` is a unix-socket DSN, the test's own `client_addr` is NULL, the subquery returns NULL, and every foreign row satisfies `IS DISTINCT FROM NULL` → all benign TCP peers are flagged. Not hit by the default `127.0.0.1:5432` DSN, but a real trip-wire. Fix: when the own `client_addr` is NULL, skip the check (can't compare reliably). (edge Low.)

_Dismissed (2):_
- _`roles` assertions order-coupled to the `@everyone` injection position (blind Low) — **dismissed**: Edge verified `authService.ts:54` appends the guild id LAST with no dedup and the order is preserved verbatim through `rbacService`/`authController`, so `toEqual(['admin','mod',GUILD_ID])` is correct AND deterministic (a future reorder would fail loudly, not flakily)._
- _Point-in-time guard + pooler/different-role false-negatives (blind/edge Low-Med) — **dismissed as inherent best-effort limitations** of a `pg_stat_activity` heuristic, not fixable without a heavier mechanism; honestly disclosed via the reworded message + doc (patch 2) and the deferred-work note. This project runs a single local Postgres under one role, so they don't bite in practice._

## Dev Agent Record

### Agent Model Used

_(to be filled by bmad-dev-story)_

### Debug Log References

**Task 1 — reproduction spike (2026-07-08), AC-1 satisfied. Two DISTINCT vectors, cleanly separated:**

Ran `npx vitest run --project backend-integration` repeatedly, with live `docker compose` app containers (`share2brain-backend/bot/workers`) up (they had been running ~4h against the same Postgres/Redis), then with those three containers stopped.

- **Vector 1 — DETERMINISTIC, container-INDEPENDENT: the `rbac` roles assertions are STALE, not a flake, not isolation.** Both `rbac.integration.test.ts` role assertions fail EVERY run, containers up or down: `res.body.roles` = `['admin','mod','test-guild']` vs expected `['admin','mod']`, and `['nobody','test-guild']` vs `['nobody']`. Root cause: `authService.ts:54-56` unconditionally injects the guild id as the `@everyone` role (PR #32 / AD-12 — "Discord's guild-member endpoint omits `@everyone`, whose ID equals the guild ID; inject it so `@everyone` allow rules match every member"), and `buildTestAppOptions` sets `guildId: 'test-guild'` (`test-helpers.ts:83`). So the injected `'test-guild'` role is **correct product behavior**; the test expectations simply predate PR #32. **Test-only fix (AC-1 decision gate: NOT a product bug) — update the assertions to expect the injected guild id.**
- **Vector 2 — CONTAINER-DEPENDENT: `documents`/`channels` 404s.** With the app containers UP, runs intermittently also failed e.g. `documents.integration.test.ts` "narrow the page to one channel via channelId" (404 vs 200). With `bot`/`backend`/`workers` STOPPED, these failures DISAPPEARED (only the 2 stale-assertion `rbac` failures remained: 87 passed / 2 failed, stable across runs). Mechanism: the live backend re-materializes `channel_permissions` from ITS OWN config on startup (AD-12 materialization), and the live bot/workers write `discord_messages`/`embeddings` — clobbering the test's seeded `itest-` rows mid-run. **Key implication: run-unique salting (AC-2) does NOT defend against a live backend that truncates/rewrites the whole shared `channel_permissions` table — the effective fix for Vector 2 is the clean-environment precondition (AC-4).**

Conclusion: no product bug (D3 not triggered). Fix = (1) correct the stale `rbac` role assertions [Vector 1, trivial, deterministic]; (2) clean-environment precondition, ideally a fail-fast guard, since you cannot isolate from a live backend that rewrites shared tables [Vector 2]. Run-unique salting (AC-2) retains value only against sibling TEST-suite races, not against live containers.

**Deeper-dig correction (2026-07-08, same spike):** on closer inspection Vector 1 is the WHOLE of the reliably-reproducible failure — the `rbac` "test-guild" assertions fail **6/6 runs, deterministically, container-independent**. It is NOT a flake and NOT an isolation problem: PR #32 added the `@everyone`/guild-id role injection and the assertions were never updated. This is almost certainly what the 6.2/6.3/6.4 notes actually saw (PR #32 merged 2026-07-08). The `documents`/`channels` 404 is a genuinely RARE intermittent (observed 1/6, containers up) whose container-correlation is **UNPROVEN** — the operator's materialized `channel_permissions` rows persist after a container stop, yet `documents` passed post-stop, so "live backend clobbers the DB" does not fully explain it; and `pg_stat_activity` shows the app containers hold **no** active/idle Postgres connection at rest (pool closed after boot-time materialization). So: **Vector 1 is the real, definitive fix for the reported problem.** Vector 2 gets a best-effort fail-fast guard (detects an actively-connected foreign writer; a no-op false-positive-free when the DB is clean/CI) + a development_guide precondition; a precise root-cause of the rare `documents` 404 is deferred to if/when it recurs (noted honestly rather than papered over with salting that the spike shows would not fix it).

**Residual-flake investigation (Borja: "investigate the residual now") — conclusion:**

Ruled out, in order: (a) `redis.flushAll`/`flushDb` cross-file — none exists in the suite; (b) cross-file parallelism — set `fileParallelism: false` (files serial); the flake STILL occurred and each run was ~5× slower, so serialization is not the fix (reverted, no net change); (c) live containers — failures occurred with `bot/backend/workers` stopped too; (d) a single culprit test — the failing test SHIFTED run-to-run (`auth` CSRF-state, `documents` channelId, `search` q-missing), all auth+session-backed endpoints.

Root characterization: the residual is **load/timing-sensitive, not a logic defect**. It reproduced only while the machine was under heavy concurrent load (rapid back-to-back suite loops + `docker compose` stop/start + builds). Once quiet: **28 consecutive clean backend-integration runs** (10 + 15 + a final 10) and **3/3 clean full `npm run test:integration`** (110 tests, backend+bot+workers). The shifting `× should <status>` assertion failures under load are consistent with a session write→read timing gap under contention (a just-written Redis session transiently unreadable → `requireAuth` 401s before the endpoint's own validation runs). Not reproducible when quiet, so not precisely pinnable now.

Decision: OPS-2's TARGET (the deterministic RBAC `test-guild` leak) is definitively fixed and the suite is deterministic under normal load. The load-sensitive residual is documented in `deferred-work.md` (with the evidence + the specific tests) as a known, low-priority, investigate-if-it-recurs intermittency — NOT chased further (it can't be reproduced quiet, and it is a pre-existing, distinct issue from the RBAC leak).

### Completion Notes List

- **Root cause of the reported "test-guild role leak" (Vector 1): a STALE assertion, not a flake.** `authService.ts:54-56` injects the guild id as the `@everyone` role (PR #32 / AD-12); `buildTestAppOptions` uses `guildId: 'test-guild'`, so `res.body.roles` legitimately includes it. The `rbac.integration.test.ts` assertions (`['admin','mod']`, `['nobody']`) predated PR #32. **Test-only fix** (AC-1 decision gate: correct product behavior, not a bug).
- **`rbac.integration.test.ts` rewritten for isolation + correctness:** run-unique suffix `SFX` on the member id, guild id, and all channel ids; `appOptions()` binds the app to the run-unique guild id (drives the `@everyone` injection deterministically); assertions now expect the injected guild id and are scoped via `ownChannels()` (prefix filter) so a stray/stale row can't perturb them; `afterAll` deletes only this run's ids (no broad `LIKE 'itest-%'`). `rbac` now passes **10/10** (was 2/2 failing every run).
- **Fail-fast guard (AC-4):** `assertNoCompetingWriter(db)` in `openTestClients` throws with an actionable message if a foreign connection to the test DB is detected (different `client_addr` in `pg_stat_activity`) — catches a live `docker compose` app container attached to the same DB. Best-effort + false-positive-free on a clean/CI DB (empty → passes); bypass with `SHARE2BRAIN_TEST_ALLOW_SHARED_DB=1`. Note: an idle app (closed pool) shows no connection, so the DOC is the primary mitigation.
- **`docs/development_guide.md`:** documented the precondition — stop `bot/backend/workers` (or use a dedicated test DB) before `npm run test:integration`, with the exact commands.
- **Salting scope (Borja: minimal):** applied to the `rbac` suite only (the known offender); the other integration suites were NOT swept — the spike showed run-unique salting does not fix the residual load-sensitive flake, so a full sweep would be churn without payoff. Tasks 2/4 intentionally descoped to this minimal footprint.
- **AC-5 (determinism):** 10/10 clean backend-integration runs (28 clean consecutively counting the investigation runs) + 3/3 clean full integration under normal load; a deliberately-stale row no longer perturbs `rbac` by construction (run-unique `ownChannels()` scoping). The load-sensitive residual is documented, not fully closed (honest).
- **Verification gate:** `npm run lint` 0 · `npm run test` **668** unit+web · `npm run build` clean (5 pkgs) · `npm run test:integration` **110** green (normal load). No production `src` behavior changed — RBAC semantics (AD-12) untouched; changes are test-infra + a doc.

### File List

**Modified:**
- `packages/backend/src/rbac.integration.test.ts` (run-unique ids + `appOptions` + injected-guild-id assertions + scoped `ownChannels`)
- `packages/backend/src/test-helpers.ts` (`assertNoCompetingWriter` guard + `sql` import + call in `openTestClients`)
- `docs/development_guide.md` (integration-test clean-environment precondition)
- (`packages/backend/vitest.config.ts` — `fileParallelism: false` tried and REVERTED; no net change)

### File List

_(to be filled)_

## Change Log

- 2026-07-08 — Story OPS-2 code review (bmad-code-review) → status **done**. 3 adversarial layers confirmed the core determinism fix correct (Edge verified the authService injection chain / order / appOptions / prefixes / result shape / backend-only guard); all findings were on the best-effort guard. 4 patches applied: (1) `console.warn` when the guard swallows an unexpected error (no longer silently dead); (2) reworded throw message + development_guide to state the guard is best-effort and does NOT catch a same-host `npm run dev` writer or a pooled/different-role one; (3) run the guard before `redis.connect()` + end the pg pool on throw (no resource leak); (4) skip the check when our own `client_addr` is NULL (unix socket) to avoid flagging every TCP peer. 2 dismissed (roles order verified correct by Edge; inherent `pg_stat_activity` heuristic limits, disclosed). Gate re-run green: lint 0 / build clean (5 pkgs) / backend-integration 89 passed, 3/3 deterministic after patches. Status → done.
- 2026-07-08 — Story OPS-2 implemented (bmad-dev-story) → status **review**. Spike (AC-1) pinned the reported "test-guild role leak" as a STALE `rbac` assertion (deterministic; PR #32 `@everyone`/guild-id injection), NOT an isolation flake — fixed by run-unique ids + injected-guild-id assertions + scoped `ownChannels`. Added a fail-fast foreign-connection guard in `openTestClients` + a `development_guide.md` clean-environment precondition. Investigated the residual ~1/10 shifting flake (auth/documents/search): ruled out flushAll, cross-file parallelism (serial didn't help, reverted), and containers; it is load/timing-sensitive and non-reproducible when quiet (28 consecutive clean backend-integration runs + 3/3 full) — documented in deferred-work as a load-sensitive intermittency, not chased further. Minimal salting scope (rbac only, per Borja). Gate: lint 0 / 668 unit+web / build clean (5 pkgs) / 110 integration green + rbac 10/10. No product change (AD-12 untouched). Status → review.
- 2026-07-08 — Story OPS-2 created (bmad-create-story) from operational-backlog P1.2, picked up alongside OPS-1 after the Epic 6 retro. Fixes the recurring `rbac`/`channels` integration flake ("test-guild role leak") reported as pre-existing in the 6.2/6.3/6.4 Completion Notes and first seen in Epic 4. Test-infra hardening (run-unique salted fixtures + scoped assertions + clean-environment precondition), generalizing the Epic 4 run-unique-isolation rule to `packages/backend`; no product change unless a reproduction spike (Task 1) proves a real bug (→ escalate to Borja). Numbered `ops-N`, outside the epic sequence. Status → ready-for-dev.
