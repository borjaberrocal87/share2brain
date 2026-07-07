---
baseline_commit: 9b06416a7d95142a514c9a60c5c91204fdd20c96
---

# Story 5.1: Endpoint SSE de Chat con Pipeline RAG

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an authenticated user,
I want to send a message to the RAG agent and receive the answer streamed in real time over SSE,
so that I get contextualized answers from my community's indexed knowledge, restricted to the channels I may access.

**Scope note:** This is the FIRST story of Epic 5 and the first LangGraph `StateGraph` in the
repo. It builds the backend `POST /api/chat` SSE endpoint + the RAG pipeline
(`retrieve → reason → respond`). It does **not** build the conversation LIST/DETAIL read
endpoints or history summarization (Story 5.2), and it builds **no UI** (Stories 5.3/5.4).
Almost every dependency it needs already exists — see the **Reuse Map** in Dev Notes; the
net-new surface is the agent graph, the chat request contract, the SSE controller, and
conversation/message persistence.

## Acceptance Criteria

Derived from `epics.md` §"Historia 5.1" (lines 801–818), which is already BDD-formatted, plus
the invariants it cites. Each AC below is the DEV agent's contract.

1. **SSE content type.** `POST /api/chat` with a JSON body `{ message, conversationId? }`
   responds with `Content-Type: text/event-stream` (not `application/json`, not a WebSocket
   upgrade). The endpoint sits behind the existing `/api` gate so it inherits `requireAuth`
   (401 without a session) and the RBAC middleware (`req.allowedChannelIds`). [AD-4]

2. **StateGraph pipeline.** The request is answered by a LangGraph `StateGraph` executing the
   explicit nodes `retrieve → reason → respond` (a real `StateGraph`, not an ad-hoc function
   chain). [AD-11]

3. **Provider factory.** The graph's chat model is built via the provider factory from `agent`
   config (`provider` / `model` / `base_url` / `api_key` / `temperature`), supporting
   `anthropic | openai | custom`. No agent code constructs a LangChain client directly. [AD-6,
   provider factory in `@hivly/shared/providers`]

4. **RBAC inside the retrieve query.** The `retrieve` node filters vectors by the caller's
   `allowedChannelIds` (computed per-request by the RBAC middleware from
   `session.discordRoles` + `channel_permissions`) as a clause of the pgvector query — never a
   post-filter. An empty scope yields zero fragments (deny-by-default) without a paid
   embeddings call. [AD-12]

5. **Deleted-message exclusion.** The `retrieve` node excludes any embeddings chunk that joins
   to a `discord_messages` row with `deleted_at IS NOT NULL` (exclude-if-ANY — Story 4.1 D1
   semantics). [reused from `embeddingSearchRepository`]

6. **SSE wire format.** The stream emits frames that conform exactly to `SSEFrameSchema` in
   `packages/shared/src/schemas/sse.ts`: `token` (incremental answer text), `citation` (one per
   cited source), `done` (carries the real `conversationId`), `error`. Frames are serialized as
   `data: <json>\n\n`. Frame order: N × `token` → M × `citation` → one terminal `done` (or a
   single `error` frame on failure). Only these four shipped frame types are emitted (see
   Design Decision D2 on `tool_call`/`observation`). [AD-4]

7. **ESLint legacy-LangChain ban.** An ESLint `no-restricted-imports` rule in `packages/backend`
   blocks imports of `langchain/chains` and `langchain/memory` (and other deprecated v0.2 memory
   APIs), enforced by `npm run lint` in CI. [AD-11]

8. **nginx buffering.** `location /api/chat` in `nginx.conf` has `proxy_buffering off;
   proxy_cache off; proxy_read_timeout 300s;`. **This block already exists and is correct**
   (`nginx.conf:26-33`) — the AC is satisfied; verify it is unchanged, do not duplicate it.
   [AD-7]

9. **Persistence & conversation lifecycle.** When `conversationId` is absent/null, a new
   `conversations` row is created for `req.session.userId`; when present, it must belong to that
   user (else the request is rejected before streaming — see D8). The user message
   (`role: 'user'`) and the assistant answer (`role: 'assistant'`, with the emitted citations)
   are persisted to `messages`; `conversations.updated_at` is bumped. The `done` frame carries
   the conversation's UUID. [data-model.md: `conversations`/`messages`, owner = backend]

10. **Contract in shared.** The chat request shape is a Zod schema in
    `packages/shared/src/schemas/` (AD-6) — the endpoint validates the body with `.parse()`/
    `.safeParse()` at the edge; the web app (5.4) will `z.infer<>` it. No local request shape in
    `backend`.

11. **Spike removal.** The Epic-4 SSE spike is deleted: `mountSpikeChatSse` (+ its call) in
    `packages/backend/src/e2e/server.ts` and `packages/web/tests/chat-sse-spike.spec.ts` (both
    self-document "delete when Story 5.1 lands the real `/api/chat`"). The real `/api/chat` must
    become reachable in the Playwright harness backend so Story 5.4 can drive it (satisfied by
    injecting a fake chat model in `buildTestAppOptions` defaults — see D6/D11).

12. **Verification gate (backend story — no visual ACs).** `npm run lint && npm run test &&
    npm run build` all green, output pasted. PLUS an integration test over real
    Postgres+pgvector that exercises `/api/chat` end-to-end and asserts: the frame sequence
    (tokens → citations → done), RBAC scoping (a fragment in a disallowed channel never appears
    as a citation), deleted-message exclusion, and that the conversation + both messages are
    persisted. PLUS exercise the live endpoint once (curl the SSE stream) and paste the raw
    `data:` frames. [CLAUDE.md verification gate; bmad-story-mandatory-steps.md]

## Tasks / Subtasks

- [x] **Task 1 — Shared: chat request contract** (AC: 6, 10)
  - [x] Add `packages/shared/src/schemas/chat.ts`: `CHAT_MESSAGE_MAX_LENGTH` (4000), 
        `ChatRequestSchema = z.object({ message: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_LENGTH), conversationId: z.uuid().nullable().optional() })`,
        `type ChatRequest = z.infer<...>`, and `CHAT_ERROR = { VALIDATION_ERROR, NOT_FOUND, INTERNAL } as const` + `ChatErrorCode`. Mirror `search.ts`.
  - [x] `export * from './chat.js'` in `packages/shared/src/schemas/index.ts`.
  - [x] Co-locate `chat.test.ts` (valid body, blank message → fail, oversized message → fail, bad-UUID conversationId → fail, absent conversationId → ok).
  - [x] Note: `SSEFrameSchema` already exists in `sse.ts` — do NOT redefine; import it.

- [x] **Task 2 — Backend deps + ESLint legacy ban** (AC: 2, 3, 7)
  - [x] Add `"@langchain/langgraph": "^1.4.7"` to `packages/backend/package.json` dependencies (peer `@langchain/core ^1.1.48` is satisfied by the installed `^1.2.1`). Run `npm install` and commit the `package-lock.json` diff.
  - [x] `packages/backend` already depends on `@hivly/shared` (→ `@hivly/shared/providers` for `createChatModel`). Do NOT add `@langchain/anthropic`/`@langchain/openai` to backend — those stay behind the shared provider factory.
  - [x] `eslint.config.js`: FOLD the langchain-legacy ban into the existing `banSiblingServices('backend')` block (see D9 — a later flat-config object would clobber the whole `no-restricted-imports` option, the exact gotcha already documented for the `web` block at `eslint.config.js:22-29`). Add a `patterns` entry banning `langchain/chains`, `langchain/memory` (and `langchain/chains/**`, `langchain/memory/**`) alongside the sibling-import ban, with a message citing AD-11.
  - [x] Prove the rule bites: temporarily add `import 'langchain/memory'` in a backend file, confirm `npm run lint` errors, then remove it. Confirm the sibling-service ban still fires (don't regress it).

- [x] **Task 3 — Domain ports for the agent** (AC: 2, 3, 4, 5)
  - [x] `packages/backend/src/domain/repositories/chatModel.ts`: a minimal `ChatModel` port the agent depends on instead of `BaseChatModel` directly — e.g. `stream(messages: ChatTurn[]): AsyncIterable<string>` (yields answer token chunks). Keeps LangChain out of the graph/service (AD-2 spirit; mirrors `QueryEmbedder`). `ChatTurn = { role: 'system'|'user'|'assistant'; content: string }`.
  - [x] `packages/backend/src/domain/repositories/ragRetriever.ts`: `RagRetriever` port — `retrieve(query: string, allowedChannelIds: string[], topK: number): Promise<SearchFragment[]>`. (SearchFragment is the shared shape reused for citations.)
  - [x] `packages/backend/src/domain/repositories/conversationRepository.ts`: port for persistence — `createConversation(userId)`, `getOwnedConversation(id, userId)` (null if missing/not owned), `appendMessage({conversationId, role, content, citations})`, `touchConversation(id)`.

- [x] **Task 4 — Infrastructure adapters** (AC: 3, 4, 5, 9)
  - [x] `packages/backend/src/infrastructure/chatModel.langchain.ts`: `createLangchainChatModel(agent: HivlyConfig['agent']): ChatModel` — build once via `createChatModel(agent)` from `@hivly/shared/providers`, adapt `.stream()` to yield string chunks. The ONLY agent-side file importing the provider factory (mirrors `queryEmbedder.langchain.ts`). No network I/O at construction.
  - [x] `packages/backend/src/infrastructure/ragRetriever.drizzle.ts`: `RagRetriever` adapter that composes the EXISTING `queryEmbedder.embedQuery()` + `embeddingSearchRepository.searchByEmbedding()`. Do NOT hand-write a new pgvector query — reusing `searchByEmbedding` gives AC4 (RBAC-in-query) + AC5 (deleted-message exclusion) + anchor join for free. Empty scope short-circuits (already handled downstream).
  - [x] `packages/backend/src/infrastructure/conversationRepository.drizzle.ts`: Drizzle adapter over `conversations`/`messages` using the `sql`/query builder re-exported by `@hivly/shared/db` (never import `drizzle-orm` directly, AD-2). `getOwnedConversation` filters by BOTH id AND `userId` (ownership).

- [x] **Task 5 — The RAG agent (LangGraph StateGraph)** (AC: 2, 4, 5, 6)
  - [x] `packages/backend/src/agent/` — build the `StateGraph` with `AgentState` = `{ messages, allowedChannelIds, retrievedFragments, conversationId }` and nodes:
    - `retrieve`: embeds the last user message and calls `ragRetriever.retrieve(query, state.allowedChannelIds, RETRIEVE_TOP_K)`; returns `{ retrievedFragments }`. `RETRIEVE_TOP_K` is a local constant defaulting to 5 (see D3 — there is NO `knowledge.topK` in config).
    - `reason`: truncates history to the last `memory_window` turns (D3 — NOT summarization; that's 5.2), builds the LLM turn list `[systemPrompt, buildRAGContext(fragments), ...recentTurns]`, and prepares the model input. Author a concrete `systemPrompt` (English; instruct grounded answers + cite sources + say "no information" when fragments are empty) and `buildRAGContext(fragments)` (renders fragments with channel/author/date for grounding).
    - `respond`: streams the model tokens.
  - [x] Expose the agent as an async generator: `runChat(input): AsyncIterable<SSEFrame>` (input: `{ message, history, allowedChannelIds, conversationId }`). It yields `token` frames as the model streams, then one `citation` frame per retrieved fragment (`{ type:'citation', channel: f.channelName, author: f.authorName, date: f.createdAt }`), then a terminal `done` with `conversationId`. NO Express in this module (unit-testable; mirrors `searchService`'s no-Express rule). Accept an `AbortSignal` so the controller can cancel on client disconnect.
  - [x] Keep the graph extension-ready for the optional `tool_exec` loop (AD-11) but bind NO tools in 5.1 (none exist) — the loop never fires. Do NOT emit `tool_call`/`observation` frames (D2).
  - [x] Unit tests: node/graph behavior with a fake `ChatModel` (fixed token chunks) + fake `RagRetriever` — assert the frame sequence, that empty scope → no citations, and that citations map fragment fields correctly.

- [x] **Task 6 — Application service** (AC: 6, 9)
  - [x] `packages/backend/src/application/services/chatService.ts`: orchestrates a chat turn — resolve/create the conversation (ownership-checked), persist the user message, run `agent.runChat(...)` while forwarding frames to the caller (async generator or emit callback), accumulate the streamed answer text + citations, persist the assistant message, `touchConversation`, and ensure the `done` frame carries the resolved `conversationId`. Depends ONLY on ports (ChatModel/agent, RagRetriever, ConversationRepository) — no Drizzle, no Express, no LangChain. Unit-test with fakes.

- [x] **Task 7 — Presentation: SSE controller + route** (AC: 1, 6, 8, 9)
  - [x] `packages/backend/src/presentation/controllers/chatController.ts`:
    - Validate body with `ChatRequestSchema.safeParse` → 400 `VALIDATION_ERROR` (Spanish user message + English code) BEFORE any header is sent.
    - Read `req.allowedChannelIds ?? []` and `req.session.userId`.
    - Ownership: if `conversationId` provided and not owned → 404 `NOT_FOUND` (JSON, pre-stream).
    - Set headers `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`; `res.flushHeaders()` (mirror the spike server precedent at `e2e/server.ts:45-48`).
    - Wire an `AbortController`; `req.on('close', () => controller.abort())` to stop paying for tokens on disconnect.
    - Iterate `chatService`'s frames, `res.write(\`data: ${JSON.stringify(frame)}\n\n\`)`; `res.end()` after `done`.
    - Mid-stream failure (headers already flushed): emit `{ type:'error', code, message }` then `res.end()` — never leak raw LLM/DB errors (map to a generic message + stable code; log the real one server-side).
  - [x] `packages/backend/src/routes/chatRoutes.ts`: `router.post('/', (req,res) => void controller.chat(req,res))` (mirror `searchRoutes.ts`). Do NOT re-add auth/RBAC — mounting under `/api/chat` after the gate inherits them.

- [x] **Task 8 — Composition root wiring + test defaults** (AC: 1, 3, 11)
  - [x] `app.ts`: add `chatModel?: ChatModel` to `AppOptions` (mirror the `queryEmbedder?` required-at-runtime precedent at `app.ts:48-55,103-109`). Build the RagRetriever (from injected `queryEmbedder` + `embeddingSearchRepository`), conversationRepository, agent, chatService, chatController; `app.use('/api/chat', createChatRouter(chatController))` AFTER the `/api` gate.
  - [x] `main.ts`: build `chatModel = createLangchainChatModel(config.agent)` and pass it into `createApp` (mirror `queryEmbedder` at `main.ts:62,76`). Pass `config.agent.memory_window` to whatever needs it.
  - [x] `test-helpers.ts`: add a deterministic `fakeChatModel()` (streams a fixed token list) and include `chatModel: fakeChatModel()` in `buildTestAppOptions` defaults (so ALL integration tests AND the Playwright e2e backend get `/api/chat` for free — this is what makes AC11 / Story 5.4's live endpoint work without a real LLM).

- [x] **Task 9 — Remove the spike** (AC: 11)
  - [x] Delete `mountSpikeChatSse` + its constants + its call in `packages/backend/src/e2e/server.ts` (leave the rest of the e2e server intact; `/api/chat` is now live in the harness via createApp + the fake chat model default).
  - [x] Delete `packages/web/tests/chat-sse-spike.spec.ts`.
  - [x] Grep for `_spike` / `chat-sse-spike` and remove any dangling references (scripts, README mentions).

- [x] **Task 10 — Integration test + live exercise** (AC: 4, 5, 6, 9, 12)
  - [x] `packages/backend/src/chat.integration.test.ts` (real Postgres+pgvector, real session via the same fake-OAuth path the other integration suites use, `fakeChatModel` + `fakeQueryEmbedder`). Assert: 200 `text/event-stream`; frame sequence tokens→citations→done; citations only from allowed channels (seed one allowed + one disallowed channel and confirm the disallowed fragment never appears); deleted-message exclusion (seed a chunk whose source message has `deleted_at` → no citation); a new conversation is created + both messages persisted with the right roles/citations; passing an existing owned `conversationId` appends to it; a non-owned/unknown `conversationId` → 404; blank/oversized message → 400.
  - [x] Live exercise for the gate: `docker compose up -d postgres redis`, run the backend (or the e2e server), obtain a session, `curl -N` the SSE stream, paste the raw `data:` frames into Debug Log.

- [x] **Task 11 — Docs sync** (AC: 12)
  - [x] If any decision here refines the design (e.g. the `knowledge.topK` / `memoryBudget` naming corrections, the async-generator agent boundary, the memory_window=truncation-in-5.1 vs summarization-in-5.2 split), record it in the story Dev Notes and — only if a design invariant moved — in `docs/context/`. Update `docs/api-spec.yml` only if the request/response shape diverges from what's already there (it should not).

### Review Findings

_Code review 2026-07-07 (bmad-code-review, 3 adversarial layers: Blind Hunter + Edge Case Hunter + Acceptance Auditor, Opus 4.8, over the uncommitted working tree, baseline 9b06416). Acceptance Auditor: 12/12 ACs SATISFIED (AC12 gate not re-run in the audit; comprehensive integration test present). 9 findings dismissed as noise/false-positive/verified-valid._

- [x] [Review][Patch] Mid-stream failure/abort leaves an orphaned user turn — On an LLM error or client disconnect, `streamChat` throws out of the `for await` loop before persisting the assistant message and calling `touchConversation`; the conversation keeps a `user` row with no answer and stale `updated_at`. **RESOLVED (decision 2026-07-07): persist the partial answer.** ✅ FIXED: wrapped the streaming in try/finally with a single-shot `persistAssistant()` — any interruption persists whatever answer/citations accumulated + `touchConversation` (ChatGPT-style; never orphan the turn). Regression test added (`chatService.test.ts`: "should persist the partial answer... when the agent throws mid-stream"). [packages/backend/src/application/services/chatService.ts:66-116]
- [x] [Review][Patch] AbortSignal never reaches the LLM — client disconnect cannot cancel paid token generation. ✅ FIXED: added `signal?: AbortSignal` to the `ChatModel.stream()` port; `respondNode` now passes `config?.signal` into `chatModel.stream(...)`, and the LangChain adapter forwards it as `model.stream(msgs, { signal })`. The abort now flows controller → `graph.stream({signal})` → node `config.signal` → provider request. [packages/backend/src/domain/repositories/chatModel.ts:11-18, packages/backend/src/agent/graph.ts:70-83, packages/backend/src/infrastructure/chatModel.langchain.ts:47-56]
- [x] [Review][Patch] `done` frame forwarded to the client before the assistant message is persisted — ✅ FIXED: `streamChat` now calls `persistAssistant()` on the `done` branch BEFORE forwarding the frame; a persistence failure there throws to the controller, which emits an `error` frame instead of a `done` the client would trust. Regression test added ("should persist the assistant message BEFORE emitting the done frame"). [packages/backend/src/application/services/chatService.ts:88-107]
- [x] [Review][Patch] `res.write` continues to a closed socket on client disconnect — ✅ FIXED: added a `writeFrame()` guard (`res.writableEnded || res.destroyed` → skip), a `res.on('error', …)` swallow so a post-close write can't crash the process, and a `!res.writableEnded` guard on `res.end()`. [packages/backend/src/presentation/controllers/chatController.ts:55-83]
- [x] [Review][Patch] `state.messages.slice(-memoryWindow)` collapses to the FULL history when `memory_window <= 0` — `slice(-0)` === `slice(0)`. ✅ FIXED: guarded as `memoryWindow > 0 ? slice(-memoryWindow) : []`. [packages/backend/src/agent/graph.ts:61-63]

#### Review Findings — Round 2 (re-review of the 5 patches as new code, 2026-07-07)

_Second bmad-code-review pass (Epic 3 retro AI#1: treat every applied patch as new un-reviewed code) over a patch-only diff (pre-patch snapshot reconstructed from the round-1 diff vs. current). Acceptance Auditor: patches preserve all 12 ACs, 0 regressions. Edge Case Hunter VERIFIED the libraries — LangGraph 1.4.7 rethrows the AbortError out of `graph.stream` (so `finally` runs on abort + the throw reaches the controller catch) and LangChain honors `RunnableConfig.signal` (provider request aborts) — confirming the round-1 abort fix works end-to-end. 7 findings dismissed (Blind Hunter's "signal wiring absent" + "{signal} contract unproven" = diff-scope false positives, verified present/honored; "silent loss if no `done`" = impossible, the agent always emits `done` or throws; memoryWindow NaN/fractional = config-schema scope, dead-path in 5.1; persist-partial-for-gone-client = the accepted product decision)._

- [x] [Review][Patch] Zero-token turn persists an empty assistant message — ✅ FIXED: `persistAssistant()` now returns early when `answer.length === 0 && citations.length === 0` (nothing streamed → nothing saved, no blank bubble). Regression test: "should NOT persist an assistant message or touch when the turn produced nothing". [packages/backend/src/application/services/chatService.ts:86-105]
- [x] [Review][Patch] A `touchConversation` failure fails an already-committed turn — ✅ FIXED: the `updated_at` bump is now wrapped in try/catch + log, so a committed answer is never failed (nor `done` suppressed) by a non-essential timestamp write. Regression test: "should still emit done when the best-effort touchConversation fails after a committed answer". [packages/backend/src/application/services/chatService.ts:100-108]
- [x] [Review][Patch] `res.write` can throw synchronously (EPIPE/write-after-FIN) — ✅ FIXED: `writeFrame` now wraps `res.write` in try/catch + log, so a synchronous throw (uncaught by `res.on('error')`) can't become an unhandled rejection. Regression test: "should not throw when res.write throws synchronously (EPIPE race)". [packages/backend/src/presentation/controllers/chatController.ts:64-77]
- [x] [Review][Patch] Guard asymmetry + silent error swallow — ✅ FIXED: `res.end()` now guards `!writableEnded && !destroyed` (symmetric with `writeFrame`), and the `res.on('error')` handler now logs instead of swallowing silently. [packages/backend/src/presentation/controllers/chatController.ts:57-63,88-91]
- [x] [Review][Patch] Round-1 patch behaviors were untested — ✅ FIXED: added a controller test that flips `res.destroyed` and asserts `writeFrame` skips the write, plus a `graph` test asserting `memoryWindow <= 0` truncates history to `[]` (only system messages reach the model) and `memoryWindow >= 1` includes the current turn. [packages/backend/src/presentation/controllers/chatController.test.ts, packages/backend/src/agent/graph.test.ts]

## Dev Notes

### Reuse Map — what already exists (do NOT reinvent)

This story is mostly composition. Verified present on disk:

| Need | Already built | Location |
|---|---|---|
| SSE frame contract | `SSEFrameSchema` (token/citation/done/error) + `SSEFrame` type | `packages/shared/src/schemas/sse.ts` (exported via `schemas/index.ts`) |
| LLM provider factory | `createChatModel(agent) → BaseChatModel` (anthropic/openai/custom, explicit api_key/base_url) | `packages/shared/src/providers/index.ts` — import via `@hivly/shared/providers` ONLY |
| Query embedder | `createLangchainQueryEmbedder(config.embeddings)` + `QueryEmbedder` port (+ degenerate-vector guards) | `packages/backend/src/infrastructure/queryEmbedder.langchain.ts` |
| pgvector RBAC search | `searchByEmbedding(vec, allowedChannelIds, limit)` — RBAC-in-query (AD-12), deleted-if-ANY exclusion (D1), anchor join, empty-scope short-circuit | `packages/backend/src/infrastructure/embeddingSearchRepository.drizzle.ts` |
| Fragment/citation shape | `SearchFragmentSchema` (`{channel..author..date..}`) + `Citation` (`{channel,author,date}`) | `packages/shared/src/schemas/search.ts`, `packages/shared/src/db/schema.ts:30` |
| RBAC per-request scope | `req.allowedChannelIds` populated on every `/api/*` | `packages/backend/src/middleware/rbac.ts` |
| Session identity | `req.session.userId` (users.id UUID), `req.session.discordRoles` | `packages/backend/src/infrastructure/sessionStore.ts:13-16` |
| Conversation tables | `conversations` + `messages` (owner: backend) — **already migrated** | `packages/shared/src/db/schema.ts:111-131`, migration `0001_tough_skrulls.sql` — **NO migration needed** |
| nginx SSE config | `location /api/chat { proxy_buffering off; proxy_cache off; proxy_read_timeout 300s; }` | `nginx.conf:26-33` — **already correct** |
| SSE server pattern | headers + `flushHeaders()` + `data: <json>\n\n` + `req.on('close')` | `packages/backend/src/e2e/server.ts:44-69` (the spike — delete after copying the pattern) |
| Composition/injection pattern | `queryEmbedder?` required-at-runtime injection + `buildTestAppOptions` default | `packages/backend/src/app.ts:48-113`, `test-helpers.ts:59-76` |
| Controller/route/service patterns | search/document/readStatus triads (edge validation, Spanish msg + English code, no-Express service, ports-only deps) | `packages/backend/src/{presentation,routes,application}/**` |

### Net-new surface (what 5.1 actually writes)

`shared/src/schemas/chat.ts`; `backend/src/domain/repositories/{chatModel,ragRetriever,conversationRepository}.ts`;
`backend/src/infrastructure/{chatModel.langchain,ragRetriever.drizzle,conversationRepository.drizzle}.ts`;
`backend/src/agent/**` (StateGraph + system prompt + buildRAGContext + `runChat`);
`backend/src/application/services/chatService.ts`; `backend/src/presentation/controllers/chatController.ts`;
`backend/src/routes/chatRoutes.ts`; wiring in `app.ts`/`main.ts`/`test-helpers.ts`; integration test;
`@langchain/langgraph` dep; ESLint rule; spike deletion.

### Architecture compliance (guardrails — non-negotiable)

- **AD-1/AD-2:** code under `packages/backend/src/`; agent/service/controller depend on
  `@hivly/shared` and local ports only — never on `drizzle-orm` or LangChain directly. LangChain
  lives behind `chatModel.langchain.ts` (the only agent-side importer of the provider factory);
  Drizzle behind the `*.drizzle.ts` adapters. Never import a sibling service.
- **AD-4:** SSE, not WebSocket; `text/event-stream`; frames per `sse.ts`. Client (5.4) uses fetch
  streaming — this story only produces the stream.
- **AD-6:** the request shape is a Zod schema in `shared`; validate at the edge. Reuse the
  existing `SSEFrameSchema` for the wire format.
- **AD-11:** real LangGraph `StateGraph` with explicit nodes; no `langchain/chains` / `langchain/memory`
  (ESLint-enforced). Conversation history is explicit graph state (`messages`), not hidden in a
  memory object.
- **AD-12:** RBAC is a clause of the retrieve query (via `searchByEmbedding`), computed
  per-request; no chat query runs before `allowedChannelIds` is resolved; empty scope → nothing,
  no paid embed call.
- **AD-7:** already satisfied by `nginx.conf` — verify unchanged.
- **AD-8:** `main.ts` calls `loadConfig()` first; `config.agent` drives the model.
- **Language rule:** all code/comments/logs in English; never log secrets or full message
  content; map errors to `{ error, code }` and never leak raw LLM/DB errors to the client.
  (Spanish only appears in user-facing 400/404 `error` message strings, matching `searchController`.)

### Design Decisions (autonomous, within story scope — implement as specified)

- **D1 — Agent↔Express boundary = async generator.** The agent exposes
  `runChat(input): AsyncIterable<SSEFrame>` (or an emit callback); the controller owns `res` and
  writes frames. This keeps the graph/service Express-free and unit-testable (assert the frame
  sequence with fakes), mirroring `searchService`'s no-Express rule. Token streaming uses the
  `ChatModel.stream()` port.
- **D2 — 5.1 emits only the four shipped frame types.** `sse.ts` defines exactly
  token/citation/done/error. Story 5.4's AC mentions `tool_call`/`observation` frames in colors,
  but those types do NOT exist in `sse.ts` — extending the schema + emitting them is a future
  concern (5.4 or a schema story), NOT 5.1. Build the graph tool-loop-ready but bind no tools and
  emit no tool frames now.
- **D3 — Config key corrections (the TECHNICAL-DESIGN pseudo-code is wrong here).**
  `TECHNICAL-DESIGN.md §9` references `config.knowledge.topK` and `config.agent.memoryBudget` —
  **neither exists** in `HivlyConfigSchema`. Real keys: there is NO topK anywhere (Story 4.1
  hardcoded a local cap; do the same — `RETRIEVE_TOP_K = 5` constant in the agent), and history
  budgeting uses `config.agent.memory_window` (a NUMBER — treat as a turn-COUNT window in 5.1).
  For 5.1, `reason` TRUNCATES history to the last `memory_window` turns (cheap, deterministic).
  Real `compressIfNeeded()` SUMMARIZATION is explicitly Story 5.2 ("compressIfNeeded() comprime
  mensajes históricos") — do NOT build it here.
- **D4 — retrieve reuses `searchByEmbedding`, not the TD's raw drizzle query.** The `§9`
  `retrieve` pseudo-code (`db.select().from(embeddings)...`) would import drizzle into the agent
  (AD-2 violation) and re-implement the RBAC + deleted-message logic. Instead the retrieve node
  goes through the `RagRetriever` port whose adapter composes the existing `queryEmbedder` +
  `searchByEmbedding` — inheriting AC4 (RBAC-in-query) and AC5 (deleted-if-ANY) for free.
- **D5 — citations.** One `citation` frame per retrieved fragment:
  `{ type:'citation', channel: f.channelName, author: f.authorName, date: f.createdAt }`.
  `authorName` currently falls back to `authorId` (no display name persisted yet — Story 4.1 D2).
  Persist the same `{channel,author,date}` array on the assistant `messages.citations`.
- **D6 — chat model injection mirrors the embedder.** `AppOptions.chatModel?: ChatModel`
  required at runtime; `main.ts` builds it from `config.agent`; tests inject `fakeChatModel()`.
- **D7 — request contract.** `conversationId` optional/nullable (api-spec) → absent means new
  conversation. Cap `message` length (`CHAT_MESSAGE_MAX_LENGTH = 4000`) like search caps `q`
  (cost/DoS on an authenticated endpoint).
- **D8 — two-phase error handling.** Pre-stream (headers not yet sent): 400/404/401 as JSON
  `ErrorSchema`. Mid-stream (headers flushed): can't change status → emit an `error` frame then
  `res.end()`. `req.on('close')` aborts the model stream (AbortController) to stop token spend.
- **D9 — ESLint flat-config gotcha.** `banSiblingServices('backend')` currently OWNS the whole
  `no-restricted-imports` option for backend files; a later config object setting the same rule
  would clobber the sibling ban (documented at `eslint.config.js:22-29` for `web`). So FOLD the
  `langchain/chains`+`langchain/memory` `patterns` INTO the backend block, keeping the sibling
  ban in the same object. Verify BOTH bans fire.
- **D10 — spike is fully removed** (AC11); the harness gets the real endpoint via the
  `fakeChatModel` default in `buildTestAppOptions`.
- **D11 — harness stays green.** Because `buildTestAppOptions` now defaults a `chatModel`, the
  4.5 e2e server (`e2e/server.ts`) and every existing integration test keep booting `createApp`
  without change beyond deleting the spike. Confirm `npm run test:integration` and (if run)
  `npm run test:e2e` still pass.
- **D12 — real token streaming via LangGraph's custom stream channel (implementation refinement
  of D1).** The `respond` node calls `getWriter(config)` (LangGraph 1.4's per-invocation writer,
  scoped by the node's own `config` param — no shared/module-level state, so concurrent chat
  requests never cross-emit) and pushes each `chatModel.stream()` chunk as a `token` SSEFrame
  through it. `runChat` calls `graph.stream(initialState, { streamMode: ['custom', 'values'] })`
  and forwards `custom` chunks live while capturing the final `values` chunk for
  `retrievedFragments` (used to build citation frames after the graph settles). This keeps AC2
  (a REAL StateGraph with explicit nodes) AND true incremental token streaming — the tokens are
  not buffered until the graph finishes.
- **D13 — 5.1 does not load prior conversation turns into the prompt.** `ConversationRepository`
  (Task 3) has no message-listing method — deliberately, per the ports as scoped — so
  `chatService.streamChat` always passes `history: []` to `runChat`. The `reason` node's
  `memory_window` truncation (D3) is fully built and unit-tested, but in 5.1's actual wiring it
  only ever truncates the single new turn; loading persisted history into the prompt is deferred
  to Story 5.2 (conversation history). Each turn's persistence (both messages saved, conversation
  continuity via `conversationId`) is unaffected — only the LLM's own context window is scoped to
  the current message until 5.2 lands.
- **D14 — chatService split into `resolveConversation` + `streamChat` (refinement of D8).**
  D8 requires the ownership check to complete BEFORE any SSE header is sent. Since `streamChat`
  is an async generator (lazy — its body doesn't run until iterated), the ownership check cannot
  live inside it and still run pre-flush. `resolveConversation` (plain async function, awaited by
  the controller before `res.flushHeaders()`) resolves/creates the conversation and throws
  `ChatOwnershipError` on an unknown/unowned id; `streamChat` runs the turn against the
  already-resolved conversation. The controller maps `ChatOwnershipError` to a pre-stream 404.
- **D15 — `docs/api-spec.yml` had no `404` response documented for `POST /api/chat`** (only
  400/401) even though D8's ownership check requires one. Added `"404": { $ref:
  "#/components/responses/NotFound" }` — a spec-completeness fix, not a request/response shape
  change (the shapes already matched `ChatRequestSchema`/`SSEFrame` exactly).

### Files being modified (read current state before editing — AD-3-style regression guard)

- `packages/backend/src/app.ts` — composition root; add chat wiring AFTER the `/api` gate; add
  `chatModel?` to `AppOptions`. Preserve the existing `queryEmbedder` required-at-runtime throw
  pattern and the ordering comments (auth router before the generic gate).
- `packages/backend/src/main.ts` — build + inject `chatModel`; preserve the `loadConfig`-first /
  materialize-permissions / shutdown structure.
- `packages/backend/src/test-helpers.ts` — add `fakeChatModel()` + default it in
  `buildTestAppOptions`; preserve `fakeQueryEmbedder`/`openTestClients`/existing defaults.
- `packages/backend/src/e2e/server.ts` — remove ONLY the spike (Task 9); keep seed/reset/OAuth/
  shutdown intact so 4.5's harness still works.
- `eslint.config.js` — extend the backend block only (Task 2/D9); don't touch the web/sibling logic elsewhere.
- `packages/shared/src/schemas/index.ts` — add the chat re-export.
- `packages/backend/package.json` (+ root `package-lock.json`) — add `@langchain/langgraph`.

### Testing standards

- Vitest, co-located `*.test.ts`, AAA, behavior names (`should <behavior> when <condition>`).
- Tests-first for the agent graph + chatService (orchestration/domain per project-context) — write
  red then green; adapters (controller/Drizzle) may test after.
- Mock the LLM + embeddings in unit tests (never real network). Integration test hits real
  Postgres+pgvector (the value is in the RBAC SQL + persistence).
- MUST-test per project-context: RBAC (a fragment outside `allowedChannelIds` never surfaces as a
  citation) and the deleted-message exclusion. Also test the frame ordering and persistence.

### Project Structure Notes

- New `packages/backend/src/agent/` directory is expected by backend-standards (`§structure`:
  `agent/ # LangGraph StateGraph (retrieve → reason → respond)`).
- File naming: `camelCase.ts` modules; ports in `domain/repositories/`, adapters in
  `infrastructure/` suffixed by mechanism (`.langchain.ts` / `.drizzle.ts`), service in
  `application/services/`, controller in `presentation/controllers/`, route in `routes/`.
- No migration: `conversations`/`messages` already exist in the schema and in `0001_tough_skrulls.sql`.

### Previous-story intelligence (Epic 4, esp. 4.5 harness + retro action items)

- **AI#7 (SSE spike) is consumed by this story** — the spike proved fetch-streaming works
  incrementally through the vite-preview proxy and established the exact server framing pattern
  (`data: <json>\n\n`, `flushHeaders`, `req.on('close')`). Copy the pattern, then delete the
  spike (AC11).
- **Epic 4 retro critical-path item: "extend the harness with chat/SSE specs" lands with 5.3/5.4**,
  not 5.1 — but 5.1 must make `/api/chat` reachable in the harness backend (D11) so 5.4 can.
- **Epic 3 retro AI#1 — treat every applied patch as new un-reviewed code**: during
  `bmad-code-review`, re-review patches independently.
- **Story 4.1 D2** — `authorName` still falls back to `authorId` (no display name persisted);
  citations inherit this until the deferred display-name follow-up.
- **The visual-AC lesson does NOT apply** — 5.1 is backend-only, no CSS/visual ACs. Its
  verification is the integration test + a live `curl -N` of the SSE stream (AC12), not Playwright.

### Latest tech

- `@langchain/langgraph@1.4.7` (current) — peer `@langchain/core: ^1.1.48` (installed `^1.2.1` ✓)
  and `zod: ^3.25.32 || ^4.2.0` (repo uses zod 4 ✓). Stack table pins it at 1.4
  (`backend-standards.md:68`, project-context "@langchain/langgraph 1.4"). Use LangGraph's typed
  `StateGraph` / `Annotation` state API (v1.x). For token streaming, drive the model via the
  `ChatModel.stream()` port and yield chunks; if using `graph.stream(..., { streamMode: 'messages' })`,
  keep the frame emission in the `runChat` generator, not inside a node (D1).
- Provider factory returns `BaseChatModel` — its `.stream()` yields message chunks whose
  `.content` is the token text; the adapter normalizes that to `string` chunks for the port.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Historia-5.1] (lines 801–818) — ACs (BDD).
- [Source: docs/context/ARCHITECTURE-SPINE.md] — AD-4 (SSE), AD-7 (nginx buffering), AD-11
  (LangGraph StateGraph + legacy-import ban), AD-12 (RBAC in query).
- [Source: docs/context/TECHNICAL-DESIGN.md#9] — RAG agent graph shape + AgentState + wire example
  (NOTE the `knowledge.topK` / `agent.memoryBudget` naming errors — see D3/D4).
- [Source: docs/backend-standards.md] — RAG Agent (§lines 799–804), SSE wire format (§746–758),
  `Citation.fromSSEFrame` (§322), StateGraph extension pattern (§542), structure (`agent/`).
- [Source: docs/api-spec.yml] (lines 160–184, 296–317) — `POST /api/chat` contract + `SSEFrame`.
- [Source: docs/data-model.md] + `packages/shared/src/db/schema.ts:30,111-131` — `conversations`/
  `messages`/`Citation`; owner = backend.
- [Source: packages/shared/src/schemas/sse.ts] — the wire contract to reuse.
- [Source: packages/shared/src/providers/index.ts] — `createChatModel`.
- [Source: packages/backend/src/infrastructure/embeddingSearchRepository.drizzle.ts] — reuse for retrieve.
- [Source: packages/backend/src/app.ts, main.ts, test-helpers.ts] — injection + composition pattern.
- [Source: packages/backend/src/e2e/server.ts:37-70] — spike (pattern to copy, then delete).
- [Source: nginx.conf:26-33] — AD-7 block (already correct).
- [Source: _bmad-output/project-context.md] — project rules digest.

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5)

### Debug Log References

Live SSE exercise (AC12) — `docker compose` postgres/redis already running; started the e2e
backend (`npm run e2e:server -w @hivly/backend`, port 3100), logged in via the fake OAuth
(`code=e2e-member`), then `curl -N` POST `/api/chat`:

```
data: {"type":"token","content":"Hola"}

data: {"type":"token","content":" desde"}

data: {"type":"token","content":" Hivly"}

data: {"type":"token","content":"."}

data: {"type":"citation","channel":"general","author":"e2e-author-ada","date":"2026-06-01T10:00:00.000Z"}

data: {"type":"citation","channel":"general","author":"e2e-author-linus","date":"2026-06-02T10:00:00.000Z"}

data: {"type":"citation","channel":"general","author":"e2e-author-ada","date":"2026-06-03T10:00:00.000Z"}

data: {"type":"citation","channel":"random","author":"e2e-author-linus","date":"2026-06-04T10:00:00.000Z"}

data: {"type":"citation","channel":"random","author":"e2e-author-ada","date":"2026-06-05T10:00:00.000Z"}

data: {"type":"done","conversationId":"ccc5ee27-7338-4f01-9b17-6233cba5828a"}
```

Frame order confirmed: N tokens → M citations → one terminal `done` (AC6). E2e server stopped after the exercise.

### Completion Notes List

- All 11 tasks implemented and unit/integration-tested; see Design Decisions D12–D15 in Dev Notes
  for implementation-time refinements (real token streaming via LangGraph's custom stream
  channel, the chatService two-method split for D8's pre-stream ownership check, the deferred
  history-loading scope boundary, and the `api-spec.yml` 404 documentation fix).
- Verification gate: `npm run lint` (0 errors) && `npm run test` (389 passed, 52 files) &&
  `npm run test:integration` (83 passed, 14 files, incl. 7 new `chat.integration.test.ts` cases)
  && `npm run build` (4/4 packages clean) — all green.
- Live exercise: real e2e backend + real Postgres/Redis + fake OAuth + fake chat model; `curl -N`
  confirms the real `/api/chat` endpoint streams the correct frame sequence end-to-end (Debug Log
  above).
- ESLint legacy-LangChain ban (AC7) proven to fire (temporarily added `import 'langchain/memory'`
  to a backend file, confirmed `npm run lint` errors, removed it) without regressing the existing
  sibling-service ban.
- Spike fully removed (AC11): `mountSpikeChatSse` + its call deleted from `e2e/server.ts`;
  `packages/web/tests/chat-sse-spike.spec.ts` deleted; no dangling `_spike`/`chat-sse-spike`
  references remain outside this story file's own task description.

### File List

**Shared:**
- `packages/shared/src/schemas/chat.ts` (new)
- `packages/shared/src/schemas/chat.test.ts` (new)
- `packages/shared/src/schemas/index.ts` (modified — export chat.js)

**Backend — domain ports:**
- `packages/backend/src/domain/repositories/chatModel.ts` (new)
- `packages/backend/src/domain/repositories/ragRetriever.ts` (new)
- `packages/backend/src/domain/repositories/conversationRepository.ts` (new)

**Backend — infrastructure adapters:**
- `packages/backend/src/infrastructure/chatModel.langchain.ts` (new)
- `packages/backend/src/infrastructure/ragRetriever.drizzle.ts` (new)
- `packages/backend/src/infrastructure/conversationRepository.drizzle.ts` (new)

**Backend — agent (LangGraph StateGraph):**
- `packages/backend/src/agent/graph.ts` (new)
- `packages/backend/src/agent/graph.test.ts` (new)
- `packages/backend/src/agent/prompt.ts` (new)

**Backend — application/presentation/routes:**
- `packages/backend/src/application/services/chatService.ts` (new)
- `packages/backend/src/application/services/chatService.test.ts` (new)
- `packages/backend/src/presentation/controllers/chatController.ts` (new)
- `packages/backend/src/presentation/controllers/chatController.test.ts` (new)
- `packages/backend/src/routes/chatRoutes.ts` (new)

**Backend — composition root + test defaults:**
- `packages/backend/src/app.ts` (modified — chat wiring after the `/api` gate)
- `packages/backend/src/main.ts` (modified — build + inject `chatModel`)
- `packages/backend/src/test-helpers.ts` (modified — `fakeChatModel()` + default)
- `packages/backend/src/chat.integration.test.ts` (new)

**Backend — spike removal:**
- `packages/backend/src/e2e/server.ts` (modified — `mountSpikeChatSse` deleted)
- `packages/web/tests/chat-sse-spike.spec.ts` (deleted)

**Backend — deps + lint:**
- `packages/backend/package.json` (modified — `@langchain/langgraph` dependency)
- `package-lock.json` (modified — lockfile diff for the new dependency)
- `eslint.config.js` (modified — langchain-legacy `no-restricted-imports` ban folded into the backend block)

**Docs:**
- `docs/api-spec.yml` (modified — added `404` response for `POST /api/chat`)

## Change Log

| Date | Change |
|---|---|
| 2026-07-07 | Story 5.1 created via bmad-create-story (Epic 5 first story; epic-5 backlog → in-progress). Comprehensive context: full Reuse Map (SSE schema/provider factory/pgvector RBAC search/conversations tables all already exist; no migration; nginx block already correct), 11 design decisions incl. config-key corrections (no `knowledge.topK`/`agent.memoryBudget` — use local `RETRIEVE_TOP_K`=5 + `agent.memory_window` as turn-count truncation, summarization deferred to 5.2), async-generator agent↔Express boundary, `@langchain/langgraph@^1.4.7` to add, ESLint flat-config fold-in gotcha for the langchain-legacy ban, and spike removal. Status → ready-for-dev. |
| 2026-07-07 | Story 5.1 implemented via bmad-dev-story on branch `feat/5-1-endpoint-sse-chat-rag` (baseline `9b06416`). All 11 tasks done; 4 new design-decision refinements recorded (D12–D15: LangGraph custom-stream-writer token streaming, chatService `resolveConversation`/`streamChat` split for D8, deferred history-loading scope note, `api-spec.yml` 404 fix). Verification gate green: lint 0 errors, 389 unit tests, 83 integration tests (incl. 7 new chat SSE cases), build clean (4/4 packages). Live `curl -N` exercise confirms the real endpoint end-to-end. Status → review. |
| 2026-07-07 | Code review (bmad-code-review, 3 adversarial layers: Blind Hunter + Edge Case Hunter + Acceptance Auditor, Opus 4.8). Auditor: 12/12 ACs SATISFIED; 9 findings dismissed (verified false-positives / convention / accepted-by-spec). 1 decision (orphaned-turn-on-interruption → resolved: persist partial answer) + 5 patches applied, all on the streaming/error path: (1) persist partial answer + touchConversation in try/finally so an interrupted turn never orphans the user message; (2) thread `AbortSignal` through the `ChatModel` port → adapter → provider so client disconnect actually cancels paid generation; (3) persist assistant BEFORE emitting `done` (was a reload race + a `done`-then-`error` contradiction on post-done persist failure); (4) guard `res.write` against a closed socket + `res.on('error')` swallow; (5) guard `slice(-memoryWindow)` against `memory_window <= 0` (latent for 5.2). 3 regression tests added. Gate re-run green: lint 0, 392 unit (+3), 83 integration, build clean (4 pkgs). Status → done. |
| 2026-07-07 | Code review ROUND 2 (bmad-code-review re-run over a patch-only diff — Epic 3 retro AI#1: the 5 round-1 patches are new un-reviewed code). Acceptance Auditor: patches preserve all 12 ACs, 0 regressions. Edge Case Hunter VERIFIED the libraries (LangGraph 1.4.7 rethrows the AbortError out of `graph.stream`; LangChain honors `RunnableConfig.signal`) → the round-1 abort fix works end-to-end. 7 findings dismissed (signal-wiring/`{signal}`-contract = diff-scope false positives, verified present+honored; silent-loss-without-`done` = impossible by construction; memoryWindow NaN/fractional = config-schema scope, dead-path in 5.1; persist-partial-for-gone-client = accepted decision). 5 NEW patches (gaps the round-1 patches themselves introduced on the error path): (1) skip persisting a zero-token/empty assistant turn; (2) make `touchConversation` best-effort so a timestamp bump can't fail a committed turn (→ error frame + client retry + duplicate); (3) wrap `res.write` in try/catch (synchronous EPIPE not caught by `res.on('error')` → unhandled rejection); (4) symmetric `res.end()` guard + `res.on('error')` now logs; (5) added tests for the round-1 guard paths (writeFrame-skip-on-destroyed, sync-write-throw, memoryWindow<=0). Gate re-run green: lint 0, 398 unit (+6), 83 integration, build clean (4 pkgs). Status stays done. |
