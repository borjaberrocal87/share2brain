---
project_name: 'share2brain'
user_name: 'Borja'
date: '2026-07-03'
sections_completed:
  ['technology_stack', 'language_rules', 'framework_rules', 'testing_rules', 'quality_rules', 'workflow_rules', 'anti_patterns']
status: 'complete'
rule_count: 38
optimized_for_llm: true
existing_patterns_found: 13
---

# Project Context for AI Agents

_This file contains critical rules and patterns that AI agents must follow when implementing code in this project. Focus on unobvious details that agents might otherwise miss._

_Authoritative sources: `docs/context/ARCHITECTURE-SPINE.md` (invariants AD-1…AD-13), `docs/context/TECHNICAL-DESIGN.md`, and `docs/*-standards.md`. When a rule cites an `AD-*`, that AD is the authority._

---

## Technology Stack & Versions

**Runtime & language:** Node.js 24 LTS · TypeScript 6.0 (strict) · npm-workspaces monorepo.
**Backend:** Express 5.2 · @langchain/langgraph 1.4 + @langchain/core 1.2 · drizzle-orm 0.45 + drizzle-kit 0.31 · discord.js 14.26 · zod 4.4 · express-session 1.x + connect-redis 9.0 · node-redis (`redis`) 6.x.
**Frontend:** React 19.2 · Vite 8.1 (static SPA, no SSR).
**Data & infra:** PostgreSQL 17 + pgvector 0.8.2 · Redis 8 · nginx 1.27 · Docker Compose 2 (7 services).
**Testing:** Vitest (unit/integration) · Playwright (e2e). Embeddings: `text-embedding-3-small` (1536 dims).

**Constraints:** Pin all images explicitly (`pgvector/pgvector:pg17`, `redis:8-alpine`, `nginx:1.27-alpine`) — never `:latest`. No serverless/Lambda — the deploy unit is Docker Compose.

## Critical Implementation Rules

### Architecture boundaries (AD-1, AD-2 — non-negotiable)
- Code lives under `packages/<service>/src/` — **never a root `src/`**. Packages: `@share2brain/{shared,bot,backend,workers,web}`.
- `packages/shared` is the domain kernel. Services depend on `@share2brain/shared` but **NEVER import each other** (no `@share2brain/backend` from bot/workers/web, etc.).
- Bot, Backend, Workers are 3 separate Node processes, each with its own `package.json`, `Dockerfile`, and Compose entry.

### Contracts live only in shared (AD-5, AD-6)
- DB schema is Drizzle in `packages/shared/src/db/schema.ts` — the **only** place DDL exists. Migrations via `drizzle-kit generate`/`migrate` as explicit SQL; **never hand-edit generated SQL**.
- Every API request/response shape is a Zod schema in `packages/shared/src/schemas/`. Backend validates with `.parse()` at the edge; frontend infers types with `z.infer<>`. **No service defines API shapes locally.**
- A change to the schema or a Zod contract is scoped `shared` even if a consumer motivated it.

### Language / TypeScript
- Strict mode always on. Explicit types on function params and returns. **Avoid `any`** — use `unknown` or specific types; prefer Zod-inferred types over hand-written duplicates.
- Unified error shape everywhere: `{ error: string, code: string }` from `@share2brain/shared/schemas/errors.ts`. Map errors at the controller/endpoint layer; never leak raw Discord/LLM/DB errors inward or to clients.
- Use the logger exported from `@share2brain/shared` (level from `observability.log_level`). Never log secrets or full message content.

### Backend framework rules
- **RBAC lives INSIDE the vector query, never as a post-filter** (AD-12): every pgvector query carries `WHERE channel_id = ANY(:allowedChannelIds)`. Expand `session.discordRoles → allowedChannelIds` per-request against `channel_permissions` (not cached in session). No search/chat/documents query runs before `allowedChannelIds` is resolved.
- **Workers are idempotent** (AD-13): consume with `XREADGROUP`; **`XACK` only after successful processing**. On failure, do NOT ACK (Redis reassigns; PEL is the implicit DLQ). An insert on an existing `embedding.id` must UPSERT, not throw.
- Redis Stream keys & consumer groups are **fixed invariants** (AD-13): `share2brain:discord:messages`→`share2brain:indexer`, `share2brain:discord:messages:{updated,deleted}`→`share2brain:sync`. Event types in `packages/shared/src/types/events.ts`; every message carries `messageId`, `channelId`, `guildId`, `timestamp` (ISO 8601).
- **Sessions live in Redis only** (AD-10) via `express-session` + `connect-redis`. There is **NO `sessions` table** in the Drizzle schema. httpOnly cookie holds only the session ID; revoke by deleting the Redis key.
- RAG agent is a LangGraph `StateGraph` (`retrieve → reason → respond`, optional `tool_exec` loop) (AD-11). **No legacy LangChain APIs** — `langchain/chains` / `langchain/memory` are banned by a CI `no-restricted-imports` ESLint rule in `packages/backend`.
- Every service calls `loadConfig()` in `main.ts` (AD-8); invalid YAML aborts the process before any network I/O.
- **Observability = a vendor-neutral port; Sentry is one adapter** (Story ops-5, AD-2): services depend on the `Observability` **port** from `@share2brain/shared/observability` (`captureException`/`setUser`/`setupExpressErrorHandler`/`flush`/`logSink`), **never on `@sentry/node`**. `@sentry/node` is imported in **exactly one file** — `packages/shared/src/observability/sentry.ts`. Call `createObservability({ dsn: config.observability.sentry_dsn, service: '<service>', provider: config.observability.provider })` in `main.ts` **right after `loadConfig()` and before any network I/O** (AD-8) and pass its `logSink` into `createLogger` — returns a `NoopObservability` when the DSN is empty (S-5). The shared logger is a **dual sink** (stdout + the injected `StructuredLogSink`, gated by `observability.log_level`) and **must not import any vendor SDK** (dep direction: observability → logger). **Never send PII or message `content`**: `beforeSend`/`beforeSendLog` scrub message/stack/attributes via `redactSecrets` and drop any `content`; user context is internal id + Discord roles only; `sendDefaultPii` stays off. **Add a provider** = new adapter file + one `createObservability` branch + the `observability.provider` config value; **no service/web edit**.
- **LLM inference tracing = a SEPARATE vendor-neutral port; Arize Phoenix is one adapter** (Story ops-6, AD-2): LLM/embeddings **traces** (spans: model, tokens, latency, prompt/completion) are NOT the `Observability` port (D1 — Sentry keeps errors+logs; Phoenix takes traces). Services depend on the `LlmTracing` port from `@share2brain/shared/tracing` (`withSpan`/`flush`/`shutdown`), **never** on `@opentelemetry/*`/`@arizeai/*`. Those SDKs are imported in **exactly one file** — `packages/shared/src/tracing/phoenix.ts`; the module is **NOT re-exported from the shared root barrel** (pulls OTel+LangChain transitively, like `providers`). Call `createLlmTracing({ endpoint: config.observability.tracing?.endpoint ?? '', service: '<svc>', provider: config.observability.tracing?.provider })` in `main.ts` in the AD-8 slot (right after `createObservability`/`createLogger`, **before any LangChain model is constructed** so the OpenInference CallbackManager patch precedes any chain), and wire `shutdown()` into graceful shutdown + `flush()` into the fatal handlers. Empty `endpoint` ⇒ `NoopLlmTracing` (S-5 feature flag — no OTel object, no instrumentation, zero network). **Scope: `backend` + `workers` only** (the bot makes no LLM calls; it still receives `PHOENIX_ENDPOINT` in compose because interpolation aborts on any unset `${VAR}`). Never-throw + `withSpan`-transparency contract (mirrors `Observability`). Content MAY travel in spans **only** to the self-hosted, compose-internal collector (SNF-18); SNF-9 (no content/PII to Sentry) stays intact. Manual `withSpan` attributes carry **counts/params only**, never content. **Add a provider** = new adapter file + one `createLlmTracing` branch + `LlmTracingProvider`/Zod enum literal + the `observability.tracing.provider` config value; **no service/web edit**.
- **Chat streams via SSE, not WebSocket** (AD-4): `POST /api/chat` returns `text/event-stream`; client uses `fetch` streaming (NOT `EventSource`, so it can POST a body). Frames follow `SSEFrame` in `packages/shared/src/schemas/sse.ts` (`token`/`citation`/`done`/`error`). nginx MUST disable buffering on `/api/chat` (`proxy_buffering off; proxy_cache off; proxy_read_timeout 300s;`) (AD-7).
- Write ownership: only the owning service writes a table (Bot→`discord_messages`, Workers→`embeddings`, Backend→app tables). See `docs/data-model.md`.

### Frontend rules
- Static SPA only (AD-3) — Vite builds to `dist/`; nginx serves it. No Node server for the web app, no SSR.
- API types come from `z.infer<>` of shared Zod schemas — never redefine request/response shapes in `web`.
- Chat client consumes the SSE stream with `fetch` streaming and renders `token` frames incrementally.

### Testing rules
- Vitest, tests co-located as `*.test.ts` (or `__tests__/`). AAA pattern; behavior-driven names (`should <behavior> when <condition>`).
- **Tests-first where it pays** (core/domain, orchestration: agent graph, Indexer pipeline, RBAC expansion): write red, then green. Adapter glue (discord.js listeners, HTTP controllers) may test after.
- Mock external deps (Discord, LLM/embeddings, and in unit tests the DB/Redis). No real network/DB in unit tests. Integration tests hit real Postgres+pgvector where the value is in the SQL (vector filter, indexes).
- **Always test**: idempotency (re-delivered stream event UPSERTs, doesn't duplicate; failed processing leaves entry un-ACKed) and RBAC (queries never return fragments outside `allowedChannelIds`).

### Code quality & naming
- Files: `camelCase.ts` for modules; `PascalCase.ts` for classes and React components. Vars/functions `camelCase`; types/classes `PascalCase`; constants `UPPER_SNAKE_CASE`.
- REST endpoints: `/api/<resource>` kebab-case plural; route params camelCase (`/api/conversations/:conversationId`).
- IDs: Discord snowflake (string) for Discord entities; UUID v4 for own entities. Dates: ISO 8601 UTC in serialized shapes; `timestamp with time zone` in Postgres.
- **English only** in all code, comments, logs, tests, commits, docs — regardless of conversation language.

### Development workflow (BMAD Method)
- **One story at a time** (`bmad-dev-story`); never bundle stories. Build inner layers first: schema (`shared`) → domain → orchestration → adapters → endpoint → UI → tests.
- **Branch first**: `git branch --show-current`; if default, `git switch -c feat/<epic>-<story-slug>` (or `fix/<topic>`). Never commit on `main`.
- **Verification gate is mandatory and the AGENT runs it** (never the user): `npm run lint && npm run test && npm run build` — paste output. Never commit red. For DB/API/UI changes, also exercise endpoints/E2E and restore state.
- **Conventional Commits**, English, imperative, ≤72 chars: `<type>(<scope>): <summary>`. Scopes: `shared|bot|backend|workers|web|repo`. One commit per meaningful slice — never a single dump commit. Mark contract breaks with `!` + `BREAKING CHANGE:` footer.
- Docs are the source of truth: a post-apply fix updates the story/epic (and `docs/context/` if a decision moved) BEFORE code. PR at story end; hand off to `bmad-code-review` → `bmad-checkpoint-preview`. Never auto-merge.
- Planning/review skills (`bmad-prd`, `bmad-architecture`, `bmad-create-story`, `bmad-code-review`, …) run on the strongest model at high reasoning; return to a cheaper tier for mechanical `bmad-dev-story` steps. Never review a change with a weaker model than the one that wrote it.

### Critical don't-miss (anti-patterns)
- ❌ A root `src/` directory. ❌ One service importing another. ❌ Defining a DB table or Zod schema outside `packages/shared`.
- ❌ Post-filtering RBAC after the vector query (leaks private channels). ❌ `XACK` before successful processing. ❌ A `sessions` table in the schema.
- ❌ `EventSource` for chat. ❌ `langchain/chains` or `langchain/memory` imports. ❌ Mixing secrets (`.env`) with behavior config (`Share2Brain.config.yml`). ❌ `:latest` image tags. ❌ Marking a criterion satisfied without running the verification and pasting evidence.

---

## Usage Guidelines

**For AI Agents:**
- Read this file before implementing any code.
- Follow ALL rules exactly; when a rule cites an `AD-*`, the invariant in `ARCHITECTURE-SPINE.md` is the authority.
- When in doubt, prefer the more restrictive option.
- This is a lean digest — for concrete design detail read `docs/context/TECHNICAL-DESIGN.md` and the relevant `docs/*-standards.md`.

**For Humans:**
- Keep this file lean and focused on agent needs.
- Update when the stack, an `AD-*` invariant, or a convention changes — `docs/` remains the source of truth.
- Review periodically; remove rules that become obvious over time.

Last Updated: 2026-07-03
</content>
