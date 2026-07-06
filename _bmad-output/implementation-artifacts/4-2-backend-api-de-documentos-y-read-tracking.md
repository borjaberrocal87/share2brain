---
baseline_commit: 11c240e
---

# Story 4.2: Backend — API de documentos y read tracking

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a community member,
I want to browse all indexed fragments and manage which ones I have read,
so that I can keep a personal track of what new knowledge is available.

This is the **second backend story of Epic 4** and the **first writer of `user_read_status`** — the
per-user read-tracking table (owner: backend, `docs/data-model.md`). It builds directly on the
`/api/search` vertical slice from Story 4.1 (done): same hexagonal layering, same **AD-12 RBAC-inside-
the-query** invariant, same D1/D2 decisions over grouped chunks. Story 4.1 read `embeddings` ranked by
similarity; this story reads them **paginated + read-annotated** and adds four write/read endpoints for
read status. It unblocks the Web views 4.3 (Search) and 4.4 (Documents + read-tracking UI + sidebar badge).

**No schema change / no migration** — `user_read_status`, `embeddings`, `discord_messages`,
`channel_permissions`, and `users` all already exist in `packages/shared/src/db/schema.ts`.

## Acceptance Criteria

**AC1 — `GET /api/documents?page=1&limit=20` (valid session):**
1. Validates query params with a Zod schema in `packages/shared/src/schemas/` (`page`/`limit` arrive as
   strings → `z.coerce.number()`; `page` min 1 default 1; `limit` min 1 max 100 default 20).
2. Returns fragments from `embeddings` **paginated** and filtered by `allowedChannelIds` **inside the
   SQL** (AD-12) — never a JS post-filter.
3. Each fragment includes `isRead: boolean`, computed from `user_read_status` for the **current user**
   (`req.session.userId`, which is the app `users.id` UUID — see Dev Notes "Session identity").
4. Fragments whose grouped chunk contains **any** message with `deleted_at IS NOT NULL` are **excluded**
   (Decision D1, carried from 4.1).

**AC2 — Document fragment shape:** each fragment includes `id`, `content`, `channelId`, `channelName`,
`authorId`, `authorName`, `createdAt`, `indexedAt`, `messageId`, `isRead` (Decision D3). `authorName`
falls back to `authorId`; `messageId`/`authorId`/`createdAt` come from the anchor message
`message_ids[0]` (Decision D2, carried from 4.1).

**AC3 — `POST /api/read-status/:embeddingId` (valid session):** when the fragment **exists AND the user
has RBAC access to its channel AND it is not D1-excluded**, insert into `user_read_status` with
`ON CONFLICT DO NOTHING` and return **HTTP 200**. A malformed (non-UUID) `:embeddingId` → **400**. A
non-existent / not-accessible / D1-excluded fragment → **404** (uniform, to avoid leaking the existence
of fragments outside the caller's RBAC scope — Decision D5).

**AC4 — `DELETE /api/read-status/:embeddingId` (valid session):** delete the caller's own
`user_read_status` row for that embedding and return **HTTP 200**. **Idempotent** — returns 200 even when
no row existed (deleting your own data is harmless). A malformed (non-UUID) `:embeddingId` → **400**
(Decision D5).

**AC5 — `POST /api/read-status/mark-all` with `{ channelId? }` (valid session):**
- When `channelId` is provided and **is in `allowedChannelIds`**, mark every visible (non-D1-excluded)
  fragment in that channel as read.
- When `channelId` is **omitted/null**, mark every visible fragment across **all** `allowedChannelIds`
  (serves the 4.4 "todos" filter — Decision D6).
- Inserts are processed in **batches of 1 000** with `ON CONFLICT DO NOTHING`, and the operation only
  ever touches channels in `allowedChannelIds`.
- Returns **HTTP 200** with `{ markedCount: number }` (count of **newly** inserted rows; already-read
  fragments do not increment it).
- A provided `channelId` **not** in `allowedChannelIds` → **403** (Decision D6).

**AC6 — `GET /api/read-status/unread-count` (valid session):** returns a JSON object
`{ [channelId]: number }` mapping each channel to its unread fragment count for the current user. Only
channels in `allowedChannelIds` are included; a channel with 0 unread is simply absent from the map
(the UI treats a missing key as 0). D1-excluded fragments are not counted (Decision D7).

**AC7 (derived, non-negotiable):** the RBAC scope filter is part of the SQL of **every** endpoint here
(documents list, unread-count, mark-all, and the per-embedding access check) — never a JS `.filter()`.
A test must prove a fragment outside `allowedChannelIds` is never listed, never counted, and cannot be
marked/read (AD-12; project-context.md Testing rules).

---

## Design Decisions

### Carried unchanged from Story 4.1 (done) — reuse, do NOT reinvent
- **D1 — `deleted_at` exclusion = EXCLUDE-IF-ANY.** A chunk is excluded if **any** message in
  `message_ids` has `deleted_at IS NOT NULL`, implemented as a `NOT EXISTS` anti-join
  (`embeddings.message_ids → discord_messages.deleted_at`). Reuse the exact clause from
  `embeddingSearchRepository.drizzle.ts:58-61`. Applies to documents list, unread-count, mark-all, and
  the per-embedding visibility check. (`deleted_at` is always NULL today — `messageDelete` is Epic 6 —
  but the queries must be correct from the start, exactly as 4.1 did.)
- **D2 — anchor = `message_ids[0]`, `authorName` = `authorId`.** `messageId`/`authorId`/`createdAt` come
  from the anchor message (`discord_messages` where `id = message_ids[1]` — Postgres arrays are
  1-indexed). `authorName` falls back to the `authorId` string (no display name is persisted anywhere —
  the real display-name/avatar follow-up is still deferred, see "Previous Story Intelligence").

### New to this story
- **D3 — `DocumentFragment` shape = `SearchFragment` minus `similarity`, plus `indexedAt` and `isRead`.**
  Fields: `id`, `content`, `channelId`, `channelName`, `authorId`, `authorName`, `createdAt` (anchor
  message date, same semantics as 4.1), `indexedAt` (`embeddings.created_at` — the "indexado" column in
  the 4.4 table), `messageId`, `isRead`. Keeping `createdAt` consistent with `SearchFragment` lets 4.3/4.4
  reuse the same result-card component; `indexedAt` is the free extra column the Documents table needs.
- **D4 — pagination + ordering.** `page` (min 1, default 1) + `limit` (min 1, max 100, default 20);
  `OFFSET (page-1)*limit`. **Order by `embeddings.created_at DESC, embeddings.id DESC`** (newest indexed
  first — "qué conocimiento nuevo hay disponible"; the `id` tiebreaker makes pagination stable).
  Response: `{ results: DocumentFragment[], page, limit, total }` where `total` = count of all visible
  fragments in scope (lets the UI compute "hay más" for the 4.4 "Cargar más" button).
- **D5 — POST/DELETE failure codes.** Per-embedding endpoints validate `:embeddingId` is a UUID (400 if
  not). `POST`: not-found OR not-in-scope OR D1-excluded all return an **undifferentiated 404**, so the
  endpoint never reveals whether a fragment exists in a channel the caller cannot see (AD-12 spirit).
  `DELETE`: idempotent, scoped to the caller's own row (`WHERE user_id = :userId AND embedding_id = :id`);
  always 200 (no existence/RBAC check — you can only ever delete your own data, worst case a no-op).
- **D6 — `mark-all` `channelId` is OPTIONAL (confirmed with Borja 2026-07-06).** The epic 4.2 AC says
  `{ channelId }`, but the 4.4 UI needs a "todos" path. Resolution: `channelId` optional — present ⇒ that
  channel (must be in `allowedChannelIds` else **403 FORBIDDEN**); absent ⇒ all `allowedChannelIds`. (403
  not 404 here: a `channelId` is not a secret the way an individual embedding id is — the client only ever
  sends channels from its accessible filter chips, and denying an out-of-scope channel leaks nothing
  meaningful.) A **scope-based** mark-all (not a `{ embeddingIds[] }` list) is deliberate: the Documents
  table is paginated ("Cargar más"), so the client cannot enumerate *all* unread ids without a wasteful,
  racy pre-fetch; the server computes the full visible+unread set from the same RBAC+D1 query. A selective
  bulk-by-ids endpoint (for a future multi-select UI) would be an additive, non-breaking follow-up.
- **D7 — `unread-count` response = a bare `{ [channelId]: number }` map** (Zod
  `z.record(z.string(), z.number().int().nonnegative())`). Channels with 0 unread are absent (natural
  `GROUP BY`); the sidebar badge (4.4) sums the values and per-channel chips read a single key.
  **NOTE:** `docs/api-spec.yml:165-175` currently scaffolds this as `{ unread: integer }` (a single
  total) — that is stale; the epic AC (per-channel map) is authoritative. Update the spec (Task 7).

---

## Tasks / Subtasks

- [x] **Task 1 — Zod contracts in `packages/shared/src/schemas/` (AC1, AC2, AC5, AC6)**
  - [x] `documents.ts`:
    - `DocumentsQuerySchema`: `{ page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) }`.
    - `DocumentFragmentSchema`: `id` (`z.uuid()`), `content` (`z.string()`), `channelId` (`z.string()`),
      `channelName` (`z.string()`), `authorId` (`z.string()`), `authorName` (`z.string()`),
      `createdAt` (`z.string()` — ISO 8601), `indexedAt` (`z.string()` — ISO 8601),
      `messageId` (`z.string()`), `isRead` (`z.boolean()`).
    - `DocumentsResponseSchema`: `{ results: z.array(DocumentFragmentSchema), page: z.number().int(), limit: z.number().int(), total: z.number().int() }`.
    - `DOCUMENTS_ERROR` const map: `{ VALIDATION_ERROR: 'VALIDATION_ERROR', INTERNAL: 'INTERNAL' }` (mirror `SEARCH_ERROR` in `schemas/search.ts`).
  - [x] `readStatus.ts`:
    - `EmbeddingIdParamSchema`: `{ embeddingId: z.uuid() }` (validate the route param).
    - `MarkAllRequestSchema`: `{ channelId: z.string().min(1).optional() }` (nullable/absent ⇒ all scope).
    - `MarkAllResponseSchema`: `{ markedCount: z.number().int().nonnegative() }`.
    - `UnreadCountResponseSchema`: `z.record(z.string(), z.number().int().nonnegative())`.
    - `READ_STATUS_ERROR` const map: `{ VALIDATION_ERROR, NOT_FOUND, FORBIDDEN, INTERNAL }` (English constants).
  - [x] Export both from `packages/shared/src/schemas/index.ts` (`export * from './documents.js'` / `'./readStatus.js'`).
  - [x] Unit test both schemas (mirror `search.test.ts`): coerce/cap/default `page`+`limit`; reject a
        non-UUID `embeddingId`; `mark-all` accepts absent `channelId`; `unread-count` record shape.

- [x] **Task 2 — Documents domain port + Drizzle adapter (AC1, AC2, AC4-list, AC7)**
  - [x] `domain/repositories/documentRepository.ts`: port
        `listDocuments(userId: string, allowedChannelIds: string[], limit: number, offset: number): Promise<DocumentFragmentRow[]>`
        and `countDocuments(allowedChannelIds: string[]): Promise<number>` (raw pre-Zod row shape).
  - [x] `infrastructure/documentRepository.drizzle.ts` — the ONLY file that knows this SQL. Use
        `db.execute(sql\`…\`)` + the re-exported `inArray` from `@hivly/shared/db` (never import
        `drizzle-orm` directly, AD-2). Mirror `embeddingSearchRepository.drizzle.ts` exactly.
    - [x] **Short-circuit AC7:** `if (allowedChannelIds.length === 0) return [];` (and `countDocuments` → `0`)
          FIRST — `inArray`/`ANY([])` on an empty array is unsafe (the shared/db barrel warns `inArray` throws on empty).
    - [x] List SQL: `embeddings e` JOIN `channel_permissions cp` + anchor JOIN `discord_messages dm ON dm.id = e.message_ids[1]`
          + `LEFT JOIN user_read_status urs ON urs.embedding_id = e.id AND urs.user_id = ${userId}`;
          `isRead = (urs.embedding_id IS NOT NULL)`; `indexedAt = e.created_at`; RBAC via `inArray(sql\`e.channel_id\`, allowedChannelIds)`;
          D1 `NOT EXISTS` deleted anti-join; `ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit} OFFSET ${offset}`.
    - [x] Count SQL: `SELECT count(*) FROM embeddings e WHERE inArray(...) AND NOT EXISTS(deleted)` (same scope + D1, no JOINs needed).
    - [x] Integration test against real Postgres (see Testing).

- [x] **Task 3 — Read-status domain port + Drizzle adapter (AC3, AC4, AC5, AC6, AC7)**
  - [x] `domain/repositories/readStatusRepository.ts` port with:
    - `findVisibleEmbeddingChannel(embeddingId, allowedChannelIds): Promise<string | null>` — returns the
      channel id iff the embedding exists, is in scope, and is not D1-excluded; else `null` (drives AC3's 404).
    - `markRead(userId, embeddingId): Promise<void>` — `INSERT … ON CONFLICT DO NOTHING`.
    - `unmarkRead(userId, embeddingId): Promise<void>` — `DELETE … WHERE user_id AND embedding_id` (idempotent).
    - `markAllInChannels(userId, channelIds): Promise<number>` — batch mark, returns newly-inserted count.
    - `unreadCountByChannel(userId, allowedChannelIds): Promise<Record<string, number>>`.
  - [x] `infrastructure/readStatusRepository.drizzle.ts` — raw `sql` via `db.execute`, `inArray` for RBAC.
        Empty `allowedChannelIds`/`channelIds` short-circuit to `null` / `0` / `{}` before any DB round-trip.
    - [x] `markAllInChannels`: select candidate embedding ids in **keyset batches of 1 000**
          (`… AND e.id > :lastId ORDER BY e.id LIMIT 1000`, visible + not-already-read), then
          `INSERT INTO user_read_status (user_id, embedding_id) SELECT ${userId}, id FROM (…) ON CONFLICT DO NOTHING`;
          sum `rowCount` per batch. See the "mark-all batching" blueprint in Dev Notes.
    - [x] `unreadCountByChannel`: `SELECT e.channel_id, count(*) FROM embeddings e WHERE inArray(...) AND NOT EXISTS(deleted) AND NOT EXISTS (SELECT 1 FROM user_read_status urs WHERE urs.embedding_id = e.id AND urs.user_id = ${userId}) GROUP BY e.channel_id`.
    - [x] Integration tests against real Postgres (see Testing) — this is the RBAC/idempotency core.

- [x] **Task 4 — Application services (AC1, AC3, AC5, AC6)**
  - [x] `application/services/documentService.ts`: `createDocumentService({ documentRepo })` →
        `listDocuments(userId, page, limit, allowedChannelIds): Promise<DocumentsResponse>`. Empty-scope fast
        path → `{ results: [], page, limit, total: 0 }` (no DB round-trip). Otherwise list + count, map rows,
        `DocumentsResponseSchema.parse(...)` before returning (AD-6). Port-only deps → unit-testable with a fake.
  - [x] `application/services/readStatusService.ts`: `createReadStatusService({ readStatusRepo })` with
        `markRead`, `unmarkRead`, `markAll`, `unreadCount` — each takes `userId` + `allowedChannelIds` and
        enforces the RBAC/visibility rules (return a typed result the controller maps to 200/403/404).
        Validate `unreadCount` output with `UnreadCountResponseSchema`, `markAll` with `MarkAllResponseSchema`.
    - [x] `markRead`: `findVisibleEmbeddingChannel` → if `null` return a `not-found` signal (controller → 404);
          else `markRead` → ok. `unmarkRead`: always `unmarkRead` → ok (idempotent). `markAll`: if a
          `channelId` is given and ∉ `allowedChannelIds` → `forbidden` signal (→ 403); else compute the
          target channel set (`[channelId]` or all `allowedChannelIds`) → `markAllInChannels`.
  - [x] Unit tests: empty scope short-circuits (no repo call for list); RBAC 404/403 branches; markedCount
        pass-through; D2 anchor mapping in a listed fragment.

- [x] **Task 5 — Presentation controllers + routes (AC1, AC3, AC4, AC5, AC6)**
  - [x] `presentation/controllers/documentController.ts`: `list(req,res)` — `DocumentsQuerySchema.safeParse(req.query)`
        → 400 on failure (`{ error: 'Parámetros inválidos', code: DOCUMENTS_ERROR.VALIDATION_ERROR }`);
        `const userId = req.session.userId!` (route is behind `requireAuth`); `const allowedChannelIds = req.allowedChannelIds ?? []`;
        call service; 200 payload; `try/catch` → log + 500 `{ error: 'Internal error', code: DOCUMENTS_ERROR.INTERNAL }` (never leak).
  - [x] `presentation/controllers/readStatusController.ts`: `markRead`, `unmarkRead`, `markAll`, `unreadCount`.
        Validate `:embeddingId` with `EmbeddingIdParamSchema` (400 non-UUID); validate the `mark-all` body with
        `MarkAllRequestSchema`; map service `not-found` → 404 (`{ error: 'Fragmento no encontrado', code: NOT_FOUND }`),
        `forbidden` → 403 (`{ error: 'Sin acceso al canal', code: FORBIDDEN }`); 500 on unexpected errors (no leak).
  - [x] `routes/documentRoutes.ts`: `router.get('/', …)`. `routes/readStatusRoutes.ts`:
        `router.post('/mark-all', …)` **and** `router.get('/unread-count', …)` registered BEFORE the
        `:embeddingId` param routes (`router.post('/:embeddingId', …)`, `router.delete('/:embeddingId', …)`)
        so the literal paths are not shadowed by the param route. **⚠ Ordering is load-bearing — see the
        "route ordering" gotcha in Dev Notes.**
  - [x] Controller unit tests: 400 on non-UUID param / bad query; 404 / 403 / 200 mappings; 500 non-leak.

- [x] **Task 6 — Wire into the composition root (`app.ts`) (AC1, AC3-AC6, AC7)**
  - [x] In `createApp`, AFTER the `/api` gate (`app.ts:87`), build the two Drizzle repos, the two services,
        the two controllers, and mount `app.use('/api/documents', createDocumentRouter(...))` and
        `app.use('/api/read-status', createReadStatusRouter(...))`. Both inherit `requireAuth` +
        `createRbacMiddleware` from the `/api` gate — do NOT re-add them. No new `AppOptions` field is needed
        (unlike 4.1's `queryEmbedder`; these features need no config-derived dependency).
  - [x] No change to `main.ts` (no new startup dependency) and no change to `test-helpers.ts` beyond what
        integration tests seed themselves.

- [x] **Task 7 — Docs sync (docs are the source of truth)**
  - [x] Update `docs/api-spec.yml`: add `page`/`limit` params to `/api/documents`; add
        `POST`/`DELETE /api/read-status/{embeddingId}` and the `mark-all` `{ channelId? }` body; fix
        `/api/read-status/unread-count` response from `{ unread }` to the per-channel `{ [channelId]: number }` map.
  - [x] `docs/data-model.md` already documents `user_read_status` correctly — no change expected (verify).

- [x] **Task 8 — Verification gate (mandatory, the AGENT runs it — never the user)**
  - [x] `npm run lint && npm run test && npm run build` — paste evidence; never commit red.
  - [x] Real-infra integration tests green (real Postgres): documents pagination + `isRead` + RBAC + D1;
        read-status mark/unmark/mark-all (idempotent, batched) + unread-count + RBAC 404/403.
  - [x] Exercise the endpoints end-to-end against real infra (mirror `search.integration.test.ts`): seed
        `users` + `channel_permissions` + `discord_messages` + `embeddings` (+ some `user_read_status`), log in
        a member, hit all five endpoints, assert 401 (no session), 400 (bad param), 200/403/404, RBAC scoping
        (a denied fragment never lists/counts/marks), and idempotency (double POST → one row, `markedCount`
        counts only new inserts). Clean up seeded rows in `afterAll`.

### Review Findings (bmad-code-review 2026-07-06 — Blind Hunter + Edge Case Hunter + Acceptance Auditor)

- [x] [Review][Patch] `channelId: null` on `mark-all` is rejected — `MarkAllRequestSchema` uses `z.string().min(1).optional()` (accepts `undefined`, not `null`) but the shipped `docs/api-spec.yml` declares `channelId: { type: string, nullable: true }`. **Resolved (Decision 1 → 1b):** drop `nullable: true` from api-spec so `null` is not a valid input (matches the TS client, which only ever omits the field); no schema/service change. [docs/api-spec.yml]
- [x] [Review][Defer] `total`/unread counts can exceed the rows the list can return (anchor-JOIN asymmetry) — `listDocuments` uses an INNER `JOIN discord_messages dm ON dm.id = e.message_ids[1]`, but `countDocuments`, `unreadCountByChannel`, `markAllInChannels`, and `findVisibleEmbeddingChannel` have no anchor join, so an in-scope, non-D1-deleted fragment with a missing anchor row is counted/marked yet never listed. **Deferred (Decision 2 → 2a):** Divergencia solo materializable con hard-delete de embeddings (Epic 6); hoy los anchors siempre existen y el spec prescribe count sin JOINs. Revisar junto al TOCTOU de la misma familia. [packages/backend/src/infrastructure/documentRepository.drizzle.ts:72, packages/backend/src/infrastructure/readStatusRepository.drizzle.ts:102]
- [x] [Review][Patch] `page` has no upper bound → astronomically large `page` makes `OFFSET (page-1)*limit` overflow Postgres `bigint` → opaque 500 [packages/shared/src/schemas/documents.ts:10]
- [x] [Review][Patch] `docs/api-spec.yml` documents only 200/401/403 for `/api/read-status/mark-all`, but the controller returns 400 on an invalid body — add the `400 BadRequest` response for parity [docs/api-spec.yml]
- [x] [Review][Patch] Stray comment `-- D2: anchor = message_ids[0]` contradicts the code `e.message_ids[1]` four lines below (Postgres arrays are 1-indexed) — clarify to avoid a future off-by-one "fix" [packages/backend/src/infrastructure/documentRepository.drizzle.ts:36]
- [x] [Review][Defer] TOCTOU in `markRead`: fragment deleted between `findVisibleEmbeddingChannel` and the `INSERT` → FK violation surfaces as 500 instead of the uniform 404 [packages/backend/src/application/services/readStatusService.ts:47] — deferred, unreachable until Epic 6 introduces hard-delete of embeddings (same family as the anchor-missing decision above)

_Dismissed as noise (1): `markAllInChannels` re-scans already-read rows on every call (O(total) per no-op) — behavior is correct and deliberate (keyset cursor advances from the `batch` set, not `RETURNING`), and mark-all is a rare user action._

**Round 2 (fresh independent pass over the round-1 patches, 2026-07-06):** All 4 round-1 patches verified clean and both deferrals (2a anchor-JOIN asymmetry, TOCTOU) confirmed still-deferred — no divergence. Auditor: 7/7 AC satisfied, 0 violations.

- [x] [Review][Patch] api-spec `page` query param lacked the `maximum: 1000000` the code enforces (parity gap left by P2) — added `maximum: 1000000` so the spec matches the schema and mirrors `limit`'s `maximum: 100` [docs/api-spec.yml]
- Re-surfaced but already deferred (Decision 2a) — not re-actioned: anchor-JOIN asymmetry across count/unread-count/mark-all/findVisibleEmbeddingChannel vs list (Blind escalated to High, Edge Medium; Auditor confirmed matches the deferral).
- Dismissed round 2 (2): Blind Hunter's claim that the `page`-cap rationale is false — false positive (it computed the max offset *with* the cap in place; without the cap `page≈1e18` → offset 1e20 overflows int8 → 500; Edge Hunter independently confirmed the cap closes the class). `countDocuments` omits the `channel_permissions` join — unreachable, since `allowedChannelIds` is derived from `channel_permissions`.

---

## Dev Notes

### Architecture layering — mirror the Story 4.1 search slice (do NOT invent a new pattern)
The backend is hexagonal/DDD. Copy the shape 4.1 established (which itself mirrored auth):
`domain/repositories/*` (ports) → `infrastructure/*.drizzle.ts` (adapters, the ONLY place SQL lives) →
`application/services/*` (pure, port-only deps) → `presentation/controllers/*` (HTTP) → `routes/*`
(Express router) → composed in `app.ts`. Services must be unit-testable with plain fakes (no Drizzle, no
Express) — exactly like `searchService`/`rbacService`. Two features here (documents, read-status) = two
parallel slices; keep them separate but structurally identical.
[Source: packages/backend/src/{application/services/searchService.ts, infrastructure/embeddingSearchRepository.drizzle.ts, presentation/controllers/searchController.ts, routes/searchRoutes.ts, app.ts:89-103}]

### Session identity — `req.session.userId` IS the app `users.id` UUID (critical)
`user_read_status.user_id` is a FK → `users.id` (a UUID). The session stores exactly that: `authService.
handleCallback` does `users.upsertByDiscordId(...)` and puts the returned **UUID** `id` into
`req.session.userId` (NOT the Discord snowflake). So a controller reads `req.session.userId` directly and
uses it as `user_read_status.user_id` — **no Discord→app mapping is needed**. The route is behind
`requireAuth`, so `req.session.userId` is guaranteed present (assert with `!` or a defensive 401).
[Source: authService.ts:46-52; authController.ts:79; requireAuth.ts:9; schema.ts:133-150 (userReadStatus FK)]

### AD-12 — RBAC INSIDE every query (the invariant this story must uphold)
`createRbacMiddleware` runs on every `/api/*` request and attaches `req.allowedChannelIds` (recomputed
per-request from `channel_permissions`, never cached in the session). Every endpoint here filters by it
**inside the SQL** — documents list, count, unread-count `GROUP BY`, mark-all target set, and the
per-embedding visibility check — never a JS `.filter()`. Post-filtering leaks private channels and is an
explicit anti-pattern. The empty-scope case (`allowedChannelIds = []`) short-circuits in the adapter
before any DB round-trip (never build `ANY('{}')`/`inArray([])`).
[Source: middleware/rbac.ts; app.ts:87; project-context.md "RBAC lives INSIDE the vector query"; db/index.ts:22-26 (inArray throws on empty)]

### SQL blueprints

**Documents list (D1+D2+D3+D4, `isRead` via LEFT JOIN):**
```sql
SELECT
  e.id                                    AS "id",
  e.content                               AS "content",
  e.channel_id                            AS "channelId",
  cp.name                                 AS "channelName",
  dm.author_id                            AS "authorId",
  dm.author_id                            AS "authorName",   -- D2
  dm.created_at                           AS "createdAt",    -- anchor message date
  e.created_at                            AS "indexedAt",    -- D3: the "indexado" column
  dm.id                                   AS "messageId",    -- D2 anchor = message_ids[1]
  (urs.embedding_id IS NOT NULL)          AS "isRead"
FROM embeddings e
JOIN channel_permissions cp ON cp.channel_id = e.channel_id
JOIN discord_messages   dm ON dm.id = e.message_ids[1]        -- INTENTIONAL INNER JOIN (see 4.1 note)
LEFT JOIN user_read_status urs ON urs.embedding_id = e.id AND urs.user_id = ${userId}
WHERE ${inArray(sql`e.channel_id`, allowedChannelIds)}
  AND NOT EXISTS (                                            -- D1: exclude-if-ANY deleted
    SELECT 1 FROM discord_messages d
    WHERE d.id = ANY(e.message_ids) AND d.deleted_at IS NOT NULL
  )
ORDER BY e.created_at DESC, e.id DESC                          -- newest indexed first, stable tiebreak
LIMIT ${limit} OFFSET ${offset};
```
Notes: the anchor INNER JOIN is intentional (drop an anchorless chunk rather than surface placeholder
fields — same rationale + comment as `embeddingSearchRepository.drizzle.ts:47-53`). `message_ids[1]` is
Postgres 1-indexed = JS `message_ids[0]`.

**Count (for `total`):** same `WHERE inArray(...) AND NOT EXISTS(deleted)` over `embeddings e` only —
`SELECT count(*)::int AS "total"`. No JOINs needed.

**unread-count (D7, RBAC + D1):**
```sql
SELECT e.channel_id AS "channelId", count(*)::int AS "count"
FROM embeddings e
WHERE ${inArray(sql`e.channel_id`, allowedChannelIds)}
  AND NOT EXISTS (SELECT 1 FROM discord_messages d WHERE d.id = ANY(e.message_ids) AND d.deleted_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM user_read_status urs WHERE urs.embedding_id = e.id AND urs.user_id = ${userId})
GROUP BY e.channel_id;
```
Reduce the rows to `Record<channelId, number>` in the adapter (channels with 0 unread never appear).

**Per-embedding visibility check (drives AC3 404):**
```sql
SELECT e.channel_id AS "channelId"
FROM embeddings e
WHERE e.id = ${embeddingId}
  AND ${inArray(sql`e.channel_id`, allowedChannelIds)}
  AND NOT EXISTS (SELECT 1 FROM discord_messages d WHERE d.id = ANY(e.message_ids) AND d.deleted_at IS NOT NULL)
LIMIT 1;
```
`null` (no row) ⇒ controller returns 404. On a hit, `INSERT INTO user_read_status (user_id, embedding_id)
VALUES (${userId}, ${embeddingId}) ON CONFLICT DO NOTHING`.

**DELETE (idempotent):** `DELETE FROM user_read_status WHERE user_id = ${userId} AND embedding_id = ${embeddingId}` → 200 regardless of rowCount.

**mark-all batching (AC5 — "lotes de 1 000"):** keyset-paginate the candidate embedding ids (visible +
not-already-read) 1 000 at a time and insert each batch; sum `rowCount`:
```sql
-- repeat until a batch returns < 1000 rows; carry the last id as the keyset cursor
INSERT INTO user_read_status (user_id, embedding_id)
SELECT ${userId}, e.id
FROM embeddings e
WHERE ${inArray(sql`e.channel_id`, targetChannelIds)}     -- [channelId] or all allowedChannelIds
  AND e.id > ${lastId}                                     -- keyset cursor (start at '00000000-0000-0000-0000-000000000000')
  AND NOT EXISTS (SELECT 1 FROM discord_messages d WHERE d.id = ANY(e.message_ids) AND d.deleted_at IS NOT NULL)
ORDER BY e.id
LIMIT 1000
ON CONFLICT DO NOTHING
RETURNING embedding_id;
```
`markedCount` = sum of returned rows across batches; advance `lastId` to the max id **selected** each
batch (select the batch of ids first, or use a CTE that returns the candidate id set so the cursor
advances even when `ON CONFLICT` skips a row — otherwise already-read rows stall the cursor). Simplest
robust form: a CTE `WITH batch AS (SELECT e.id FROM embeddings e WHERE … AND e.id > :lastId ORDER BY e.id
LIMIT 1000) INSERT … SELECT :userId, id FROM batch ON CONFLICT DO NOTHING RETURNING embedding_id` — but
track the cursor from `batch` (max id), NOT from `RETURNING` (which omits conflicts). Loop until a batch
selects < 1 000 ids.

### GOTCHAs
- **Route ordering (read-status router):** register `GET /unread-count` and `POST /mark-all` **before**
  `POST /:embeddingId` / `DELETE /:embeddingId`. Express matches in registration order; a `:embeddingId`
  param route registered first would capture `/unread-count` and `/mark-all` as an embedding id. (The
  `EmbeddingIdParamSchema` UUID validation would then 400 them — a subtle, hard-to-spot bug.)
- **`inArray` on empty array throws** — short-circuit `allowedChannelIds.length === 0` (and, in mark-all,
  the resolved `targetChannelIds`) in the adapter before building any query. [db/index.ts:22-26]
- **`::int` / `::float8` casts on aggregate/computed columns** — `count(*)` returns a JS string via
  node-postgres unless cast; cast to `::int` (as 4.1 cast similarity to `::float8`) or `Number(...)` the
  raw value in the adapter mapping. Do both defensively (cast + `Number()`), like 4.1.
- **`message_ids` array-literal in test seeds** — insert as a single `'{a,b}'::text[]` literal string, NOT
  an interpolated JS array (drizzle expands a JS array into comma params and breaks the cast). Copy
  `search.integration.test.ts:55-62`'s `seedEmbedding` helper.
- **`users` FK seed** — `user_read_status.user_id` FKs `users.id`; integration tests that seed a
  read-status row directly must first insert a `users` row (or log in via the fake OAuth flow, which
  upserts one — `search.integration.test.ts:38-43` + cleanup `delete from users where discord_id = …`).

### Error contract & language
User-facing `error` strings may be Spanish (project convention — 4.1 returns `"Query requerida"`); `code`
is a stable English constant. Suggested strings: `"Parámetros inválidos"` (400), `"Fragmento no
encontrado"` (404), `"Sin acceso al canal"` (403), `"Internal error"` (500). All errors map to the shared
`ErrorSchema` `{ error, code }`; never leak raw DB errors (log with `console.error`, the established
backend pattern). [Source: searchController.ts; authController.ts; project-context.md language rules]

### NO migration / NO schema change
This story reads `embeddings`/`discord_messages`/`channel_permissions` and reads+writes `user_read_status`
— all already in `schema.ts` (incl. the composite PK `(user_id, embedding_id)` that makes `ON CONFLICT DO
NOTHING` work, and `idx_user_read_status_user`/`_embedding`). Do NOT touch `schema.ts` or generate a
migration. [Source: packages/shared/src/db/schema.ts:133-150]

### shared/db re-exports — you likely need only `sql` + `inArray` (both already exported)
Do everything via `db.execute(sql\`…\`)` (as `embeddingSearchRepository.drizzle.ts` does) plus the
re-exported `inArray`. That avoids adding any new `drizzle-orm` re-export to `packages/shared/src/db/index.ts`.
If you find you genuinely need another helper (`eq`, `and`, `count`), re-export it from the shared barrel
FIRST (a schema/contract change is scoped `shared`, AD-2) — never import `drizzle-orm` directly in the
backend. Prefer raw `sql` to avoid the shared change entirely. [Source: db/index.ts:14-26]

### Project Structure Notes
- New files (all under existing dirs — no new top-level structure):
  - `packages/shared/src/schemas/documents.ts` (+ `documents.test.ts`)
  - `packages/shared/src/schemas/readStatus.ts` (+ `readStatus.test.ts`)
  - `packages/backend/src/domain/repositories/documentRepository.ts`
  - `packages/backend/src/domain/repositories/readStatusRepository.ts`
  - `packages/backend/src/infrastructure/documentRepository.drizzle.ts` (+ integration test)
  - `packages/backend/src/infrastructure/readStatusRepository.drizzle.ts` (+ integration test)
  - `packages/backend/src/application/services/documentService.ts` (+ `.test.ts`)
  - `packages/backend/src/application/services/readStatusService.ts` (+ `.test.ts`)
  - `packages/backend/src/presentation/controllers/documentController.ts` (+ `.test.ts`)
  - `packages/backend/src/presentation/controllers/readStatusController.ts` (+ `.test.ts`)
  - `packages/backend/src/routes/documentRoutes.ts`
  - `packages/backend/src/routes/readStatusRoutes.ts`
  - `packages/backend/src/documents.integration.test.ts`, `packages/backend/src/readStatus.integration.test.ts`
- Updated files: `packages/shared/src/schemas/index.ts` (2 barrel exports), `packages/backend/src/app.ts`
  (compose + mount 2 routers), `docs/api-spec.yml` (Task 7).
- Naming: `camelCase.ts` modules; `createXxx` factories; endpoints `/api/<resource>` kebab plural; route
  params camelCase (`:embeddingId`). [Source: project-context.md Code quality & naming]

### Files being touched — current state & what must be preserved (UPDATE files)
- **`packages/backend/src/app.ts`** — composition root. Order is load-bearing: `cors` → `express.json` →
  session → `/api/auth` router → `app.use('/api', requireAuth, createRbacMiddleware(...))` gate (line 87) →
  `/api/search` (line 103). **Preserve** this ordering; mount the two new routers AFTER the gate (they
  inherit auth+RBAC). Do not alter the `queryEmbedder` handling. No new `AppOptions` field.
- **`packages/shared/src/schemas/index.ts`** — barrel; append the two `export *` lines.
- **`docs/api-spec.yml`** — scaffold "kept in sync"; update the documents + read-status paths (Task 7).

### Testing Requirements (Vitest; tests-first for the SQL/RBAC core)
- **Unit (write red first — orchestration/RBAC is core):**
  - `documents.test.ts` / `readStatus.test.ts`: schema coercion/caps/defaults; non-UUID `embeddingId`
    rejected; `mark-all` optional `channelId`; response shapes.
  - `documentService.test.ts`: empty scope → `{ results: [], total: 0 }` and repo NOT called; happy path
    maps + validates; D2 anchor mapping; `isRead` pass-through.
  - `readStatusService.test.ts`: `markRead` 404 branch when `findVisibleEmbeddingChannel` → null; `unmarkRead`
    idempotent ok; `markAll` 403 when out-of-scope `channelId`; `markAll` all-scope path; `markedCount` pass-through.
  - Controllers (adapter glue, may test after): 400/403/404/200/500 mappings without leaking.
- **Integration (real Postgres — where the value is in the SQL):** seed `users`, `channel_permissions`
  (≥2 channels, distinct roles), `discord_messages`, `embeddings`, and some `user_read_status`; assert:
  - **RBAC (AC7):** a fragment in a channel NOT in `allowedChannelIds` is never listed, never counted, and
    `POST /read-status/:id` on it → 404; mark-all with that channelId → 403.
  - **`isRead` (AC1.3):** a pre-seeded read row makes exactly that fragment `isRead: true`; others `false`.
  - **Pagination (D4):** `page`/`limit` window + stable ordering; `total` matches the visible count.
  - **D1:** set `deleted_at` on one message of a chunk → it disappears from list, count, and cannot be marked.
  - **Idempotency (AC3):** two POSTs → one row; `markedCount` (mark-all) counts only new inserts (re-run → 0).
  - **AC4:** DELETE a non-existent read row → 200; DELETE then GET documents → `isRead: false`.
  - Follow `search.integration.test.ts` / `rbac.integration.test.ts` setup: `openTestClients()`, unique
    suffix per run, clean up ALL seeded rows (incl. `user_read_status` and `users`) in `afterAll`.
[Source: project-context.md Testing rules; search.integration.test.ts; rbac.integration.test.ts]

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 4.2] — ACs, user story, endpoint behaviors.
- [Source: _bmad-output/implementation-artifacts/4-1-backend-api-de-busqueda-semantica.md] — the slice to
  mirror (layering, D1/D2, SQL/gotchas, integration-test setup), incl. its Review Findings.
- [Source: docs/api-spec.yml:112-183] — documents + read-status paths (scaffold, update in Task 7).
- [Source: docs/data-model.md#8 user_read_status + Write Ownership + Critical Indexes] — table + indexes.
- [Source: docs/context/TECHNICAL-DESIGN.md:758-765] — canonical endpoint list (matches the epic ACs).
- [Source: docs/context/ARCHITECTURE-SPINE.md] — AD-2 (no cross-service / no direct drizzle-orm),
  AD-5 (DDL only in shared), AD-6 (Zod contracts in shared), AD-12 (RBAC inside the query).
- [Source: packages/shared/src/db/schema.ts:36-150] — `embeddings`, `discord_messages`, `channel_permissions`,
  `users`, `user_read_status` (composite PK, FKs, indexes).
- [Source: packages/backend/src/{app.ts, middleware/rbac.ts, middleware/requireAuth.ts, infrastructure/sessionStore.ts, application/services/authService.ts}] — session identity + RBAC middleware provenance.

## Previous Story Intelligence

From Story 4.1 (done, 2 code-review passes) and Epic 3:
- **Reuse the 4.1 slice verbatim** — layering, the `embeddingSearchRepository.drizzle.ts` SQL idioms
  (`db.execute(sql)`, `inArray(sql\`e.channel_id\`, …)`, D1 `NOT EXISTS`, anchor INNER JOIN + its comment,
  `::float8`/`Number()` casts, JSON-array-literal test seeds). This story is "4.1 without the vector, plus
  writes" — do not invent new patterns.
- **`req.session.userId` = app UUID** (confirmed in `authService`) — the exact value `user_read_status.user_id`
  needs. This was the main unknown; it is resolved.
- **4.1 review lessons that apply here:**
  - *Attribute 400s to the field that actually failed* (4.1 P5) — a bad `limit`/`page` must not claim `q`/
    param problems; give distinct messages/codes.
  - *Guard degenerate inputs* — validate the UUID param (400) before it reaches SQL (a raw non-UUID in
    `WHERE embedding_id = …` throws an opaque 500).
  - *Whole-response `.parse()` fail-fast* is accepted (AD-6); row shape is controlled by our own projection.
  - *Every code-review patch is new, un-reviewed code* (Epic 3 retro Action Item #1) — expect an independent
    verification pass over any patches.
- **Deferred, NOT in scope here (carried):** real author **display-name + avatar** (D2 follow-up — no data
  source; still deferred, affects 4.3/4.4 rendering, must be flagged again before 4.3); "view in Discord"
  link convention for grouped chunks (before 4.3); `access_control.enabled`/allow-policy branch (Epic 4+,
  tracked in `deferred-work.md`); stream trimming / transactional outbox (Epic 6).

## Git Intelligence Summary

Recent commits (Epic 4.1 slice + Epic 3 tail):
- `11c240e` Merge #18 — Story 4.1 backend search API.
- `b13cc5d` feat(backend): add semantic search endpoint with RBAC-in-query.
- `24e610f` feat(shared): add search API Zod contract.
Patterns to carry forward: **Conventional Commits** `<type>(<scope>)`; scope `shared` for the Zod
contracts (a schema change is scoped `shared` even when a backend consumer motivated it), `backend` for
the endpoints/services, `repo`/`docs` for the api-spec sync. **One commit per meaningful slice** (shared
schemas → documents repo/adapter → read-status repo/adapter → services → controllers/routes → wiring →
docs → tests), never a single dump commit. **Branch first:**
`git switch -c feat/4-2-backend-documents-read-tracking` (never commit on `main`).

## Latest Tech Information

- **drizzle-orm 0.45 (pinned):** raw `db.execute(sql\`…\`)` for all queries here; `inArray(sql\`col\`, arr)`
  renders `col in ($1,$2,…)`. No new `drizzle-orm` import in the backend — re-export from the shared barrel
  if a helper is truly needed (AD-2). `INSERT … ON CONFLICT DO NOTHING` and `RETURNING` are plain SQL via `sql`.
- **PostgreSQL 17:** `count(*)` returns `bigint` → node-postgres yields a **string**; cast `::int` or wrap
  in `Number()`. Composite PK `(user_id, embedding_id)` backs `ON CONFLICT DO NOTHING` (idempotent mark).
  Keyset pagination (`WHERE id > :cursor ORDER BY id LIMIT n`) is preferred over large `OFFSET` for the
  1 000-row mark-all batches; the documents list uses small `OFFSET` (page*20) which is fine.
- **Zod 4.4:** `z.coerce.number()` for string query params; `z.uuid()` (top-level, as in `auth.ts`/`search.ts`)
  for the `:embeddingId` param; `z.record(z.string(), z.number().int())` for the unread-count map;
  `.optional()` for `mark-all`'s `channelId`.
- **node-postgres:** `result.rowCount` gives affected rows per statement — sum across mark-all batches for
  `markedCount` (but advance the keyset cursor from the selected id set, not from `RETURNING`, so conflicts
  don't stall it).

## Project Context Reference

Full rules: `_bmad-output/project-context.md` (read before coding). Authoritative sources:
`docs/context/ARCHITECTURE-SPINE.md` (AD-1…AD-13), `docs/context/TECHNICAL-DESIGN.md`, `docs/*-standards.md`.
Story-critical invariants: **AD-2** (no cross-service imports; no direct `drizzle-orm` — use
`@hivly/shared/db` re-exports), **AD-5** (DDL only in shared — this story adds none), **AD-6** (Zod
contracts only in `packages/shared/src/schemas`; validate at the edge with `.parse()`), **AD-12** (RBAC
inside the query, never a post-filter). Verification gate (`npm run lint && npm run test && npm run build`)
is mandatory and the **agent** runs it — paste evidence; never commit red.

## Resolved Questions (confirmed with Borja 2026-07-06)

All three open questions were resolved as recommended — no further clarification pending; these are now
fixed decisions (see Design Decisions D5, D6, D7 above):

1. **D6 — `mark-all` `channelId` OPTIONAL + all-scope fallback + 403 on out-of-scope.** ✅ Confirmed.
   Scope-based (not a `{ embeddingIds[] }` list): under pagination the client cannot enumerate all unread
   ids, so the server derives the full visible+unread set from the RBAC+D1 query.
2. **D5 — POST on a fragment outside RBAC scope → undifferentiated 404.** ✅ Confirmed (don't leak that a
   fragment exists in a channel the caller can't see; AD-12 spirit).
3. **D7 — `unread-count` = per-channel `{ [channelId]: number }` map.** ✅ Confirmed. Honor the epic AC and
   fix the stale `{ unread: integer }` scaffold in `docs/api-spec.yml` (Task 7).

## Dev Agent Record

### Agent Model Used

claude-sonnet-5 (bmad-dev-story, 2026-07-06)

### Debug Log References

- **Verification gate (final, all green):**
  - `npm run lint` → 0 errors.
  - `npm run test` → 298 passed (40 test files; +53 vs. Story 4.1's 245).
  - `npm run build` → clean (`shared`, `backend`, `bot`, `workers` tsc --noEmit; `web` vite build).
  - `npm run test:integration` → 68 passed (12 test files: backend + bot + workers), run twice
    consecutively with no flakiness.
- **Pre-existing latent bug found and fixed (blocked the gate, not a scope addition):**
  `auth.integration.test.ts` and `rbac.integration.test.ts` cleaned up with a broad
  `DELETE FROM users WHERE discord_id LIKE 'itest-%'`. This matched EVERY integration
  test's discord_id across the whole codebase (all use an `itest-*` convention), and
  raced with this story's tests when run in parallel: one file's cleanup could delete
  another suite's still-in-use user row mid-test. It was dormant until now because no
  other suite previously wrote a row keyed to that user id via a foreign key — Story 4.2
  is the first writer of `user_read_status.user_id → users.id`, which is precisely the FK
  that surfaced the race as a 500 (FK violation) in `markRead`/`mark-all`. Fixed by
  scoping both DELETEs to their own known discord_id(s) instead of the wildcard.
- **`markAllInChannels` implementation note:** the mark-all batching blueprint's
  `RETURNING`-based cursor was refined to a two-CTE round-trip (`batch` selects the
  candidate id page; `ins` inserts `ON CONFLICT DO NOTHING`) so the cursor advances from
  the SELECTED id set in the SAME query as the insert (one round-trip per batch, not two).
  `max(uuid)` is not a valid Postgres aggregate — the last-id cursor is taken via
  `ORDER BY id DESC LIMIT 1` instead.
- **Test-isolation note for future Epic 4/5 integration tests:** RBAC expansion
  (`rbacService.expandAllowedChannelIds`) resolves against the WHOLE `channel_permissions`
  table, not scoped per test file. A literal role like `'member'` shared across parallel
  integration suites pulls in every other suite's "allowed" channels into scope. This is
  harmless for read-only assertions (inclusion/exclusion checks on specific ids), but any
  test that acts on the FULL scope (e.g. this story's mark-all-with-no-channelId) must use
  a suffix-unique role (`member-${suffix}`) to avoid touching other suites' data. Applied
  in `documents.integration.test.ts` / `readStatus.integration.test.ts`.

### Completion Notes List

- Implemented both hexagonal slices (documents, read-status) mirroring Story 4.1's
  search slice exactly: `domain/repositories/*` (ports) → `infrastructure/*.drizzle.ts`
  (the only files with SQL) → `application/services/*` (port-only deps, unit-testable
  with fakes) → `presentation/controllers/*` → `routes/*` → composed in `app.ts`.
- **Task 1** — `DocumentsQuerySchema`/`DocumentFragmentSchema`/`DocumentsResponseSchema`/
  `DOCUMENTS_ERROR` in `documents.ts`; `EmbeddingIdParamSchema`/`MarkAllRequestSchema`/
  `MarkAllResponseSchema`/`UnreadCountResponseSchema`/`READ_STATUS_ERROR` in
  `readStatus.ts`; both barrel-exported. 25 unit tests.
- **Task 2** — `documentRepository.ts` port + `documentRepository.drizzle.ts` adapter:
  LEFT JOIN `user_read_status` for `isRead`, D1 anti-join, D2 anchor INNER JOIN, D4
  ordering/pagination. AC7 empty-scope short-circuit before any DB round-trip. 6
  integration tests against real Postgres (RBAC, D1, isRead, pagination, count, empty
  scope).
- **Task 3** — `readStatusRepository.ts` port + `readStatusRepository.drizzle.ts`
  adapter: visibility check (undifferentiated 404 signal), idempotent mark/unmark,
  batched mark-all (keyset cursor, 1 000/batch), per-channel unread count. 13
  integration tests.
- **Task 4** — `documentService.ts` (empty-scope fast path, AD-6 `.parse()` before
  return) and `readStatusService.ts` (RBAC/visibility branches → typed
  `{ ok, reason }` results for the controller to map to HTTP status). 12 unit tests.
- **Task 5** — `documentController.ts` and `readStatusController.ts` (400/403/404/
  200/500 mapping, Spanish user messages + English `code`, never leak raw errors).
  `documentRoutes.ts` and `readStatusRoutes.ts` — `/unread-count` and `/mark-all`
  registered BEFORE `/:embeddingId` (route-ordering gotcha). 16 unit tests.
- **Task 6** — wired both repos/services/controllers/routers into `createApp`, mounted
  AFTER the `/api` gate (inherit `requireAuth` + RBAC middleware). No `AppOptions`
  change needed (no config-derived dependency, unlike 4.1's `queryEmbedder`).
- **Task 7** — `docs/api-spec.yml`: added `page`/`limit` to `/api/documents`; added
  `POST`/`DELETE /api/read-status/{embeddingId}` and the `mark-all` request/response
  bodies; fixed `/api/read-status/unread-count` from the stale `{ unread }` scaffold to
  the per-channel map. Verified `docs/data-model.md` already documents
  `user_read_status` correctly (no change needed).
- **Task 8** — verification gate green (see Debug Log References): lint 0, 298 unit
  (+53 new), build clean, 68 integration (+35 new: 6 `documentRepository` adapter + 13
  `readStatusRepository` adapter + 7 `documents.integration.test.ts` end-to-end + 9
  `readStatus.integration.test.ts` end-to-end). The two end-to-end suites exercise all
  5 endpoints against real Postgres: 401/400/403/404/200, RBAC scoping, D1 exclusion,
  isRead annotation, pagination, idempotent mark/unmark, batched mark-all, per-channel
  unread counts.
- No schema/migration change, as scoped. No change to `main.ts` or `test-helpers.ts`
  beyond what the new integration tests seed themselves.

### File List

**New:**
- `packages/shared/src/schemas/documents.ts` (+ `documents.test.ts`)
- `packages/shared/src/schemas/readStatus.ts` (+ `readStatus.test.ts`)
- `packages/backend/src/domain/repositories/documentRepository.ts`
- `packages/backend/src/domain/repositories/readStatusRepository.ts`
- `packages/backend/src/infrastructure/documentRepository.drizzle.ts` (+
  `documentRepository.drizzle.integration.test.ts`)
- `packages/backend/src/infrastructure/readStatusRepository.drizzle.ts` (+
  `readStatusRepository.drizzle.integration.test.ts`)
- `packages/backend/src/application/services/documentService.ts` (+ `.test.ts`)
- `packages/backend/src/application/services/readStatusService.ts` (+ `.test.ts`)
- `packages/backend/src/presentation/controllers/documentController.ts` (+ `.test.ts`)
- `packages/backend/src/presentation/controllers/readStatusController.ts` (+ `.test.ts`)
- `packages/backend/src/routes/documentRoutes.ts`
- `packages/backend/src/routes/readStatusRoutes.ts`
- `packages/backend/src/documents.integration.test.ts`
- `packages/backend/src/readStatus.integration.test.ts`

**Updated:**
- `packages/shared/src/schemas/index.ts` — barrel exports for `documents.js` / `readStatus.js`.
- `packages/backend/src/app.ts` — composed + mounted `/api/documents` and `/api/read-status`.
- `docs/api-spec.yml` — documents pagination params; read-status endpoints; unread-count
  map shape fix.
- `packages/backend/src/auth.integration.test.ts` — scoped the `afterAll` user cleanup to
  its own discord_ids (pre-existing test-isolation bug fix, see Debug Log References).
- `packages/backend/src/rbac.integration.test.ts` — same fix, scoped to its own discord_id.

## Change Log

- 2026-07-06 (bmad-dev-story): Implemented the documents + read-status backend slice
  (5 endpoints, 2 hexagonal slices, no schema change). Fixed a pre-existing
  test-isolation bug in `auth.integration.test.ts`/`rbac.integration.test.ts` (broad
  `discord_id LIKE 'itest-%'` cleanup racing across integration suites) that this
  story's `user_read_status` FK writes surfaced. Status → review.
