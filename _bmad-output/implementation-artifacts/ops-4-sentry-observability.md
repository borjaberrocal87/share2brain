---
baseline_commit: c40fe2a4501c94e148303b1ac27fdca1a5b19e56
---

# Story ops-4: Sentry observability for the three Node services

Status: done

<!-- Post-roadmap operational item (ops-N convention, outside the epic sequence). -->
<!-- Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-13-sentry.md (approved 2026-07-13). -->
<!-- Backlog: _bmad-output/implementation-artifacts/operational-backlog.md § P1.3. -->

## Story

As the **operator of the self-hosted deployment**,
I want **`backend`, `bot`, and `workers` to ship their errors and all structured log lines to Sentry**,
so that I have **centralized runtime observability without `docker logs`/`docker exec` on the Hostinger VPS**.

This is an **additive observability change** — no feature, flow, data-model, RBAC rule, or API contract
changes. All the scaffolding already exists (`observability.sentry_dsn` in the Zod config at invariant
S-5, `SENTRY_DSN` in `.env`, `docker-compose.yml` propagating it to all three services, PRD NFR13). The
instrumentation itself was **explicitly deferred** in `ARCHITECTURE-SPINE.md` — this story resolves that
deferral. `@sentry/node` is not installed anywhere yet.

**Scope decided with Borja (Correct Course, 2026-07-13):**
- **What goes to Sentry:** *full logs* — errors **plus** every log line (info/warn/debug/error) via Sentry
  Structured Logs, so the operator never opens `docker logs`. (Trade-off accepted: log volume is gated by
  `observability.log_level`; watch Sentry quota.)
- **Logger topology:** *consolidate on the shared logger* — migrate `bot`/`workers` to
  `@share2brain/shared/logger` and delete their local copies (removes the Story 6.4 DECISION 3 duplication
  debt); a single Sentry integration point.

## Acceptance Criteria

1. **Given** `packages/shared`, **when** dependencies are installed, **then** `@sentry/node` (`^9.41.0` or
   later — the minimum that supports Structured Logs) is a dependency of `@share2brain/shared` only, and
   the three services inherit it transitively via `@share2brain/shared` (no service adds `@sentry/node`
   directly — AD-2: services depend on shared, never on each other); **and** `npm install` has regenerated
   `package-lock.json` (never hand-edited).

2. **Given** the shared kernel, **when** the code is read, **then** a new module
   `packages/shared/src/observability/sentry.ts` exports `initSentry(dsn: string, service: string): void`;
   **and** it is reachable via the package subpath `@share2brain/shared/observability` (new entry in the
   `exports` map of `packages/shared/package.json`, mirroring the `./notifier` pattern).

3. **Given** an **empty** `observability.sentry_dsn` (the default that disables Sentry, invariant S-5),
   **when** any of the three services boots, **then** `initSentry` is a **no-op** (`Sentry.init` is never
   called), all three services start normally, and logs are written to `stdout` exactly as before this
   story — verified by a unit test and by booting a service with `SENTRY_DSN` unset.

4. **Given** a **non-empty** `sentry_dsn`, **when** `initSentry(dsn, service)` runs, **then** it calls
   `Sentry.init({ dsn, enableLogs: true, environment, beforeSend, beforeSendLog })` (top-level `enableLogs`,
   **not** `_experiments`), tags the events with `service` (one of `backend`/`bot`/`workers`), and does
   **not** enable `sendDefaultPii`.

5. **Given** the shared logger (`packages/shared/src/logger.ts`), **when** a line is emitted at or above the
   configured `log_level`, **then** in addition to the existing `stdout` sink it is forwarded to
   `Sentry.logger[level]` (map `debug/info/warn/error` → the matching `Sentry.logger` method), with the
   **same redaction** already applied by `redactSecrets` to both message and context; **and** lines below
   the threshold are forwarded to neither sink (Sentry log volume respects `log_level`). Before `initSentry`
   runs (or when DSN is empty) the forwarded calls are safe no-ops.

6. **Given** the three service entrypoints, **when** they boot, **then** each `main.ts` calls
   `initSentry(config.observability.sentry_dsn, '<service>')` **immediately after `loadConfig()` and before
   any network I/O** (AD-8 boot order); **and** the existing `uncaughtException` / `unhandledRejection`
   handlers additionally call `Sentry.captureException(error)` with the real `Error` object (preserving the
   stack) alongside the existing `logger.error(...)`.

7. **Given** the backend HTTP layer, **when** a request produces an unhandled error / HTTP 5xx, **then**
   Sentry captures it with a stack trace and Discord **user context** (`Sentry.setUser({ id: <discord id>,
   ... roles }`) set by a post-auth middleware — **id and roles only, never message `content` or any
   secret**) — satisfying **PRD NFR13**. `Sentry.setupExpressErrorHandler(app)` (or the v9 equivalent) is
   registered after the routes and before/around the existing error-mapping layer, without changing the
   client-facing `{ error, code }` response shape.

8. **Given** the redaction requirement, **when** an error event or a log is about to be sent, **then**
   `beforeSend` and `beforeSendLog` run the message + stack (and log attributes) through the shared
   `redactSecrets`, and **no message `content`, secret, token, or connection-string credential** ever
   appears in any Sentry event or log — verified by unit tests that feed a `user:pass@host` URL and a
   `content` field and assert both are scrubbed/absent.

9. **Given** the logger consolidation, **when** the tree is swept, **then** `packages/bot/src/logger.ts` and
   `packages/workers/src/logger.ts` are **deleted**, `bot`/`workers` `main.ts` import `createLogger` from
   `@share2brain/shared/logger` and call it with the service name (`'bot'` / `'workers'`), and the emitted
   `stdout` prefix is unchanged (`[bot] …` / `[workers] …`) — no log-format regression. (`bot`/`workers`
   have no `logger.test.ts` to remove.)

10. **Given** the docs are the source of truth, **when** read, **then**: the PRD stack table no longer
    claims "Sentry + **Pino**" (Pino was never adopted — corrected to the actual
    `@share2brain/shared/logger`); PRD NFR13 notes full logs (not only 5xx) ship to Sentry Logs;
    `ARCHITECTURE-SPINE.md` changes its "instrumentation … deferred" note to record the **implemented**
    decision; `docs/development_guide.md` gains an "Observability / Sentry" subsection; and
    `_bmad-output/project-context.md` gains the observability rule (initSentry in `main.ts` after
    `loadConfig`; never send PII/`content`; dual sink).

11. **Given** the mandatory verification gate, **when** run by the agent, **then**
    `npm run lint && npm run test && npm run build` is green with output pasted; **and** an **env-gated
    real-DSN smoke** (with a scratch Sentry project) confirms an error and an `info` log from at least one
    service actually arrive in Sentry, tagged `service`, with no `content`/secret leaked. If no scratch DSN
    is available, this AC is satisfied by the empty-DSN no-op path (AC3) plus the redaction unit tests
    (AC8), and the live smoke is noted as deferred in the Completion Notes.

## Tasks / Subtasks

> Inner-first per AD-1: `shared` (contracts/infra) → service wiring → tests → docs. One commit per group.
> Keep the branch un-pushed until the whole gate is green (deleting the local loggers breaks the build
> until the `main.ts` imports are swapped — do Task 3 in the same commit as the deletions).

- [x] **Task 0 — Branch & baseline** (AC: all)
  - [x] Verify `main` is current & clean, then `git switch -c feat/ops-4-sentry-observability`.
  - [x] Confirm the tooling assumption (Standing DoD): `@sentry/node` publishes a version `≥9.41.0`
        compatible with Node 24 (see Latest Tech Info below) before adding it.

- [x] **Task 1 — shared: Sentry SDK + `initSentry` + scrubbing** (AC: 1, 2, 4, 8) — commit
      `feat(shared): add Sentry init + scrubbing (initSentry)`
  - [x] `packages/shared/package.json`: add `"@sentry/node": "^9.41.0"` (or the current stable ≥9.41.0) to
        `dependencies`; add `"./observability": { "types": "./src/observability/index.ts", "default":
        "./src/observability/index.ts" }` to the `exports` map.
  - [x] New `packages/shared/src/observability/sentry.ts`: `initSentry(dsn, service)` — early-return when
        `dsn === ''`; else `Sentry.init({ dsn, enableLogs: true, environment: process.env.NODE_ENV ??
        'production', beforeSend, beforeSendLog })`, then set the `service` tag (initialScope or
        `setTag`). Do **not** set `sendDefaultPii`.
  - [x] Implement `beforeSend(event)` and `beforeSendLog(log)` in the same module: run message / exception
        value+stacktrace / log message + attribute values through `redactSecrets` (imported from
        `../logger.js`), and strip any `content` attribute/key. Never forward `content`.
  - [x] New `packages/shared/src/observability/index.ts` barrel re-exporting `initSentry` (+ the sink
        helper if extracted).
  - [x] `npm install` from the repo root to regenerate `package-lock.json` + workspace symlinks.

- [x] **Task 2 — shared: logger dual sink (stdout + Sentry Logs)** (AC: 5) — commit
      `feat(shared): forward logger lines to Sentry Logs (dual sink)`
  - [x] `packages/shared/src/logger.ts`: in `emit`, after the existing threshold check and `redactSecrets`,
        forward to `Sentry.logger[msgLevel](redactedMessage, redactedContext?)` for every level
        (`debug→debug, info→info, warn→warn, error→error`). Keep the console sink untouched. Import
        `* as Sentry from '@sentry/node'` (methods are safe no-ops before `Sentry.init`).
  - [x] Confirm redaction is applied to BOTH the message and the context before forwarding (reuse the
        existing `redactSecrets` calls; do not send the raw context object).

- [x] **Task 3 — service wiring + logger consolidation** (AC: 3, 6, 7, 9) — commit
      `feat(backend,bot,workers): init Sentry + consolidate on shared logger`
  - [x] `packages/bot/src/main.ts`: import `createLogger` from `@share2brain/shared/logger` +
        `initSentry` from `@share2brain/shared/observability`; call `createLogger(level, 'bot')`; call
        `initSentry(config.observability.sentry_dsn, 'bot')` right after `loadConfig()`; add
        `Sentry.captureException(error)` in the existing `uncaughtException`/`unhandledRejection` handlers.
  - [x] `packages/workers/src/main.ts`: same with `'workers'` (keep the `type Logger` import now coming
        from shared).
  - [x] `packages/backend/src/main.ts`: add `initSentry(config.observability.sentry_dsn, 'backend')` after
        `loadConfig()` (line ~31, before Redis/DB open); add `Sentry.captureException` in the existing
        `uncaughtException`/`unhandledRejection` handlers (main.ts:49/57). Backend already imports the
        shared logger — no logger swap needed.
  - [x] `packages/backend/src/app.ts`: register `Sentry.setupExpressErrorHandler(app)` after the routes,
        preserving the existing `{ error, code }` error-mapping layer; add a post-auth middleware that
        calls `Sentry.setUser({ id: <discord user id>, ...roles })` — **id + roles only** (source the
        session's `discordUserId` / `discordRoles`; never `content`).
  - [x] **Delete** `packages/bot/src/logger.ts` and `packages/workers/src/logger.ts` in this same commit
        (build stays green only once the imports above are swapped).

- [x] **Task 4 — tests** (AC: 3, 5, 8) — commit `test(shared): Sentry init + dual-sink + scrubbing`
  - [x] New `packages/shared/src/observability/sentry.test.ts` (mock `@sentry/node`): empty DSN → `init`
        NOT called (AC3); non-empty → `init` called with `enableLogs: true` and both `beforeSend` /
        `beforeSendLog` present + `service` tag (AC4); `beforeSend`/`beforeSendLog` scrub a
        `redis://user:pass@host` string and drop/omit a `content` field (AC8).
  - [x] Extend `packages/shared/src/logger.test.ts` (mock `@sentry/node`): a line ≥ threshold forwards to
        `Sentry.logger[level]` with redaction applied; a line below threshold forwards to neither sink
        (AC5).

- [x] **Task 5 — docs** (AC: 10) — commit `docs: record Sentry observability (drift, NFR13, spine, guide)`
  - [x] `docs/context/PRD.md`: stack table "Sentry + Pino" → "Sentry + `@share2brain/shared/logger`
        (custom structured logger)"; annotate NFR13 that full logs (not only 5xx) ship to Sentry Logs.
  - [x] `docs/context/ARCHITECTURE-SPINE.md`: replace the "Observabilidad detallada … deferred" note with
        the implemented decision (per-process `initSentry` in `main.ts` after `loadConfig`; dual sink;
        `enableLogs`; PII/`content` excluded; `@sentry/node` lives in `shared`).
  - [x] `docs/development_guide.md`: new "Observability / Sentry" subsection (set `SENTRY_DSN` to enable;
        empty = disabled; what is captured; volume note).
  - [x] `_bmad-output/project-context.md`: add the observability rule under backend/framework rules.

### Review Findings

_bmad-code-review (2026-07-13), 3 adversarial layers @ Opus 4.8 (Blind Hunter / Edge Case Hunter / Acceptance Auditor). Auditor: 0 AC violations — AC1–AC11 all SATISFIED against real source. Findings below are robustness/security-hardening beyond the ACs. Triage: 1 decision-needed (→ deferred by Borja), 2 patch, 4 defer, 5 dismissed._

- [x] [Review][Defer] No per-request Sentry scope isolation — `setSentryUser` can bleed across concurrent requests [packages/backend/src/app.ts:255] — `initSentry` runs inside `main()` after Express is already imported (`backend/main.ts:36` + `app.ts:8` static import), so Sentry v9's OTEL http/express request-isolation is never installed (needs import-time `instrument.ts`). `Sentry.setUser` writes the process-global scope: two concurrent authenticated requests can attribute one user's internal id + role ids to another user's captured 5xx (NFR13 traceability). Blind + Edge rate this High; Auditor notes it is the story's disclosed KNOWN LIMITATION. — deferred: KNOWN LIMITATION aceptada; perfil single-guild de baja concurrencia, `instrument.ts` (request-isolation real) queda como enhancement futuro fuera del alcance logs+captura de ops-4.

- [x] [Review][Patch] APPLIED — Fatal handlers never flush Sentry before `process.exit(1)` — captured fatal errors + buffered logs are dropped [packages/backend/src/main.ts, packages/bot/src/main.ts, packages/workers/src/main.ts]. Fix: new `flushSentry(timeoutMs = 2000)` wrapper (`Sentry.close`, bounded, never-throws) exported from `@share2brain/shared/observability`; chained into all six fatal handlers as `.notify(...).finally(() => flushSentry()).finally(() => process.exit(1))` so the captured Error + buffered Structured Logs drain before exit. +2 unit tests (flush called with timeout; flush swallows a rejected close).
- [x] [Review][Patch] APPLIED — Egress redaction is shallow — nested `content`/secrets and auto-captured breadcrumbs/request bypass `redactSecrets` [packages/shared/src/observability/sentry.ts]. Fix: `redactAttributes` is now recursive (`redactValue` walks nested objects/arrays, drops `content` at any depth, WeakSet guards circular refs); `beforeSend` additionally scrubs `event.breadcrumbs[].message/data` and `event.request` (url/query_string/headers/data). +2 unit tests (deep nested secret + nested content; breadcrumbs + request).

**Re-run (post-patch, 2026-07-13):** re-ran the 3 layers on the patched diff. Auditor re-confirmed 0 AC violations; Edge verified against the real Sentry SDK in `node_modules` that P1's `flushSentry` neither hangs nor exits early (empty-DSN `close()` resolves immediately) and that N2 below is a non-issue. The re-run found P2's `redactValue` had introduced defects, now fixed in one consolidated hardening:
- [x] [Review][Patch] APPLIED (re-run) — `redactValue` hardening [packages/shared/src/observability/sentry.ts]. (N1, Med) the WeakSet was a global visited-set, so a shared **non-circular** reference (`{a: obj, b: obj}`, or `[obj, obj]`) was dropped to `undefined` as if it were a cycle → now path-scoped (`seen.delete` after recursion) so only genuine cycles are dropped. (N4, Low) non-plain objects (`Date`/`Map`/`Buffer`/`Error`) were mangled to `{}` by `Object.entries` → now passed through unchanged via an `isPlainObject` guard. (N3, Low) a string `request.data` body bypassed the `typeof === 'object'` guard → now redacted with `redactSecrets`. +3 unit tests (shared-ref DAG survives; true cycle doesn't throw; `Date` not flattened). Gate re-run green: lint 0 / 1071 unit+web / build clean (5 pkgs).
- N2 (dismissed): `request.headers[key]` throwing on a non-string value — refuted by reading Sentry's `headersToDict` (`@sentry/core`), which keeps only string header entries; `event.request.headers` is always `Record<string,string>`.

**Re-run #2 (convergence, 2026-07-13):** Edge + Auditor declared full convergence (0 findings; Auditor 0 AC violations, 26/26 shared tests, `tsc` clean, AD-2 grep empty; the redactor hardening hand-traced sound — cycle terminates, DAG survives, `isPlainObject` classifies `Object.create(null)`/arrays/class instances correctly). Blind surfaced 1 new actionable Low-Med item (B1) + 4 residuals already deferred/dismissed (diamond-lattice O(2ᴺ) — unreachable per Edge; non-plain pass-through leak — by-design tradeoff; `redactSecrets` scope — DF1; `setUser` bleed — D1).
- [x] [Review][Patch] APPLIED (re-run #2) — Graceful SIGTERM shutdown never flushed Sentry → tail Structured Logs dropped on every normal deploy/restart [packages/backend/src/lifecycle.ts, packages/bot/src/main.ts, packages/workers/src/main.ts]. Fix: `flushSentry()` now runs in the `finally` of all three graceful-shutdown paths (after the connection drain, before `exit(0)`), mirroring the P1 fatal-handler fix. Backend's is injectable via `GracefulShutdownDeps.flushSentry` (defaults to the real shared flush) to match the file's DI style. +1 lifecycle test asserting flush runs after the drain and immediately before exit. Gate re-run green: lint 0 / 1072 unit+web / build clean (5 pkgs).

- [x] [Review][Defer] `redactSecrets` only strips URL `user:pass@` userinfo — bare tokens/API keys and passwords containing `@` not fully redacted [packages/shared/src/logger.ts:42-44] — deferred, pre-existing (Sentry egress raises the stakes)
- [x] [Review][Defer] `JSON.stringify(context)` in shared logger `emit` can throw on circular refs / BigInt, no try/catch [packages/shared/src/logger.ts:74] — deferred, pre-existing (console path predates ops-4; now shared by all three services)
- [x] [Review][Defer] Errors carrying a `<500` status (e.g. body-parser `SyntaxError` 400) are mapped to a client-facing HTTP 500 but skipped by Sentry's default `>=500` capture [packages/backend/src/app.ts:343, packages/backend/src/routes/errorHandler.ts:30] — deferred, NFR13 edge gap

## Dev Notes

### Current state of the files being modified (read before touching)

- **`packages/shared/src/logger.ts`** — canonical logger. `createLogger(level, service, sink = console)`;
  `emit` gates on `LEVEL_ORDER`, prefixes `[${service}] ${level} …`, and runs message + `JSON.stringify`
  context through `redactSecrets` (AUDIT M2). **Preserve** the threshold gate, the prefix format, and the
  redaction — the Sentry forward is *added alongside*, not instead of, the console sink. `redactSecrets`
  is exported here and reused by the notifier and (post-consolidation) by `sentry.ts`.
- **`packages/bot/src/logger.ts` / `packages/workers/src/logger.ts`** — near-identical local copies with a
  **different signature**: `createLogger(level, sink = console)` with the service name **hardcoded** in the
  prefix (`[bot]` / `[workers]`). They import `redactSecrets` from `@share2brain/shared/logger` already.
  Swapping to `createLogger(level, 'bot')` from shared produces the **identical** `[bot] …` prefix → no
  log-format regression (AC9). Each is instantiated **once** in its `main.ts` and dependency-injected
  downstream, so only the `main.ts` import site changes.
- **`packages/{bot,workers,backend}/src/main.ts`** — all three follow the AD-8 boot order: `loadConfig()`
  first (throws `ConfigError` on invalid YAML / unset `${VAR}`, caught by the top-level wrapper), then
  secrets via `requireEnv`, then DB/Redis, then the process's real work. `initSentry` goes **right after
  `loadConfig()`** so a DSN typo can't matter (config already validated it, S-5) and Sentry is armed before
  any I/O. bot/workers already have `process.on('uncaughtException' | 'unhandledRejection')` handlers
  holding the real `Error` — the ideal place for `captureException` (backend's are at main.ts:49/57).
- **`packages/backend/src/app.ts`** — builds the Express app and the generic auth/RBAC gate + the
  `{ error, code }` error mapper. `Sentry.setupExpressErrorHandler` must sit after the routes; keep the
  existing mapper as the client-facing shape (Sentry only observes).

### Architecture constraints (guardrails)

- **AD-2** — `@sentry/node` goes in `packages/shared` only; services inherit it. No service imports another.
- **AD-8** — `initSentry` after `loadConfig()`, before network I/O, in every `main.ts`.
- **S-5** — empty `observability.sentry_dsn` disables Sentry (no-op). The Zod refine already rejects a
  non-empty non-URL DSN at load, so `initSentry` never needs to defend against a malformed DSN.
- **NFR13** — 5xx captured with stack trace + user context (Discord id/roles). Never `sendDefaultPii`.
- **project-context §anti-patterns / SECURITY** — never log/forward secrets or full message `content`;
  reuse `redactSecrets` in `beforeSend`/`beforeSendLog`. Log `content.length`/ids, not `content`.

### Latest tech information (verified 2026-07-13, Sentry docs)

- `@sentry/node` **≥ 9.41.0** is required for Structured Logs; **Structured Logs are now GA** (no longer
  `_experiments`). Enable with the **top-level** `enableLogs: true` in `Sentry.init`.
- Logs API: `Sentry.logger.{trace,debug,info,warn,error,fatal}(message, attributes?)`. Our logger has four
  levels (debug/info/warn/error) → map 1:1; `fatal` unused.
- `beforeSendLog(log)` — `log` has `{ level, message, timestamp, attributes }`; return `null` to drop.
  `beforeSend(event)` — for error events; scrub `event.message` and `event.exception.values[].value` /
  `.stacktrace`.
- `Sentry.setupExpressErrorHandler(app)` is the v9 Express error hook. **ESM ordering caveat:** full
  automatic HTTP/request tracing wants `Sentry.init` to run *before* Express is imported (the "import
  instrument.ts first" pattern). Our scope is **logs + error capture**, not performance tracing — the
  error handler and explicit `captureException` do **not** depend on import-time init, so initializing
  inside `main()` is sufficient. If request-level performance spans are ever wanted, revisit with a
  dedicated `instrument.ts`. Verify the error path with the env-gated real-DSN smoke (AC11).
- Optional: `consoleLoggingIntegration()` exists (captures raw `console.*`). **Not used** — we forward via
  the shared logger so redaction is guaranteed before anything reaches Sentry.

### Project Structure Notes

- New folder `packages/shared/src/observability/` (`sentry.ts` + `index.ts`) mirrors the existing
  `notifier/` folder-with-barrel + `./notifier` subpath export convention. No root `src/`, no DDL, no Zod
  contract, no schema change — purely additive infra in `shared`.
- `docker-compose.yml` already passes `SENTRY_DSN` to `backend`/`bot`/`workers` (`:125`, `:170`, `:211`) —
  **no compose change**. `Share2Brain.config.yml`'s `observability.sentry_dsn: "${SENTRY_DSN}"` and
  `.env`'s `SENTRY_DSN` already exist — no config/env change.

### Testing standards

- Vitest, co-located `*.test.ts`, AAA, behavior-named. Mock `@sentry/node` (no real network in unit
  tests). Empirically verify the "test that lies" rule: a test asserting redaction must fail if the
  scrub is removed. Env-gate the live smoke behind `SENTRY_DSN` presence (Standing DoD — real-provider
  smoke for any new external integration).

### References

- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-13-sentry.md] — full change analysis + edit proposals (approved).
- [Source: _bmad-output/implementation-artifacts/operational-backlog.md#P1.3] — backlog entry.
- [Source: docs/context/ARCHITECTURE-SPINE.md#Observabilidad-detallada] — the deferred note this story resolves; AD-2/AD-8/S-5.
- [Source: docs/context/PRD.md] — NFR13 (5xx→Sentry+user context); observability config block; stack table "Sentry + Pino" drift.
- [Source: packages/shared/src/config/index.ts:128-134] — `observability` schema; empty-or-URL `sentry_dsn` (S-5).
- [Source: packages/shared/src/logger.ts] — canonical logger, `redactSecrets`, injectable `LogSink`.
- [Source: packages/{bot,workers}/src/logger.ts] — local copies to delete (hardcoded prefix, `createLogger(level, sink)`).
- [Source: packages/{backend,bot,workers}/src/main.ts] — AD-8 boot order; uncaught handlers (backend :49/:57).
- [Source: packages/backend/src/app.ts] — Express app + error mapper (Sentry error handler mount point).
- [Source: docker-compose.yml:125,170,211] — `SENTRY_DSN` already wired to all three services.
- [Sentry docs] https://docs.sentry.io/platforms/javascript/guides/node/logs/ — enableLogs (top-level), Sentry.logger API, beforeSendLog.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Claude Opus 4.8) — bmad-dev-story workflow.

### Debug Log References

- Gate: `npm run lint` → 0 errors. `npm run test` → **1064 passed / 1 skipped** (103 files;
  +13 vs the 1051 baseline — 8 new `sentry.test.ts` + 3 new logger dual-sink + net logger churn).
  `npm run build` → clean across all 5 packages (initial run flagged one test-fixture cast
  `{ extra } as ErrorEvent`; fixed with `as unknown as` — a compile-time-only test change).
- AC3 no-op boot smoke (real modules via `tsx`, `SENTRY_DSN` unset): stdout emitted the
  `[backend] …` lines with the connection URL redacted, the below-threshold `debug` line
  suppressed, `Sentry.getClient()` === `undefined` (init never called), `captureException`
  a safe no-op. Result: **PASS**.
- AC11 live smoke (real scratch DSN provided by Borja, `NODE_ENV=development`): sent one
  `info` log (carrying a `content` attribute + a `postgres://user:pass@…` URL) and one
  captured `Error` (message embedding a `redis://user:pass@…` URL). `Sentry.flush(5000)` →
  `true`; `lastEventId` returned (`8acd…1757`). Result: **PASS** — payloads accepted by the
  real Sentry ingest. Visual confirmation in the Sentry UI (event tagged `service=backend`,
  `content` absent, credentials redacted) is Borja's to eyeball; the egress-side scrubbing is
  additionally proven by the AC8 unit tests.

### Completion Notes List

- **All 11 ACs satisfied.** `@sentry/node@^9.41.0` (resolved 9.47.1, Node ≥18) added to
  `@share2brain/shared` **only**; the three services inherit it transitively (AD-2) and import
  exclusively from the new `@share2brain/shared/observability` subpath — **no service imports
  `@sentry/node` directly**, keeping a single integration point (AC2) and avoiding reliance on
  hoisting an undeclared dep. `beforeSend`/`beforeSendLog`/`captureException`/`setSentryUser`/
  `setupSentryErrorHandler` are thin wrappers in `shared`.
- **DECISION — user id source (AC7):** the story text assumed a `discordUserId` in the session,
  but `SessionData` carries only the **internal `userId` (UUID)** + `discordRoles` (the Discord
  snowflake is used at OAuth callback to upsert the user and is *not* persisted, `sessionStore.ts`).
  `Sentry.setUser` therefore uses the internal UUID as `id` — a pseudonymous identifier that is a
  *better* fit for "id + roles only, never PII" than the real Discord snowflake would be. No session
  shape change (AD-10 keeps the session minimal).
- **DECISION — `Log` type import:** `@sentry/node` re-exports `ErrorEvent` but not the structured-log
  `Log` type (it lives in `@sentry/core`, a transitive dep we must not name — AD-2). Derived it from
  the `beforeSendLog` hook signature on the init options, so we track the SDK's own type without a
  second Sentry dependency.
- **DECISION — `@sentry/node` version:** pinned `^9.41.0` (resolves to latest 9.x) per AC1, not the
  available 10.x major — v9 matches the verified Structured-Logs API notes (top-level `enableLogs`,
  `Sentry.logger`, `beforeSendLog`, `setupExpressErrorHandler`) and avoids unverified major drift.
- **Logger consolidation (AC9):** `packages/{bot,workers}/src/logger.ts` deleted; 36 bot/workers
  files that imported `type Logger` from the local copy were redirected to `@share2brain/shared/logger`
  (absolute package import — depth-independent). `main.ts` now calls `createLogger(level, 'bot'|'workers')`,
  producing the **identical** `[bot] …` / `[workers] …` stdout prefix (no format regression).
- **Open Question 1 — `environment`:** resolved to `process.env.NODE_ENV ?? 'production'` (no
  config/schema change), as recommended.
- **Open Question 2 — `release` tagging:** deferred (not trivial without threading the GHCR image tag
  through as an env var); tracked as a future enhancement.
- **KNOWN LIMITATION (noted for review):** `Sentry.setUser` in the post-auth middleware sets the user
  on the current scope. Full per-request isolation for user context / performance spans would require
  the import-time `instrument.ts` pattern (Sentry's ESM ordering caveat), which is out of scope here
  (logs + error capture only, per the story's tech notes). At the self-hosted single-guild concurrency
  profile this is acceptable; revisit with `instrument.ts` if request-level tracing is ever wanted.

### File List

**Added**
- `packages/shared/src/observability/sentry.ts` — `initSentry`, `beforeSend`, `beforeSendLog` (recursive deep redaction), `captureException`, `flushSentry`, `setSentryUser`, `setupSentryErrorHandler`.
- `packages/shared/src/observability/index.ts` — barrel for the `./observability` subpath.
- `packages/shared/src/observability/sentry.test.ts` — AC3/AC4/AC8 + wrapper tests.

**Modified — shared**
- `packages/shared/package.json` — `@sentry/node` dep + `./observability` export.
- `package-lock.json` — regenerated by `npm install` (not hand-edited).
- `packages/shared/src/logger.ts` — dual sink (stdout + `Sentry.logger`), same redaction.
- `packages/shared/src/logger.test.ts` — dual-sink tests (AC5) + `@sentry/node` mock.

**Modified — services**
- `packages/backend/src/main.ts` — `initSentry` after `loadConfig`; `captureException` + `flushSentry` in fatal handlers.
- `packages/backend/src/app.ts` — post-auth `setSentryUser` middleware; `setupSentryErrorHandler` before the mapper.
- `packages/backend/src/lifecycle.ts` — (review P1/B1) `flushSentry` in the graceful-shutdown `finally` before `exit(0)`, injectable via `GracefulShutdownDeps.flushSentry`.
- `packages/backend/src/lifecycle.test.ts` — (review B1) test asserting flush runs after the drain and immediately before exit.
- `packages/bot/src/main.ts` — shared logger + `initSentry('bot')` + `captureException`; `flushSentry` in fatal + graceful shutdown paths.
- `packages/workers/src/main.ts` — shared logger + `initSentry('workers')` + `captureException`; `flushSentry` in fatal + graceful shutdown paths.
- 36 files under `packages/bot/src/**` and `packages/workers/src/**` — `import type { Logger }` redirected to `@share2brain/shared/logger`.

**Deleted**
- `packages/bot/src/logger.ts`
- `packages/workers/src/logger.ts`

**Modified — docs**
- `docs/context/PRD.md` — stack table (Pino → shared logger) + SNF-9/NFR13 (full logs to Sentry).
- `docs/context/ARCHITECTURE-SPINE.md` — "Observabilidad detallada" deferred → implemented decision; Logging binding note.
- `docs/development_guide.md` — new "🔭 Observability (Sentry)" section.
- `_bmad-output/project-context.md` — observability rule under Backend framework rules.

### Change Log

- 2026-07-13 — Implemented ops-4 (Sentry observability). Added `@sentry/node` to `shared` only +
  `@share2brain/shared/observability` (`initSentry` + scrubbing hooks + wrappers); logger dual sink
  (stdout + Sentry Structured Logs); wired `initSentry`/`captureException` into all three `main.ts`
  and `setupSentryErrorHandler` + post-auth `setSentryUser` into the backend app; consolidated
  `bot`/`workers` onto the shared logger (local copies deleted, 36 import sites redirected); docs
  synced (PRD, ARCHITECTURE-SPINE, development_guide, project-context). Gate green
  (lint 0 / 1064 tests / build 5 pkgs); AC3 no-op boot smoke + AC11 live real-DSN smoke both PASS.

## Open Questions (RESOLVED at implementation)

1. **`environment` value** — **RESOLVED:** `process.env.NODE_ENV ?? 'production'` (no config/schema
   change), per the recommendation.
2. **`release` tagging** — **DEFERRED:** not wired; would require threading the GHCR image tag through
   as an env var. Tracked as a future enhancement.
