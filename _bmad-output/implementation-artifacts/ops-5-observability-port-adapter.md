---
baseline_commit: d2d0faca239a76341a1713587e60583dc1529a10
---

# Story ops-5: Refactor observability to a vendor-neutral port + adapter

Status: done

<!-- Post-roadmap operational item (ops-N convention, outside the epic sequence). -->
<!-- Follow-on to ops-4-sentry-observability.md (Sentry shipped, done 2026-07-13). -->
<!-- Motivation: architecture review 2026-07-16 (Amelia) — ops-4 isolated the @sentry/node -->
<!-- DEPENDENCY to `shared` (AD-2) but did NOT invert it: the public surface is vendor-named -->
<!-- (initSentry/captureException/setSentryUser/...), so adding a second provider today would -->
<!-- force edits across all three services. Backlog: operational-backlog.md § P1.4. -->

## Story

As the **maintainer of Share2Brain**,
I want **observability exposed as a vendor-neutral port with Sentry as one interchangeable adapter**,
so that **a future provider (OpenTelemetry, Datadog, Grafana, …) can be added by writing one adapter and flipping one config value — without touching `backend`, `bot`, `workers`, or the shared logger**.

This is a **behavior-preserving refactor** — no feature, flow, data-model, RBAC rule, API contract, or
runtime output changes. With a DSN set, exactly the same errors + logs reach Sentry, tagged and scrubbed
identically; with an empty DSN, every service still boots and logs to stdout as today (S-5). The story
inverts the dependency that ops-4 left concrete: it replaces the vendor-named free-function surface
(`initSentry`, `captureException`, `flushSentry`, `setSentryUser`, `setupSentryErrorHandler`) with an
`Observability` **port** (interface), makes Sentry a concrete **adapter** behind a `createObservability`
factory (mirroring the existing `createNotifier` port in `packages/shared/src/notifier/index.ts`), adds a
`NoopObservability` for the empty-DSN case, and removes the hard-wired `import * as Sentry` from the shared
logger by injecting a vendor-neutral structured-log sink.

**Why this is worth doing (the concrete gap ops-4 left):**
- The barrel `@share2brain/shared/observability` re-exports functions whose names contain the vendor
  (`initSentry`, `setSentryUser`, …). Consumers bind to Sentry by name at ~10 call sites across all three
  services — the vendor leaks into the application layer, violating DIP / Open–Closed.
- `packages/shared/src/logger.ts` hard-imports `@sentry/node` (`:18`) and calls `Sentry.logger[level]`
  directly (`:88`). The console sink is injectable (`LogSink`, `:47`) but the Sentry sink is not —
  inconsistent, and a second log destination would mean editing `createLogger`.
- `taggedService` is module-level mutable state (`sentry.ts:30`) — an implicit singleton.
- The sibling `notifier` module **already** demonstrates the correct pattern (`interface Notifier` +
  `createNotifier` factory + `NOOP_NOTIFIER`). ops-4 copied the notifier *barrel* but not its *port*. This
  story closes that inconsistency inside `packages/shared`.

**Scope boundary (explicitly OUT):** no new provider is implemented — only the seam that makes the next one
config-only. No change to what is captured, redacted, or tagged. No `instrument.ts` / request-isolation work
(ops-4 KNOWN LIMITATION stays as-is). No change to `redactSecrets`' redaction rules.

## Acceptance Criteria

1. **Given** `packages/shared`, **when** the observability module is read, **then** a vendor-neutral port
   exists — an `Observability` interface (e.g. in `packages/shared/src/observability/observability.ts`) with
   **no `Sentry`/vendor name in the type or its member names**, exposing at least:
   `captureException(error: unknown): void`, `setUser(user: { id: string; roles: string[] }): void`,
   `setupExpressErrorHandler(app: unknown): void`, `flush(timeoutMs?: number): Promise<void>`, and a
   vendor-neutral structured-log sink the logger can consume (see AC4). The interface is exported from the
   `@share2brain/shared/observability` barrel.

2. **Given** the port, **when** the composition entry point is read, **then** a single factory
   `createObservability(opts: { dsn: string; service: string }): Observability` is exported from
   `@share2brain/shared/observability` (mirroring `createNotifier(config, logger)` in
   `packages/shared/src/notifier/index.ts`). It performs **no network I/O at construction** beyond what
   `Sentry.init` already did in ops-4, and it is the ONLY function services call to obtain observability.

3. **Given** an **empty** `dsn` (invariant S-5), **when** `createObservability` is called, **then** it
   returns a shared `NoopObservability` (mirroring `NOOP_NOTIFIER`): `Sentry.init` is **never called**, every
   method is a safe no-op, `flush()` resolves immediately, and the injected structured-log sink drops every
   line — so all three services boot and log to stdout exactly as before (verified by a unit test asserting
   `Sentry.init` is not called and by an empty-DSN boot smoke).

4. **Given** the shared logger, **when** `packages/shared/src/logger.ts` is read, **then** it **no longer
   imports `@sentry/node`** (the `import * as Sentry` at `:18` and the direct `Sentry.logger[msgLevel]` call
   at `:88` are gone). Instead `createLogger` accepts a vendor-neutral structured-log sink (default: a no-op)
   and forwards each emitted line to it as `(level, redactedMessage, redactedAttributesObject)` — the **same
   `redactSecrets` output** already fed to stdout, and only for lines at/above the threshold. The console
   `LogSink`, the `[service] level msg` prefix, the threshold gate, and `redactSecrets` are all preserved
   byte-for-byte (no stdout-format regression).

5. **Given** the Sentry **adapter** (`packages/shared/src/observability/sentry.ts`), **when** a **non-empty**
   `dsn` is supplied, **then** it still calls `Sentry.init({ dsn, enableLogs: true, environment, beforeSend,
   beforeSendLog })` (top-level `enableLogs`, `sendDefaultPii` off), tags events with `service`, and stamps
   `service` on structured logs — behavior identical to ops-4. The former module-level `taggedService`
   mutable global is eliminated (the service is now closure/instance state of the adapter).

6. **Given** the egress redaction, **when** the code is read and tests run, **then** `beforeSend`,
   `beforeSendLog`, and `redactValue`/`redactAttributes` are **preserved intact** (recursive deep scrub, drop
   any `content` key at any depth, path-scoped `WeakSet` cycle guard, `isPlainObject` pass-through for
   Date/Map/Buffer/Error, breadcrumbs + request scrubbing). **No security regression**: the unit tests that
   feed a `user:pass@host` URL and a `content` field and assert both are scrubbed/absent still pass, now
   driven **through the port** (adapter under test), not the free functions.

7. **Given** the three service entrypoints, **when** `packages/{backend,bot,workers}/src/main.ts` are read,
   **then** each calls `createObservability({ dsn: config.observability.sentry_dsn, service: '<service>' })`
   **immediately after `loadConfig()` and before any network I/O** (AD-8), passes the resulting port's
   structured-log sink into `createLogger`, and the `uncaughtException` / `unhandledRejection` handlers call
   `observability.captureException(error)` and `.finally(() => observability.flush())`. **No `main.ts` file
   references `@sentry/node`, `initSentry`, `captureException`, `flushSentry`, or any vendor name** — only the
   port instance and `createObservability`.

8. **Given** the backend HTTP layer, **when** `packages/backend/src/app.ts` and `lifecycle.ts` are read,
   **then** the `Observability` port is injected (through `createApp` opts and `GracefulShutdownDeps`, matching
   the existing DI for `notifier`/`queryEmbedder`/`flushSentry`): the post-auth middleware calls
   `observability.setUser({ id: req.session.userId, roles: req.session.discordRoles ?? [] })`, the error hook
   is `observability.setupExpressErrorHandler(app)` (client-facing `{ error, code }` mapper unchanged), and the
   graceful-shutdown `finally` calls `observability.flush()`. **No `setSentryUser` / `setupSentryErrorHandler`
   / `flushSentry` / vendor name remains in `app.ts` or `lifecycle.ts`.**

9. **Given** the whole tree after the refactor, **when** it is swept, **then** `@sentry/node` is imported in
   **exactly one file** — `packages/shared/src/observability/sentry.ts` (AD-2 preserved and tightened; verify
   with `grep -rn "@sentry/node" packages --include=*.ts | grep -v node_modules` returning only that file and
   its test). `@sentry/node` remains a dependency of `@share2brain/shared` only; the `./observability` subpath
   export is unchanged.

10. **Given** the "add a provider without touching the app" goal, **when** the config contract is read,
    **then** the extension point is config-selectable: `observability` gains an **optional** `provider` field
    (Zod, in `packages/shared/src/config/index.ts`) that defaults to `sentry` (fail-safe, backward compatible —
    an existing `Share2Brain.config.yml`/`.env` with no `provider` behaves exactly as today), and
    `createObservability` selects the adapter from it. Adding a future provider is then: (a) a new adapter file
    implementing `Observability`, (b) one branch/registry entry in `createObservability`, (c) a config value —
    **zero changes** to any `packages/{backend,bot,workers}` or `web` file. Document this three-step recipe in
    the module header of `observability/index.ts` (or a short `observability/README`). *(If, on implementation,
    the `provider` field is judged premature per YAGNI, it MAY be deferred — but only if the factory is still
    structured so the single edit to add a provider lives entirely inside `createObservability`; record the
    decision either way in Completion Notes.)*

11. **Given** the mandatory verification gate, **when** run by the agent, **then**
    `npm run lint && npm run test && npm run build` is green with output pasted, with **no net loss of test
    count/coverage** vs the ops-4 baseline (the sentry + logger dual-sink + scrubbing suites are migrated to
    drive the port, not deleted). An **empty-DSN boot smoke** confirms all three services start and stdout is
    byte-identical to today (AC3). The env-gated **real-DSN smoke** (AC11 of ops-4) is re-run if a scratch DSN
    is available and confirms an error + an `info` log still arrive tagged `service` with no `content`/secret;
    if unavailable, it is satisfied by the empty-DSN path + the migrated redaction unit tests, noted deferred.

## Tasks / Subtasks

> Inner-first per AD-1: define the port → build the Sentry adapter + Noop behind the factory → decouple the
> logger → re-wire the three services → migrate tests → config selector + docs. The build will not go green
> until the service wiring (Task 4) is swapped in the same commit that stops exporting the vendor-named
> functions (Task 2). Keep the branch un-pushed until the whole gate is green.

- [x] **Task 0 — Branch & baseline** (AC: all)
  - [x] Verify `main` is current & clean, then `git switch -c refactor/ops-5-observability-port`.
  - [x] Re-read the three files being modified end-to-end (Dev Notes § current state) before editing.

- [x] **Task 1 — shared: define the `Observability` port + `StructuredLogSink`** (AC: 1, 4) — commit
      `refactor(shared): add vendor-neutral Observability port`
  - [x] New `packages/shared/src/observability/observability.ts` (or co-locate in the barrel): export
        `interface Observability { captureException; setUser; setupExpressErrorHandler; flush; logSink }`.
  - [x] Define the vendor-neutral structured-log sink type. **Put it in `logger.ts`** (or a tiny shared types
        module) so the dependency direction stays `observability → logger` (observability already imports
        `redactSecrets` from logger; the logger must NOT import from observability). Suggested shape:
        `interface StructuredLogSink { log(level: LogLevel, message: string, attributes?: Record<string, unknown>): void }`.
        Export a `NOOP_STRUCTURED_SINK`.

- [x] **Task 2 — shared: Sentry adapter + Noop + `createObservability` factory** (AC: 2, 3, 5, 6) — commit
      `refactor(shared): Sentry adapter behind createObservability + Noop`
  - [x] Refactor `packages/shared/src/observability/sentry.ts`: fold `initSentry`/`captureException`/
        `flushSentry`/`setSentryUser`/`setupSentryErrorHandler` into a `createSentryObservability({ dsn,
        service }): Observability` that calls `Sentry.init(...)` in its constructor and returns an object
        implementing the port; its `logSink.log(level, msg, attrs)` maps to `Sentry.logger[level](msg, attrs)`.
        Move `taggedService` into closure/instance state (AC5). **Keep `beforeSend`/`beforeSendLog`/
        `redactValue`/`redactAttributes`/`isPlainObject` unchanged** (AC6) — same functions, now module-private
        to the adapter (still unit-testable, exported for the test or tested through the adapter).
  - [x] Add `NoopObservability` (all methods no-op, `flush` resolves, `logSink = NOOP_STRUCTURED_SINK`) —
        mirror `NOOP_NOTIFIER` in `notifier/index.ts`.
  - [x] Add `createObservability({ dsn, service }): Observability` — returns `NoopObservability` when
        `dsn === ''` (S-5), else the Sentry adapter (or the provider selected per AC10).
  - [x] Update `packages/shared/src/observability/index.ts`: export `createObservability` + the
        `Observability` type; **stop exporting** `initSentry`/`captureException`/`flushSentry`/`setSentryUser`/
        `setupSentryErrorHandler`/`beforeSend`/`beforeSendLog` (vendor-named surface removed).

- [x] **Task 3 — shared: decouple the logger from `@sentry/node`** (AC: 4) — commit
      `refactor(shared): inject structured-log sink into createLogger`
  - [x] `packages/shared/src/logger.ts`: remove `import * as Sentry from '@sentry/node'` (`:18`) and the
        `Sentry.logger[msgLevel](...)` call (`:88`). Add a `structuredSink: StructuredLogSink = NOOP_STRUCTURED_SINK`
        parameter to `createLogger`; in `emit`, after redaction and only for lines ≥ threshold, call
        `structuredSink.log(msgLevel, redactedMessage, attributes)` (the same object it parses back today).
        Preserve the console sink, prefix, threshold gate, and `redactSecrets` exactly.

- [x] **Task 4 — services: inject the port, drop the vendor surface** (AC: 7, 8, 9) — commit
      `refactor(backend,bot,workers): consume Observability port via DI`
  - [x] `packages/{backend,bot,workers}/src/main.ts`: replace the `initSentry(...)` call with
        `const observability = createObservability({ dsn: config.observability.sentry_dsn, service: '<svc>' })`
        right after `loadConfig()`; pass `observability.logSink` into `createLogger(level, service, undefined,
        observability.logSink)` (or the chosen ergonomics); replace `captureException(error)` →
        `observability.captureException(error)` and `flushSentry()` → `observability.flush()` in the fatal
        handlers. Remove all `@share2brain/shared/observability` vendor-named imports.
  - [x] `packages/backend/src/main.ts`: thread `observability` into `createApp({ ..., observability })` and into
        `createGracefulShutdown({ ..., observability })`.
  - [x] `packages/backend/src/app.ts`: `createApp` opts gains `observability: Observability`; the post-auth
        middleware calls `opts.observability.setUser(...)`; replace `setupSentryErrorHandler(app)` with
        `opts.observability.setupExpressErrorHandler(app)`. Remove the vendor-named imports.
  - [x] `packages/backend/src/lifecycle.ts`: replace the injected `flushSentry?: () => Promise<void>` with the
        `observability` port (or keep an injected `flush` that defaults to `observability.flush`); call it in the
        graceful-shutdown `finally` before `exit(0)`.

- [x] **Task 5 — migrate tests to drive the port** (AC: 3, 5, 6, 11) — commit
      `test(shared): drive observability via the port; assert @sentry/node isolation`
  - [x] `packages/shared/src/observability/sentry.test.ts`: retarget from `initSentry`/free functions to
        `createObservability`/`createSentryObservability`. Keep: empty DSN → `Sentry.init` NOT called + Noop
        returned (AC3); non-empty → `init` with `enableLogs: true` + both hooks + `service` tag (AC5);
        `beforeSend`/`beforeSendLog` scrub `redis://user:pass@host` and drop nested `content` at depth; DAG
        survives, true cycle terminates, `Date` not flattened (AC6). Add: the port's `logSink.log` forwards to
        `Sentry.logger[level]` with the mapped message/attributes.
  - [x] `packages/shared/src/logger.test.ts`: replace the `@sentry/node` mock with a **fake `StructuredLogSink`**
        injected into `createLogger`; assert a line ≥ threshold calls `sink.log(level, redactedMessage, attrs)`
        with redaction applied, and a line below threshold calls neither the console sink nor `sink.log` (AC4).
        Verify the "test that lies" rule: removing the forward must fail the test.
  - [x] `packages/backend/src/lifecycle.test.ts` (+ any app test): update the injected dep from `flushSentry` to
        the port; assert `flush` runs after the drain and immediately before exit.

- [x] **Task 6 — config selector + docs** (AC: 10) — commit
      `feat(shared): optional observability.provider selector + docs`
  - [x] `packages/shared/src/config/index.ts`: add optional `provider` to the `observability` block (Zod enum,
        default `'sentry'`, fail-safe). `createObservability` reads it. *(Or defer per AC10 note — record the
        decision.)*
  - [x] `Share2Brain.config.yml`: no change required (default applies); optionally document the key with a
        comment. **Do not** add secrets here (AD: secrets only in `.env`).
  - [x] Document the 3-step "add a provider" recipe in the `observability/index.ts` header (or a short README):
        new adapter file → one factory branch → config value; nothing in services/web.
  - [x] Update `docs/context/ARCHITECTURE-SPINE.md` (observability note: port+adapter, Sentry is one adapter,
        `@sentry/node` in one file), `docs/development_guide.md` (Observability section: how to add a provider),
        and `_bmad-output/project-context.md` (the observability rule: services depend on the `Observability`
        port, never on `@sentry/node`; single adapter file).

### Review Findings

_bmad-code-review 2026-07-16 (Opus 4.8, adversarial 3-layer: Blind Hunter / Edge Case Hunter / Acceptance Auditor). Verification gate re-run by the reviewer: lint clean · 1116 passed | 1 skipped · build clean (5 packages). AC9 sweep + dangling-importer grep confirmed clean. All 11 ACs PASS. Initial outcome: 0 decision-needed, 0 patch, 6 defer, 9 dismissed._

_Follow-up (2026-07-16): Borja promoted findings #2 and #6 to patches; applied and re-reviewed adversarially (delta re-review clean; one Low sub-point on `setupExpressErrorHandler` also resolved). Gate re-run green: lint clean · **1123 passed | 1 skipped** (+7 tests) · build clean. Net outcome: **2 patched, 4 deferred, 9 dismissed.**_

_Full adversarial re-sweep (2026-07-16, all 3 layers on the complete diff): confirmed behavior-preserving, **11/11 ACs PASS, no regression, no Critical/High**; auditor verified `guard()` did not touch the redaction hooks and AC9 single-file isolation holds. Three micro-fixes applied to the hardening delta: (a) tightened the `guard()` doc comment — `Sentry.init`/`setTag` in the constructor are deliberately unguarded (a bad DSN SHOULD fail loud per AD-8; Zod already validated it), resolving a wording contradiction; (b) ran the degraded-path `console.error` message through `redactSecrets` (an SDK error string could carry the DSN); (c) honest naming for the logger→logSink→beforeSendLog test (SDK is mocked; hook invoked directly). Gate green (lint / 1123 pass / build). Remaining pre-existing items (`redactValue` depth bound, logger `JSON.stringify` on BigInt/cyclic context) are unchanged by ops-5 and already tracked from the ops-4 review._

- [x] [Review][Defer] Fail-open extensibility in `createObservability` [packages/shared/src/observability/index.ts + config/index.ts:533] — deferred, out of scope. Two future-provider foot-guns: (a) an unknown `provider` string falls through to `return NoopObservability` silently instead of failing loud; (b) the `dsn === ''` gate is Sentry-DSN-specific yet runs before provider dispatch, so a future provider that authenticates via its own credential (empty `sentry_dsn`) would be silently Noop'd. Only bites when provider #2 lands (explicitly OUT per spec §Scope boundary); AC10 endorses fail-safe-to-Noop. Source: blind+edge+auditor.
- [x] [Review][Patch] ✅ FIXED — `Observability` port non-throw contract + adapter guards [packages/shared/src/observability/{observability.ts,sentry.ts}] — the port interface now documents the "no method throws / flush never rejects" contract (mirroring `Notifier`); the Sentry adapter wraps `captureException`/`setUser`/`setupExpressErrorHandler`/`logSink.log` in a `guard(fn, onErrorLabel?)` helper. Hot/crash-path calls swallow silently (no spam/recursion); the once-per-boot `setupExpressErrorHandler` degrades rather than crashing but emits a one-line `console.error` signal (matching `redis.ts`/`db/index.ts`) so a wiring failure is visible. 4 never-throw guard tests added (test-that-lies verified). Source: edge.
- [x] [Review][Defer] DI defaults regressed from functional to inert Noop [packages/backend/src/app.ts:154, lifecycle.ts:78] — deferred, no live impact. `createApp` and `createGracefulShutdown` now default `observability` to `NoopObservability`; ops-4 defaulted to the process-global Sentry client / real `flushSentry`. All call sites (`main.ts`) inject the port, so no live effect — but a mis-wired future caller silently loses 5xx capture / tail flush. Arguably correct for a port design (inert default, explicit DI). Source: edge.
- [x] [Review][Defer] Two sources of truth for the provider set [packages/shared/src/observability/observability.ts (`ObservabilityProvider`) + config/index.ts:533 (Zod enum)] — deferred, low. The TS union and the Zod enum are hand-synced (the code comment admits the drift risk); they can diverge with no compiler complaint. Fix, if promoted: derive one from the other. Bites with provider #2. Source: blind.
- [x] [Review][Defer] Traceability: ops-5 code carries `// Story ops-4:` comments [packages/backend/src/{lifecycle.ts:~335,main.ts:~386,391}, app.ts:~239] — deferred, doc hygiene. Several lines rewritten in ops-5 keep `Story ops-4` tags, and app.ts renumbered a comment AC7→AC8; partly defensible (the drain/dual-sink features originate in ops-4). Judgment call, no code impact. Source: blind.
- [x] [Review][Patch] ✅ FIXED — Test coverage gaps [packages/shared/src/observability/sentry.test.ts] — added a test for the unknown-provider→Noop fallthrough (cast past the type to reach the defensive branch; asserts `toBe(NoopObservability)` + `init` not called), an end-to-end `logger → port logSink → Sentry.logger → beforeSendLog` test (real logger + real adapter sink + redaction, then the captured hook stamps `service`), a below-threshold-dropped test, plus the 4 never-throw guard tests. AC11 "no coverage loss" preserved and extended (+7 tests). Source: blind.

_Dismissed (9): `setupExpressErrorHandler(app: unknown)` (spec-endorsed to keep `shared` express-free; adapter casts); empty-DSN middleware-stack not "byte-identical" (no observable diff — AC3 byte-identical is scoped to stdout, verified); `service` attr overwrite in `beforeSendLog` (pre-existing, service tag authoritative); positional 4th `createLogger` arg (matches spec design sketch verbatim); `NoopObservability` not frozen (mirrors un-frozen `NOOP_NOTIFIER`); barrel-export removal / dangling importers (grep + green build confirm clean); `setUser` global-scope concurrency (spec explicitly OUT — ops-4 KNOWN LIMITATION, request-isolation deferred); `provider` field vs AC7 illustrative sig (AC10-endorsed, `provider?` optional); AC11 numbers not reproduced (reviewer re-ran the gate — green)._

## Dev Notes

### Current state of the files being modified (read before touching)

- **`packages/shared/src/observability/sentry.ts`** — exports the vendor-named free functions
  (`initSentry`, `beforeSend`, `beforeSendLog`, `captureException`, `flushSentry`, `setSentryUser`,
  `setupSentryErrorHandler`) + module-level `taggedService` state (`:30`). `beforeSend`/`beforeSendLog` and
  the recursive `redactValue`/`redactAttributes`/`isPlainObject` scrubbers are hardened and reviewed (ops-4
  re-runs #1/#2) — **preserve their logic verbatim**; only their *packaging* (into an adapter object) changes.
- **`packages/shared/src/observability/index.ts`** — barrel re-exporting the seven functions. Becomes the
  export point for `createObservability` + the `Observability` type; the vendor-named exports are removed.
- **`packages/shared/src/logger.ts`** — canonical logger. `createLogger(level, service, sink = console)`;
  `emit` gates on `LEVEL_ORDER`, prefixes `[${service}] ${level} …`, runs message + `JSON.stringify(context)`
  through `redactSecrets`, then (ops-4) round-trips the redacted JSON back to an object and calls
  `Sentry.logger[msgLevel](redactedMessage, attributes)` (`:88`). Imports `* as Sentry` at `:18`. **Preserve**
  the threshold gate, prefix, and redaction; **remove** the direct Sentry coupling — the structured forward
  moves behind an injected `StructuredLogSink`. `redactSecrets` stays exported here (notifier + adapter reuse
  it — do NOT move it).
- **`packages/notifier/index.ts` (the pattern to mirror)** — `interface Notifier { notify(...) }`,
  `const NOOP_NOTIFIER: Notifier = { notify: async () => undefined }`, and
  `createNotifier(config, logger): Notifier` returning `NOOP_NOTIFIER` when disabled. Replicate this shape
  exactly for `Observability` / `NoopObservability` / `createObservability`.
- **`packages/{backend,bot,workers}/src/main.ts`** — AD-8 boot order: `loadConfig()` → `initSentry(...)` →
  `createLogger(...)` → `createNotifier(...)` → DB/Redis → work. `initSentry` sits right after `loadConfig`
  and before `createLogger` "so the logger's dual sink can forward from the very first line" (backend
  `main.ts:33-37`). After the refactor, `createObservability` takes that slot and its `logSink` is passed into
  `createLogger` — the ordering guarantee is unchanged (the Noop/adapter sink exists before the first log).
  The `uncaughtException`/`unhandledRejection` handlers (backend `:52`/`:65`; bot/workers likewise) call
  `captureException` + chain `.finally(() => flushSentry())` before `process.exit(1)` — swap to the port.
- **`packages/backend/src/app.ts`** — `createApp(opts)` already DI-injects `queryEmbedder`, `rbacService`,
  etc. The post-auth middleware (`:256`) calls `setSentryUser({ id: req.session.userId, roles:
  req.session.discordRoles ?? [] })`; `setupSentryErrorHandler(app)` is mounted after the routes (`:346`),
  before/around the `{ error, code }` mapper. Add `observability` to opts and route both calls through it.
- **`packages/backend/src/lifecycle.ts`** — `GracefulShutdownDeps.flushSentry?: () => Promise<void>` (`:51`),
  defaulted to the real `flushSentry` (`:77`), called in the drain `finally`. Swap to the port (or keep an
  injected `flush` fn defaulting to `observability.flush`).

### Architecture constraints (guardrails)

- **AD-2** — `@sentry/node` stays in `packages/shared` only, now in a **single file**
  (`observability/sentry.ts`). Services depend on the `Observability` port, never on `@sentry/node`, never on
  each other. The logger must not import `@sentry/node` (AC4) and must not import from `observability`
  (dependency direction: `observability → logger`).
- **AD-6** — the API/config contracts live in `shared` (Zod). The optional `observability.provider` field is
  a `shared` config change (allowed); no service defines it locally.
- **AD-8** — `createObservability` runs right after `loadConfig()`, before network I/O, in every `main.ts`.
- **S-5** — empty `observability.sentry_dsn` ⇒ `NoopObservability`, `Sentry.init` never called. The Zod refine
  already rejects a non-empty non-URL DSN at load, so the adapter never defends against a malformed DSN.
- **NFR13** — 5xx captured with stack + user context (internal UUID + Discord role ids only; never the
  snowflake, content, email, IP). `sendDefaultPii` off. Behavior identical to ops-4 — this is a refactor.
- **project-context §anti-patterns / SECURITY** — never log/forward secrets or full message `content`; the
  `beforeSend`/`beforeSendLog`/`redactValue` scrubbers and `redactSecrets` are preserved.

### Design sketch (target)

```ts
// packages/shared/src/observability/observability.ts (port — no vendor name)
export interface Observability {
  captureException(error: unknown): void;
  setUser(user: { id: string; roles: string[] }): void;
  setupExpressErrorHandler(app: unknown): void;   // param type derived from Sentry sig inside the adapter
  flush(timeoutMs?: number): Promise<void>;
  logSink: StructuredLogSink;                      // injected into createLogger
}

// packages/shared/src/observability/index.ts (composition root + extension point)
export function createObservability(opts: { dsn: string; service: string }): Observability {
  if (opts.dsn === '') return NoopObservability;               // S-5
  // provider selector (AC10) — the ONLY place a new adapter is wired:
  return createSentryObservability(opts);
}
```

- Adding a provider later = new `otel.ts` implementing `Observability` + one branch here + a config value.
  No `main.ts`/`app.ts`/`lifecycle.ts`/`web` edit. That is the story's whole point — assert it in AC10 docs.
- The `setupExpressErrorHandler(app: unknown)` port method keeps `shared` free of an `express` dependency
  (ops-4 already derived the param type from Sentry's own signature — the adapter keeps doing that; the port
  widens it to `unknown` so no vendor type leaks into the interface).

### Testing standards

- Vitest, co-located `*.test.ts`, AAA, behavior-named. Mock `@sentry/node` **only inside the adapter test**;
  the logger test now injects a fake `StructuredLogSink` (no Sentry mock needed there — proof of decoupling).
- **No net coverage loss** (AC11): every ops-4 assertion (empty-DSN no-op, `enableLogs`, `service` tag, deep
  redaction, `content` drop, DAG/cycle/Date handling, flush-before-exit) must survive, retargeted through the
  port. Apply the "test that lies" rule to the logger forward and the redaction.
- Env-gate the live real-DSN smoke behind `SENTRY_DSN` presence (Standing DoD).

### Project Structure Notes

- Additive/refactor within `packages/shared/src/observability/` + `logger.ts` + the three services' wiring.
  No root `src/`, no DDL, no schema change (the optional `provider` config field is a Zod contract edit in
  `shared`, AD-6-clean). The `./observability` subpath export in `packages/shared/package.json` is unchanged.
- `docker-compose.yml`, `.env`, and `Share2Brain.config.yml`'s `observability.sentry_dsn` are untouched
  (the new `provider` key is optional with a fail-safe default).

### References

- [Source: _bmad-output/implementation-artifacts/ops-4-sentry-observability.md] — the shipped Sentry story this
  refactors; its ACs define the behavior that MUST be preserved.
- [Source: packages/shared/src/observability/sentry.ts] — vendor-named free functions + `taggedService` state;
  `beforeSend`/`beforeSendLog`/`redactValue` scrubbers to preserve verbatim.
- [Source: packages/shared/src/observability/index.ts] — barrel to convert to `createObservability`.
- [Source: packages/shared/src/logger.ts:18,88] — the `@sentry/node` import + direct `Sentry.logger[level]`
  call to remove; `LogSink` (`:47`) is the injectable precedent to mirror for the structured sink.
- [Source: packages/shared/src/notifier/index.ts:23,102,109] — the `Notifier` port / `NOOP_NOTIFIER` /
  `createNotifier` pattern to replicate.
- [Source: packages/backend/src/main.ts:8,33-37,52,65] — vendor imports + AD-8 slot + fatal handlers.
- [Source: packages/backend/src/app.ts:251-261,344-346] — `setSentryUser` middleware + `setupSentryErrorHandler`.
- [Source: packages/backend/src/lifecycle.ts:51,77] — injected `flushSentry` dep to swap to the port.
- [Source: packages/{bot,workers}/src/main.ts] — `initSentry`/`captureException`/`flushSentry` call sites.
- [Source: packages/shared/src/config/index.ts:143] — `observability` Zod block for the optional `provider`.
- [Source: docs/context/ARCHITECTURE-SPINE.md] — AD-2/AD-6/AD-8/S-5/NFR13.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (bmad-dev-story).

### Debug Log References

- Verification gate (single pass): `npm run lint && npm run test && npm run build` — lint clean;
  **1116 passed | 1 skipped** (108 test files passed, 1 skipped); build clean across all 5 packages
  (backend/bot/shared/workers `tsc --noEmit`, web `vite build`). No net loss vs the ops-4 baseline —
  the sentry adapter, logger dual-sink, scrubbing, and lifecycle-flush suites were migrated to drive
  the port (not deleted), and new port/factory/logSink assertions were added.
- AC9 sweep: `grep -rn "@sentry/node" packages --include="*.ts" | grep -v node_modules` returns
  **only** `packages/shared/src/observability/sentry.ts` and its `sentry.test.ts`.
- Empty-DSN boot smoke (AC3/AC11): a standalone script exercised the real shared build —
  `createObservability({ dsn: '' })` returns the Noop (SDK never touched, `flush()` resolves
  immediately, every method a safe no-op), and a logger wired to `obs.logSink` produced stdout
  **byte-identical** to a logger with no sink (secret redacted, below-threshold line dropped). PASS ×5.

### Completion Notes List

Behavior-preserving refactor — no feature, flow, data-model, RBAC, API-contract, or runtime-output
change. What shipped:

- **Port (AC1):** `packages/shared/src/observability/observability.ts` — vendor-neutral `Observability`
  interface (`captureException`/`setUser`/`setupExpressErrorHandler`/`flush`/`logSink`) + shared
  `NoopObservability` (mirrors `NOOP_NOTIFIER`). `StructuredLogSink` + `NOOP_STRUCTURED_SINK` live in
  `logger.ts` so the dependency direction stays observability → logger.
- **Adapter + factory (AC2/AC3/AC5/AC6):** `sentry.ts` folded the five vendor-named free functions into
  `createSentryObservability({ dsn, service }): Observability`; `taggedService` is gone (service is now
  closure state via `makeBeforeSendLog`). `createObservability` (barrel) returns Noop on empty DSN (S-5),
  else the selected adapter. `beforeSend`/`beforeSendLog`/`redactValue`/`redactAttributes`/`isPlainObject`
  preserved **verbatim** — now module-private, driven through the adapter's captured init opts in the test.
- **Logger decoupled (AC4):** `logger.ts` no longer imports any vendor SDK; `createLogger` gained a 4th
  param `structuredSink = NOOP_STRUCTURED_SINK` and forwards `(level, redactedMessage, attributes)` — the
  same redacted output as stdout, only for lines ≥ threshold. Console sink, `[service]` prefix, threshold
  gate and `redactSecrets` unchanged.
- **Services re-wired (AC7/AC8/AC9):** all three `main.ts` call `createObservability(...)` in the AD-8 slot
  and pass `observability.logSink` into `createLogger`; fatal handlers use `observability.captureException`
  + `.finally(() => observability.flush())`. Backend `app.ts` injects the port (`opts.observability ??
  NoopObservability`) and routes `setUser` + `setupExpressErrorHandler` through it; `lifecycle.ts` swapped
  the injected `flushSentry` dep for the port. No vendor name / `@sentry/node` remains outside the adapter.
- **Config selector (AC10) — IMPLEMENTED, not deferred.** Added optional `observability.provider`
  (`z.enum(['sentry']).default('sentry')`, fail-safe/backward-compatible) and threaded it from every
  service into `createObservability`. **Decision:** implementing it (rather than deferring per the YAGNI
  clause) is what makes AC10's "zero service edits to add a provider" actually TRUE — the services already
  forward whatever `provider` is configured, so a future adapter needs only (a) a new adapter file, (b) one
  `createObservability` branch + enum literal, (c) the config value. The AC2/AC7 minimal signature
  `{ dsn, service }` still type-checks (`provider?` is optional, defaults to `sentry`); the services pass
  the extra field, which is a faithful extension of AC7's illustrative call, not a deviation from its
  substance (no vendor name, AD-8 ordering intact). `Share2Brain.config.yml` documents the key (commented,
  default applies); the 3-step recipe is in `observability/index.ts`, `docs/development_guide.md`, the
  architecture spine, and `project-context.md`.
- **Real-DSN smoke (AC11): deferred** — no scratch DSN available. Satisfied by the empty-DSN boot smoke +
  the migrated redaction unit tests (adapter `beforeSend`/`beforeSendLog` still scrub `user:pass@` URLs and
  drop `content` at depth, driven through the port), exactly as AC11 permits.

### File List

- `packages/shared/src/observability/observability.ts` (new) — `Observability` port, `ObservabilityProvider`, `NoopObservability`
- `packages/shared/src/observability/sentry.ts` — folded free functions into `createSentryObservability` adapter; scrubbers preserved
- `packages/shared/src/observability/index.ts` — `createObservability` factory + provider selector + 3-step recipe; vendor-named exports removed
- `packages/shared/src/logger.ts` — removed `@sentry/node`; added `StructuredLogSink`/`NOOP_STRUCTURED_SINK` + injected sink into `createLogger`
- `packages/shared/src/config/index.ts` — optional `observability.provider` Zod enum (default `sentry`)
- `packages/backend/src/main.ts` — `createObservability` in AD-8 slot; port injected into `createApp` + `createGracefulShutdown`
- `packages/backend/src/app.ts` — `AppOptions.observability?`; `setUser`/`setupExpressErrorHandler` routed through the port
- `packages/backend/src/lifecycle.ts` — injected `flushSentry` dep replaced by the `Observability` port
- `packages/bot/src/main.ts` — `createObservability` wiring + port in fatal handlers & shutdown flush
- `packages/workers/src/main.ts` — `createObservability` wiring + port in fatal handlers & shutdown flush
- `packages/shared/src/observability/sentry.test.ts` — retargeted to the port/factory; hooks driven via captured init opts
- `packages/shared/src/logger.test.ts` — replaced `@sentry/node` mock with an injected fake `StructuredLogSink`
- `packages/backend/src/lifecycle.test.ts` — flush test now injects the port
- `Share2Brain.config.yml` — documented the optional `observability.provider` key
- `docs/context/ARCHITECTURE-SPINE.md`, `docs/development_guide.md`, `_bmad-output/project-context.md` — observability = port + adapter; single adapter file; add-a-provider recipe

## Change Log

- 2026-07-16 — Implemented ops-5: refactored observability to a vendor-neutral `Observability` port with
  Sentry as one adapter behind `createObservability`, added `NoopObservability` (S-5), decoupled the shared
  logger from `@sentry/node` via an injected `StructuredLogSink`, re-wired all three services + backend
  `app.ts`/`lifecycle.ts` through the port, added the optional `observability.provider` selector (AC10), and
  migrated the tests to drive the port. Gate green (lint / 1116 tests / build); `@sentry/node` now in exactly
  one file. Status → review.
