---
baseline_commit: fce991133234e731fd1572079f4ad84116782215
---

# Story 7.1: shared — modelo de datos, contratos y config de enriquecimiento

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->
<!-- Ultimate context engine analysis completed 2026-07-09 — comprehensive developer guide created
     (3 parallel deep-dives: shared current-state, cross-package blast radius, prior-story + docs intel). -->

## Story

As a **community operator pivoting Share2Brain into an AI-curated resource index**,
I want **the shared kernel (DB schema, Zod contracts, config schema) to model resources as
`title + description + link` instead of raw `content`, with a new `enrichment` config block**,
so that **Stories 7.2–7.5 can build the URL-extraction/fetch/AI-enrichment pipeline and its
projections on top of a single, already-ratified contract (AD-5/AD-6)**.

**Source**: `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-09.md` (approved
correct-course, scope **Major**). Epic 7 = "Índice Curado de Recursos con IA", Story 1 of 6.
This story is the **inner layer** (schema → contracts → config); it does **NO** behavioral
work — no URL extraction, no fetching, no LLM calls, no UI redesign.

**Depends on**: none unmet (roadmap epics 1–6 all done).

## Decisions confirmed with Borja (2026-07-09, story creation)

| # | Fork | Decision |
|---|---|---|
| D1 | `Citation.link` presence | **REQUIRED** (`link: string` in the interface; required key in `CitationSchema`). Consequence accepted: legacy persisted `messages.citations` jsonb rows (Epic 5 era) lack `link` and will fail Zod parse → the Epic 7 clean-slate deploy runbook is **extended to also truncate `conversations` + `messages`** (see AC-2/runbook). Local dev DBs and the e2e seed are re-seeded anyway. |
| D2 | `link` value validation (fragments AND citation) | **Empty-or-URL refine** — the existing repo convention (`config/index.ts:61-63` `base_url`): `z.string().refine((v) => v === '' || /^https?:\/\//.test(v), …)`. NOT strict `z.url()`. Rationale: until 7.2 generates real URLs, mechanical ripples/seeds use `link: ''`; a strict `z.url()` would fail runtime parses in `ragRetriever`/`searchService`/`documentService`/SSE and break integration + e2e tiers. |
| D3 | `enrichment` config block | **REQUIRED top-level block** (NOT the optional `notifications` pattern). It is the core of the pivot; 7.2's Indexer cannot run without it. `api_key: "${ENRICHMENT_LLM_API_KEY}"` lives uncommented in BOTH YAML files; the secret becomes first-class in `.env.example`. |
| D4 | Pending Phase-0 doc edits | **Story 7.1 carries the shared-relevant doc updates** (data-model.md, api-spec.yml, ARCHITECTURE-SPINE, TECHNICAL-DESIGN config+citation sections, epics.md FR edits + Épico 7 append, PRD scope note). The ingestion-pipeline rewrite of TECHNICAL-DESIGN §7 belongs to 7.2. |
| D5 | Gate-green slicing (implied by the mandatory verification gate) | Dropping `embeddings.content` breaks compilation in workers/backend/web, so this story includes **minimal mechanical compile-fix ripples** in consumers under an explicit placeholder policy (§Placeholder policy). It does NOT implement 7.2–7.5 behavior. |

## Acceptance Criteria

1. **`embeddings` table redefined** in `packages/shared/src/db/schema.ts`:
   - `+ title: text NOT NULL`, `+ description: text NOT NULL`, `+ link: text NOT NULL`; `− content`.
   - Column order: `id, chunkKey, title, description, link, embedding, channelId, messageIds, createdAt`.
   - `chunkKey` doc-comment rewritten: semantics are now `"<messageId>:<urlIndex>"` (one row per URL of one message; snowflakes globally unique so channel stays implicit). No DDL change to the key itself.
   - `messageIds` doc-comment: length-1 array; `messageIds[0]` is the anchor for Search/Docs projection.
   - Indexes UNCHANGED: `uniqueIndex('idx_embeddings_chunk_key')`, HNSW `idx_embeddings_vector` (`vector_cosine_ops`), `idx_embeddings_channel`. **NO unique index on `link`** (placeholders `''` would collide; dedup is `chunk_key`'s job).
   - `Citation` interface (schema.ts:29-34) gains `link: string` (required).
2. **Destructive migration `0003_*` generated, reviewed and applied**:
   - Generated with `npx drizzle-kit generate` (NOT hand-written); SQL hand-REVIEWED: exactly `DROP COLUMN content` + `ADD COLUMN title/description/link NOT NULL`, nothing else.
   - `migrations/meta/0003_snapshot.json` + `meta/_journal.json` committed alongside the SQL (3.3 precedent, commit `2dc1d74`).
   - Applied locally against compose Postgres (`docker compose up -d postgres redis` → truncate per runbook → `npx drizzle-kit migrate`) and verified with `\d embeddings`.
   - **Deploy runbook documented** (in this story's Dev Agent Record + `_bmad-output/implementation-artifacts/operational-backlog.md` § runbooks or a new `docs/` note): clean slate = `TRUNCATE user_read_status, messages, conversations, embeddings, discord_messages` (FK-safe order: `user_read_status` before `embeddings`; `messages` before `conversations`) → migrate → fresh ingest. Truncating `conversations`/`messages` is REQUIRED by D1.
3. **Search/Documents contracts swapped** in `packages/shared/src/schemas/`:
   - `SearchFragmentSchema` (search.ts): `content: z.string()` → `title: z.string()`, `description: z.string()`, `link: <empty-or-URL refine>` (D2). All other fields unchanged.
   - `DocumentFragmentSchema` (documents.ts): same swap; `indexedAt`/`isRead` etc. unchanged.
   - Their `.test.ts` suites updated (fixtures + reject-cases for the new fields, incl. a reject case for a non-URL non-empty `link`).
4. **Citation contract gains required `link`** (D1 + D2):
   - `CitationSchema` (citation.ts): `+ link` with the empty-or-URL refine; the bidirectional `satisfies` guards (citation.ts:24-25) still compile against the updated `Citation` interface.
   - SSE `citation` frame inherits `link` automatically via `CitationSchema.shape` (sse.ts:11) — verify with a new `sse.test.ts` case (citation frame with/without `link` → parse/reject).
   - `conversations.ts` untouched (already `z.array(CitationSchema)`).
5. **Required `enrichment` config block** added to `Share2BrainConfigSchema` (`packages/shared/src/config/index.ts`), per proposal §4.3 + resolved item 4:
   - `enrichment.language: z.string().min(1)` (AI output language, behavior → YAML, NOT `.env`).
   - `enrichment.llm: { provider: z.enum(['anthropic','openai','custom']), model: min(1), temperature: z.number(), base_url: <empty-or-URL refine>.optional(), api_key: min(1) }` — same shape/messages as the existing `agent` block; `superRefine` extended: `custom` provider requires non-empty `base_url` (mirror the existing agent/embeddings rule).
   - `enrichment.fetch: { timeout_ms: int positive, max_bytes: int positive, max_redirects: int nonnegative, user_agent: min(1), allowed_schemes: z.array(z.enum(['http','https'])).nonempty(), block_private_ips: z.boolean() }`.
   - Export `type EnrichmentConfig = Share2BrainConfig['enrichment']`.
   - `createChatModel` (providers/index.ts) parameter type widened to a structural `ChatModelConfig` = `{ provider, model, temperature, base_url?, api_key }` so BOTH `agent` and `enrichment.llm` are assignable (zero behavior change; unblocks 7.2 reuse). `agent`'s extra fields (`max_iterations`, `memory_window`) stay on the agent block only.
6. **Config surfaces updated coherently** (6.4 learnings):
   - `Share2Brain.config.yml.example` (tracked) AND the local gitignored `Share2Brain.config.yml` gain the `enrichment` block with `api_key: "${ENRICHMENT_LLM_API_KEY}"`.
   - `.env.example` gains `ENRICHMENT_LLM_API_KEY` as a first-class (uncommented) secret with a one-line comment; local `.env` must set it before any service boots (interpolateEnv aborts on unset referenced vars — for local dev it may reuse the `LLM_API_KEY` value).
   - **interpolateEnv gotcha honored**: `${VAR}` must never appear inside YAML comments in either file.
   - Verify `ENRICHMENT_LLM_API_KEY` reaches the workers container in `docker-compose.yml` (if services consume the root `.env` via `env_file`, nothing to do; if they enumerate `environment:` keys, add it to `workers`).
   - `packages/shared/src/config/index.test.ts`: `VALID_YAML` fixture gains the block; new tests — valid block parses; **missing block → ConfigError** (it is required); `custom` provider without `base_url` → ConfigError; empty `language` → ConfigError; invalid `allowed_schemes` entry → ConfigError; non-positive `timeout_ms`/`max_bytes` → ConfigError.
7. **Mechanical consumer ripples applied under the Placeholder policy** (D5 — compile/tests green, ZERO new behavior): workers `indexBatch.ts`/`processUpdate.ts` write `{ title: '', description: <old content text>, link: '' }`; backend ports/repos/services/prompt/graph/chatService and web SearchView/DocsView/ChatWidget adapted per the §Ripple map; `packages/backend/src/e2e/seed.ts` seeds the new columns and citation `link`. All affected unit/integration/web tests retargeted (full list in §Ripple map). Nothing from Stories 7.2–7.5 is implemented.
8. **Docs synchronized** (D4, mandatory-steps §3.5):
   - `docs/data-model.md`: `embeddings` section rewritten (`+title +description +link −content`; document `chunk_key` — currently omitted, stale since 3.3 — with the new `"<messageId>:<urlIndex>"` semantics; fix the stale "UPSERT on `id`" note → UPSERT on `chunk_key`; `message_ids` length-1 anchor note).
   - `docs/api-spec.yml`: `Citation` component + `SSEFrame` citation variant gain `link`; `/api/search` + `/api/documents` response descriptions updated to `title/description/link` (adding full fragment schema components is optional — the file is a declared scaffold; Zod remains the runtime truth).
   - `docs/context/ARCHITECTURE-SPINE.md`: AD-4 citation frame shape gains `link`; AD-5 note on the new `embeddings` columns + `chunk_key` semantics; AD-6 note on the fragment/citation contract change; new ingestion-capability note (workers will perform outbound fetch with SSRF mitigations + a generative LLM call — detail lands in 7.2).
   - `docs/context/TECHNICAL-DESIGN.md`: §13 config example gains the `enrichment` block; §9/§12 citation wire shape gains `link`; add a short pointer in §7 that the grouping/chunking pipeline is superseded by Epic 7 (full rewrite in Story 7.2).
   - `_bmad-output/planning-artifacts/epics.md`: FR5 rewritten + FR6/FR11/FR12/FR16/FR17/FR13/FR21 adjusted + "Épico 7" section appended with its 6 historias (verbatim text in proposal §4.4/§4.5; keep the file's Spanish).
   - `docs/context/PRD.md`: product-scope statement updated to the curated resource index (non-link discussion no longer searchable).
9. **Verification gate green and pasted as evidence** (agent-run): `npm run lint` && `npm run test` (unit+web) && `npm run build`; plus `npm run test:integration` (backend + workers suites against real Postgres/Redis, post-migration) and `npm run test:e2e -w @share2brain/web` (13 specs — they assert testids/classes, not content strings, and must stay green with placeholder data). Stop compose app containers first (`assertNoCompetingWriter` guard, OPS-2).

## Tasks / Subtasks

- [x] Task 0 — Branch + preconditions (AC: all)
  - [x] `git branch --show-current` → if `main`, `git switch -c feat/7-1-shared-resource-index-contracts`.
  - [x] `docker compose up -d postgres redis`; STOP app containers (backend/bot/workers) if running (OPS-2 guard).
  - [x] Confirm local `Share2Brain.config.yml` has `embeddings.dimensions: 1536` (schema generate-time reads it via `readEmbeddingDimensions()` — a wrong value produces a spurious vector-dimension diff in the migration).
- [x] Task 1 — Contracts first, tests-first where red is cheap (AC: 3, 4)
  - [x] Update `packages/shared/src/schemas/search.ts` + `search.test.ts` (write the new fixture/reject tests red, then swap the schema).
  - [x] Update `documents.ts` + `documents.test.ts` likewise.
  - [x] Update `db/schema.ts` `Citation` interface + `schemas/citation.ts` (+ refine helper) + `citation.test.ts`; confirm the two `satisfies` guards still compile.
  - [x] Add `sse.test.ts` cases for the citation frame with `link` (valid `''`, valid URL, reject non-URL non-empty, reject missing).
- [x] Task 2 — DB schema + migration (AC: 1, 2)
  - [x] Edit the `embeddings` table in `db/schema.ts` (columns, comments; indexes untouched).
  - [x] `npx drizzle-kit generate` — **expect the interactive rename prompt** ("is `title` renamed from `content`?"): answer **create new column** (NOT rename) for all three; then hand-review `0003_*.sql`.
  - [x] Truncate local data per runbook order, `npx drizzle-kit migrate`, verify `\d embeddings`.
  - [x] Write the deploy runbook (AC-2) — truncate order, migrate, full fresh ingest.
- [x] Task 3 — `enrichment` config block (AC: 5, 6)
  - [x] Extend `Share2BrainConfigSchema` + `superRefine` + `EnrichmentConfig` type; widen `createChatModel` to `ChatModelConfig`.
  - [x] Update `config/index.test.ts` (fixture + the 6 new cases in AC-6).
  - [x] Update `Share2Brain.config.yml.example`, local `Share2Brain.config.yml`, `.env.example`, local `.env`; check docker-compose env plumbing for workers.
- [x] Task 4 — Mechanical ripples, workers (AC: 7)
  - [x] `indexBatch.ts` values/`onConflictDoUpdate` sets → placeholder mapping; `processUpdate.ts` same.
  - [x] Retarget `indexBatch.test.ts`, `processUpdate.test.ts`, `indexBatch.integration.test.ts`, `sync.integration.test.ts` assertions from `content` → `description`.
- [x] Task 5 — Mechanical ripples, backend (AC: 7)
  - [x] Port interfaces (`SearchFragmentRow`, `DocumentFragmentRow`) → `title/description/link`.
  - [x] Raw SELECTs + mappers in `embeddingSearchRepository.drizzle.ts`, `documentRepository.drizzle.ts`, `ragRetriever.drizzle.ts`, `searchService.ts`, `documentService.ts`.
  - [x] `agent/prompt.ts` context line → `title — description (link)` (the 7.4-prescribed shape; rendering it now IS the mechanical fix).
  - [x] `agent/graph.ts` citation frame + `chatService.ts` citation accumulation gain `link`.
  - [x] `e2e/seed.ts`: `EmbeddingSpec.content` → `description` (+ `title: ''`, `link: ''`); `CONVERSATION_CITATIONS` gains `link: ''`; raw INSERT column list updated.
  - [x] Retarget backend unit tests (`graph.test.ts`, `searchService.test.ts`, `documentService.test.ts`) + the 8 integration suites listed in §Ripple map.
- [x] Task 6 — Mechanical ripples, web (AC: 7)
  - [x] `SearchView.tsx:351` renders `fragment.description`; `DocsView.tsx:448` renders `doc.description` (keep the `doc-row-content` testid element non-empty — e2e asserts it); `ChatWidget.tsx:301-305` citation construction gains `link` from the frame. NO visual redesign (7.5).
  - [x] Retarget `SearchView.test.tsx`, `DocsView.test.tsx`, `ChatWidget.test.tsx`, `api/conversations.test.ts` fixtures/assertions.
- [x] Task 7 — Docs (AC: 8) — data-model.md, api-spec.yml, ARCHITECTURE-SPINE.md, TECHNICAL-DESIGN.md, epics.md, PRD.md per AC-8 bullet list.
- [x] Task 8 — Verification gate + evidence (AC: 9); update this story's Dev Agent Record; flip sprint-status `7-1-…` → `review` on completion; commit in slices (§Git intelligence) and open the PR.

### Review Findings

_Code review 2026-07-09 (bmad-code-review, 3 adversarial layers). Acceptance Auditor found ZERO AC/decision violations; all substantive findings concern the dormant `link` field and are forward-looking to 7.2._

- [x] [Review][Defer] `link` empty-or-URL refine is a weak URL validator — the ratified D2 convention `v === '' || /^https?:\/\//.test(v)` is case-sensitive (rejects a valid `HTTP://…`) and prefix-only (accepts `https://` with no host, embedded whitespace/markup, or trailing garbage). Dormant in 7.1 (`link` is always `''`) but it is the shared contract 7.2 writes and 7.5 renders as an href. Compounding: `ragRetriever.drizzle.ts` maps rows through `SearchFragmentSchema.parse` per-row with no try/catch, so a single malformed `link` would abort the whole retrieval batch. [Sources: Edge #2, Edge #3] — deferred (decision, 2026-07-09): robust URL validation belongs to 7.2 where extraction/normalization lives; the D2 refine stays aligned with `base_url` and `link` is inert (`''`) in 7.1.
- [x] [Review][Patch] Deploy runbook automated-migration path can skip the truncate [_bmad-output/implementation-artifacts/operational-backlog.md:~90] — step 3's "or let the compose `migrator` one-shot service run it on the next `docker compose up`" reads as an alternative to the manual sequence; run out of order it skips step 2's `TRUNCATE`, the `ADD COLUMN … NOT NULL` fails on a non-empty table, and every app service (`depends_on: migrator service_completed_successfully`) fails to start. [Source: Edge #1] — FIXED: added a bold caveat to runbook step 3 that step 2's truncate MUST run first even on the `migrator` path.
- [x] [Review][Patch] Missing config reject-tests for validation branches this diff introduced [packages/shared/src/config/index.test.ts] — no negative case for `enrichment.llm.base_url` non-empty-invalid, `enrichment.fetch.allowed_schemes: []` (`.nonempty()`), or `enrichment.fetch.max_redirects: -1` (`.nonnegative()`); a future loosening of these rules would pass CI silently. [Source: Edge #6] — FIXED: added 3 reject-case tests; config suite now 36 passed (was 33).
- [x] [Review][Defer] Schema/doc comments describe the post-7.2 `chunk_key`/`messageIds` state ahead of the code [packages/shared/src/db/schema.ts + docs/data-model.md, docs/context/TECHNICAL-DESIGN.md] — `chunk_key = "<messageId>:<urlIndex>"` and `messageIds` length-1 are documented now, but shipped worker code (`indexBatch.ts`) still writes grouped multi-message arrays with a chunk index. Sanctioned by AC-1 + the AD-13 note ("7.1 just documents it"); resolved when 7.2 lands. — deferred, forward-doc by design. [Source: Blind #2]

**Dismissed as noise (6):** Blind #1 backend/bot boot failure (FALSE POSITIVE — all services use `env_file: - .env`, verified; the required secret reaches every container) · Blind #3 migration `NOT NULL`-without-default footgun (intentional/destructive-by-design, runbook-documented) · Edge #4 `ENRICHMENT_LLM_BASE_URL` per-service asymmetry (consistent with the pre-existing `EMBEDDINGS_BASE_URL` pattern; `.env.example` ships the line) · Edge #5 `prompt.ts` renders ` — <text> ()` under placeholders (spec-sanctioned "acceptable pre-7.2") · Auditor obs-1 Ripple-map under-lists 3 test files (all legit, in the File List) · Auditor obs-2 unit fixtures use non-empty `title` (test-only, harmless; runtime writes + e2e seed correctly use `''`).

## Dev Notes

### Architecture compliance (invariants that bind this story)

- **AD-5**: ONLY `packages/shared` does DDL; migration generated by drizzle-kit as explicit SQL, never hand-edited. Vector dimension is read at generate-time by the minimal YAML reader (`config/embeddingDimensions.ts`, default 1536) — NOT `loadConfig()`.
- **AD-6**: every API shape is a Zod schema in `packages/shared/src/schemas/`; consumers infer with `z.infer<>`. This story IS an AD-6 change — scoped `shared` per base-standards §"a change that alters the schema or a Zod contract is scoped shared even if a consumer motivated it".
- **AD-12 preserved**: `channelId` column and `idx_embeddings_channel` are untouched; RBAC stays inside the vector query. Do not touch any RBAC SQL.
- **AD-13**: `chunk_key` unique index + UPSERT convergence is the idempotency mechanism; the new `"<messageId>:<urlIndex>"` semantics keep redelivery convergent even under non-deterministic AI output (7.2 concern; 7.1 just documents it).
- **AD-8**: invalid YAML aborts every service pre-I/O — which is why the required `enrichment` block must land in BOTH yml files and the env var in `.env` before anything boots.
- **AD-2**: no cross-service imports; `providers/` stays subpath-only (`@share2brain/shared/providers`), never re-exported from the root barrel (keeps LangChain out of web/bot bundles).

### Current state (verbatim anchors — verified 2026-07-09)

**`embeddings` (schema.ts:56-78)**: `id uuid PK defaultRandom` · `chunkKey text notNull` (unique `idx_embeddings_chunk_key`; current comment says `"<firstMessageId>:<chunkIndex>"`, Story 3.3) · `content text notNull` ← drops · `embedding vector(EMBEDDING_DIMENSIONS) notNull` (HNSW `vector_cosine_ops`) · `channelId text notNull` (idx) · `messageIds text[] notNull` · `createdAt timestamptz defaultNow`. `EMBEDDING_DIMENSIONS` is module-local (schema.ts:27), fed by `readEmbeddingDimensions()`.

**`Citation` (schema.ts:29-34)**: `{ channel: string; author: string; date: string }` — used by `messages.citations: jsonb().$type<Citation[]>().notNull()` (schema.ts:129).

**`CitationSchema` (citation.ts:11-15)** `{channel, author, date}` + bidirectional compile guards (citation.ts:24-25): `void (null as unknown as CitationType satisfies Citation)` and the reverse — **both `Citation` and `CitationSchema` MUST gain `link` in the same edit or shared itself stops compiling** (that is the guard's purpose).

**`SSEFrameSchema` (sse.ts:7-16)**: citation frame is `z.object({ type: z.literal('citation') }).extend(CitationSchema.shape)` → inherits `link` for free.

**`SearchFragmentSchema` (search.ts:32-42)**: `{ id: z.uuid(), content, channelId, channelName, authorId, authorName, createdAt, similarity: 0..1, messageId }`. **`DocumentFragmentSchema` (documents.ts:31-42)**: same minus `similarity`, plus `indexedAt`, `isRead`.

**Config (`config/index.ts`)**: `Share2BrainConfigSchema` at :40; top-level blocks `version, discord, agent, embeddings, knowledge, sync, access_control, read_tracking, observability, security, notifications?, streams?`; `superRefine` at :139-194. The `agent` block (:55-65) is the shape template for `enrichment.llm` (provider enum, model min-1, temperature, empty-or-URL `base_url` refine at :61-63, api_key min-1). **No `.default()`s anywhere in the schema** — keep it that way; values live in YAML. `interpolateEnv` (:200-214) replaces `${VAR}` across the WHOLE raw file **including comments** before YAML parse and throws on unset vars. `loadConfig` (:237-264).

**Providers (`providers/index.ts`)**: `createChatModel(agent: Share2BrainConfig['agent']): BaseChatModel` (:35) destructures exactly `{provider, api_key, model, temperature, base_url}`; `createEmbeddingsModel` (:70). Keys passed explicitly — never rely on LangChain's implicit env lookup. Subpath-only export.

**Migrations**: `packages/shared/src/db/migrations/` → `0000_enable_pgvector.sql` (hand-written), `0001_tough_skrulls.sql` (initial), `0002_lush_fabian_cortez.sql` (chunk_key, Story 3.3). `drizzle.config.ts` at repo root (`out: './packages/shared/src/db/migrations'`). Compose `migrator` one-shot service applies them (`npx drizzle-kit migrate`, journal-idempotent); app services `depends_on: service_completed_successfully`.

**`user_read_status`** FKs `embeddings.id` with **no cascade** (plain `no action`) → any truncate/delete must remove `user_read_status` rows FIRST. Same for `messages` → `conversations`.

### Placeholder policy (the ONE invented behavior — keep it boring and uniform)

Until 7.2 produces real data, every mechanical write/seed uses exactly:

```
title:       ''            // AI-generated in 7.2
description: <old content text>   // semantic successor of `content` — carries the old value
link:        ''            // extracted URL in 7.2; '' passes the empty-or-URL refine
```

- Test assertions previously on `content` retarget to `description` with the SAME expected strings — this keeps intent (`indexBatch.test.ts:142` `'hello world'`, `processUpdate.test.ts:172` `'edited content'`, `sync.integration.test.ts:161` `'brand new edited content'`, `indexBatch.integration.test.ts:134`, the web `getByText/findByText` fixtures, and the 5 e2e seed sentences).
- NO unique index on `link` (all placeholders are `''`).
- Citation `link` placeholder is also `''` (valid per refine). e2e `CONVERSATION_CITATIONS` gains `link: ''`.
- `prompt.ts` renders `title — description (link)`; with placeholders that yields ` — <old text> ()` — acceptable pre-7.2, and it means 7.4 inherits the final format already wired.

### Ripple map (exhaustive — from the 2026-07-09 blast-radius analysis)

**Do-NOT-touch look-alikes**: `discord_messages.content` (schema.ts:44), `messages.content` (:128), the SSE `token` frame's `content` (sse.ts:8), `MessageCreatedEvent.content` / `MessageUpdatedEvent.newContent` (types/events.ts), everything in `packages/bot` (zero embeddings references), `agent/graph.ts`/`compress.ts` ChatTurn content, `chatService.ts` message content, `processDelete.ts` (only `ANY(message_ids)` deletes — no content).

**Workers (2 src + 4 test files)**
- `indexer/indexBatch.ts:184-201` — `.values({ content: chunks[i] … })` and `set: { content: sql\`excluded.content\` … }` → placeholder mapping + `excluded.title/description/link`. Steps 1–5 of the pipeline (events/dedup/grouping/chunking/embed) are 7.2's demolition zone — DO NOT touch beyond compiling.
- `sync/processUpdate.ts:100-115` — same two spots (`:89-93` is `discord_messages.content` — stays).
- Tests: `indexBatch.test.ts` (:33-35,53,142), `processUpdate.test.ts` (:42,172), `indexBatch.integration.test.ts` (:126,134), `sync.integration.test.ts` (:92-93,118,161).

**Backend (10 src + ~9 test files)**
- Ports: `domain/repositories/embeddingSearchRepository.ts:17`, `documentRepository.ts:18` (`content` → three fields).
- Raw SQL SELECT + mapper: `infrastructure/embeddingSearchRepository.drizzle.ts:37,74`; `documentRepository.drizzle.ts:30,61`; `ragRetriever.drizzle.ts:27-29` (feeds `SearchFragmentSchema.parse`).
- Mappers: `searchService.ts:39`, `documentService.ts:61`.
- `agent/prompt.ts:23` (`${f.content}` — hard compile error) → `title — description (link)` line.
- `agent/graph.ts:180-186` citation frame construction → `+ link: fragment.link`; `chatService.ts:~137` accumulation → `+ link: frame.link`.
- `e2e/seed.ts`: `EmbeddingSpec` (:48-55), 5 rows (:79-85), raw INSERT (:155-163), `CONVERSATION_CITATIONS` (:102-104).
- Unit tests: `graph.test.ts:31-44,105` (fakeFragment + citation-frame expectation), `searchService.test.ts:20-30,65`, `documentService.test.ts:18,58`.
- Integration (raw `insert into embeddings (chunk_key, content, …)` column lists + a few shape asserts): `search.integration.test.ts:58-59`, `documents.integration.test.ts:57-58`, `readStatus.integration.test.ts:57-58`, `chat.integration.test.ts:78-79` (+`:192,207` citation `toEqual` gains `link`), `conversations.integration.test.ts:73-74,195-206`, `embeddingSearchRepository.drizzle.integration.test.ts:52-53`, `documentRepository.drizzle.integration.test.ts:37-38`, `readStatusRepository.drizzle.integration.test.ts:41-42`. **`rbac.integration.test.ts` has ZERO embeddings references — if it goes red, that is the deferred-work.md load-sensitive session flake, not you.**
- Integration seeding discipline (OPS-2): run-unique salted ids, cleanup deletes only own ids, never broad `LIKE`; `assertNoCompetingWriter` throws if a compose app container holds a connection.

**Web (3 src + 4-5 test files)**
- `components/SearchView.tsx:351` (`{fragment.content}`), `DocsView.tsx:448` (`{doc.content}`), `ChatWidget.tsx:301-305` (CitationType construction; the CitationChip hardcoded-discord-href at :949-956 stays — rendering `link` is 7.5).
- Tests: `SearchView.test.tsx:23,35,114-123`, `DocsView.test.tsx:27,40` + ~12 `findByText` cases, `ChatWidget.test.tsx:319,452`, `api/conversations.test.ts:81,88,112`.
- Playwright specs (`tests/*.spec.ts`) assert testids/classes/channel text — safe as long as seed inserts succeed and `doc-row-content` stays non-empty (placeholder `description` = old sentences → OK). jsdom gotcha: repo has no jest-dom — use `.textContent`/`toContain`, not `toHaveTextContent`.

**Shared's own tests**: `search.test.ts:65-94`, `documents.test.ts:103-132`, `citation.test.ts`, `sse.test.ts` (+new cases), `conversations.test.ts:71,90` (citation arrays gain `link`), `config/index.test.ts` (fixture is the FULL `VALID_YAML` string at :9-68 — the required `enrichment` block must be added there or ~28 tests fail). Other packages build config fixtures via `as unknown as Share2BrainConfig` — immune to the new block.

### Migration procedure + gotchas (Story 3.3 playbook, adapted)

1. Verify `Share2Brain.config.yml` `embeddings.dimensions: 1536` (generate-time read).
2. Edit schema.ts → `npx drizzle-kit generate`.
3. **drizzle-kit WILL prompt interactively**: dropping `content` while adding `title/description/link` triggers the rename-or-new heuristic. Answer **"+ create column"** for all three — a rename would corrupt the snapshot semantics.
4. Hand-review the SQL: expect exactly 1 DROP + 3 ADD `NOT NULL` on `embeddings`. `NOT NULL` without default is safe ONLY because the approved runbook truncates first (the 0002 precedent comment) — on any non-empty table the ALTER fails; that is by design, not a bug to work around.
5. Apply locally: truncate (runbook order) → `npx drizzle-kit migrate` → `\d embeddings`.
6. Commit the SQL + `meta/0003_snapshot.json` + `meta/_journal.json` together.

### Latest tech notes (researched 2026-07-09)

- **Zod 4.4.3** (installed): `z.string().url()` is DEPRECATED in favor of top-level `z.url()` ([changelog](https://zod.dev/v4/changelog)). This repo uses neither — it uses the empty-or-URL refine convention, which D2 adopts for `link`. Do NOT introduce `z.string().url()`.
- **drizzle-kit 0.31**: `generate` prompts interactively on ambiguous drop+add (rename detection) — see step 3 above; there is no non-interactive answer file, so the dev agent must run it in a TTY and answer the prompt ([docs](https://orm.drizzle.team/docs/drizzle-kit-generate)).
- `@langchain/*` versions unchanged by this story; `createChatModel` widening is type-level only.

### Previous story intelligence

- **6.4 (config-block precedent)**: touched `config/index.ts` + `index.test.ts` + BOTH yml files + `.env.example`; initially missed the tracked `Share2Brain.config.yml.example` (git status doesn't surface the gitignored real file — don't repeat); the interpolateEnv-in-comments gotcha is 6.4's headline discovery.
- **3.3 (migration precedent)**: shared schema change in its own `feat(shared)` commit including `meta/` files; hand-review + local apply + `\d` verification before committing.
- **OPS-1/OPS-2**: `streams` optional-block precedent (not used here — enrichment is required); integration-test hygiene (salted ids, `assertNoCompetingWriter`, `SHARE2BRAIN_TEST_ALLOW_SHARED_DB=1` escape hatch); the residual RBAC-adjacent session flake is documented in `deferred-work.md` — don't chase it.
- **Epic 4 AI#4 (web)**: base border/color values must live in CSS classes, not inline — irrelevant here unless you touch styles (you shouldn't).

### Git intelligence

Recent pattern: one feature commit per meaningful slice + PR per story (`gh pr create`, base `main`, never auto-merge). Suggested slices (Conventional Commits, English, ≤72 chars):
1. `feat(shared)!: replace embeddings.content with title/description/link` — schema + migration 0003 (+meta) + search/documents/citation/sse contracts + shared tests. Footer: `BREAKING CHANGE: embeddings and search/document/citation contracts expose title/description/link; consumers must re-index (full wipe runbook in story 7.1).`
2. `feat(shared)!: add required enrichment config block` — config schema + tests + yml example + .env.example + `ChatModelConfig` widening. Footer: `BREAKING CHANGE: Share2Brain.config.yml requires an enrichment block; ENRICHMENT_LLM_API_KEY must be set.`
3. `refactor(repo): adapt workers/backend/web to resource-index contracts` — mechanical ripples + retargeted tests + e2e seed.
4. `docs(repo): sync data-model, api-spec, spine, technical-design, epics for epic 7`.

### Project Structure Notes

- All shared changes under `packages/shared/src/` (schema/schemas/config/providers + migrations). No root `src/`, no new packages, no new dependencies, no version bumps.
- Ripples touch ONLY the files in §Ripple map; if compilation demands touching anything else, STOP and re-check — it likely means behavior is leaking in from 7.2–7.5.
- English only in code/comments/tests/commits/docs, regardless of this story file's Spanish title.
- Docs edits: `epics.md` keeps its Spanish; `docs/` files keep their existing language/format.

### References

- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-09.md §4.1-§4.5, §5, Resolved items] — the approved change, schema/contract/config specs, story list.
- [Source: docs/context/ARCHITECTURE-SPINE.md AD-2/AD-4/AD-5/AD-6/AD-8/AD-12/AD-13]
- [Source: docs/data-model.md §2 embeddings, §Write Ownership, §Critical Indexes]
- [Source: docs/base-standards.md §2, §4, §6, §7 (breaking-change marking :123-131; scoping rule :121)]
- [Source: docs/bmad-story-mandatory-steps.md §2, §3.2, §3.5]
- [Source: docs/context/TECHNICAL-DESIGN.md §7, §9, §12, §13]
- [Source: _bmad-output/implementation-artifacts/6-4-notificaciones-externas-seguridad-y-graceful-shutdown.md — config-block + interpolateEnv learnings]
- [Source: _bmad-output/implementation-artifacts/3-3-workers-indexer-embeddings-y-pgvector.md — migration playbook]
- [Source: _bmad-output/implementation-artifacts/ops-2-integration-test-isolation.md — integration hygiene]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5)

### Debug Log References

- `npx drizzle-kit generate` requires a real TTY (fails with "Interactive prompts require a TTY
  terminal" under a plain piped shell); drove it via `expect` scripting `\r` on the "create column"
  default-selected option for `title`/`description`/`link` — matches the story's documented gotcha.
- One `documents.integration.test.ts` login-flow test (`expected 401 to be 302`) failed once under
  the full parallel `test:integration` run and passed both in isolation and on an immediate re-run
  of the full suite — a load-sensitive session/Redis flake under concurrent integration suites,
  consistent with the pre-existing intermittency already documented in `deferred-work.md` /
  `operational-backlog.md` P1.2. Not caused by this story's changes (schema-unrelated auth path);
  not chased further per established project convention.

### Completion Notes List

- **AC-1/AC-2 (schema + migration):** `embeddings` redefined (`chunk_key, title, description, link,
  embedding, channelId, messageIds, createdAt`); migration `0003_bent_mandrill.sql` generated
  (exactly 3 `ADD COLUMN … NOT NULL` + 1 `DROP COLUMN`, hand-reviewed), applied locally against
  compose Postgres after a full FK-safe truncate (`user_read_status, messages, conversations,
  embeddings, discord_messages`), verified with `\d embeddings`. Deploy runbook documented in
  `operational-backlog.md` § Deploy runbooks (new section).
- **AC-3/AC-4 (contracts):** `SearchFragmentSchema`/`DocumentFragmentSchema` swap `content` →
  `title/description/link` (empty-or-URL refine, D2); `CitationSchema` + the `Citation` interface
  both gain required `link` in the same edit (the bidirectional `satisfies` guards still compile);
  `sse.test.ts` covers the citation frame's `link` (empty/URL/reject/missing).
- **AC-5/AC-6 (enrichment config):** `Share2BrainConfigSchema` gains a REQUIRED `enrichment` block
  (`language`, `llm{provider,model,temperature,base_url?,api_key}`, `fetch{timeout_ms,max_bytes,
  max_redirects,user_agent,allowed_schemes,block_private_ips}`); `superRefine` extended for
  `enrichment.llm.provider === 'custom'` → `base_url` required, mirroring `agent`/`embeddings`.
  `createChatModel` widened to a structural `ChatModelConfig` (zero behavior change). Both
  `Share2Brain.config.yml{,.example}` + `.env.example` gained the block/secret; local `.env` reuses
  `LLM_API_KEY`'s value for `ENRICHMENT_LLM_API_KEY` (provider stays `anthropic` locally, so no
  `base_url` needed). `docker-compose.yml` workers `environment:` gained
  `ENRICHMENT_LLM_API_KEY`/`ENRICHMENT_LLM_BASE_URL` (mirrors the existing `EMBEDDINGS_*` pattern —
  workers is where Story 7.2's Indexer will consume it).
- **AC-7 (mechanical ripples, Placeholder policy):** workers (`indexBatch.ts`, `processUpdate.ts`)
  write `{title:'', description:<old content>, link:''}` on every insert/upsert; backend ports,
  Drizzle repos, `ragRetriever`, `searchService`/`documentService`, `agent/prompt.ts` (renders
  `title — description (link)`), `agent/graph.ts`/`chatService.ts` (citation gains `link`),
  `e2e/seed.ts` all updated under the same policy; web `SearchView.tsx`/`DocsView.tsx` render
  `description`, `ChatWidget.tsx` citation construction gains `link`. All retargeted tests
  (unit + the 8 backend integration suites + 4 workers suites) assert the SAME expected strings
  under the new field names — behavior-preserving, zero new logic.
- **AC-8 (docs):** `data-model.md` (embeddings section rewritten, `idx_embeddings_chunk_key`
  documented — was stale/omitted since Story 3.3 — UPSERT-on-`chunk_key` note fixed);
  `api-spec.yml` (`Citation`/`SSEFrame` gain `link`, `/api/search`+`/api/documents` descriptions);
  `ARCHITECTURE-SPINE.md` (AD-4/AD-5/AD-6 notes + new ingestion-capability note on AD-13); `TECHNICAL-
  DESIGN.md` (§7 "superseded" pointer, §9/§12 citation `link`, §13 `enrichment` example, §6 ER
  diagram brought in sync with `data-model.md`); `epics.md` (FR5 rewritten, FR6/FR11/FR12/FR13/
  FR16/FR17/FR21 adjusted, "Épico 7" summary + detailed section appended — the 6 historias are
  listed as scope-only; full Gherkin ACs land when each is created via `bmad-create-story`, matching
  the fact that only 7.1 exists today); `PRD.md` (executive-summary + scope note on the pivot,
  not a full document rewrite — the rest of the legacy PRD is explicitly flagged as pre-pivot and
  updated incrementally as 7.2–7.6 land, consistent with this story doing NO behavioral work).
- **AC-9 (verification gate, evidence):**
  - `npm run lint` → 0 errors.
  - `npm run test` (unit+web) → **78 files / 685 tests passed**.
  - `npm run build` (5 packages: shared, backend, bot, workers — `tsc --noEmit`; web — `vite build`)
    → clean.
  - `npm run test:integration` (backend + bot + workers) → **19 files / 110 tests passed** (one
    transient login-flow flake on the first parallel run, green on re-run — see Debug Log).
  - `npm run test:e2e -w @share2brain/web` → **13/13 Playwright specs passed** (Chromium; asserts
    testids/classes, not content strings, so placeholder `title:''/link:''` data doesn't break
    them, as anticipated in the story's Dev Notes).
- No new dependencies, no version bumps. Local gitignored `Share2Brain.config.yml`/`.env` were updated
  (not tracked by git) alongside their tracked `.example` counterparts — 6.4's gotcha honored.

### File List

**New:**
- `packages/shared/src/db/migrations/0003_bent_mandrill.sql`
- `packages/shared/src/db/migrations/meta/0003_snapshot.json`

**Modified — `packages/shared`:**
- `src/db/schema.ts` — `Citation` interface gains `link`; `embeddings` table redefined
- `src/db/migrations/meta/_journal.json`
- `src/schemas/search.ts`, `src/schemas/search.test.ts`
- `src/schemas/documents.ts`, `src/schemas/documents.test.ts`
- `src/schemas/citation.ts`, `src/schemas/citation.test.ts`
- `src/schemas/sse.test.ts`
- `src/schemas/conversations.test.ts`
- `src/config/index.ts`, `src/config/index.test.ts`
- `src/providers/index.ts`

**Modified — `packages/workers`:**
- `src/indexer/indexBatch.ts`, `src/indexer/indexBatch.test.ts`, `src/indexer/indexBatch.integration.test.ts`
- `src/sync/processUpdate.ts`, `src/sync/processUpdate.test.ts`, `src/sync/sync.integration.test.ts`

**Modified — `packages/backend`:**
- `src/domain/repositories/embeddingSearchRepository.ts`, `src/domain/repositories/documentRepository.ts`
- `src/infrastructure/embeddingSearchRepository.drizzle.ts`, `src/infrastructure/embeddingSearchRepository.drizzle.integration.test.ts`
- `src/infrastructure/documentRepository.drizzle.ts`, `src/infrastructure/documentRepository.drizzle.integration.test.ts`
- `src/infrastructure/ragRetriever.drizzle.ts`
- `src/infrastructure/readStatusRepository.drizzle.integration.test.ts`
- `src/application/services/searchService.ts`, `src/application/services/searchService.test.ts`
- `src/application/services/documentService.ts`, `src/application/services/documentService.test.ts`
- `src/application/services/chatService.ts`, `src/application/services/chatService.test.ts`
- `src/application/services/conversationService.test.ts`
- `src/agent/prompt.ts`, `src/agent/graph.ts`, `src/agent/graph.test.ts`
- `src/e2e/seed.ts`
- `src/search.integration.test.ts`, `src/documents.integration.test.ts`, `src/readStatus.integration.test.ts`
- `src/chat.integration.test.ts`, `src/conversations.integration.test.ts`

**Modified — `packages/web`:**
- `src/components/SearchView.tsx`, `src/components/SearchView.test.tsx`
- `src/components/DocsView.tsx`, `src/components/DocsView.test.tsx`
- `src/components/ChatWidget.tsx`, `src/components/ChatWidget.test.tsx`
- `src/api/conversations.test.ts`, `src/api/chat.test.ts`
- `src/App.test.tsx`

**Modified — config/infra (repo root):**
- `Share2Brain.config.yml.example`, `.env.example`, `docker-compose.yml`
- Local gitignored `Share2Brain.config.yml`, `.env` (not tracked by git — see Completion Notes)

**Modified — docs:**
- `docs/data-model.md`, `docs/api-spec.yml`
- `docs/context/ARCHITECTURE-SPINE.md`, `docs/context/TECHNICAL-DESIGN.md`, `docs/context/PRD.md`
- `_bmad-output/planning-artifacts/epics.md`
- `_bmad-output/implementation-artifacts/operational-backlog.md` (new § Deploy runbooks)
- `_bmad-output/implementation-artifacts/sprint-status.yaml`

## Change Log

| Date | Change |
|---|---|
| 2026-07-09 | Story 7.1 implemented: `embeddings` schema/migration, search/documents/citation/sse contracts, required `enrichment` config block, mechanical ripples across workers/backend/web, docs synced. Gate green (lint 0 / 685 unit+web / build clean / 110 integration / 13 e2e). Status → review. |
