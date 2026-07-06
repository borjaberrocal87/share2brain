---
baseline_commit: cf1054bf20cf2f848b0597701867edfdf3919dbb
---

# Story 4.1: Backend — API de búsqueda semántica

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a community member,
I want to search the indexed knowledge with natural language,
so that the system returns the most relevant fragments while respecting the channels I have access to.

This is the **first story of Epic 4** (Search, Documents & Read Tracking) and the **first read-side
consumer of the `embeddings` table** the Indexer populated in Epic 3. It is also the **first pgvector
similarity query in the codebase** — Epic 3 only wrote vectors; this story reads them. It makes the
AD-12 invariant concrete for the first time: **RBAC lives inside the vector query, never as a
post-filter.**

## Acceptance Criteria

**AC1 — Happy path (`GET /api/search?q=texto` with a valid session):**
1. Validates the query with a Zod schema in `packages/shared/src/schemas/`.
2. Generates the query embedding with the embeddings client from the provider factory
   (`createEmbeddingsModel(config.embeddings)`), asserting the returned vector width equals
   `config.embeddings.dimensions`.
3. Runs the vector search in pgvector with the **mandatory** filter
   `WHERE channel_id = ANY(:allowedChannelIds)` **inside** the query (AD-12).
4. Returns fragments ordered by **cosine similarity descending**.

**AC2 — Response shape:** each fragment includes `id`, `content`, `channelId`, `channelName`,
`authorId`, `authorName`, `createdAt`, `similarity` (float 0–1), `messageId`. Fragments whose
grouped chunk contains **any** message with `deleted_at IS NOT NULL` are **excluded** (see
Decision D1).

**AC3 — Empty RBAC scope:** a user with access to no channel (`allowedChannelIds = []`) gets
**HTTP 200 with an empty results array** — and the vector query is **not executed** (short-circuit).

**AC4 — Missing query param:** a search with no `q` (or blank/whitespace-only) returns **HTTP 400**
with `{ error: "Query requerida", code: "VALIDATION_ERROR" }`.

**AC5 (derived, non-negotiable):** the RBAC filter is part of the SQL vector query itself — never a
JS `.filter()` over query results. A test must prove a fragment outside `allowedChannelIds` is never
returned (Testing rules: "queries never return fragments outside `allowedChannelIds`").

---

## Design Decisions (resolved with Borja at story creation — 2026-07-06)

These two were explicitly deferred to Story 4.1 creation by the Epic 3 retrospective (Action Item #2)
and by a gap discovered while writing this story. Both are **confirmed**.

### D1 — `deleted_at` exclusion over grouped chunks → **EXCLUDE-IF-ANY**
`deleted_at` lives on `discord_messages`, not `embeddings`, and a chunk groups **multiple** messages
(`message_ids` array). **Exclude the whole chunk if ANY message in `message_ids` has
`deleted_at IS NOT NULL`.**
- **Why:** the chunk's stored `content` physically concatenates all grouped messages, so a deleted
  message's text is *inside* the chunk. Exclude-if-any is the only rule that guarantees deleted
  content is never surfaced.
- `messageDelete` handling is Epic 6, so `deleted_at` is **always NULL today** — but AC2 requires the
  query be written correctly from the start. Implement as an anti-join / `NOT EXISTS`.
- [Source: epic-3-retro-2026-07-06.md#5 Action Items — #2; sprint-status action_items epic:3]

### D2 — Author + anchor fields → **anchor = `message_ids[0]`, `authorName` = `authorId`**
The response needs a **single** `messageId`/`authorId`/`authorName`/`createdAt` per fragment, but a
chunk groups many messages, and **`discord_messages` stores only `authorId`** — no author display
name is persisted anywhere (`users` holds only OAuth *app*-users, not message authors).
- **Anchor message = `message_ids[0]`** — the message that anchors `chunk_key`
  (Story 3.3 builds `chunkKey = \`${group.messageIds[0]}:${i}\``). `messageId`, `authorId`, and
  `createdAt` come from that anchor message's `discord_messages` row. This is consistent with Epic 3
  retro Action Item #3's candidate for the "view in Discord" link.
- **`authorName` falls back to the `authorId` string** for now — it is the only truthful value
  available. The contract field stays present and stable.
- **Follow-up (epic-level, before Story 4.3):** real author **display name + avatar** resolution has
  no data source today. This is a known gap for the whole Search/Documents UI (4.3 renders author
  name + avatar). Flag it in the retro/deferred-work; do **not** solve it here (it would require a
  schema change + bot capture + re-backfill — out of the one-story boundary).
- [Source: schema.ts discord_messages (authorId only) / embeddings.messageIds; indexBatch.ts:187]

---

## Tasks / Subtasks

- [x] **Task 1 — Zod contract in `packages/shared/src/schemas/search.ts` (AC1, AC2, AC4)**
  - [x] `SearchQuerySchema`: `{ q: z.string().trim().min(1), limit: z.coerce.number().int().min(1).max(50).default(5) }`
        (query params arrive as strings → `z.coerce.number()` for `limit`).
  - [x] `SearchFragmentSchema`: `id` (`z.uuid()`), `content` (`z.string()`), `channelId` (`z.string()`),
        `channelName` (`z.string()`), `authorId` (`z.string()`), `authorName` (`z.string()`),
        `createdAt` (`z.string()` — ISO 8601), `similarity` (`z.number().min(0).max(1)`),
        `messageId` (`z.string()`).
  - [x] `SearchResponseSchema`: `{ results: z.array(SearchFragmentSchema) }`.
  - [x] `SEARCH_ERROR` const map: `{ VALIDATION_ERROR: 'VALIDATION_ERROR', INTERNAL: 'INTERNAL' }`
        (mirror the `AUTH_ERROR` pattern in `schemas/auth.ts`).
  - [x] Export all from `packages/shared/src/schemas/index.ts` (add `export * from './search.js'`).
  - [x] Unit test the schema (mirror `sse.test.ts`): rejects missing/blank `q`, coerces `limit`,
        caps `limit` at 50, defaults to 5.

- [x] **Task 2 — Domain port + Drizzle adapter for the vector query (AC1, AC2, AC3, AC5)**
  - [x] `domain/repositories/embeddingSearchRepository.ts`: port
        `searchByEmbedding(queryVector: number[], allowedChannelIds: string[], limit: number): Promise<SearchFragmentRow[]>`
        where `SearchFragmentRow` is the raw row (pre-Zod) shape.
  - [x] `infrastructure/embeddingSearchRepository.drizzle.ts`: the ONLY file that knows the SQL.
        Build the query with `@hivly/shared/db` re-exports (never import `drizzle-orm` directly, AD-2).
    - [x] **Short-circuit AC3:** `if (allowedChannelIds.length === 0) return [];` — MUST come first.
          `inArray`/`ANY([])` on an empty array is unsafe (the shared/db barrel explicitly warns
          `inArray` throws on empty arrays).
    - [x] Vector search with cosine distance operator `<=>`; RBAC filter and `deleted_at` exclusion
          in the same query (see "SQL blueprint" in Dev Notes). RBAC via re-exported `inArray`
          (a raw JS-array interpolation is expanded by drizzle into comma params — would break `ANY`).
    - [x] `similarity = GREATEST(0, LEAST(1, 1 - (embedding <=> :queryVec)))`; `ORDER BY (embedding <=> :queryVec) ASC`
          (ascending distance = descending similarity); `LIMIT :limit`.
    - [x] Bind the query vector as a pgvector literal (see the "query-vector serialization" gotcha).
  - [x] Integration test against real Postgres+pgvector (see Testing). 6 tests green.

- [x] **Task 3 — Query embedder port + adapter (AC1)**
  - [x] `domain/repositories/queryEmbedder.ts`: port `{ embedQuery(text: string): Promise<number[]> }`.
  - [x] `infrastructure/queryEmbedder.langchain.ts`: adapter wrapping `createEmbeddingsModel(config.embeddings)`
        from `@hivly/shared/providers`; call `.embedQuery(text)`, then `assertEmbeddingDimensions(vector, config.embeddings.dimensions)`
        before returning (reuse the guard that already exists in `providers/index.ts`).
  - [x] Keep the LangChain import behind this adapter only (do not leak it into the service/controller).

- [x] **Task 4 — Application service (AC1, AC2, AC3)**
  - [x] `application/services/searchService.ts`: `createSearchService({ embedder, searchRepo })` returning
        `{ search(q: string, limit: number, allowedChannelIds: string[]): Promise<SearchResponse> }`.
    - [x] AC3 fast path: if `allowedChannelIds.length === 0`, return `{ results: [] }` **without** embedding
          the query (skip the paid embeddings call — no point).
    - [x] Otherwise: `embedder.embedQuery(q)` → `searchRepo.searchByEmbedding(vec, allowedChannelIds, limit)`
          → map rows to fragments → `SearchResponseSchema.parse(...)` before returning (AD-6, mirror
          `rbacService.getRolesResponse`).
  - [x] Depends only on the two ports — unit-testable with plain fakes (no Drizzle, no LangChain, no Express).
  - [x] Unit test: empty scope → `[]` and embedder NOT called; happy path maps + validates; anchor
        field mapping (D2) is correct. 4 tests green.

- [x] **Task 5 — Presentation controller + route (AC1, AC3, AC4)**
  - [x] `presentation/controllers/searchController.ts`: `search(req, res)` handler (mirror
        `authController` structure).
    - [x] Parse `req.query` with `SearchQuerySchema.safeParse`; on failure →
          `res.status(400).json({ error: 'Query requerida', code: SEARCH_ERROR.VALIDATION_ERROR })`.
    - [x] `const allowedChannelIds = req.allowedChannelIds ?? []` (populated by the RBAC middleware).
    - [x] Call the service; `res.status(200).json(payload)`.
    - [x] `try/catch` → log + `res.status(500).json({ error: 'Internal error', code: SEARCH_ERROR.INTERNAL })`;
          never leak the raw DB/LLM error (language rule).
  - [x] `routes/searchRoutes.ts`: `createSearchRouter(controller)` → `router.get('/', ...)`.
  - [x] Controller unit test: 400 on missing/blank `q`; 500 mapped to ErrorSchema without leaking; 200 payload. 5 tests green.

- [x] **Task 6 — Wire into the composition root (`app.ts` + `main.ts`)**
  - [x] `app.ts`: after the generic `/api` gate (line ~75), build searchRepo (Drizzle), searchService,
        searchController, and `app.use('/api/search', createSearchRouter(searchController))`. The
        search router inherits `requireAuth` + `createRbacMiddleware` because it is registered under
        `/api` after that gate — do NOT re-add them (verify ordering: gate at line 75 runs first).
  - [x] The query embedder needs `config.embeddings`, which `app.ts` does not currently receive.
        Follow the `oauth?` injection precedent: add `queryEmbedder?: QueryEmbedder` to `AppOptions`;
        `main.ts` builds the real adapter from `config.embeddings` and passes it; `createApp` uses
        `opts.queryEmbedder ?? <error>` (there is no config in `createApp` to build a default, so an
        injected value is required in `main.ts`).
  - [x] `test-helpers.ts` `buildTestAppOptions`: provide a **fake `queryEmbedder`** (deterministic
        vector) so integration tests don't hit a real embeddings endpoint.
  - [x] End-to-end endpoint integration test (`search.integration.test.ts`): 401/400/200 + RBAC scope
        + AC3. All backend integration green: 5 files / 22 tests.

- [x] **Task 7 — Verification gate (mandatory, agent runs it — never the user)**
  - [x] `npm run lint && npm run test && npm run build` — GREEN: lint 0 errors · 237 unit (33 files) ·
        build clean (backend, bot, shared, web, workers).
  - [x] Real-infra integration test green (real Postgres+pgvector) — `embeddingSearchRepository.drizzle.integration.test.ts`
        (6 tests). Full integration suite: 8 files / 32 tests green (no regressions).
  - [x] Exercise the endpoint end-to-end against real infra — `search.integration.test.ts` seeds
        `channel_permissions` + `discord_messages` + `embeddings`, logs in a member, and hits
        `GET /api/search`: 401/400/200, RBAC scoping (denied fragment identical to query never
        surfaces), AC3 empty scope → `{ results: [] }`.

---

## Dev Notes

### Architecture layering (mirror the existing auth vertical slice — do NOT invent a new pattern)
The backend is hexagonal/DDD. Copy the shape already established by the auth feature:
`domain/repositories/*` (ports) → `infrastructure/*.drizzle.ts` / `*.langchain.ts` (adapters) →
`application/services/*` (pure, port-only deps) → `presentation/controllers/*` (HTTP) →
`routes/*` (Express router) → composed in `app.ts`. The service must be unit-testable with plain
fakes (no Drizzle, no Express, no LangChain) — exactly like `rbacService`/`authService`.
[Source: packages/backend/src/app.ts:36-77; rbacService.ts; channelPermissionRepository.drizzle.ts]

### AD-12 — RBAC INSIDE the query (the whole point of this story)
The RBAC middleware (`middleware/rbac.ts`) already runs on every `/api/*` request and attaches
`req.allowedChannelIds` (recomputed per-request from `channel_permissions`, never cached in the
session). The search route inherits it via the `/api` gate in `app.ts:75`. The filter
`channel_id = ANY(:allowedChannelIds)` must be a clause of the vector SQL, **not** a JS filter over
results. Post-filtering leaks private channels and is an explicit anti-pattern.
[Source: project-context.md "RBAC lives INSIDE the vector query"; middleware/rbac.ts; ARCHITECTURE-SPINE AD-12]

### SQL blueprint (the first pgvector query in the repo)
`embedding <=> :queryVec` is pgvector **cosine distance** (0 = identical, up to 2 = opposite), backed
by the existing HNSW index `idx_embeddings_vector … USING hnsw (embedding vector_cosine_ops)` and the
btree `idx_embeddings_channel` for the RBAC filter. `similarity = 1 - distance`, clamped to `[0,1]`.

Recommended shape (Drizzle query-builder + a `sql` fragment for the distance; or a full `sql` template
via `db.execute` — either is fine, keep it in the adapter):

```sql
SELECT
  e.id,
  e.content,
  e.channel_id                         AS "channelId",
  cp.name                              AS "channelName",
  dm.author_id                         AS "authorId",
  dm.author_id                         AS "authorName",   -- D2: no display name persisted yet
  dm.created_at                        AS "createdAt",
  dm.id                                AS "messageId",     -- D2: anchor = message_ids[0]
  GREATEST(0, LEAST(1, 1 - (e.embedding <=> :queryVec))) AS similarity
FROM embeddings e
JOIN channel_permissions cp ON cp.channel_id = e.channel_id
JOIN discord_messages   dm ON dm.id = e.message_ids[1]     -- Postgres arrays are 1-indexed
WHERE e.channel_id = ANY(:allowedChannelIds)
  AND NOT EXISTS (                                          -- D1: exclude-if-ANY deleted
    SELECT 1 FROM discord_messages d
    WHERE d.id = ANY(e.message_ids) AND d.deleted_at IS NOT NULL
  )
ORDER BY (e.embedding <=> :queryVec) ASC
LIMIT :limit;
```
Notes:
- `message_ids[1]` is the anchor (Postgres arrays are 1-indexed; `message_ids[0]` in JS/TS = SQL `[1]`).
- The anchor `discord_messages` row is expected to exist (the Indexer stamps `indexed_at` on it before
  the row is queryable), but use a plain `JOIN` — if for some reason it is absent, dropping the chunk
  is acceptable and safe.
- The `channel_permissions` JOIN is safe as an INNER JOIN: `allowedChannelIds` are derived *from*
  `channel_permissions`, so every RBAC-visible `channel_id` has a matching row.

### GOTCHA — query-vector serialization (this WILL bite if done naively)
Drizzle's `vector` column accepts a `number[]` on **insert** (Story 3.3 does `embedding: vectors[i]`),
but binding a JS array into a raw `sql` fragment for the `<=>` operator makes node-postgres send a
Postgres **array** literal (`{1,2,3}`), which pgvector rejects. Serialize the query vector as a
pgvector **text literal** and cast it:
```ts
const vecLiteral = JSON.stringify(queryVector); // number[] → "[0.1,0.2,...]" — exactly pgvector's text format
// ... sql`... e.embedding <=> ${vecLiteral}::vector ...`
```
`JSON.stringify` of a `number[]` yields `[a,b,c]`, which is pgvector's text representation; the
`::vector` cast makes Postgres parse it. Use the SAME bound literal in both the `SELECT` similarity
expression and the `ORDER BY` (or compute distance once in a subquery/CTE to avoid double evaluation).

### Empty-array short-circuit (AC3) — two places
1. `searchService`: if `allowedChannelIds.length === 0` → return `{ results: [] }` and **skip embedding
   the query** (don't pay for an embeddings call that can only return nothing).
2. `embeddingSearchRepository`: defensively short-circuit `[]` too (never build `ANY('{}')` / `inArray([])`).
The shared/db barrel explicitly documents that `inArray` throws on an empty array.
[Source: packages/shared/src/db/index.ts:22-26]

### Error contract & language
- `error` is **user-facing** and Spanish here (`"Query requerida"`, `"Internal error"` may stay
  English internal) — this matches the existing `authController` which returns Spanish user messages
  (`"No eres miembro del guild"`). `code` is a **stable English constant** (`VALIDATION_ERROR`,
  `INTERNAL`). This is the project convention: code/comments/logs English, but user-facing `error`
  strings may be Spanish. Do not "fix" `"Query requerida"` to English — the AC mandates it verbatim.
- All errors map to the shared `ErrorSchema` `{ error, code }`; never leak raw DB/LLM errors
  (project-context.md language rules).

### Provider factory (query embedding)
Use `createEmbeddingsModel(config.embeddings)` from `@hivly/shared/providers` and call `.embedQuery()`.
This is the same factory Story 3.3 used for `.embedDocuments()`. It forces `encodingFormat: 'float'`
to avoid the corrupt all-zero-vector bug found in Story 3.0 against the real LiteLLM proxy. After
embedding, call `assertEmbeddingDimensions(vec, config.embeddings.dimensions)` (already exported) so a
width mismatch fails loudly instead of producing a garbage search. `config.embeddings.dimensions` is
1536 in the deployed setup (Story 3.3 pivot).
[Source: providers/index.ts:70-120; sprint-status story 3-3 dimension pivot]

### NO migration / NO schema change
This story only **reads** `embeddings`, `discord_messages`, and `channel_permissions`. Do **not** touch
`schema.ts` or generate a migration. (The author display-name/avatar gap in D2 is a *deferred*
follow-up, explicitly NOT solved here.) [Source: schema.ts — all needed columns already exist]

### Config
There is **no** `knowledge.topK` in the config schema (`config/index.ts` `knowledge` = `chunk_size`,
`chunk_overlap`, `grouping_window` only). Do not invent one — use the `limit` **query param**
(api-spec: default 5) with a hard cap of 50 in the Zod schema.
[Source: packages/shared/src/config/index.ts:74-77; docs/api-spec.yml:104-106]

### Project Structure Notes
- New files (all under existing dirs — no new top-level structure):
  - `packages/shared/src/schemas/search.ts` (+ `search.test.ts`)
  - `packages/backend/src/domain/repositories/embeddingSearchRepository.ts`
  - `packages/backend/src/domain/repositories/queryEmbedder.ts`
  - `packages/backend/src/infrastructure/embeddingSearchRepository.drizzle.ts` (+ integration test)
  - `packages/backend/src/infrastructure/queryEmbedder.langchain.ts`
  - `packages/backend/src/application/services/searchService.ts` (+ `.test.ts`)
  - `packages/backend/src/presentation/controllers/searchController.ts`
  - `packages/backend/src/routes/searchRoutes.ts`
- Updated files: `packages/shared/src/schemas/index.ts` (add export), `packages/backend/src/app.ts`
  (compose + mount), `packages/backend/src/main.ts` (build query embedder from config),
  `packages/backend/src/test-helpers.ts` (fake embedder in `buildTestAppOptions`).
- Naming: `camelCase.ts` modules; `createXxx` factory functions; endpoints `/api/<resource>` kebab
  plural; route params camelCase. [Source: project-context.md Code quality & naming]

### Files being touched — current state & what must be preserved (UPDATE files)
- **`packages/backend/src/app.ts`** — composition root. Order is load-bearing: `cors` → `express.json`
  → session → `/api/auth` router (auth-exempt) → `app.use('/api', requireAuth, createRbacMiddleware(...))`
  gate. **Preserve** this ordering; the new search router MUST be registered *after* line 75 so it
  inherits auth+RBAC. Adding `queryEmbedder` to `AppOptions` must not change existing option handling.
- **`packages/backend/src/main.ts`** — boots config→db→redis→materialize→createApp. **Preserve**
  the loadConfig-first ordering (AD-8) and the background Redis connect. Add the query-embedder build
  from `config.embeddings` between `config` load and `createApp`.
- **`packages/backend/src/test-helpers.ts`** — `buildTestAppOptions` returns test defaults with
  `...overrides`. Adding a fake `queryEmbedder` default must keep the `overrides` spread last so tests
  can override it.
- **`packages/shared/src/schemas/index.ts`** — barrel; just append the new export line.

### Testing Requirements (Vitest; tests-first for the SQL/RBAC core)
- **Unit (write red first — orchestration/RBAC is core):**
  - `search.test.ts`: schema rejects missing/blank `q`; coerces + caps `limit`; response shape.
  - `searchService.test.ts`: empty `allowedChannelIds` → `{ results: [] }` AND embedder never called;
    happy path embeds → calls repo → validates; D2 anchor mapping (`messageId`/`authorId`/`authorName`
    from anchor) correct.
  - `searchController` (optional after — adapter glue): 400 on missing `q`; 500 maps to `ErrorSchema`
    without leaking; 200 returns the payload.
- **Integration (real Postgres+pgvector — where the value is in the SQL):**
  - Seed `channel_permissions` (2 channels, distinct roles), `discord_messages`, and `embeddings`
    rows with real vectors; query and assert:
    - **RBAC (AC5):** a fragment in a channel NOT in `allowedChannelIds` is NEVER returned.
    - **Ordering (AC1.4):** results come back by descending similarity.
    - **deleted_at (D1):** set `deleted_at` on one message of a chunk → that chunk disappears.
    - **AC3:** `allowedChannelIds = []` → empty results, no throw.
  - Follow the `rbac.integration.test.ts` / `indexBatch.integration.test.ts` setup: `openTestClients()`,
    clean up seeded rows in `afterEach`/`afterAll` (`delete from embeddings where chunk_key like ...`).
- Mock the embeddings provider in unit tests (no real network); the integration test may use a
  deterministic fake embedder (as `indexBatch.integration.test.ts` does) — the value is in the SQL,
  not the embedding.
[Source: project-context.md Testing rules; existing *.integration.test.ts]

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 4.1] — ACs, user story, response fields.
- [Source: docs/api-spec.yml#/api/search] — `q` required, `limit` default 5, 200/400/401.
- [Source: docs/context/TECHNICAL-DESIGN.md#Nodo retrieve (lines 616-634)] — canonical RBAC-in-query
  vector pattern (`inArray(embeddings.channelId, allowedChannelIds)` + `ORDER BY embedding <=> vec`).
- [Source: docs/context/ARCHITECTURE-SPINE.md] — AD-2 (no cross-service / no direct drizzle-orm),
  AD-6 (Zod contracts in shared), AD-12 (RBAC inside the query).
- [Source: packages/shared/src/db/schema.ts] — `embeddings` (id, content, embedding, channelId,
  messageIds, chunkKey), `discord_messages` (authorId, createdAt, deletedAt), `channel_permissions`
  (channelId, name), HNSW + channel indexes.
- [Source: packages/backend/src/middleware/rbac.ts + app.ts:75] — `req.allowedChannelIds` provenance.
- [Source: packages/shared/src/providers/index.ts:70-120] — `createEmbeddingsModel`,
  `assertEmbeddingDimensions`.
- [Source: packages/workers/src/indexer/indexBatch.ts:187] — `chunkKey = message_ids[0]:i` (anchor).
- [Source: packages/backend/src/infrastructure/channelPermissionRepository.drizzle.ts] — Drizzle
  adapter pattern + `arrayOverlaps`/`sql` re-export usage.

## Previous Story Intelligence

From Epic 3 (esp. 3.3, the story that populated `embeddings`) and the Epic 3 retro:
- **Anchor convention already exists:** the Indexer builds `chunkKey = \`${group.messageIds[0]}:${i}\``,
  so `message_ids[0]` is the established anchor — D2 reuses it (not a new invention).
- **Dimension pivot to 1536** (Story 3.3): the deployed `vector(1536)` + HNSW cannot index >2000 dims;
  `config.embeddings.dimensions` = 1536. The query embedding must match — `assertEmbeddingDimensions`.
- **Corrupt all-zero-vector bug** (Story 3.0): a `custom`/LiteLLM proxy returning a plain float array
  while the SDK expects base64 produced wrong-length zero vectors. `createEmbeddingsModel` already
  forces `encodingFormat: 'float'`; the dimension assert is the safety net — keep it.
- **Idempotency / at-least-once** is a *write*-side concern (3.3); 4.1 is read-only, but the
  `chunk_key` UNIQUE index means each grouped chunk is exactly one row — no dedup needed at read time.
- **Review discipline (Epic 3 retro Action Item #1):** treat every code-review patch as new,
  un-reviewed code; a patch isn't done until an independent pass confirms it. Epic 3 had 10 review
  passes and several patch-introduced bugs. Expect the same rigor here.
- **Deferred debt NOT in scope for 4.1:** stream trimming/MAXLEN, transactional outbox, "view in
  Discord" link convention (4.3), author display-name/avatar (see D2 follow-up).

## Git Intelligence Summary

Recent commits (all Epic 3, `feat/3-*` branches → merged to `main`):
- `cf1054b` Merge #17 — Epic 3 retrospective.
- `35b0e5a` docs(repo): Epic 3 retrospective — close Knowledge Indexing Pipeline.
- `e809312` fix(workers): close Indexer correctness/safety gaps found in code review.
- `90f8f1b` docs(repo): record Story 3.3.
Patterns to carry forward: **Conventional Commits** with `<type>(<scope>)`; scope for this story is
`backend` (endpoint/service) and `shared` (the Zod schema — a schema change is scoped `shared` even
when a backend consumer motivated it, per project-context.md). One commit per meaningful slice
(schema → repo/adapter → service → controller/route → wiring → tests), never a single dump commit.
**Branch first:** `git switch -c feat/4-1-backend-search-api` (never commit on `main`).

## Latest Tech Information

- **pgvector 0.8.2** distance operators: `<->` L2, `<#>` negative inner product, **`<=>` cosine
  distance**. With `vector_cosine_ops` HNSW index (the one that exists), `<=>` is index-accelerated.
  Cosine *distance* ∈ [0,2]; cosine *similarity* = `1 - distance` ∈ [-1,1], clamped here to [0,1].
- **HNSW `ef_search`**: default is fine for this dataset; do not tune in 4.1. HNSW is approximate —
  results are near-neighbors, acceptable for semantic search (do not assert exact ordering in tests
  beyond "more-similar seeded vector ranks above a clearly-unrelated one").
- **drizzle-orm 0.45** (pinned): use `sql` template fragments for the `<=>` distance; the query-builder
  `.orderBy(sql\`...\`)` composes with `.where(inArray(...))`. Either the query builder or a full
  `db.execute(sql\`...\`)` is acceptable — keep raw SQL confined to the adapter.
- **Zod 4.4**: `z.coerce.number()` for string query params; `z.string().trim().min(1)` rejects blank
  `q`; `z.uuid()` (Zod 4 top-level, as used in `auth.ts`).

## Project Context Reference

Full rules: `_bmad-output/project-context.md` (read before coding). Authoritative sources:
`docs/context/ARCHITECTURE-SPINE.md` (AD-1…AD-13), `docs/context/TECHNICAL-DESIGN.md`,
`docs/*-standards.md`. Story-critical invariants: **AD-2** (no cross-service imports; no direct
`drizzle-orm` — use `@hivly/shared/db` re-exports), **AD-6** (Zod contracts only in
`packages/shared/src/schemas`; validate at the edge with `.parse()`), **AD-12** (RBAC inside the
vector query, never a post-filter). Verification gate (`npm run lint && npm run test && npm run build`)
is mandatory and the **agent** runs it — paste evidence; never commit red.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (bmad-dev-story)

### Debug Log References

- pgvector query-vector serialization: bound `JSON.stringify(vec)::vector` (a raw `number[]` would be
  sent as a Postgres array literal `{…}` and rejected by `<=>`). Confirmed working against real pgvector.
- drizzle `sql` template array-expansion trap: interpolating a JS array (`${arr}`) expands it into
  comma-separated params, so `= ANY(${allowedChannelIds}::text[])` breaks. Switched the RBAC filter to
  the re-exported `inArray(sql\`e.channel_id\`, allowedChannelIds)` (renders `e.channel_id in ($1,$2,…)`).
  Same trap hit the test seed's `message_ids` insert → fixed by passing a single array-literal string
  `{a,b}`. (Also: backticks inside a `sql\`…\`` comment terminate the template literal — kept SQL
  comments backtick-free.)

### Completion Notes List

- Ultimate context engine analysis completed — comprehensive developer guide created.
- Two design decisions resolved with Borja at creation: D1 deleted_at = exclude-if-any; D2 anchor =
  message_ids[0] + authorName = authorId (real display-name/avatar deferred to an epic follow-up
  before Story 4.3).
- Implemented the full hexagonal slice mirroring the auth vertical: Zod contract (shared) → domain ports
  (`embeddingSearchRepository`, `queryEmbedder`) → Drizzle + LangChain adapters → `searchService`
  (port-only, unit-tested) → `searchController` + `searchRoutes` → composed in `app.ts`, embedder built
  from `config.embeddings` in `main.ts` (injected fake in `test-helpers`).
- AD-12 made concrete for the first time: the RBAC filter is a clause of the vector SQL, proven by an
  integration test where a fragment IDENTICAL to the query but in a denied channel never surfaces.
- D1 (exclude-if-any) implemented as a `NOT EXISTS` anti-join over `embeddings.message_ids →
  discord_messages.deleted_at`; proven by a chunk whose non-anchor sibling is soft-deleted disappearing.
- AC3 short-circuits in TWO places: `searchService` returns `{ results: [] }` without embedding (skips
  the paid call), and the adapter defensively returns `[]` before any DB round-trip.
- NO migration / NO schema change — read-only over `embeddings`, `discord_messages`, `channel_permissions`.
- **Deferred (epic-level, before Story 4.3):** real author display-name + avatar has no data source
  today; `authorName` falls back to `authorId` (D2 follow-up). Unchanged by this story.
- Verification gate GREEN: lint 0 · 237 unit (33 files) · build clean (5 packages) · 32 integration
  (8 files) incl. 10 new (6 adapter + 4 endpoint).

### File List

**New:**
- `packages/shared/src/schemas/search.ts`
- `packages/shared/src/schemas/search.test.ts`
- `packages/backend/src/domain/repositories/embeddingSearchRepository.ts`
- `packages/backend/src/domain/repositories/queryEmbedder.ts`
- `packages/backend/src/infrastructure/embeddingSearchRepository.drizzle.ts`
- `packages/backend/src/infrastructure/embeddingSearchRepository.drizzle.integration.test.ts`
- `packages/backend/src/infrastructure/queryEmbedder.langchain.ts`
- `packages/backend/src/application/services/searchService.ts`
- `packages/backend/src/application/services/searchService.test.ts`
- `packages/backend/src/presentation/controllers/searchController.ts`
- `packages/backend/src/presentation/controllers/searchController.test.ts`
- `packages/backend/src/routes/searchRoutes.ts`
- `packages/backend/src/search.integration.test.ts`

**Modified:**
- `packages/shared/src/schemas/index.ts` (barrel export of `./search.js`)
- `packages/backend/src/app.ts` (AppOptions.queryEmbedder + mount `/api/search` after the `/api` gate)
- `packages/backend/src/main.ts` (build the LangChain query embedder from `config.embeddings`)
- `packages/backend/src/test-helpers.ts` (fake `queryEmbedder` default in `buildTestAppOptions`)
- `_bmad-output/implementation-artifacts/4-1-backend-api-de-busqueda-semantica.md` (this file)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status transitions)

## Change Log

- 2026-07-06 — Implemented Story 4.1 (bmad-dev-story). Added the `/api/search` vertical slice: Zod
  contract in `shared`, domain ports + Drizzle/LangChain adapters, port-only `searchService`,
  controller + route, wired into `app.ts`/`main.ts` with an injected query embedder. AD-12 RBAC
  enforced inside the pgvector query (`inArray` filter, cosine `<=>` ordering); D1 exclude-if-any via
  `NOT EXISTS`; D2 anchor = `message_ids[0]`, `authorName` = `authorId`. No migration. Gate green:
  lint 0 / 237 unit / build clean / 32 integration (10 new). Status → review.

### Review Findings

Code review 2026-07-06 (bmad-code-review — 3 adversarial layers: Blind Hunter + Edge Case Hunter +
Acceptance Auditor). 2 decision-needed, 3 patch, 5 dismissed as noise. Acceptance Auditor found no
hard AC violations — all ACs, D1/D2, and AD-2/AD-6/AD-12 are satisfied and test-backed.

- [x] [Review][Patch] Anchor `JOIN` silently drops a fragment when the anchor message row is absent — `dm.id = e.message_ids[1]` is an INNER JOIN [embeddingSearchRepository.drizzle.ts:47]. If `message_ids` is empty (`message_ids[1]` = NULL) or the anchor row was hard-deleted/purged, the whole chunk vanishes with no error. Not reachable today (Indexer always groups ≥1 message; hard-delete is Epic 6; soft-delete covered by D1 NOT EXISTS). **Resolved (Borja 2026-07-06): KEEP + DOCUMENT** — keep INNER JOIN, add an explicit comment that dropping an anchorless chunk is intentional/acceptable, and add a test documenting the behavior. (blind+edge)
- [x] [Review][Patch] `limit > 50` (and any non-`q` param error) returns `400 { error: "Query requerida" }` — misattributes the failure to `q` when `q` is valid [searchController.ts:24; search.ts:15]. **Resolved (Borja 2026-07-06): DIFFERENTIATE THE MESSAGE** — keep `"Query requerida"` (VALIDATION_ERROR) only for blank/missing `q` (AC4 intact); return a distinct `limit`-specific message for `limit` failures. Keep the reject semantics (no clamp). (blind+edge+auditor)
- [x] [Review][Patch] Degenerate/non-finite query vector is unguarded — `assertEmbeddingDimensions` checks only length, not value sanity [queryEmbedder.langchain.ts:20-24]. An all-zero vector → cosine `<=>` = NaN → every row `similarity=1.0` in arbitrary order (a silent garbage search — exactly the Story 3.0 failure the guard claims to prevent); NaN/Infinity components → `JSON.stringify` emits `null` → malformed `::vector` literal → opaque 500. Fix: after the width assert, verify all components are finite and the vector has non-zero magnitude; throw loudly otherwise. (blind+edge)
- [x] [Review][Patch] No maximum length on `q` — `z.string().trim().min(1)` has no `.max()` [search.ts:14]. A multi-KB/MB `q` is forwarded verbatim to the paid embeddings provider (cost/DoS vector on an any-role authenticated endpoint), surfacing as an opaque 500. Fix: add a sane `.max(...)` cap. (edge)
- [x] [Review][Patch] No unit test for the LangChain query embedder adapter [queryEmbedder.langchain.ts] — `createLangchainQueryEmbedder` and its `assertEmbeddingDimensions` failure branch (the claimed Story 3.0 safety net) are entirely unverified; a regression that drops the check ships green. Fix: add a unit test with a fake model covering happy path + dimension-mismatch throw (+ the degenerate-vector guard from the patch above). (blind)

**Patches applied 2026-07-06** (gate green: lint 0 · 245 unit / 34 files · build clean · 33 integration / 8 files):
- P1 `queryEmbedder.langchain.ts` — `assertUsableQueryVector` guard (non-finite + all-zero) after the width assert.
- P2 `search.ts` — `SEARCH_QUERY_MAX_LENGTH = 1000` cap on `q`.
- P3 `queryEmbedder.langchain.test.ts` (new) — 4 unit tests: happy path + width/non-finite/all-zero throws.
- P4 `embeddingSearchRepository.drizzle.ts` — explicit INNER-JOIN comment + integration test (anchorless chunk dropped, no error).
- P5 `searchController.ts` — field-attributed 400 message (`q` keeps "Query requerida"; `limit` → "Parámetro limit inválido"; over-length `q` → "Query demasiado larga"); +2 controller tests, +2 schema tests.

**Second pass — independent verification of the patches 2026-07-06** (Epic 3 retro Action Item #1: every patch is new, un-reviewed code). Re-ran all 3 layers over a patch-only diff. Acceptance Auditor: PASS, 0 AC regressions (verified against real Zod 4.4.3 that all AC4 cases still return the exact `{ error: "Query requerida", code: "VALIDATION_ERROR" }`; P1 surfaces as a non-leaking 500 and never runs on the AC3 empty-scope fast path). 1 patch + 2 dismissed:
- P6 `queryEmbedder.langchain.ts` (converged Blind+Edge): the all-zero check summed squares, which underflows to 0 for a genuinely non-zero but tiny-magnitude vector (`[1e-200,…]`) → false rejection. Switched to an exact any-non-zero test. Gate re-run green: lint 0 · 245 unit · build clean · 33 integration.
- Dismissed: P5 message attribution "brittleness" (Edge verified all Zod-code mappings correct + the controller test guards the `too_big` branch; empty-path root issue is unreachable — Express always yields an object `req.query`); P4 test's first `not.toContain(ghost)` assertion is vacuous but harmless — the `toEqual([a,b])` assertion deterministically proves the anchorless drop (a LEFT JOIN would surface fragE as a 3rd row and break it).

**Dismissed (5):** `createdAt` map throwing on null/invalid (guarded by `discord_messages.created_at` NOT NULL + node-postgres returning `Date`); whole-response `.parse()` fail-fast losing all rows on one bad row (follows AD-6; row shape controlled by our own SQL projection, ~0 reachability); `ORDER BY` lacking a tie-breaker (HNSW is approximate by design — spec accepts, tie-breaker doesn't change ANN non-determinism); double `<=>` evaluation (spec explicitly permits binding the same literal twice; negligible); HNSW approximate under-return (informational, explicitly in-scope per spec — no `ef_search` tuning in 4.1). Also noted: `console.error` over the shared logger is the established backend-wide pattern (authController), not a 4.1 defect.
