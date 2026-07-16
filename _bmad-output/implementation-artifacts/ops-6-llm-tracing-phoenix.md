---
baseline_commit: 41f8e8eeaea27bf0d60ffe1f8272573c36891ce6
---

# Story ops-6: LLM inference tracing via Arize Phoenix behind a separate `LlmTracing` port

Status: done

<!-- Post-roadmap operational item (ops-N convention, outside the epic sequence). -->
<!-- Approved via sprint-change-proposal-2026-07-16-llm-tracing-phoenix.md (Proposals A-D, -->
<!-- ratified individually by Borja 2026-07-16). Backlog: operational-backlog.md § P1.5. -->
<!-- Ratified decisions: D1 separate port (NOT the ops-5 Observability port — Sentry keeps -->
<!-- errors+logs, Phoenix takes LLM traces); D2 content MAY travel in spans ONLY to the -->
<!-- self-hosted, compose-internal collector (new SNF-18; SNF-9 untouched); D3 backend+workers -->
<!-- only (bot makes no LLM calls). -->

## Story

As the **maintainer of Share2Brain**,
I want **every LLM and embeddings call in `backend` and `workers` to emit OpenTelemetry traces
(spans with model, tokens, latency, prompt/completion) to a self-hosted Arize Phoenix instance,
behind a vendor-neutral `LlmTracing` port with a Noop feature flag**,
so that **I can finally see the RAG pipeline (retrieve → reason → respond), history compression,
enrichment and indexing latencies that PRD NFRs SNF-1/2/3/13/14 demand — and later swap Phoenix
for Langfuse/OpenLLMetry/Datadog by writing one adapter and flipping one config value, without
touching any service**.

**What exists today (the blind spot):** Sentry receives errors + all log lines through the ops-5
`Observability` port, but there is **zero tracing** — no tracer, no OTel dependency anywhere in
the repo. Six call sites are invisible: the RAG `reason` node and `respond` streaming
(`packages/backend/src/agent/graph.ts`), history compression (`agent/compress.ts`), query
embedding (`infrastructure/queryEmbedder.langchain.ts`), the pgvector similarity query
(`infrastructure/embeddingSearchRepository.drizzle.ts`, consumed via `ragRetriever.drizzle.ts`),
workers enrichment (`enrichment/enrich.ts`) and indexing embeddings (`indexer/indexBatch.ts:267`).

**This story is 100 % additive** — no DDL, no API-contract change, no `web` change, no edit to any
business-logic module. The `LlmTracing` port is a **deliberately separate seam** from the ops-5
`Observability` port (D1, Interface Segregation): the `Observability` port, the Sentry adapter,
the logger and `redactSecrets` are **NOT modified**.

## Acceptance Criteria

1. **Given** `packages/shared`, **when** the new tracing module is read, **then**
   `packages/shared/src/tracing/tracing.ts` exports a vendor-neutral port — **no
   Phoenix/OTel/Arize name in the type or its member names**:
   `interface LlmTracing { withSpan<T>(name: string, attributes: Record<string, unknown>, fn: () => Promise<T>): Promise<T>; flush(timeoutMs?: number): Promise<void>; shutdown(): Promise<void> }`,
   `type LlmTracingProvider = 'phoenix'` (one literal per adapter, mirroring
   `ObservabilityProvider`), and a shared `NoopLlmTracing` whose `withSpan` **just runs and
   returns `fn()`** and whose `flush`/`shutdown` resolve immediately. The port header documents
   the **never-throw contract** (mirroring `Observability`): tracing is best-effort — no method
   throws, `flush`/`shutdown` never reject, and `withSpan` is **transparent**: `fn`'s return
   value and `fn`'s thrown error always propagate unchanged; only *tracing* faults are swallowed.

2. **Given** the port, **when** the composition entry point is read, **then**
   `packages/shared/src/tracing/index.ts` exports a single factory
   `createLlmTracing(opts: { endpoint: string; service: string; provider?: LlmTracingProvider }): LlmTracing`
   (mirroring `createObservability` in `observability/index.ts`): empty `endpoint` ⇒ returns
   `NoopLlmTracing` (**S-5 — this is the feature flag**; no OTel object is ever constructed, no
   instrumentation is registered); `provider ?? 'phoenix'` selects the adapter; an unknown
   provider fails safe to `NoopLlmTracing` (consistent with the ops-5 factory and its accepted
   fail-open deferral). The module header documents the 3-step "add a provider" recipe (new
   adapter file → one factory branch + enum literal + Zod enum member → config value; zero
   service edits).

3. **Given** the Phoenix adapter (`packages/shared/src/tracing/phoenix.ts`), **when** a non-empty
   `endpoint` is supplied, **then** it builds (SDK 2.x idioms — see Dev Notes § Resolved
   versions): a `NodeTracerProvider` with `resource: resourceFromAttributes({ [SEMRESATTRS_PROJECT_NAME]: 'share2brain', 'service.name': opts.service })`
   and `spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }))]`
   (protobuf exporter — Phoenix's OTLP/HTTP collector expects protobuf on the UI port), calls
   `provider.register()` **once**, and registers OpenInference LangChain auto-instrumentation
   **once at creation**: `new LangChainInstrumentation().manuallyInstrument(CallbackManagerModule)`
   (with `CallbackManagerModule` = `import * as … from '@langchain/core/callbacks/manager'`).
   This auto-traces every `@langchain/core` model call — the `reason` node, `respond` streaming,
   `compress.ts`, and workers `enrich.ts` — with prompt/completion/token/latency attributes (D2).
   `withSpan` starts an **active** span (so it nests under any live auto-instrumented trace),
   records exceptions + error status, always ends the span, and rethrows `fn`'s error;
   `flush(timeoutMs = 2000)` / `shutdown()` wrap `provider.forceFlush()` / `provider.shutdown()`
   bounded and never reject (guard pattern from `observability/sentry.ts`).

4. **Given** the vendor isolation (AD-2, grep-green rule), **when** the tree is swept, **then**
   `@opentelemetry/*` and `@arizeai/*` are imported **only** inside `packages/shared/src/tracing/`
   (`phoenix.ts` + its test), verified with
   `grep -rn "@opentelemetry\|@arizeai" packages --include=*.ts | grep -v node_modules`. The new
   deps live in `packages/shared/package.json` **only**. `packages/shared/package.json` gains a
   `"./tracing"` subpath export (same shape as `"./observability"`), and the tracing module is
   **NOT re-exported from the root barrel** (it pulls OTel + LangChain transitively — same
   containment rule as `providers/index.ts`).

5. **Given** the ESLint guard, **when** `eslint.config.js` is read, **then** `@opentelemetry/*`
   and `@arizeai/*` (as `['@opentelemetry', '@opentelemetry/**', '@arizeai', '@arizeai/**']`
   pattern groups) are banned in `packages/{bot,backend,workers,web}` with a message pointing to
   `@share2brain/shared/tracing` — **folded into the EXISTING per-package `no-restricted-imports`
   objects** (`banSiblingServices('bot'/'workers')`, `banBackendLegacyImports`,
   `banNonBrowserSafeSharedInWeb`), NOT appended as new flat-config objects: a later object
   setting the same rule for the same files **clobbers** the whole option (footgun documented in
   the file itself at lines 22-24/43-44 — adding a separate object would silently drop AD-2's
   sibling-import ban).

6. **Given** the config contract (AD-6, Zod in `packages/shared/src/config/index.ts`), **when**
   it is read, **then** the `observability` block gains an **optional** `tracing` sub-block
   (streams precedent — the block itself has NO `.default()`; absent block ⇒ consumers resolve
   `endpoint` to `''` ⇒ Noop):
   `tracing: z.object({ provider: z.enum(['phoenix']).default('phoenix'), endpoint: z.string().refine((v) => v === '' || URL.canParse(v), { message: 'observability.tracing.endpoint must be empty or a valid URL' }) }).optional()`.
   `Share2Brain.config.yml` + `Share2Brain.config.yml.example` gain the block
   (`endpoint: "${PHOENIX_ENDPOINT}"`), `.env.example` gains `PHOENIX_ENDPOINT=` with the "leave
   empty to disable / no inline comment after empty value" style of `SENTRY_DSN`. **Config-test
   coverage:** absent block OK; empty endpoint OK; malformed endpoint rejected; provider defaults
   to `'phoenix'`.

7. **Given** `docker-compose.yml`, **when** it is read, **then** (a) a new 8th service `phoenix`
   exists: `image: arizephoenix/phoenix:18.0.0` (pinned exact tag, never `:latest`), `mem_limit`,
   `PHOENIX_WORKING_DIR: /mnt/data` + named volume `phoenixdata:/mnt/data`, attached to the
   `data` network **only**, **no public port** — at most a dev-only loopback binding
   `127.0.0.1:6006:6006` (same pattern as `postgres`/`redis`; operator access via SSH tunnel;
   never proxied by nginx — SNF-18/D2); app services do **NOT** `depends_on: phoenix` (tracing is
   best-effort; boot must never wait on the collector); and (b) **all three** app services'
   `environment:` blocks gain `PHOENIX_ENDPOINT: ${PHOENIX_ENDPOINT:-}` — **including `bot`**:
   the bot parses the same YAML and `interpolateTree` aborts `loadConfig` on any unset `${VAR}`
   (footgun documented at `docker-compose.yml:16-24`).

8. **Given** the two service entrypoints in scope (D3), **when**
   `packages/{backend,workers}/src/main.ts` are read, **then** each calls
   `createLlmTracing({ endpoint: config.observability.tracing?.endpoint ?? '', service: '<svc>', provider: config.observability.tracing?.provider })`
   in the AD-8 slot (right after `createObservability`/`createLogger`, before any network I/O and
   before any LangChain model is constructed), and `shutdown()` is wired into graceful shutdown:
   backend threads the port into `createGracefulShutdown({ …, llmTracing })` whose deps gain
   `llmTracing?: Pick<LlmTracing, 'shutdown'>` defaulting to `NoopLlmTracing` (same pattern as
   `observability`), with `await llmTracing.shutdown()` in the drain `finally` beside
   `observability.flush()`; workers add the same `await` in their inline shutdown `finally`
   (`main.ts:190-195`). The fatal `uncaughtException`/`unhandledRejection` handlers chain
   `.finally(() => llmTracing.flush())` beside the existing observability flush. **`packages/bot`
   is untouched** — `grep -rn "tracing\|LlmTracing" packages/bot/src` returns nothing.

9. **Given** the manual spans (the calls auto-instrumentation cannot see), **when** the wiring is
   read, **then** they are added **only at composition roots via DI decorators** — zero edits to
   `graph.ts`, `compress.ts`, `queryEmbedder.langchain.ts`, `ragRetriever.drizzle.ts`,
   `embeddingSearchRepository.drizzle.ts`, `enrich.ts`, or `indexBatch.ts`:
   - **backend:** `createApp` opts gain `llmTracing?: LlmTracing` (default `NoopLlmTracing`,
     matching `observability`); inside `app.ts`, before building the retriever, the injected
     `queryEmbedder` is wrapped so `embedQuery` runs inside
     `withSpan('embeddings.embed_query', …)`, and the `embeddingSearch` repo is wrapped so
     `searchByEmbedding` runs inside
     `withSpan('pgvector.similarity_search', { 'db.top_k': topK, 'rbac.allowed_channels.count': allowedChannelIds.length }, …)`.
     Span names are fixed as written; attributes are illustrative — use whatever the wrapper
     already has in scope (the decorated method's own parameters), and carry **counts and
     parameters only, never message content and never the channel-id list itself** — content
     flows only through the OpenInference auto spans (D2).
   - **workers:** in `main.ts`, the `embedder` passed to `runIndexer`/`runSync` is wrapped so
     `embedDocuments` runs inside
     `withSpan('embeddings.embed_documents', { 'embedding.batch_size': texts.length }, …)`.
   - The wrapper helpers may live beside the composition roots or as a tiny generic decorator in
     `shared/src/tracing/` — dev's choice; the port method is the only tracing API they use.

10. **Given** the enrichment LLM (SCP handoff item), **when** coverage is verified, **then** the
    story confirms that `enrich.ts`'s structural `EnrichmentChatModel.invoke` /
    `.withStructuredOutput(…).invoke` calls — satisfied at runtime by the real `BaseChatModel`
    from `createChatModel` — are captured by the OpenInference LangChain instrumentation (they go
    through `@langchain/core`'s CallbackManager). **Verification:** the live smoke (AC12) shows
    enrichment spans in Phoenix, or — if auto-capture provably misses them — the fallback is a
    `withSpan('enrichment.llm', …)` wrap of `enrichModel` in workers `main.ts` (composition root,
    still zero business-logic edits); record which path was taken in Completion Notes.

11. **Given** an **empty** `endpoint` (or absent `tracing` block), **when** any service boots,
    **then** behavior is byte-identical to today: `NoopLlmTracing` everywhere, no OTel object is
    constructed, no instrumentation patch is applied, zero tracing network calls. The factory
    stays **synchronous** (mirroring `createObservability` — ESM dynamic import would force an
    async factory, don't do it): `index.ts` statically imports the adapter like
    `observability/index.ts` does, and the story verifies the adapter module has **zero
    import-time side effects** (all OTel/OpenInference construction and registration happens
    inside `createPhoenixLlmTracing`, never at module top level).
    Verified by unit tests (factory returns the shared Noop; adapter constructor never invoked)
    and a boot smoke of backend + workers with the block absent.

12. **Given** a running stack with `PHOENIX_ENDPOINT=http://phoenix:6006`, **when** the live
    smoke runs (env-gated like the ops-4/ops-5 real-DSN smoke; requires `docker compose up`),
    **then**: one chat turn produces a trace in Phoenix showing the retrieve phase
    (`embeddings.embed_query` + `pgvector.similarity_search` spans) → `reason` (LLM span with
    prompt/completion/tokens/latency) → `respond`; one indexed URL produces workers enrichment +
    `embeddings.embed_documents` spans. If no live environment is available at implementation
    time, the smoke is recorded as deferred and the ACs are satisfied by the mocked adapter tests
    + the Noop boot smoke (ops-5 precedent) — but the trace-shape assertions stay in this AC for
    the eventual run.

13. **Given** the SSE hot path (SNF-3: first chunk < 100 ms), **when** tracing is active,
    **then** no synchronous export happens per token: spans are batch-exported asynchronously
    (`BatchSpanProcessor` — never `SimpleSpanProcessor`), `withSpan` wraps whole operations (one
    span per embed/search call, never per streamed chunk), and the story's verification includes
    an explicit check that `/api/chat` first-chunk latency is not degraded (compare with tracing
    on vs. off in the live smoke; if the live smoke is deferred, assert the code path: no
    span-per-token, batch processor only).

14. **Given** the docs-sync that rides this story (SCP Proposals C + D — approved old→new
    wording in the SCP §4), **when** the docs are read, **then**:
    - **PRD** (`docs/context/PRD.md`): §11.2 gains the **SNF-18** row (LLM inference tracing —
      full approved text in SCP Proposal C.1; table at lines ~1339-1357); §6.2 Observabilidad
      stack row (line ~853) appends the Phoenix/OTel/OpenInference mention; §4.6 config example
      (~line 453) gains the `observability.tracing` block; §10.2's stale **Pino snippet**
      (~lines 1302-1312) is replaced with the real `@share2brain/shared/logger` dual-sink
      description (§6.2 already states Pino was never adopted).
    - **TECHNICAL-DESIGN** (`docs/context/TECHNICAL-DESIGN.md`): §17 Deferred Observabilidad row
      (line ~1212) updated to the SCP Proposal D.1 wording (errors+logs → Sentry via
      `Observability`; LLM traces → Phoenix via `LlmTracing`); §13 YAML example (~line 935) gains
      the `tracing` block; §15 stack table (~line 1141) gains Arize Phoenix +
      OpenTelemetry/OpenInference rows.
    - **`docs/context/ARCHITECTURE-SPINE.md`** observability note + **`docs/development_guide.md`**
      + **`_bmad-output/project-context.md`** gain the `LlmTracing` port rule (separate port from
      `Observability`; OTel/Arize only in `packages/shared/src/tracing/phoenix.ts`; empty
      endpoint ⇒ Noop; content in spans only to self-hosted collectors — SNF-18), following the
      ops-5 documentation precedent. English for all docs except the two Spanish-language context
      docs (PRD/TD), which stay in their existing language.

15. **Given** the mandatory verification gate, **when** run by the agent, **then**
    `npm run lint && npm run test && npm run build` is green with output pasted, with no net loss
    of test count vs. the ops-5 baseline (1123 passed | 1 skipped), plus:
    `grep -rn "@opentelemetry\|@arizeai" packages --include=*.ts | grep -v node_modules` hits only
    `packages/shared/src/tracing/`; `npm ls @langchain/core` resolves to a **single** copy
    (the instrumentation patches one `CallbackManagerModule` instance — a duplicated
    `@langchain/core` would silently produce no traces); the empty-endpoint boot smoke passes;
    Sentry/`Observability`/logger behavior unchanged (their suites untouched and green).

## Tasks / Subtasks

> Inner-first per AD-1: port → adapter + factory → config contract → compose/env → service
> wiring + manual spans → lint guard + tests → docs-sync. Keep the branch un-pushed until the
> whole gate is green. The `Observability` port, Sentry adapter, logger and `redactSecrets` are
> read-only in this story.

- [x] **Task 0 — Branch & baseline** (AC: all)
  - [x] Verify `main` is current & clean, then `git switch -c feat/ops-6-llm-tracing-phoenix`.
  - [x] Re-read the files being modified end-to-end (Dev Notes § Current state) before editing.

- [x] **Task 1 — shared: `LlmTracing` port + Noop + config contract** (AC: 1, 6) — commit
      `feat(shared): add vendor-neutral LlmTracing port + observability.tracing config`
  - [x] New `packages/shared/src/tracing/tracing.ts`: `LlmTracing` interface, `LlmTracingProvider`,
        `NoopLlmTracing` (mirror `observability/observability.ts` file layout — port + Noop
        together). Document the never-throw + `withSpan`-transparency contract in the header.
  - [x] `packages/shared/src/config/index.ts`: add the optional `tracing` sub-block to
        `observability` (AC6 exact schema). Extend `config/index.test.ts` with the four cases.
  - [x] `packages/shared/package.json`: add the `"./tracing"` subpath export. Do NOT touch the
        root barrel.

- [x] **Task 2 — shared: Phoenix adapter + `createLlmTracing` factory** (AC: 2, 3, 4) — commit
      `feat(shared): Phoenix LlmTracing adapter (OTel + OpenInference) behind createLlmTracing`
  - [x] Add deps to `packages/shared/package.json` (pinned ranges, Dev Notes § Resolved versions):
        `@opentelemetry/api ^1.9.1`, `@opentelemetry/sdk-trace-node ^2.9.0`,
        `@opentelemetry/resources ^2.9.0`, `@opentelemetry/exporter-trace-otlp-proto ^0.220.0`,
        `@arizeai/openinference-instrumentation-langchain ^4.0.14`,
        `@arizeai/openinference-semantic-conventions ^2.5.0`.
  - [x] New `packages/shared/src/tracing/phoenix.ts` — the ONLY file importing those packages:
        `createPhoenixLlmTracing(opts: { endpoint: string; service: string }): LlmTracing` per
        AC3 (SDK 2.x: `resourceFromAttributes`, `spanProcessors` in the constructor —
        **`new Resource(…)` and `addSpanProcessor` no longer exist**). `withSpan` via
        `tracer.startActiveSpan` (active context → nests under auto-instrumented traces);
        guard every tracing-side call (adopt `guard()` from `sentry.ts` as the model); quiet the
        OTel diag logger (exporter failures must not spam stdout — one-line signal at most).
  - [x] New `packages/shared/src/tracing/index.ts`: `createLlmTracing` factory per AC2 (empty
        endpoint ⇒ Noop before provider dispatch; sync factory, static adapter import, adapter
        module side-effect-free per AC11) + 3-step recipe header + re-exports (`LlmTracing`,
        `LlmTracingProvider`, `NoopLlmTracing`).
  - [x] New `packages/shared/src/tracing/phoenix.test.ts` (mirror `sentry.test.ts` structure):
        mock `@opentelemetry/*` + `@arizeai/*`; assert factory S-5/Noop/unknown-provider
        branches; provider construction (resource attrs, exporter URL `${endpoint}/v1/traces`,
        BatchSpanProcessor); `manuallyInstrument` called exactly once with the CallbackManager
        module; `withSpan` returns `fn`'s value, rethrows `fn`'s error with exception recorded +
        span ended, and never throws when the tracer itself fails ("test that lies" rule on the
        transparency contract); `flush`/`shutdown` bounded + never reject.

- [x] **Task 3 — compose + env + config files** (AC: 7, and the config-file half of 6) — commit
      `feat(repo): phoenix compose service + PHOENIX_ENDPOINT wiring`
  - [x] `docker-compose.yml`: add the `phoenix` service per AC7 (copy the `redis` service shape:
        pinned image `arizephoenix/phoenix:18.0.0`, `mem_limit`, named volume `phoenixdata`,
        `data` network, loopback-only dev port). No `depends_on` from app services. Add
        `PHOENIX_ENDPOINT: ${PHOENIX_ENDPOINT:-}` to backend, bot AND workers env blocks.
        Mirror in `docker-compose.prod.yml` if it declares its own env blocks (read it first).
  - [x] `.env.example`: `PHOENIX_ENDPOINT=` (+ "set to http://phoenix:6006 to enable" comment on
        its own line — never inline after the empty value).
  - [x] `Share2Brain.config.yml` + `Share2Brain.config.yml.example`: add the
        `observability.tracing` block per AC6.

- [x] **Task 4 — backend wiring + manual spans** (AC: 8, 9, 13) — commit
      `feat(backend): wire LlmTracing port + embed/pgvector spans via DI`
  - [x] `packages/backend/src/main.ts`: `createLlmTracing(…)` in the AD-8 slot (after
        `createLogger`, before `requireEnv`/DB/Redis and before `createLangchainChatModel`/
        `createLangchainQueryEmbedder`); thread into `createApp({ …, llmTracing })` and
        `createGracefulShutdown({ …, llmTracing })`; add `.finally(() => llmTracing.flush())` to
        both fatal handlers.
  - [x] `packages/backend/src/app.ts`: `AppOptions.llmTracing?: LlmTracing` (default
        `NoopLlmTracing`); wrap `queryEmbedder` + `embeddingSearch` with `withSpan` decorators
        before `createDrizzleRagRetriever` per AC9 (counts/params only in attributes).
  - [x] `packages/backend/src/lifecycle.ts`: `GracefulShutdownDeps.llmTracing?: Pick<LlmTracing, 'shutdown'>`
        default `NoopLlmTracing`; `await llmTracing.shutdown()` in the drain `finally` beside
        `observability.flush()`. Extend `lifecycle.test.ts`: shutdown runs after drain, and a
        rejecting `shutdown()` cannot block exit (the port contract says it never rejects, but
        the lifecycle should still `await` it inside the existing bounded/`finally` structure).

- [x] **Task 5 — workers wiring + manual spans** (AC: 8, 9, 10) — commit
      `feat(workers): wire LlmTracing port + embedDocuments span`
  - [x] `packages/workers/src/main.ts`: `createLlmTracing(…)` in the AD-8 slot; wrap `embedder`
        (`embedDocuments` → `withSpan`) before `runIndexer`/`runSync`; `await llmTracing.shutdown()`
        in the inline shutdown `finally` (`:190-195`); `.finally(() => llmTracing.flush())` on the
        fatal handlers. `enrichModel` stays unwrapped unless AC10's verification demands the
        fallback.
  - [x] Confirm `packages/bot/src/main.ts` untouched (AC8 grep).

- [x] **Task 6 — ESLint guard + isolation sweep** (AC: 4, 5) — commit
      `chore(repo): lint-ban @opentelemetry/@arizeai outside shared`
  - [x] `eslint.config.js`: fold the `@opentelemetry`/`@arizeai` pattern ban into the four
        existing `no-restricted-imports` option objects (bot, backend, workers, web) — read the
        clobber warning in the file first; do NOT add new flat-config objects for the same files.
  - [x] Run the AC4 grep + `npm ls @langchain/core` dedupe check; paste both outputs.

- [x] **Task 7 — docs-sync + verification gate** (AC: 12, 14, 15) — commit
      `docs(repo): SNF-18 + LlmTracing port docs; ops-6 docs-sync`
  - [x] Apply the PRD edits (SNF-18 row, §6.2, §4.6, §10.2 Pino fix) and TD edits (§13, §15, §17)
        using the approved old→new wording in SCP §4 Proposals C/D.
  - [x] Update `ARCHITECTURE-SPINE.md`, `development_guide.md`, `project-context.md` per AC14.
  - [x] Run the gate: `npm run lint && npm run test && npm run build` — paste output. Run the
        empty-endpoint boot smoke (AC11). Run the live Phoenix smoke (AC12/AC13) if a compose
        stack is available; otherwise record it deferred with the exact commands to run later.

## Dev Notes

### Resolved versions (researched 2026-07-16 — do not silently bump)

| What | Pin | Notes |
|---|---|---|
| Phoenix Docker image | `arizephoenix/phoenix:18.0.0` | Released 2026-07-14. Port 6006 = UI **and** OTLP/HTTP collector; 4317 = OTLP gRPC. Persistence: `PHOENIX_WORKING_DIR=/mnt/data` + volume (SQLite; Postgres optional via `PHOENIX_SQL_DATABASE_URL`, not needed for MVP). Auth available later via `PHOENIX_ENABLE_AUTH` + `PHOENIX_SECRET` — not required while compose-internal. |
| `@arizeai/openinference-instrumentation-langchain` | `^4.0.14` | Peer `@langchain/core ^1.0.0 \|\| ^0.3.0 \|\| ^0.2.0` → **our 1.2.1 is supported** ("≥4.0.0 supports LangChain 1.0 and above"). Registration is **manual only**: `new LangChainInstrumentation().manuallyInstrument(CallbackManagerModule)` — LangChain has no patchable module structure, so there is no auto-hook. |
| `@arizeai/openinference-semantic-conventions` | `^2.5.0` | Exports `SEMRESATTRS_PROJECT_NAME` (`openinference.project.name`) — how Phoenix groups traces into a project; there is no server-side project env var. |
| `@opentelemetry/api` | `^1.9.1` | API stays 1.x; SDK is 2.x. |
| `@opentelemetry/sdk-trace-node`, `@opentelemetry/resources` | `^2.9.0` | **SDK 2.x breaking changes**: `Resource` class removed → `resourceFromAttributes()`; `addSpanProcessor()` removed → `spanProcessors: […]` in the ctor. The OpenInference README still shows the pre-2.x pattern — it will not compile; use the AC3 shape. Node 24 fully supported. |
| `@opentelemetry/exporter-trace-otlp-proto` | `^0.220.0` | Matched set with SDK 2.9.0 (Arize's own `@arizeai/phoenix-otel` pins this combo). Phoenix expects **protobuf** on `http://phoenix:6006/v1/traces` — use `-proto`, not `-http` (JSON). |

- **LangGraph 1.4 coverage confirmed:** LangGraph.js rides `@langchain/core` callbacks; the
  instrumentation patches `@langchain/core/callbacks/manager`, so graph-node LLM calls (reason,
  compress) and workers enrichment are captured automatically. Requirement: instrumentation is
  registered **before** any chain runs (our AD-8 boot slot guarantees this) and the workspace
  resolves a **single** `@langchain/core` copy (a second copy = unpatched CallbackManager =
  silent no-traces; gate check `npm ls @langchain/core`).
- **Considered and rejected:** `@arizeai/phoenix-otel` (`register()` convenience wrapper) — it
  hides the provider/exporter wiring the adapter must own to stay a *vendor-neutral port's*
  adapter, and adds a dependency for ~15 lines of code. Build on raw OTel per AC3.

### Current state of the files being modified (read before touching)

- **`packages/shared/src/observability/`** — the pattern to replicate, file-for-file: port + Noop
  together in `observability.ts` (interface at `:28-34`, `NoopObservability` at `:42-48`,
  `ObservabilityProvider = 'sentry'` at `:13`); factory in `index.ts:35-50` (S-5 empty-check →
  provider dispatch → fail-safe Noop, 3-step recipe in the header); adapter `sentry.ts` with the
  module-private `guard(fn, onErrorLabel?)` (`:167-180`) — hot-path swallows silently, once-per-boot
  wiring degrades with one `console.error`; constructor deliberately unguarded (bad config fails
  loud, AD-8); `flush` wraps the SDK close bounded (`:240-246`). **This module is read-only in
  ops-6** — the tracing module is a sibling, not an extension.
- **`packages/shared/src/config/index.ts`** — `observability` block at `:143-156` (the `refine`
  URL-or-empty idiom to copy for `endpoint`). Optional-block precedent: `streams` (`:245-249`) —
  block `.optional()`, no `.default()` on the block, consumers resolve defaults. Env interpolation
  (`:330-361`): `interpolateTree` walks the **parsed YAML** and substitutes `${VAR}` on string
  leaves; **an unset var anywhere aborts every service that mounts the config** — hence AC7(b).
  `loadConfig` at `:384-412`; add `tracing` cases to `config/index.test.ts` (fixture-YAML style,
  see the S-5 sentry_dsn test at `:397`).
- **`packages/backend/src/main.ts`** — boot order: `loadConfig` (`:32`) → `createObservability`
  (`:37-41`) → `createLogger` (`:42-47`) → `createNotifier` (`:50`) → fatal handlers (`:62-84`) →
  env/DB/Redis (`:86-97`) → `createLangchainQueryEmbedder` (`:140`) → `createLangchainChatModel`
  (`:145`) → `createApp` (`:147-194`) → `listen` (`:196`) → `createGracefulShutdown` (`:203-206`).
  `createLlmTracing` slots right after `createLogger`; it MUST precede the model factories so the
  CallbackManager patch is in place before any model object exists.
- **`packages/backend/src/app.ts`** — `createApp(db, redis, opts)`; the DI precedent to copy is
  `opts.observability ?? NoopObservability`. RAG assembly at `:323-339`:
  `createDrizzleRagRetriever({ embedder: queryEmbedder, searchRepo: embeddingSearch, logger })` →
  `createRagAgent({ chatModel, ragRetriever, memoryWindow })` → `createChatService`. Wrap
  `queryEmbedder` and `embeddingSearch` here (AC9) — the retriever and everything below stays
  untouched.
- **`packages/backend/src/lifecycle.ts`** — `GracefulShutdownDeps` at `:75-78` already takes
  `observability?: Pick<Observability, 'flush'>` defaulting to `NoopObservability`; drain
  `finally` at `:130-135` (`await observability.flush(); exit(0)`). Add `llmTracing` the same way.
  `lifecycle.test.ts` exists — extend it.
- **`packages/workers/src/main.ts`** — same head (`:83-101`); fatal handlers `:109-131`; LLM deps
  built at `:217` (`createEmbeddingsModel` → `embedder`) and `:222` (`createChatModel` →
  `enrichModel`), injected into `runIndexer` (`:241-250`) / `runSync` (`:254-264`); inline
  shutdown closure `:154-197` with `finally { await observability.flush(); process.exit(0) }` at
  `:190-195`. Wrap `embedder` between construction and injection.
- **`packages/backend/src/agent/graph.ts` / `compress.ts`** — business logic; **do not edit**.
  The graph consumes the vendor-neutral `ChatModel` port (stream-only — "do NOT widen it to
  invoke()"); the real LangChain model lives behind `infrastructure/chatModel.langchain.ts`
  (`createLangchainChatModel`, `:67`), so auto-instrumentation sees every chat/compress call at
  the `@langchain/core` layer without any code change.
- **`packages/workers/src/enrichment/enrich.ts`** — `EnrichmentChatModel` structural interface at
  `:49-54`; `enrich(model, input, signal?)` at `:207-211` (structured-output invoke + plain-invoke
  fallback). At runtime this is a real `BaseChatModel` → CallbackManager → auto-traced (AC10
  verify). **Do not edit.**
- **`packages/workers/src/indexer/indexBatch.ts`** — `IndexBatchDeps` (`:41-62`) receives
  `embedder`; the embed call is `:267` (`await embedder.embedDocuments(texts)`). Wrapping the
  injected `embedder` in `main.ts` covers it. **Do not edit.**
- **`docker-compose.yml`** — 7 services, networks `frontend`/`data`, volumes `pgdata`/`redisdata`;
  every image pinned; per-service `environment:` blocks (no `env_file`); the `redis` service
  (`:54-76`) is the internal-service template (mem_limit, loopback dev port, named volume,
  healthcheck, `data` network). NOTE at `:16-24`: every service mounting the config must receive
  every `${VAR}` it references. `SENTRY_DSN: ${SENTRY_DSN:-}` appears at `:125/:170/:211` — copy
  that default-empty idiom for `PHOENIX_ENDPOINT`. A healthcheck on `phoenix` is optional — only
  add one if the pinned image ships a shell + curl/wget (verify; the `-nonroot` variant may not).
- **`eslint.config.js`** — flat config; `SIBLING_IMPORT_BAN` (`:9-12`), `LANGCHAIN_LEGACY_BAN`
  (`:25-29`, folded into `banBackendLegacyImports`), web import guard (`:48-68`). **Clobber
  footgun** (`:22-24`, `:43-44`): two flat-config objects setting `no-restricted-imports` for the
  same files — the later one silently replaces the earlier. Fold, never append (AC5).
- **`packages/shared/package.json`** — deps include `@langchain/core ^1.2.1`,
  `@sentry/node ^9.41.0`, `zod ^4.4.0`; subpath exports map source `.ts` directly — copy the
  `"./observability"` entry shape for `"./tracing"`.

### Architecture constraints (guardrails)

- **AD-2** — OTel/Arize vendor SDKs live in `packages/shared` only, inside
  `src/tracing/phoenix.ts` (single adapter file, grep-green rule mirroring `@sentry/node`).
  Services depend on the `LlmTracing` **port**, never on `@opentelemetry/*`/`@arizeai/*`, never
  on each other.
- **AD-6** — the `observability.tracing` config contract is Zod in `shared`; no service defines
  it locally.
- **AD-8** — `createLlmTracing` runs right after `loadConfig()`/`createObservability`, before any
  network I/O and before any LangChain model is constructed, in backend + workers `main.ts`.
- **S-5 precedent** — empty `endpoint` (or absent block) ⇒ `NoopLlmTracing`; nothing vendor-side
  is constructed or imported. This IS the feature flag Borja required — local dev with tracing
  off has zero side effects.
- **D1 (ratified)** — separate port. The ops-5 `Observability` port, Sentry adapter, logger and
  `redactSecrets` are NOT modified. Sentry keeps errors + logs; Phoenix takes traces. Do not
  merge the seams "for convenience".
- **D2 / SNF-18 / SNF-9** — prompts/completions/retrieved fragments MAY appear in spans because
  the collector is self-hosted inside the Compose network. The never-content-to-Sentry rule
  (SNF-9) stays fully intact — nothing from tracing flows to the `Observability` port. Manual
  `withSpan` attributes still carry only counts/params (AC9) — content enters spans only via the
  OpenInference auto-instrumentation. Phoenix is never publicly exposed (no nginx route, no
  public port).
- **D3 (ratified)** — backend + workers only. Bot has no LLM calls; it gets the compose env var
  (AC7b, interpolation footgun) but zero code.
- **Never-throw contract (ops-5 precedent)** — no port method throws; `flush`/`shutdown` never
  reject; `withSpan` is transparent (the wrapped operation's result/error always propagate; a
  tracing fault must never fail a chat turn or an indexing batch). Adopt the `guard()` model from
  `sentry.ts`, including its rule "constructor fails loud, runtime swallows".
- **No globals in business code** — the only global side effects (OTel `provider.register()`,
  CallbackManager patch) live inside the Phoenix adapter, which services obtain via DI. Business
  modules see nothing.
- **project-context §workflow** — branch first; conventional commits (scopes
  `shared|backend|workers|repo`); the AGENT runs the verification gate and pastes output; English
  everywhere in code/comments/commits.

### Design sketch (target)

```ts
// packages/shared/src/tracing/tracing.ts (port + Noop — no vendor name anywhere)
export interface LlmTracing {
  /** Wrap an operation in a span. TRANSPARENT: fn's result/error always propagate;
   *  tracing faults are swallowed. Attributes: counts/params only at call sites —
   *  content belongs to the auto-instrumentation layer (SNF-18). */
  withSpan<T>(name: string, attributes: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
  flush(timeoutMs?: number): Promise<void>;   // never rejects
  shutdown(): Promise<void>;                  // never rejects; wired into graceful shutdown
}
export type LlmTracingProvider = 'phoenix';
export const NoopLlmTracing: LlmTracing = {
  withSpan: (_name, _attrs, fn) => fn(),
  flush: async () => undefined,
  shutdown: async () => undefined,
};

// packages/shared/src/tracing/index.ts (composition root + extension point)
export function createLlmTracing(opts: {
  endpoint: string; service: string; provider?: LlmTracingProvider;
}): LlmTracing {
  if (opts.endpoint === '') return NoopLlmTracing;          // S-5 — the feature flag
  const provider = opts.provider ?? 'phoenix';
  if (provider === 'phoenix') return createPhoenixLlmTracing(opts);
  return NoopLlmTracing;                                     // fail-safe (ops-5 precedent)
}

// packages/shared/src/tracing/phoenix.ts (ONLY file importing @opentelemetry/@arizeai)
// SDK 2.x: resourceFromAttributes + spanProcessors ctor; OTLP *proto* → `${endpoint}/v1/traces`;
// new LangChainInstrumentation().manuallyInstrument(CallbackManagerModule) once;
// withSpan via tracer.startActiveSpan (nests under auto-instrumented traces).
```

```yaml
# docker-compose.yml (shape only — copy redis's full pattern)
  phoenix:
    image: arizephoenix/phoenix:18.0.0
    mem_limit: 512m
    environment:
      PHOENIX_WORKING_DIR: /mnt/data
    ports:
      - "127.0.0.1:6006:6006"   # dev/tunnel only — NEVER public, never behind nginx (SNF-18)
    volumes:
      - phoenixdata:/mnt/data
    networks:
      - data
```

### Testing standards

- Vitest, co-located `*.test.ts`, AAA, behavior-named; root `unit` project picks up
  `packages/*/src/**/*.test.ts` (node env). Mirror `sentry.test.ts`'s approach: `vi.mock` the
  vendor modules with only the surface the adapter touches; drive everything through the
  port/factory, never through adapter internals.
- **Non-negotiable assertions:** S-5 (empty endpoint → shared Noop instance, vendor constructor
  never called); `withSpan` transparency both ways (value returned; error rethrown with span
  error-status recorded; "test that lies" — removing the rethrow/return must fail); never-throw
  under a throwing tracer/exporter; `manuallyInstrument` exactly once; exporter URL
  `${endpoint}/v1/traces`; config block absent/empty/malformed/default-provider.
- **main.ts has no test harness** (verified — no service main.ts is imported by any test);
  testability lives in the factory + adapter + lifecycle tests. Do not invent a main.ts test.
- Env-gate the live Phoenix smoke (AC12) behind the compose stack being up; record deferred
  otherwise (ops-4/ops-5 precedent).
- No net test-count loss vs. 1123 passed | 1 skipped (ops-5 baseline); the observability/logger
  suites must pass untouched.

### Project Structure Notes

- Purely additive: new `packages/shared/src/tracing/` (3 source files + 1 test, mirroring
  `observability/`), new `"./tracing"` subpath export, config sub-block, compose service +
  volume, wiring edits confined to `packages/{backend,workers}/src/main.ts`,
  `packages/backend/src/{app.ts,lifecycle.ts}`, `eslint.config.js`, env/config examples, docs.
- **Not** re-exported from the shared root barrel (pulls OTel + LangChain transitively — same
  rule as `providers`; web/bot must stay free of it). Web's ESLint guard already restricts it to
  `/schemas` + `/types/events`, and AC5 adds the vendor ban everywhere else.
- No root `src/`, no DDL, no Zod API-schema change, no `web` change, no bot change.

### Previous story intelligence (ops-5 — the pattern source)

- ops-5 shipped the exact architecture this story replicates: port+Noop in one file, factory in
  `index.ts`, single vendor adapter file, provider enum + Zod enum, `guard()` never-throw
  wrapper, DI with inert Noop defaults, 3-step extension recipe in the header. Copy the shapes;
  don't re-derive them.
- **Review findings to inherit (accepted deferrals — keep the new port consistent, don't "fix"
  unilaterally):** (a) unknown provider falls through to Noop silently (fail-open accepted;
  mirror it); (b) the TS provider union and the Zod enum are hand-synced two sources of truth —
  keep the sync comment both sides; (c) DI defaults are inert Noops by design (a mis-wired caller
  silently loses tracing — acceptable, same as observability).
- **Review patches to apply from day one** (they were retrofitted in ops-5): document the
  never-throw contract in the port header; guard hot-path methods, let the constructor fail loud;
  run any degraded-path `console.error` message through nothing sensitive (tracing endpoints are
  not secrets, but keep the one-line-signal discipline); write the never-throw tests up front.
- Verification-gate discipline: single commit-sliced tasks, gate run once green at the end,
  outputs pasted into Dev Agent Record (ops-5 Debug Log is the format example).

### Git intelligence

- Recent history is the ops-4 → ops-5 observability arc (`1a60571` refactor, `f101f2e` docs,
  `63317cb` chore, merged as PR #94 `41f8e8e` — this story's baseline). Commit style to follow:
  `feat(shared): …`, `feat(backend,workers): …`, `docs(repo): …`, one commit per task slice, PR
  from `feat/ops-6-llm-tracing-phoenix`, never auto-merge.

### References

- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-16-llm-tracing-phoenix.md] —
  the approved SCP: D1/D2/D3 decisions, Proposals A (port design), B (config+compose), C (PRD
  edits, approved old→new wording), D (TD edits), §5 success criteria.
- [Source: _bmad-output/implementation-artifacts/operational-backlog.md#P1.5] — backlog item + green-when.
- [Source: _bmad-output/implementation-artifacts/ops-5-observability-port-adapter.md] — the
  pattern story: port/adapter/Noop/factory shapes, guard(), review findings inherited above.
- [Source: packages/shared/src/observability/observability.ts:13,28-48] — port + Noop + provider
  type to mirror.
- [Source: packages/shared/src/observability/index.ts:35-50] — factory shape + 3-step recipe.
- [Source: packages/shared/src/observability/sentry.ts:167-180,240-246] — guard() + bounded flush.
- [Source: packages/shared/src/config/index.ts:143-156,245-249,330-361,384-412] — observability
  block, streams optional-block precedent, interpolateTree, loadConfig.
- [Source: packages/backend/src/main.ts:32-50,62-84,140-147,203-206] — AD-8 slot, fatal handlers,
  model factories, shutdown wiring.
- [Source: packages/backend/src/app.ts:323-339] — RAG assembly / decorator injection point.
- [Source: packages/backend/src/lifecycle.ts:75-78,130-135] — deps + drain finally.
- [Source: packages/workers/src/main.ts:83-101,109-131,154-197,217-264] — head, handlers,
  shutdown closure, embedder/enrichModel construction + injection.
- [Source: packages/workers/src/enrichment/enrich.ts:49-54,207-211] — EnrichmentChatModel (AC10).
- [Source: packages/workers/src/indexer/indexBatch.ts:41-62,267] — embedDocuments call site.
- [Source: docker-compose.yml:16-24,54-76,125,170,211] — env-var NOTE, redis template, SENTRY_DSN idiom.
- [Source: eslint.config.js:9-12,22-29,43-68] — existing bans + the clobber footgun.
- [Source: docs/context/PRD.md:453,842-853,1302-1312,1339-1357] — §4.6, §6.2, §10.2 Pino drift,
  §11.2 NFR table (SNF-18 target).
- [Source: docs/context/TECHNICAL-DESIGN.md:935,1141,1212] — §13, §15, §17 rows to edit.
- [Source: docs/context/ARCHITECTURE-SPINE.md#AD-2/AD-6/AD-8] + S-5 — invariants.
- Version research (2026-07-16): Docker Hub `arizephoenix/phoenix` tags; Arize Phoenix
  self-hosting docs (configuration: OTLP protobuf on :6006 `/v1/traces`, `PHOENIX_WORKING_DIR`);
  Arize LangChain.js integration docs ("≥4.0.0 supports LangChain 1.0",
  `manuallyInstrument(CallbackManagerModule)`); `open-telemetry/opentelemetry-js`
  `doc/upgrade-to-2.x.md` (`resourceFromAttributes`, `spanProcessors`); npm registry peer-dep
  checks for the exact pins in § Resolved versions.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (Opus 4.8) via bmad-dev-story.

### Debug Log References

- **Resolved versions confirmed on install** (single `@langchain/core@1.2.1` copy, AC15):
  `npm ls @langchain/core` → one non-deduped resolution. OTel `resources` resolves to `2.9.0`
  nested under `packages/shared/node_modules` (the root `1.30.1` belongs to `@sentry/node`,
  isolated); `phoenix.ts` (in `packages/shared`) resolves the 2.9.0 copy with
  `resourceFromAttributes`. Exact exports verified against the installed SDKs before writing the
  adapter (`resourceFromAttributes`, `NodeTracerProvider`+`BatchSpanProcessor`, `OTLPTraceExporter`,
  `SpanStatusCode`, `LangChainInstrumentation.manuallyInstrument`, `SEMRESATTRS_PROJECT_NAME =
  'openinference.project.name'`).
- **D1 finding (diag is global):** `@opentelemetry/api`'s `diag` is a shared singleton also used by
  the ops-5 Sentry adapter's OTel. Globally re-configuring it would reach across into the Sentry
  seam (violates D1), so the adapter leaves `diag` alone — OTel's default no-op logger keeps a
  down/unreachable collector silent without touching the other seam.
- **Gate (AC15) green:** `npm run lint` (0) · `npm run test` → **1145 passed | 1 skipped** (ops-5
  baseline 1123 → **+22**: 4 config + 16 phoenix + 2 lifecycle; no net loss) · `npm run build`
  clean (5 pkgs). `grep -rn "@opentelemetry\|@arizeai" packages --include=*.ts` hits only
  `packages/shared/src/tracing/`. ESLint vendor ban verified firing in all four service packages.
- **Real-SDK construction smoke (beyond the mocked unit tests + the Noop smoke):** ran
  `createLlmTracing({ endpoint: 'http://127.0.0.1:59999', service: 'backend' })` against the ACTUAL
  OTel 2.x + OpenInference SDKs (no running Phoenix — a black-hole endpoint). Result:
  `{ patchedBefore:false, patchedAfter:true, value:'v', rethrew:true, elapsedMs:3502, pass:true }`
  — the adapter CONSTRUCTS (NodeTracerProvider ctor, `resourceFromAttributes`, OTLPTraceExporter,
  BatchSpanProcessor, `register()`, `manuallyInstrument`) and the OpenInference LangChain
  instrumentation actually registers (`isPatched()` flips false→true), `withSpan` is transparent
  on a REAL span (returns fn's value / rethrows fn's error), and `flush(1500)`+`shutdown()` stay
  bounded (~3.5 s) and never reject even though the collector is unreachable. This confirms the
  real-SDK wiring works; the deferred AC12 live smoke now only needs to confirm Phoenix RECEIVES
  and DISPLAYS the spans (the trace-shape assertion), which genuinely requires a running collector.
- **Pre-existing, unrelated:** the `workers-integration` project (separate from the `unit`/`web`
  gate) has failing `indexBatch.integration.test.ts` / `sync.integration.test.ts` cases —
  reproduced on a clean tree with the ops-6 change stashed (they need real outbound URL fetch +
  enrichment, unavailable here). NOT an ops-6 regression; outside the mandatory gate.

### Completion Notes List

- **Architecture (D1):** LLM tracing is a **separate** vendor-neutral `LlmTracing` port
  (`packages/shared/src/tracing/`), NOT folded into the ops-5 `Observability` port. Sentry keeps
  errors+logs; Phoenix takes LLM traces. The `Observability` port, Sentry adapter, logger, and
  `redactSecrets` were NOT modified. Mirrors the ops-5 shape file-for-file (port+Noop in
  `tracing.ts`, factory in `index.ts`, single vendor adapter `phoenix.ts`, `guard`-style
  never-throw, 3-step provider recipe, inherited fail-open on unknown provider + hand-synced
  TS-union/Zod-enum with sync comments both sides).
- **AC10 (enrichment LLM) — auto path taken:** `enrichModel` in workers `main.ts` is left
  UNWRAPPED. `enrich.ts`'s structural `EnrichmentChatModel.invoke` /
  `.withStructuredOutput(…).invoke` is satisfied at runtime by the real `BaseChatModel` from
  `createChatModel`, so those calls go through `@langchain/core`'s CallbackManager and are captured
  by the OpenInference auto-instrumentation. The `withSpan('enrichment.llm', …)` fallback was NOT
  needed (final confirmation is the live smoke, AC12 — deferred, see below).
- **AC11 (empty-endpoint) — VERIFIED at runtime, three ways:** (1) 16 mocked adapter/factory unit
  tests (S-5 returns the shared Noop, vendor constructor never invoked, transparency both ways,
  never-throw); (2) a real-import smoke against the ACTUAL OTel+OpenInference SDKs —
  `createLlmTracing('')` returns `NoopLlmTracing`, `isPatched()` stays `false` at import AND after
  the empty-endpoint call (zero import-time side effects, no CallbackManager patch), `withSpan`
  returns fn's value and rethrows fn's error; (3) real backend + workers boots with
  `PHOENIX_ENDPOINT=""` against local Postgres+Redis — backend reached `listening … /health ready`
  (GET /health → 200) and workers reached `indexer starting` / `sync starting` / trimmer started;
  both took a clean SIGTERM (graceful shutdown drains `llmTracing.shutdown()`); zero
  OTel/tracing/phoenix log noise in either.
- **AC13 (SSE hot path) — code path asserted:** `BatchSpanProcessor` only (grep confirms
  `SimpleSpanProcessor` is used nowhere); manual `withSpan` wraps whole operations
  (`embeddings.embed_query`, `pgvector.similarity_search`, `embeddings.embed_documents`), never
  per-streamed-token; `respond` streaming is captured by ONE auto-instrumented LLM span. The
  live first-chunk-latency comparison rides the deferred AC12 smoke.
- **AC12/AC13 live Phoenix smoke — DEFERRED (ops-4/ops-5 precedent):** no full `docker compose`
  stack with real LLM/embeddings keys was available at implementation time. To run it later:
  set `PHOENIX_ENDPOINT=http://phoenix:6006` in `.env`, `docker compose up -d`, drive one chat
  turn (`POST /api/chat`) and index one URL, then confirm in the Phoenix UI (SSH-tunnel
  `127.0.0.1:6006`): the chat trace shows `embeddings.embed_query` + `pgvector.similarity_search`
  → `reason` (LLM span w/ prompt/completion/tokens/latency) → `respond`, and the workers trace
  shows enrichment + `embeddings.embed_documents`; compare `/api/chat` first-chunk latency
  tracing-on vs -off (SNF-3 < 100 ms). The trace-shape assertions remain in AC12/AC13 for that run.
- **Prod compose:** `PHOENIX_ENDPOINT: ${PHOENIX_ENDPOINT:-}` mirrored into all three prod app
  services (the interpolation footgun — the config references `${PHOENIX_ENDPOINT}`). The
  standalone prod file ships NO `phoenix` service (out of the ratified scope); a comment documents
  how to enable prod tracing (run a collector or point at an external OTLP endpoint).
- **Local `Share2Brain.config.yml`** (gitignored) was edited to add the `tracing` block for the
  boot smokes; only `Share2Brain.config.yml.example` is committed.

### File List

**New**

- `packages/shared/src/tracing/tracing.ts` — `LlmTracing` port + `NoopLlmTracing` + `LlmTracingProvider`
- `packages/shared/src/tracing/phoenix.ts` — Phoenix adapter (only file importing `@opentelemetry/*` + `@arizeai/*`)
- `packages/shared/src/tracing/index.ts` — `createLlmTracing` factory + 3-step recipe
- `packages/shared/src/tracing/phoenix.test.ts` — 16 adapter/factory tests

**Modified**

- `packages/shared/src/config/index.ts` — optional `observability.tracing` sub-block (AC6)
- `packages/shared/src/config/index.test.ts` — +4 tracing config cases
- `packages/shared/package.json` — OTel 2.x + OpenInference deps + `"./tracing"` subpath export
- `package-lock.json` — dependency lock
- `docker-compose.yml` — `phoenix` service + `phoenixdata` volume + `PHOENIX_ENDPOINT` in all 3 app services
- `docker-compose.prod.yml` — `PHOENIX_ENDPOINT` in all 3 app services (footgun mirror)
- `.env.example` — `PHOENIX_ENDPOINT=`
- `Share2Brain.config.yml.example` — `observability.tracing` block
- `packages/backend/src/main.ts` — `createLlmTracing` in AD-8 slot + threading + fatal-handler flush
- `packages/backend/src/app.ts` — `AppOptions.llmTracing` + embed/pgvector span wrappers (AC9)
- `packages/backend/src/lifecycle.ts` — `llmTracing.shutdown()` in the drain finally (guarded)
- `packages/backend/src/lifecycle.test.ts` — +2 shutdown-ordering / never-block tests
- `packages/workers/src/main.ts` — `createLlmTracing` in AD-8 slot + `embed_documents` span wrapper + shutdown/flush
- `eslint.config.js` — `@opentelemetry`/`@arizeai` ban folded into the 4 existing objects (AC5)
- `docs/context/PRD.md` — SNF-18 row, §6.2 stack, §4.6 config, §10.2 Pino→real-logger fix
- `docs/context/TECHNICAL-DESIGN.md` — §17 deferred row, §13 YAML, §15 stack rows
- `docs/context/ARCHITECTURE-SPINE.md` — `LlmTracing` separate-port note
- `docs/development_guide.md` — LLM-tracing operator section
- `_bmad-output/project-context.md` — `LlmTracing` port rule
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `ops-6` → in-progress → review

**Modified (gitignored, local only — not committed)**

- `Share2Brain.config.yml` — `observability.tracing` block (for the local boot smoke)

## Change Log

- 2026-07-16 — Implemented by bmad-dev-story (Opus 4.8): all 8 tasks + 15 ACs. New vendor-neutral
  `LlmTracing` port + Phoenix adapter (OTel 2.x + OpenInference) behind `createLlmTracing`
  (empty endpoint ⇒ Noop, S-5); backend+workers wired in the AD-8 slot with embed/pgvector/
  embed_documents manual spans via DI (zero business-logic edits); compose `phoenix` service +
  `PHOENIX_ENDPOINT` interpolation wiring; ESLint vendor ban; PRD/TD/spine/dev-guide/project-context
  docs-sync. Gate green (lint 0 / 1145 pass 1 skip / build 5 pkgs); AC11 empty-endpoint smoke
  verified (unit + real-import + backend/workers boot); AC12/AC13 live Phoenix smoke deferred
  (no full stack) with exact re-run commands recorded. Status: review.
- 2026-07-16 — Story created by bmad-create-story (ultimate context engine): SCP Proposals A-D
  distilled into 15 ACs; codebase analysis (observability pattern, DI seams, compose/eslint
  footguns) and version research (Phoenix 18.0.0, OpenInference 4.0.14 w/ LangChain-1.x support
  confirmed, OTel SDK 2.9.0 matched set) baked into Dev Notes. Status: ready-for-dev.

## Review Findings

_Code review 2026-07-16 (bmad-code-review, Opus 4.8) — 3-layer adversarial (Blind Hunter /_
_Edge Case Hunter / Acceptance Auditor). Net: 6 patch, 0 decision-needed, 0 defer, 7 dismissed._
_All architectural invariants (D1, AD-2, AD-8, AD-12, S-5, D3, SNF-9/SNF-18, never-throw) verified_
_PASS; no hard AC failure. The one High is a runtime provider-collision, not an AC violation._

### Decision-needed

_(none)_

### Patch

- [x] [Review][Patch][High] OpenInference auto-instrumentation binds to the GLOBAL OTel tracer,
  which `@sentry/node` (ops-5) claims first — so with Sentry enabled (the normal prod posture) the
  auto-instrumented LLM spans (`reason`/`respond`/`compress`/`enrich`) never reach Phoenix; only the
  3 manual `withSpan` spans do. Confirmed against SDK source: `Sentry.init()` runs `initOpenTelemetry`
  unconditionally (no `skipOpenTelemetrySetup`) → `setupOtel()` calls `trace.setGlobalTracerProvider`;
  boot order (AD-8) puts Sentry before Phoenix, and OTel's `setGlobalTracerProvider` no-ops when a
  global is already registered, so Phoenix's `provider.register()` is ignored. Fix (D1-preserving):
  bind the instrumentation to Phoenix's own provider — `new LangChainInstrumentation({ tracerProvider:
  provider })` (or `inst.setTracerProvider(provider)` before `manuallyInstrument`). MUST be confirmed
  with the deferred AC12 live smoke (Sentry + Phoenix both on) before merge. [packages/shared/src/tracing/phoenix.ts:131-138]
- [x] [Review][Patch][Medium] Tracing endpoint accepts any parseable scheme and is not normalized:
  the Zod refine is `v === '' || URL.canParse(v)`, so `redis://…` passes and `http://phoenix:6006/`
  (trailing slash) yields `…//v1/traces`; export failures are silent (best-effort), so the feature
  looks "on" but exports nothing. Fix: tighten the refine to `v === '' || isHttpUrl(v)` (reuse the
  shared helper, as `guest_access.invite_url` does) and normalize the base (`new URL('/v1/traces',
  endpoint)` or strip a trailing `/`). [packages/shared/src/config/index.ts:169, packages/shared/src/tracing/phoenix.ts:128]
- [x] [Review][Patch][Medium] `llmTracing.shutdown()`/`flush()` are awaited with NO outer timeout in
  the shutdown/fatal paths, unlike `redis.quit()`/`db.$client.end()` which are each `Promise.race`d
  with a `setTimeout`. The port contract guarantees never-reject, not never-hang; the current Phoenix
  adapter self-bounds (2s), so this is latent — but a future adapter (the whole point of the port)
  that hangs would wedge `exit(0)`/`exit(1)`. Fix: wrap the tracing teardown in the same outer
  `Promise.race([…, setTimeout])` bound for parity. [packages/backend/src/lifecycle.ts:147, packages/workers/src/main.ts:212, packages/backend/src/main.ts:86-98]
- [x] [Review][Patch][Low] `NoopLlmTracing.withSpan` is `(_n,_a,fn) => fn()`, so a SYNCHRONOUS throw
  in `fn` propagates synchronously under Noop (tests/tracing-off), whereas the Phoenix adapter routes
  it through `async runInSpan` → a rejected promise. The port declares `Promise<T>`. Fix: make Noop
  `async (_n,_a,fn) => fn()` so both paths reject identically. [packages/shared/src/tracing/tracing.ts:50]
- [x] [Review][Patch][Low] `bounded()` leaves the race `setTimeout` uncancelled and not `unref`'d on
  the fast path; benign today (every caller is immediately followed by `process.exit`) but the helper
  would keep the event loop alive up to `timeoutMs` if ever called off an exit path. Fix:
  `clearTimeout`/`unref` the timer. [packages/shared/src/tracing/phoenix.ts:89-101]
- [x] [Review][Patch][Low] Factory empty-endpoint guard uses exact `opts.endpoint === ''`, so a
  whitespace-only endpoint falls through to the live adapter (config Zod already rejects `' '` at
  load, so this only bites a non-config caller — defense-in-depth). Fix: `opts.endpoint.trim() === ''`.
  [packages/shared/src/tracing/index.ts:46]

### Defer

_(none)_

### Dismissed (recorded, not acted on)

- Crash-path +≤2s tracing flush before `exit(1)` — intentional (ship buffered spans), bounded, mirrors `observability.flush()`.
- `@opentelemetry/api ^1.9.1` "may not exist" — verified installed `1.9.1` (single copy), resolves cleanly.
- Dead-defensive `.catch` on `shutdown()` + hard-coded 2s shutdown bound — intentional, comment-acknowledged.
- Example config `${PHOENIX_ENDPOINT}` "breaks existing dev boot" — existing `Share2Brain.config.yml` is untouched (optional `tracing` block absent ⇒ Noop); fresh setups get the updated `.env.example`.
- Enrichment (AC10) auto-span unverified — same root cause as the High patch above (merged), not a separate defect.
- ARCHITECTURE-SPINE note in Spanish vs AC14 literal English — the spine doc is entirely Spanish (like PRD/TD); an English note would be the inconsistent choice.
- `/api/search` also emits spans (beyond the literal AC9 retriever scope) — additive, transparent, off the SSE hot path; an improvement, not a violation.

### Resolution (2026-07-16, patches applied)

All 6 patches applied and the verification gate re-run green (lint 0 / 1145 pass · 1 skip / build 5 pkgs):

- **High — provider collision:** `packages/shared/src/tracing/phoenix.ts` now constructs
  `new LangChainInstrumentation({ tracerProvider: provider })`, binding OpenInference's span-emitting
  `OITracer` to Phoenix's own provider instead of the Sentry-owned OTel global. Verified against the
  installed SDK source: `OITracer` is built at construction from `tracerProvider.getTracer(...)`, so the
  constructor arg (not a later `setTracerProvider`) is the correct seam.
- **Medium — endpoint:** config refine tightened to `isHttpUrl`; exporter URL built via
  `new URL('/v1/traces', endpoint)` (scheme-checked + slash/path-normalized).
- **Medium — teardown bound:** `llmTracing.shutdown()` now outer-raced with a 3s timeout in
  `lifecycle.ts` and `workers/main.ts`, matching redis/db.
- **Low ×3:** `NoopLlmTracing.withSpan` is `async` (sync-throw ⇒ rejection parity); `bounded()`
  `clearTimeout`s its race timer; factory empty-endpoint guard `trim()`s.

> ⚠️ **Mandatory follow-up (carries the pre-existing AC12/AC13 deferral):** the High fix changes which
> tracer the auto-instrumented LLM spans use at runtime. It is source-verified + unit/gate-green, but the
> live end-to-end smoke — **Sentry + Phoenix both enabled**, confirm `reason`/`respond`/`compress`/`enrich`
> spans actually land in the Phoenix UI — is still deferred (no full stack in this env). Run the deferred
> AC12/AC13 smoke before trusting tracing in production; this is the exact gap that let the bug ship unseen.

### Delta re-review (2026-07-16)

Adversarial verification of the 6 patches (Opus, refute-the-fix). Patch 1 (the High fix) **CONFIRMED
correct** against installed SDK source — the binding routes auto-spans to Phoenix's provider, leaves the
manual tracer and the Sentry seam (D1) untouched, and preserves context nesting. Two follow-ups it
surfaced, both fixed:

- **Patch 3 over-normalized** — `new URL('/v1/traces', endpoint)` discarded a *deliberate* subpath
  (`http://host/phoenix` → dropped `/phoenix`), diverging from standard OTLP append semantics. Changed to
  `` `${endpoint.replace(/\/+$/, '')}/v1/traces` `` — still fixes the trailing-slash double-slash, now
  preserves a reverse-proxy subpath.
- **Test-coverage gap on the critical line** — added a `phoenix.test.ts` assertion pinning
  `LangChainInstrumentation` is constructed with `{ tracerProvider: <our provider> }`, so a refactor can't
  silently re-break routing to Sentry's dropped tracer.

Patches 2/4/5/6 verified clean. Gate re-run green (lint 0 / 1145 pass · 1 skip / build 5 pkgs).

### Full-sweep re-review (2026-07-16)

Final holistic 3-layer sweep (Blind / Edge Case / Acceptance, Opus) over the COMPLETE branch diff
with the 6 fixes integrated. **No Critical/High, no hard AC failure; all invariants (D1, AD-2, AD-8,
AD-12, S-5, D3, SNF-9/18, never-throw) PASS.** The High provider-binding fix re-confirmed present +
correct by all three layers. Net: 3 patch (1 Medium consistency, 2 Low correctness), 0 decision-needed,
0 defer, 5 dismissed.

Patch:

- [x] [Review][Patch][Medium] Crash-path `llmTracing.flush()` is NOT outer-bounded, unlike the
  graceful-path `shutdown()` (which round 2 wrapped in `Promise.race([…, setTimeout(3s)])`). The
  `uncaughtException`/`unhandledRejection` handlers chain `.finally(() => llmTracing.flush())` with no
  outer timeout, so a future adapter whose `flush()` hangs would wedge `process.exit(1)`. Apply the same
  outer race for consistency with the shutdown hardening. [packages/backend/src/main.ts:86,97, packages/workers/src/main.ts:133,144]
- [x] [Review][Patch][Low] `withSpan` catch-fallback (`catch { return fn() }`) re-invokes `fn` if
  `startActiveSpan` ever throws AFTER entering the callback (runInSpan already ran `fn`) — a duplicate
  embedding/pgvector call, not just a duplicate span. Practically unreachable with conforming OTel
  (startActiveSpan throws only pre-callback), but the transparency contract should be airtight: capture
  the `runInSpan` promise and return it in the catch instead of re-calling `fn`. [packages/shared/src/tracing/phoenix.ts:175-184]
- [x] [Review][Patch][Low] Endpoint that already contains `/v1/traces` or carries a query/fragment
  passes `isHttpUrl` and is silently mis-appended (`…/v1/traces/v1/traces`), so the exporter POSTs to a
  404 the best-effort layer swallows — a silent-dead-tracing footgun (the exact failure class this review
  exists to catch). Add a fail-loud config refine rejecting a query/fragment or an already-appended
  `/v1/traces` path (preserves the supported reverse-proxy subpath). [packages/shared/src/config/index.ts:169]

Dismissed:

- Unverified SDK assumptions / silent failure (Blind Hunter Medium) — maps to the already-documented AC12/AC13 deferred live smoke; assumption (a) source-verified (OITracer built from the passed provider), (b) single `@opentelemetry/api` copy verified (`npm ls` → one `1.9.1`). Not a new defect.
- Unset `PHOENIX_ENDPOINT` aborts `loadConfig` (Edge Case Medium, re-raise of round 1) — fail-loud-by-design (AD-8, like every `${VAR}`); mitigated by compose `${PHOENIX_ENDPOINT:-}` defaults + updated `.env.example`; a non-compose deploy that references the var without setting it is a self-inflicted misconfig that SHOULD fail loud.
- Serial fatal-handler flushes (~4s crash latency, Blind Hunter Low) — cosmetic; parallelizing would touch the ops-5 observability chain (D1, out of scope).
- `toOtelAttributes` stringifies objects (Blind Hunter Low) — call sites are controlled and carry counts only; a generic coercer cannot distinguish "content", and the SNF-18 boundary is enforced at the call sites by design.
- ESLint bare `@opentelemetry`/`@arizeai` patterns are dead (Blind Hunter Low) — harmless redundancy; the effective ban is the `/**` globs, which do match real imports.

**Full-sweep patches applied (2026-07-16):** all 3 applied; gate re-run green (lint 0 / **1147 pass · 1 skip** — +2 new config tests pinning the endpoint refine / build 5 pkgs).

- Crash-path flush now routed through a `boundedTracingFlush()` (`Promise.race` w/ 3s) in both services' fatal handlers — parity with the graceful `shutdown()` bound.
- `withSpan` captures the `runInSpan` promise and returns it in the catch (no duplicate `fn` on a post-callback tracing fault).
- Config `endpoint` gains a second refine rejecting a query/fragment or an already-appended `/v1/traces` (fail loud; reverse-proxy subpath still accepted). The gate caught a chained-refine ordering bug during this (second refine's `new URL` threw on the value the first refine already rejected) — fixed by guarding on `isHttpUrl`; +2 tests pin both the rejection and the subpath-accept.
