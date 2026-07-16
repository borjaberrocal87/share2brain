# Sprint Change Proposal — LLM Inference Tracing via Arize Phoenix (self-hosted) behind a separate `LlmTracing` port

- **Date:** 2026-07-16
- **Author:** Correct Course workflow (Developer agent) with Borja
- **Mode:** Incremental (each proposal reviewed and approved individually)
- **Scope classification:** **Moderate** (backlog reorganization — new operational-backlog item + new ops story; no epic re-work)
- **Related:** `operational-backlog.md` P1.3/P1.4 (ops-4, ops-5), Epic 9 retro action item **AI-3** ("real deploy + observability — CRITICAL"), `sprint-change-proposal-2026-07-13-sentry.md`

---

## 1. Issue Summary

**Problem statement.** Share2Brain has error/log observability (Sentry behind the vendor-neutral
`Observability` port, ops-4/ops-5) but **zero visibility into the LLM pipeline**: no traces, no
spans, no latency measurements for any model call. The blind spots are concrete and verifiable in
code — no tracer and no OpenTelemetry dependency exist anywhere in the repo:

| Call site | File | What is invisible today |
|---|---|---|
| RAG `reason` node (chat LLM) | `packages/backend/src/agent/graph.ts` | prompt, completion, tokens, latency per turn |
| History compression LLM | `packages/backend/src/agent/compress.ts` | summarization calls |
| Query embedding (`retrieve`) | `packages/backend/src/infrastructure/queryEmbedder.langchain.ts` | embed latency per query |
| pgvector similarity query | `packages/backend/src/infrastructure/ragRetriever.drizzle.ts` | retrieval latency (SNF-1 target: P95 < 200 ms) |
| Enrichment LLM (title/description) | `packages/workers/src/enrichment/enrich.ts` | per-URL enrichment calls |
| Indexing embeddings | `packages/workers/src/indexer/indexBatch.ts` | `embedDocuments` latency/failures |

**Discovery context.** New post-roadmap requirement raised by Borja (2026-07-16): instrument LLM
calls (traces/spans/latencies) with **Arize Phoenix**, keeping strict Clean Code / SOLID —
providers swappable (Langfuse, OpenLLMetry, Datadog, …) without touching business logic, DI, no
globals in business code, and a feature flag so tracing can be off in local dev with zero side
effects. The original request was phrased for Python; **ratified adaptation**: implemented in the
project's real stack (TypeScript/Node), preserving every design constraint. PRD NFRs SNF-1/2/3/13/14/16
define latency targets that are currently **not instrumented**; PRD §17 mandates success metrics
"instrumented from day 1". Epic 9 retro AI-3 flags observability as CRITICAL and still open.

**Key user decisions (ratified 2026-07-16):**
- **D1 — Separate seam:** inference tracing gets its **own port** (`LlmTracing`), *separate* from
  the ops-5 `Observability` port. **Sentry keeps errors + logs, Phoenix takes LLM traces.**
  (Interface Segregation; the two concerns evolve independently. The `Observability` port is NOT modified.)
- **D2 — Content policy:** prompts/completions/retrieved fragments MAY travel in spans **only to a
  self-hosted collector inside the Compose network** (Phoenix). The SNF-9 prohibition (never content
  /PII to Sentry SaaS) stays fully intact. Phoenix must never be publicly exposed without auth.
- **D3 — Scope:** **backend + workers**. The bot is excluded — it makes no LLM calls.

---

## 2. Impact Analysis

### Epic impact
- **None.** Epics 1–11 unaffected; no epic invalidated, none added, no resequencing. This is a
  post-roadmap operational item — exact precedent: Sentry (P1.3 → SCP 2026-07-13 → story ops-4).

### Story impact
- No existing story is re-worked. One **new story**: `ops-6-llm-tracing-phoenix` (backlog).

### Artifact conflicts found (checklist §3)
1. **TECHNICAL-DESIGN §17 (Deferred)** — "Observabilidad | Qué errores y **traces** van a Sentry" is
   **superseded**: traces now target Phoenix; Sentry keeps errors + logs. Row must be updated.
2. **PRD SNF-9 / SO-7 / SD-18** — content-egress rule. D2 is *compatible* with SO-7 (data never
   leaves the operator's server: Phoenix runs inside Compose) but is a **new, explicitly documented
   content surface** (SD-18 style). New NFR **SNF-18** added; SNF-9 untouched.
3. **PRD §16 MVP boundary** — LLM tracing is not in MVP or v1 lists → this is a scope **addition**,
   handled (like all ops-N work) outside the epic roadmap; PRD §17 supports it.
4. **SSE path (SNF-3)** — instrumentation must add no per-token overhead on `/api/chat`. OTel spans
   are batch-exported asynchronously; story must verify first-chunk latency is unaffected.

Pre-existing doc drift to ride along in ops-6 docs-sync: PRD §10.2 still shows a **Pino** snippet
that §6.2 contradicts ("Pino nunca se adoptó"); TECHNICAL-DESIGN has no section describing the
ops-5 observability port.

### Technical impact
- New deps (in `packages/shared` **only**, per AD-2/ops-4 precedent): OTel Node SDK
  (`@opentelemetry/sdk-trace-node`, OTLP HTTP exporter) + `@arizeai/openinference-instrumentation-langchain`
  (+ semantic conventions). Exact pinned versions resolved at `bmad-create-story`.
- New Docker Compose service: `phoenix` (8th service), image pinned to an exact tag (never
  `:latest`), own volume, port 6006 **internal-network only** (operator access via SSH tunnel).
- No DDL, no API contract change, no web change.

---

## 3. Recommended Approach

**Option 1 — Direct Adjustment** (chosen; Options 2/3 not viable/needed — the change is 100 % additive, nothing to roll back, MVP unaffected).

- Add **P1.5** to `operational-backlog.md`; promote to story **ops-6** (status `backlog`) in
  `sprint-status.yaml`.
- **Effort: Medium** (new shared module + wiring in 2 `main.ts` + compose + docs + tests).
- **Risk: Low–Medium.** Risks: new dependency surface (OTel) in shared — mitigated by the Noop
  default (tracing off ⇒ byte-identical boot, S-5 precedent); SSE overhead — mitigated by async
  batch export + explicit verification in the story gate; OpenInference JS/LangChain 1.x
  compatibility — verify at story creation, fall back to manual `withSpan` wrapping of the
  provider factory if the auto-instrumentation doesn't cover LangGraph 1.4.
- **Timeline impact: none** on epics (post-roadmap operational stream).

---

## 4. Detailed Change Proposals (all APPROVED individually, 2026-07-16)

### Proposal A — Core design: `LlmTracing` port + Phoenix adapter *(approved)*

New module `packages/shared/src/tracing/` — sibling of `observability/`, same pattern
(Notifier/ops-5): port interface + factory + Noop.

```
Services (backend, workers)           ← depend ONLY on the port (DI via main.ts)
        │
        ▼
@share2brain/shared/tracing
  interface LlmTracing                ← vendor-neutral port
    withSpan<T>(name, attrs, fn)      ← manual spans (embeddings, pgvector query)
    flush(timeoutMs?) / shutdown()    ← best-effort; NO method throws (ops-5 contract)
  type LlmTracingProvider = 'phoenix' ← grows one literal per adapter
  createLlmTracing({ endpoint, service, provider })
    ├─ 'phoenix' → PhoenixLlmTracing adapter
    │     · OTel NodeTracerProvider + OTLP/HTTP exporter → phoenix:6006
    │     · registers OpenInference LangChain instrumentation once at creation
    │       (auto-traces every @langchain/core call: reason node, compress,
    │        workers enrichment — spans carry prompt/completion per D2)
    └─ empty endpoint → NoopLlmTracing (S-5; the feature flag — boot byte-identical)
```

- Auto-instrumented (zero business-logic edits): `reason` LLM, `compress.ts`, `enrich.ts`.
- Manual `withSpan` via DI: `embedQuery` (backend), `embedDocuments` (workers indexer), pgvector
  similarity query in `retrieve`.
- Vendor deps (`@opentelemetry/*`, `@arizeai/*`) imported **only** inside
  `packages/shared/src/tracing/phoenix.ts` (grep-green rule, mirrors ops-5's `@sentry/node`).
- `createLlmTracing()` called in backend + workers `main.ts` right after `loadConfig()`, before any
  network I/O (AD-8). `shutdown()` wired into graceful shutdown. The ops-5 `Observability` port is
  **not modified**.
- Adding a future provider (Langfuse/OpenLLMetry/Datadog) = new adapter file + one factory branch +
  one config enum value; zero service edits.

**Rationale:** honors the ratified separation (D1), reuses the project's proven port/adapter/Noop
pattern, and satisfies every constraint of the original request (DI, no globals, typed, feature flag).

### Proposal B — Config + Compose *(approved)*

`Share2Brain.config.yml` (behavior) + `.env` (endpoint value), Zod schema in
`packages/shared/src/config/index.ts`:

```yaml
observability:
  sentry_dsn: "${SENTRY_DSN}"
  log_level: "info"
  tracing:                            # NEW — optional block; absent ⇒ Noop (no .default(), streams precedent)
    provider: "phoenix"               # Zod enum, default 'phoenix', fail-safe
    endpoint: "${PHOENIX_ENDPOINT}"   # empty ⇒ Noop (S-5 precedent)
```

`docker-compose.yml`: new `phoenix` service — pinned exact image tag, dedicated volume
(`phoenixdata`), reachable at `http://phoenix:6006` on the internal network only; **not** proxied by
nginx; operator opens the UI via SSH tunnel. `.env.example` + `Share2Brain.config.example.yml` gain
placeholders.

### Proposal C — PRD edits *(approved)*

1. **§11.2 — new NFR row `SNF-18` (Trazado de inferencia LLM):**

   > OLD: *(row absent)*
   >
   > NEW: "Las llamadas LLM y de embeddings de `backend` y `workers` emiten trazas OTel (spans con
   > modelo, tokens, latencia y prompt/completion) a un colector **self-hosted** (Arize Phoenix)
   > vía el puerto vendor-neutral `LlmTracing` (`@share2brain/shared/tracing`); `endpoint` vacío ⇒
   > desactivado (Noop). El contenido puede viajar en spans **solo** hacia colectores self-hosted
   > dentro de la red del Compose y nunca expuestos públicamente sin autenticación; la prohibición
   > de contenido/PII hacia Sentry (SNF-9) permanece intacta. Implementado en Story ops-6."
2. **§6.2 stack table — Observabilidad row extended:** append "+ **Arize Phoenix (self-hosted)**
   para trazas LLM vía OTel/OpenInference (puerto `LlmTracing`, Story ops-6)".
3. **§4.6 config example:** add the `observability.tracing` block (as in Proposal B).
4. **Ride-along fix:** replace the stale §10.2 Pino snippet with the real
   `@share2brain/shared/logger` dual-sink description (§6.2 already states Pino was never adopted).

**Rationale:** documents the new content-egress surface explicitly (SD-18 style) without weakening
SNF-9, and clears a known doc drift.

### Proposal D — TECHNICAL-DESIGN + backlog + sprint-status *(approved)*

1. **TD §17 Deferred — Observabilidad row:**
   > OLD: "Observabilidad | Qué errores y traces van a Sentry | `SENTRY_DSN` en config"
   >
   > NEW: "Observabilidad | Errores + logs → Sentry tras el puerto `Observability` (ops-4/ops-5);
   > trazas LLM → Arize Phoenix self-hosted tras el puerto `LlmTracing` (ops-6) | `SENTRY_DSN` /
   > `PHOENIX_ENDPOINT` en `.env`; bloques `observability.*` en config"
2. **TD §13:** add the `observability.tracing` block to the YAML example. **TD §15:** add stack rows
   (Arize Phoenix, OpenTelemetry/OpenInference).
3. **`operational-backlog.md` — new item P1.5** (text below, §6 of this SCP).
4. **`sprint-status.yaml`** — new entry `ops-6-llm-tracing-phoenix: backlog` with a traceability
   comment referencing this SCP.

---

## 5. Implementation Handoff

- **Scope: Moderate** → Product Owner / Developer coordination via the operational backlog, then
  Developer agent execution.
- **Route:**
  1. This SCP applies the backlog/status/doc-pointer edits (Correct Course closes them).
  2. `bmad-create-story ops-6` (strong model) — resolves pinned versions (Phoenix image tag, OTel +
     OpenInference packages, LangGraph-1.4 compat check), fixes span attribute names, decides the
     enrichment-LLM instrumentation detail (structural-interface `invoke` is still a
     `@langchain/core` model call → covered by auto-instrumentation; verify).
  3. `bmad-dev-story ops-6` → `bmad-code-review` (different LLM) → `bmad-checkpoint-preview`.
- **Success criteria (green when):**
  - With `PHOENIX_ENDPOINT` set: a chat turn produces a trace in Phoenix showing
    retrieve (embed + pgvector spans) → reason (LLM span with prompt/completion/tokens/latency) →
    respond; an indexed URL produces enrichment + embedding spans from workers.
  - With empty endpoint: boot and behavior byte-identical to today (Noop), zero OTel network calls.
  - `grep -r '@opentelemetry\|@arizeai' packages/` hits only `packages/shared` (port adapter + tests).
  - No vendor name in any service; `Observability`/Sentry behavior unchanged; SNF-3 first-chunk
    latency unaffected (verified); gate green (`npm run lint && npm run test && npm run build`).

---

## 6. New `operational-backlog.md` item (applied by this SCP)

### P1.5 — LLM inference tracing (Arize Phoenix, self-hosted) behind a separate `LlmTracing` port
> **Approved 2026-07-16** via `sprint-change-proposal-2026-07-16-llm-tracing-phoenix.md` (Correct
> Course). To be promoted to story `ops-6-llm-tracing-phoenix.md` (`bmad-create-story`).
- **Why now:** zero visibility of the LLM pipeline (RAG graph, compression, embeddings, workers
  enrichment) — no traces/spans/latencies anywhere; PRD latency NFRs (SNF-1/2/3/13/14) are not
  instrumented; Epic 9 retro AI-3 (observability, CRITICAL) still open. Requested by Borja
  2026-07-16.
- **Scope:** new `packages/shared/src/tracing/` port (`LlmTracing` + `createLlmTracing` +
  `NoopLlmTracing`, never-throw contract) with a Phoenix adapter (OTel NodeTracerProvider + OTLP →
  `phoenix:6006`, OpenInference LangChain auto-instrumentation; manual `withSpan` for
  embeddings/pgvector); config `observability.tracing` (optional block, empty endpoint ⇒ Noop);
  compose service `phoenix` (pinned tag, internal-only); wiring in backend + workers `main.ts`
  (AD-8); bot excluded (no LLM calls). **Separate from the ops-5 `Observability` port — Sentry keeps
  errors+logs.** Content in spans allowed ONLY because the collector is self-hosted (SNF-18); never
  expose Phoenix publicly without auth.
- **Green when:** see SCP §5 success criteria.

---

## 7. Checklist Record (summary)

| Section | Result |
|---|---|
| 1. Trigger & context | [x] Done — new post-roadmap requirement; evidence in code + PRD NFRs + AI-3 |
| 2. Epic impact | [x] Done — none; [N/A] resequencing |
| 3. Artifact conflicts | [x] Done — 4 conflicts identified & resolved by Proposals A–D |
| 4. Path forward | [x] Option 1 (Direct Adjustment); effort Medium; risk Low–Medium |
| 5. Proposal components | [x] Done — this document |
| 6. Final review & handoff | [x] User approval obtained (A–D individually + final); sprint-status updated |
