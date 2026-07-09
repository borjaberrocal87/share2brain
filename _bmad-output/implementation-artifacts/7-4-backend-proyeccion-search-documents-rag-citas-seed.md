---
baseline_commit: a0e7edbda49439c267209f765243c23b2bf01fa8
---

<!-- Powered by BMAD-CORE™ -->

<!-- story_key: 7-4-backend-proyeccion-search-documents-rag-citas-seed -->

# Story 7.4: backend — proyección search/documents/RAG/citas + seed e2e

Status: done

<!-- Ultimate context engine analysis completed - comprehensive developer guide created
     (2 parallel deep-dives: backend current-state + shared contracts/docs; prior-story intel from 7.1/7.2/7.3). -->

## Story

As a **community member consuming Hivly's search, documents and chat**,
I want **the backend to project the curated resource index for real end-to-end — a RAG agent that
reasons and cites in resource terms (title + source link, FR13), strict link contracts, retrieval
that survives a corrupt row, and an e2e seed with realistic resources**,
so that **the Epic 7 pivot is visible and verifiable at the API/agent layer and Stories 7.5/7.6
have real data and final contracts to render and verify**.

**Scope**: `packages/backend` (prompt semantics, retriever resilience, e2e seed, fixtures/assertions)
+ `packages/shared` (strict link refine + `Citation.title` — a contract change is scoped `shared`
even when a consumer motivates it, AD-6) + mechanical compile ripples in `packages/web` test/
construction code (NO visual work) + docs sync. Epic line: *"Historia 7.4 · backend: proyección
search/documents/RAG/prompt/citas + seed e2e"* [Source: _bmad-output/planning-artifacts/epics.md:1009].

**Out of scope**: web rendering of title/link and the citation-chip redesign (7.5); e2e visual
harness extension (7.6); FR21 notifications (P2.5); `tool_exec`/trace panel (deferred-work F1);
any new endpoint or search-behavior change; workers (7.2/7.3 are done and merged).

**Critical context — what 7.1 already did**: commit `3b4e4f9` applied the *mechanical* projection
everywhere. Every SELECT, port interface, service mapper, the prompt context line, the SSE citation
frame and citation persistence ALREADY carry `title/description/link`; grep confirms **zero**
`embeddings.content` references remain in the backend. What 7.1 did NOT do is give any of it real
semantics: the SYSTEM_PROMPT still speaks pre-pivot "knowledge fragments from Discord history"
language, the e2e seed and every fixture insert `title: ''`/`link: ''`, and
`linkRefine.ts:2-3` says literally *"backend seeds/legacy placeholders — 7.4 updates the seed"*.
7.4 is semantics + data + hardening, not plumbing.

## Decisions confirmed with Borja (2026-07-09, story creation)

| # | Fork | Decision |
|---|---|---|
| F1 | Empty-link (`''`) tolerance in contracts | **Tighten to strict URL.** `linkRefine` stops accepting `''`; `SearchFragmentSchema`/`DocumentFragmentSchema`/`CitationSchema` `link` becomes a mandatory valid http(s) URL. Consequence accepted: pre-7.4 persisted rows (placeholder embeddings `link:''`, legacy citations) fail the contract → covered by the ratified Epic 7 clean-slate runbook (7.1 D1 already extends the wipe to `conversations`+`messages`); local dev DBs must be truncated before running 7.4. Config `base_url` refines (agent/embeddings/enrichment.llm) are a DIFFERENT convention and stay untouched. |
| F2 | `ragRetriever` per-row parse fragility (7.1 review deferral, part b) | **Skip-and-warn.** Wrap the per-row `SearchFragmentSchema.parse`: an invalid row is dropped with `logger.warn({ embeddingId, channelId, reason })` — never title/description/link values — and the rest of the batch continues. Chat degrades to N−1 resources instead of a 500. Closes the deferral in `deferred-work.md:153`. |
| F3 | Citation gains `title` | **Yes.** `Citation` interface + `CitationSchema` + SSE `citation` frame + persistence gain required `title` (the retrieved fragment's title), so the 7.5 sources chip can show the resource title. Ratified extension of the correct-course citation shape (`channel, author, date, link` → `+ title`). Chip *rendering* stays 7.5; 7.4 only carries the data. |

### Design decisions embedded in the ACs (recommended defaults — veto at review)

- **D1 — Strict refine implementation**: rename `isEmptyOrHttpUrl` → `isHttpUrl` in
  `packages/shared/src/schemas/linkRefine.ts`, dropping only the `value === ''` early-return; keep
  the whitespace reject, `URL.canParse`, http/https protocol set and non-empty hostname checks
  (all 7.2-hardened). Update `LINK_REFINE_MESSAGE` ("link must be a valid HTTP(S) URL"). Grep-clean:
  no `isEmptyOrHttpUrl` reference survives. NEVER `z.string().url()` (deprecated) nor strict
  `z.url()` — the repo convention is the named-refine helper (SPINE AD-6 note).
- **D2 — `Citation.title` is plain `z.string()`** (like `channel`/`author`) — the enrichment
  pipeline bounds title at 200 chars at generation time (7.2); the contract does not re-bound it.
  Both sides of the bidirectional `satisfies` guard (`citation.ts:28-29`) move in the same edit.
- **D3 — search/documents endpoints keep fail-fast edge validation** (AD-6:
  `SearchResponseSchema.parse`/`DocumentsResponseSchema.parse` in the services). F2's skip-and-warn
  applies ONLY to the retriever (a whole-chat 500 from one row is disproportionate; a loud search
  failure on corrupt data is diagnostic). Do not add row-skipping to the services.
- **D4 — Seed URLs use the RFC-2606 reserved domain** (`https://example.com/e2e/<slug>`,
  deterministic per row). The backend never fetches links, so any URL is safe — reserved domains
  just make that obvious and future-proof. Seed titles/descriptions stay Spanish product-flavored
  sentences (they are user-visible data, not code).
- **D5 — SYSTEM_PROMPT keeps the Epic-5 grounding invariants** (answer ONLY from provided context;
  admit "I don't have enough information" explicitly; concise) and adds the resource framing: each
  context item is a curated community resource (title, description, source URL, channel/author/date);
  when recommending a resource, include its link in the answer. Keep `[n]` numbering and the
  `#channel — author (date)` header line of `buildRAGContext` unchanged.
- **D6 — No new deps, no DDL, no migration.** `messages.citations` is jsonb (`$type<Citation[]>`)
  — adding `title` is a TypeScript/Zod change only. `embeddings` schema untouched.

## Acceptance Criteria

1. **Strict link contract (F1, D1)** — `linkRefine.ts` exports strict `isHttpUrl` (rejects `''`,
   whitespace, non-parseable, non-http(s), empty hostname); `SearchFragmentSchema`,
   `DocumentFragmentSchema` and `CitationSchema` use it for `link`; `linkRefine.test.ts` +
   `search.test.ts` + `documents.test.ts` + `citation.test.ts` + `sse.test.ts` flip `''` from
   accept to reject; config `base_url` refines untouched; repo-wide grep shows no
   `isEmptyOrHttpUrl` and no remaining `link: ''` in active code/fixtures/seeds.
2. **Citation gains required `title` (F3, D2)** — `Citation` interface (`db/schema.ts:30-35`) and
   `CitationSchema` (`schemas/citation.ts`) gain `title: z.string()` in the same edit (both
   `satisfies` guards compile); the SSE `citation` frame inherits it via `CitationSchema.shape`
   (`sse.ts:11`) with new `sse.test.ts` accept/reject cases; `agent/graph.ts` emits
   `title: fragment.title` in the citation frame; `chatService.ts` persists it;
   `GET /api/conversations/:conversationId` round-trips it; `ChatWidget.tsx` citation construction
   gains `title` (mechanical compile ripple ONLY — no chip redesign).
3. **RAG prompt reframed to the curated resource index (FR13, D5)** — `SYSTEM_PROMPT` in
   `agent/prompt.ts` rewritten: Hivly answers ONLY from the curated community resources provided as
   context; grounds every claim in them; cites channel and author inline AND includes the resource
   link when recommending a resource; states plainly when no resource answers the question.
   `buildRAGContext` keeps the `[n] #${channelName} — ${authorName} (${createdAt}):` header +
   `${title} — ${description} (${link})` line; the empty-retrieval string speaks "resources", not
   "knowledge fragments". NEW `prompt.test.ts` covers: exact fragment-line format, `[n]` numbering,
   empty case, and the SYSTEM_PROMPT invariants (only-indexed-info + link-citing instructions
   present). `graph.test.ts`'s single-system-message invariant (Epic 5 retro) stays green.
4. **Retrieval survives a corrupt row (F2)** — `ragRetriever.drizzle.ts` wraps the per-row
   `SearchFragmentSchema.parse`; an invalid row is skipped with `logger.warn({ embeddingId,
   channelId, reason })` (NEVER field values — titles/descriptions are content) and the remaining
   rows are returned; a NEW unit test proves one malformed row among K valid yields K−1 fragments +
   exactly one warn, and an all-valid batch warns nothing. The retriever port signature is unchanged.
5. **e2e seed seeds realistic resources (D4)** — `e2e/seed.ts`'s `EmbeddingSpec` gains required
   `title` + `link`; the 5 seed rows get distinct realistic titles/descriptions and deterministic
   `https://example.com/e2e/...` links; the raw INSERT binds `${e.title}`/`${e.link}` per row
   (no more hardcoded `''`); `CONVERSATION_CITATIONS` gains `title` + a real link consistent with
   the seeded answer. PRESERVED: `e2e-` prefix scoping of every delete, FK delete order, the
   anchor rows in `MESSAGES` (INNER JOIN drops rows without them), the one-hot `unitVector(i)`
   similarity ladder (1.0/0.8/0.6/0.5/0.3 drives search.spec ordering), distinct `created_at`,
   `READ_CHUNK_KEYS` mixed read state, the derived-conversation-title convention, and the exact
   seeded assistant answer text (`chat.spec.ts:39` asserts it verbatim). All 13 Playwright
   chromium specs stay green.
6. **Fixtures upgraded + first field-value assertions** — the placeholder `('', description, '')`
   embeddings inserts in the 8 backend integration suites (`search`, `documents`, `readStatus`,
   `chat`, `conversations` at `src/*.integration.test.ts` + the 3
   `infrastructure/{embeddingSearchRepository,documentRepository,readStatusRepository}.drizzle.integration.test.ts`)
   gain real salted titles/links; NEW assertions: `/api/search` and `/api/documents` responses round-trip
   `title`/`description`/`link` from the DB rows (today NO integration test asserts these values);
   `chat.integration.test.ts` asserts citation frames AND persisted citations carry the fragment's
   real `title`+`link` (flip the `link: ''` expectations at :193/:208);
   `conversations.integration.test.ts` round-trips `title`+`link`. Backend unit fixtures
   (`searchService.test.ts`, `documentService.test.ts`, `graph.test.ts`, `chatService.test.ts`) and
   web fixtures (`ChatWidget.test.tsx`, `api/conversations.test.ts`, `api/chat.test.ts` if it
   carries citation frames) flip `link: ''` → real URLs and gain `title` in citations. UNCHANGED:
   every RBAC/D1-anti-join/pagination/read-status/frame-order assertion.
7. **Runbook + docs sync (mandatory-steps §3.5)** — the Epic 7 clean-slate runbook
   (`operational-backlog.md` § Deploy runbooks) gains a 7.4 note: the strict contracts make
   pre-7.4 persisted data unparseable (placeholder embeddings on search/documents; legacy
   citations on conversation detail), so the already-ratified wipe MUST run when deploying 7.4
   over a pre-7.4 DB. Docs refreshed: `docs/api-spec.yml` (`Citation` +`title`, `link` strict
   wording — drop "empty string pre-Story-7.2"), `docs/data-model.md` (citations jsonb +`title`;
   embeddings `link` note drops the placeholder sentence), `docs/context/ARCHITECTURE-SPINE.md`
   AD-4/AD-6 notes (citation shape +`title`; refine now strict, `''` no longer valid),
   `docs/context/TECHNICAL-DESIGN.md` §9/§12 (citation wire shape +`title`; document the
   context-line format `title — description (link)` where §9 references `buildRAGContext`), and
   the stale comments in `linkRefine.ts` / `search.ts:30-33` / `documents.ts:29-33`.
8. **Endpoint verification (§3.3, AGENT-run) + gate** — with the local stack up and real-shaped
   rows: `GET /api/search` and `GET /api/documents` verified (200 shape vs Zod, RBAC never leaks
   fragments outside `allowedChannelIds`, unified `{error, code}` on invalid input);
   `POST /api/chat` SSE verified (incremental `token` frames → `citation` frames carrying
   `title`+`link` → `done`); state restored. Gate green and pasted: `npm run lint` (0) &&
   `npm run test` (unit+web) && `npm run build` (5 pkgs) && `npm run test:integration` &&
   `npm run test:e2e -w @hivly/web` (13 chromium, pass-count unchanged).

## Tasks / Subtasks

- [x] Task 0 — Branch + preconditions (AC: all)
  - [x] `git branch --show-current` → if `main`, `git switch -c feat/7-4-backend-resource-projection`.
  - [x] `docker compose up -d postgres redis`; STOP app containers (`docker compose stop bot backend workers`) — OPS-2 `assertNoCompetingWriter`.
  - [x] Truncate local data per the clean-slate runbook (strict contracts reject pre-7.4 rows): `TRUNCATE user_read_status, messages, conversations, embeddings, discord_messages` (FK order).
- [x] Task 1 — Shared contracts, tests-first (AC: 1, 2)
  - [x] Flip `linkRefine.test.ts` + the four schema test suites red (`''` → reject; citation `title` accept/reject; SSE citation frame cases), then implement: `isHttpUrl` rename+strictening, `CitationSchema`+`Citation` `title` (same edit — the `satisfies` guards enforce it), swap the refine in `search.ts`/`documents.ts`/`citation.ts`.
  - [x] Refresh the stale doc-comments in `linkRefine.ts`, `search.ts`, `documents.ts`, `citation.ts`.
  - [x] `conversations.test.ts` (shared) citation fixtures gain `title` + real link.
- [x] Task 2 — Mechanical compile ripples (AC: 2, 6)
  - [x] `agent/graph.ts:180-188` citation frame `+ title: fragment.title`; `chatService.ts:136-142` accumulation `+ title: frame.title`.
  - [x] `packages/web/src/components/ChatWidget.tsx:301-305` CitationType construction `+ title` (compile-only; chip rendering untouched).
  - [x] Flip every `link: ''` fixture: backend unit (4 files), web (`ChatWidget.test.tsx`, `api/conversations.test.ts`, check `api/chat.test.ts`/`App.test.tsx`), shared (already in Task 1).
- [x] Task 3 — Prompt (AC: 3)
  - [x] Rewrite `SYSTEM_PROMPT` per D5; adjust the `buildRAGContext` empty-case string; add `prompt.test.ts` (format, numbering, empty case, invariants).
  - [x] Re-run `graph.test.ts` — the single-system-message fold (`graph.ts:95-103`) must stay intact.
- [x] Task 4 — Retriever resilience (AC: 4)
  - [x] Wrap the per-row parse in `ragRetriever.drizzle.ts` with skip + `logger.warn` (id/channel/reason only); thread the logger the same way sibling adapters receive it.
  - [x] NEW `ragRetriever.drizzle.test.ts`: malformed-among-valid → K−1 + one warn; all-valid → zero warns; empty-scope short-circuit still skips the embedder.
- [x] Task 5 — e2e seed (AC: 5)
  - [x] `EmbeddingSpec` +`title`+`link`; 5 rows realistic + `https://example.com/e2e/...`; INSERT binds per-row values; `CONVERSATION_CITATIONS` +`title`+link.
  - [x] Run the 13 Playwright specs; `chat.spec.ts:39` asserts the exact seeded answer — do not alter the seeded assistant message text.
- [x] Task 6 — Integration fixtures + new assertions (AC: 6)
  - [x] Upgrade the 8 suites' inserts (salted ids per run, cleanup only own ids — OPS-2); add the title/description/link round-trip assertions to `search.integration.test.ts` + `documents.integration.test.ts`; flip `chat.integration.test.ts:193/:208` and `conversations.integration.test.ts:206-207` to real values +`title`.
- [x] Task 7 — Runbook + docs (AC: 7) — operational-backlog runbook note; api-spec.yml; data-model.md; SPINE AD-4/AD-6; TECHNICAL-DESIGN §9/§12.
- [x] Task 8 — Verification + gate (AC: 8) — §3.3 endpoint pass (search/documents/chat SSE + RBAC + error shape), full gate, paste evidence, restore state; flip sprint-status to review; commit in slices and open the PR.

## Dev Notes

### Architecture compliance (invariants that bind this story)

- **AD-6**: contracts ONLY in `packages/shared/src/schemas/`; backend validates with `.parse()` at
  the edge; web infers with `z.infer<>`. The strict-link + citation-title change is scoped `shared`.
- **AD-12 — DO NOT TOUCH the RBAC SQL**: `WHERE inArray(e.channel_id, allowedChannelIds)` inside
  both vector queries (`embeddingSearchRepository.drizzle.ts:59`, `documentRepository.drizzle.ts:49,89`)
  plus the empty-scope short-circuits (`:25`, `:25/:83`) and the searchService/documentService
  empty-scope fast paths (skip the paid embed call). Integration RBAC assertions must stay green.
- **AD-4**: SSE frames follow `SSEFrameSchema`; frame order tokens → citations → done is asserted
  by `chat.integration.test.ts`. The citation frame shape change is additive (`+title`).
- **AD-5**: NO DDL in this story — `embeddings` and `messages` schemas are untouched (citations is
  a jsonb `$type`, TypeScript-only).
- **AD-2**: no cross-service imports; the web ripple touches only web's own files.
- **English only** in all code/comments/tests/commits/docs — seed *data values* may stay Spanish
  (user-visible product data, existing convention).

### Current state — verbatim anchors (verified 2026-07-09, main @ a0e7edb)

**Everything below already projects title/description/link — 7.1's ripple. Do not re-plumb.**

- `embeddingSearchRepository.drizzle.ts:34-66`: SELECT `e.title/e.description/e.link` +
  `cp.name AS channelName` + `dm.author_id` as BOTH authorId/authorName (D2 fallback — do NOT
  "fix") + anchor `JOIN discord_messages dm ON dm.id = e.message_ids[1]` (pg 1-indexed = JS `[0]`;
  INNER on purpose — anchorless rows drop) + D1 `NOT EXISTS` deleted-message anti-join (`:60-63`)
  + similarity `GREATEST(0, LEAST(1, 1 - (e.embedding <=> $vec::vector)))` + pgvector text-literal
  binding gotcha (`:27-32`). Mapping `:74-86` via `String(row.x)`.
- `documentRepository.drizzle.ts:27-57`: same projection + `indexedAt = e.created_at`, read LEFT
  JOIN (`:47`), `unreadOnly` fragment (`:54`), `ORDER BY e.created_at DESC, e.id DESC` (`:55`),
  `countDocuments` (`:85-95`) repeats RBAC+D1+unread without the anchor join.
- `searchService.ts:30-52` / `documentService.ts:41-75`: 1:1 mapping + `*ResponseSchema.parse`
  at the edge + empty-scope fast paths + channel narrowing without existence leak. NO changes
  expected beyond test fixtures.
- `ragRetriever.drizzle.ts:21-39`: composes QueryEmbedder + EmbeddingSearchRepository; per-row
  `SearchFragmentSchema.parse` (**the F2 wrap point**); empty-scope skip at `:21`.
- `agent/prompt.ts:6-12` SYSTEM_PROMPT (pre-pivot language — **the AC-3 target**); `:15-28`
  `buildRAGContext` with the fragment line at `:23` already
  `` `[${i + 1}] #${f.channelName} — ${f.authorName} (${f.createdAt}):\n${f.title} — ${f.description} (${f.link})` ``.
  **No `prompt.test.ts` exists** — only the indirect `graph.test.ts:177` SYSTEM_PROMPT containment.
- `agent/graph.ts`: `retrieve → reason → respond` (`:126-134`), `RETRIEVE_TOP_K = 5` (`:25`);
  reasonNode folds ALL system turns into ONE index-0 message
  `[SYSTEM_PROMPT, buildRAGContext(...), ...systemContext].join('\n\n')` (`:95-103`) — the Epic-5
  Anthropic multi-system-400 fix, PRESERVE; respondNode threads `config?.signal` into
  `chatModel.stream` (`:116`); citation emission `:180-188` (add `title` here); `done` `:190`.
- `chatService.ts`: citations accumulation `:136-142` (add `title`); PRESERVE persist-before-done
  (`:143-148`), `finally` partial-persist for aborted turns (`:151-163`), empty-turn skip (`:108`),
  history-load-before-user-append ordering (`:79-91`, the D4 double-append trap), best-effort
  `touchConversation` (`:119-126`).
- `chatController.ts`: SSE framing, pre-stream 400/404/500 vs mid-stream `error` frame,
  `req.on('close') → abort` (`:56`), write-after-close guards. Field-agnostic — NO changes.
- `e2e/seed.ts`: `EmbeddingSpec` `:48-55` (**no title/link fields**); 5 rows `:79-85`; INSERT
  `:155-163` hardcodes `'', ${e.description}, ''`; `CONVERSATION_CITATIONS` `:102-104` with
  `link: ''`; one-hot `unitVector` ladder `:27-32` (DIMENSIONS=1536, `:18`); `e2e-` prefixed
  cleanup `:121-139`; anchors in `MESSAGES` `:69-75`; `READ_CHUNK_KEYS` `:89`; member upsert
  `:168-172`. `e2e/server.ts` uses `fakeQueryEmbedder()` (one-hot(0), `test-helpers.ts:20-28`) —
  unchanged.

### Shared contract anchors

- `linkRefine.ts`: `isEmptyOrHttpUrl` = `'' → true` early-return + whitespace reject +
  `URL.canParse` + http/https set + non-empty hostname. **Strictening = drop the early-return only**
  (D1). Comment at `:2-3` names 7.4.
- `citation.ts:14-19` CitationSchema; `:28-29` the bidirectional `satisfies` guards — both
  `Citation` and `CitationSchema` must gain `title` in the SAME edit or shared stops compiling
  (that is the guard working, not a bug).
- `sse.ts:7-14`: 4-variant discriminated union; citation = `z.object({ type: z.literal('citation') })
  .extend(CitationSchema.shape)` → inherits `title`+strict `link` for free; `done {conversationId}`,
  `error {code, message}`, `token {content}` (`content` here is the TOKEN TEXT — do not rename).
- `search.ts:36-48` / `documents.ts:35-48`: fragments already title/description/link;
  `SearchQuerySchema` (q ≤1000, limit 1..50 default 5); `DocumentsQuerySchema` — `unreadOnly` uses
  `z.stringbool()` deliberately (`z.coerce.boolean()` parses `"false"` as `true`) — don't touch.
- `db/schema.ts`: `Citation` `:30-35`; `embeddings` `:57-83` (chunkKey `"<messageId>:<urlIndex>"`,
  messageIds length-1, `[0]` anchor); `messages.citations` jsonb `:134`.

### Do-NOT-touch look-alikes

`discord_messages.content` / `messages.content` (real message text) · SSE `token.content` ·
`authorName = authorId` D2 fallback · config `base_url` empty-or-URL refines in
`config/index.ts` (agent/embeddings/enrichment.llm — separate convention) · workers' enrichment
pipeline (`buildResourceRows`, `enrich.ts` title/description bounds) · `processDelete`/
`processUpdate` · nginx/SSE buffering config.

### Test landscape — what breaks, what's new

- **Break by design (strict link / +title)**: shared `linkRefine.test.ts`, `search.test.ts`,
  `documents.test.ts`, `citation.test.ts` (":13 parse a citation with … empty link" flips to
  reject), `sse.test.ts`, `conversations.test.ts`; backend `chat.integration.test.ts:193/:208`
  (`link: ''` expectations), `conversations.integration.test.ts:206-207`; every fixture with
  `link: ''` (backend unit 4, web 2-4 files).
- **New tests**: `prompt.test.ts` (AC-3), `ragRetriever.drizzle.test.ts` (AC-4), field-value
  round-trip assertions in `search.integration.test.ts` + `documents.integration.test.ts` (AC-6 —
  today they assert RBAC/D1/similarity/pagination but NO title/description/link values).
- **Must stay green untouched**: all RBAC + D1 anti-join + pagination + read-status + frame-order
  assertions; `graph.test.ts` single-system-message invariant; the 13 Playwright specs
  (they assert testids/classes/`.kh-result-card`, not embedding strings — EXCEPT `chat.spec.ts:39`
  which asserts the exact seeded assistant ANSWER text: keep that seeded message verbatim).
- **Workers suites**: untouched by this story (workers already write real values); if
  `sync.integration.test.ts`/`indexBatch.integration.test.ts` go red, you broke a shared contract
  they consume — stop and re-check (their inserts use real extracted hrefs, so strict link is safe).
- Integration runs: `docker compose up -d postgres redis`, STOP app containers first; this Mac has
  TWO Redis (Homebrew :6379 vs compose without published ports) — local runs hit Homebrew. Salted
  ids per run; cleanup deletes only own ids; `rbac.integration.test.ts` flakes are the documented
  pre-existing load-sensitive issue — not yours.

### Previous story intelligence (7.1 → 7.3)

- 7.1 established the Placeholder policy this story retires; its §Ripple map lists every file that
  carried `link: ''` — use it as the flip checklist. Its review deferral (weak refine + retriever
  fragility) is exactly F1(a-solved-in-7.2)+F2 here.
- 7.2: `linkRefine.ts` was already hardened to `URL.canParse`-based (this story only drops the `''`
  branch); enrichment bounds title(200)/description(1000) at generation; `extractUrls` returns
  normalized `url.href` — links in real rows are always parseable http(s), so strict contracts are
  consistent with what workers write.
- 7.3: workers reuse `buildEmbeddingText(title, description)`; production rows post-7.2/7.3 are
  fully real — ONLY test/e2e fixtures still write placeholders (confirmed by grep).
- Standing DoD (operational-backlog.md): review patches are re-reviewed as new code; new tests must
  discriminate (revert-and-rerun when in doubt); never log message/resource content — the F2 warn
  logs ids and the Zod reason only.
- Epic-5 retro: any prompt/system-turn change must respect the single-system-message fold; abort
  tests assert direct side effects (LangGraph enforces abort BETWEEN super-steps).

### Git intelligence

Main @ `a0e7edb` (PR #47 merged — 7.3). Branch: `feat/7-4-backend-resource-projection`.
Suggested slices (Conventional Commits, English, ≤72 chars):
1. `feat(shared)!: strict resource link and citation title` — linkRefine + citation/search/documents
   schemas + shared tests. Footer: `BREAKING CHANGE: link fields must be valid HTTP(S) URLs and
   citations carry title; pre-7.4 persisted data requires the Epic 7 clean-slate wipe.`
2. `feat(backend): resource-index RAG prompt and resilient retrieval` — prompt + prompt.test +
   ragRetriever wrap + test + graph/chatService title plumbing.
3. `feat(backend): seed realistic resources for e2e` — seed.ts.
4. `test(repo): real resource fixtures and field round-trip assertions` — integration/unit/web fixture flips.
5. `docs(repo): sync contracts docs and clean-slate runbook for 7.4`.

### Project Structure Notes

- New files: `packages/backend/src/agent/prompt.test.ts`,
  `packages/backend/src/infrastructure/ragRetriever.drizzle.test.ts`.
- No new packages, no new dependencies, no version bumps, no migration, no root `src/`.
- Web changes are compile ripples + fixtures ONLY (`ChatWidget.tsx` construction, test fixtures) —
  any visual/JSX-structure change is scope leaking from 7.5: stop.
- If compilation demands touching a file outside this story's lists, STOP and re-check — it
  probably means behavior is leaking in from 7.5/7.6.

### References

- [Source: _bmad-output/planning-artifacts/epics.md:30-40 (FR11/FR12/FR13/FR16/FR17), :992-1011 (Épico 7)]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-09.md §4.2 (citation ripple + satisfies guard "Story 7.1 + 7.4"), §4.6 (backend projection), Resolved item 1 (citation link v1)]
- [Source: docs/context/ARCHITECTURE-SPINE.md AD-4:65, AD-5:72, AD-6:79, AD-12:111-115]
- [Source: docs/context/TECHNICAL-DESIGN.md §9:642-733 (StateGraph/buildRAGContext/RETRIEVE_TOP_K), §11:803 (REST), §12:840-873 (SSE wire)]
- [Source: docs/api-spec.yml:101-114 (/api/search), :140-158 (/api/documents), :317-349 (SSEFrame + Citation)]
- [Source: docs/data-model.md:47-73 (embeddings + link note), :122 (citations jsonb)]
- [Source: _bmad-output/implementation-artifacts/7-1-…md (Placeholder policy, Ripple map, review deferral), 7-2-…md (linkRefine hardening, enrichment bounds), 7-3-…md (buildEmbeddingText, workers write real values)]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md:153 (retriever fragility deferral — closed by F2)]
- [Source: _bmad-output/implementation-artifacts/operational-backlog.md (§ Deploy runbooks clean-slate, § Standing DoD)]
- [Source: docs/bmad-story-mandatory-steps.md §3.1-§3.5 (gate, endpoint verification, docs)]
- [Source: docs/backend-standards.md:116-181 (layering), :813-942 (testing standards)]

## Dev Agent Record

### Agent Model Used

claude-sonnet-5

### Debug Log References

None — no blocking failures. `readStatus.integration.test.ts` needed no new field-value
assertions (only the fixture flip) since it doesn't exercise search/documents response bodies.

### Completion Notes List

- F1 (strict link): `isEmptyOrHttpUrl` renamed to `isHttpUrl`, dropped the `value === ''`
  early-return only; kept whitespace/parse/scheme/hostname checks unchanged. Swapped into
  `search.ts`/`documents.ts`/`citation.ts`; refreshed all three stale doc-comments plus
  `linkRefine.ts`'s own header comment. Grep-confirmed zero `isEmptyOrHttpUrl` references and
  zero `link: ''` in active (non-reject-test) code/fixtures/seeds repo-wide.
- F3 (Citation.title): added in the same edit to both `Citation` (db/schema.ts) and
  `CitationSchema` (citation.ts) — the bidirectional `satisfies` guard enforced this; `sse.ts`
  inherited it for free via `CitationSchema.shape`. Propagated through `graph.ts` citation
  emission → `chatService.ts` accumulation → `ChatWidget.tsx` construction (compile-only ripple,
  no chip redesign).
- AC-3 (prompt reframe): rewrote `SYSTEM_PROMPT` to speak of "curated community resources" (not
  "knowledge fragments"), added the explicit "include its link when recommending a resource"
  instruction; `buildRAGContext`'s empty-case string now says "resources". Kept the `[n]
  #channel — author (date):` header + `title — description (link)` line format unchanged. New
  `prompt.test.ts` (11 cases). `graph.test.ts`'s single-system-message fold stayed green
  untouched.
- F2 (retriever resilience): `ragRetriever.drizzle.ts` now takes a `Logger` dependency and uses
  `SearchFragmentSchema.safeParse` per row — a malformed row is skipped with
  `logger.warn('skipping malformed search fragment row', { embeddingId, channelId, reason })`
  (never field values) and the rest of the batch is returned. `createApp` gained an optional
  `logger` on `AppOptions` (defaults to a no-op so tests/e2e stay silent); `main.ts` now injects
  the real structured logger. New `ragRetriever.drizzle.test.ts` (3 cases: K−1+one-warn,
  all-valid+zero-warns, empty-scope short-circuit).
- AC-5 (e2e seed): `EmbeddingSpec` gained `title`+`link`; all 5 rows got distinct realistic
  Spanish titles/descriptions and deterministic `https://example.com/e2e/<slug>` links; the raw
  INSERT now binds `${e.title}`/`${e.link}` per row. `CONVERSATION_CITATIONS` gained `title` +
  a real link matching the first seeded resource. All 13 Playwright chromium specs pass with the
  same count — none assert on description/title text except `chat.spec.ts:39`'s exact seeded
  answer, which was left untouched.
- AC-6 (integration fixtures): all 8 backend integration suites' embedding inserts now bind a
  salted `title`/`link` per chunk key instead of `''`; added first-ever title/description/link
  round-trip assertions to `search.integration.test.ts` and `documents.integration.test.ts`;
  flipped the `link: ''` citation expectations in `chat.integration.test.ts` (frame + persisted
  citation, both now assert real `title`+`link`) and `conversations.integration.test.ts`. RBAC/D1
  anti-join/pagination/read-status/frame-order assertions were untouched and stayed green.
  120 integration tests pass (118 before + 2 new round-trip assertions).
- AC-7 (docs/runbook): added a Story 7.4 note to the Epic 7 clean-slate runbook in
  `operational-backlog.md` (strict contracts reject pre-7.4 data — re-run the wipe before
  deploying); synced `api-spec.yml` (Citation +title, strict link wording), `data-model.md`
  (embeddings.link strict note, citations jsonb +title), `ARCHITECTURE-SPINE.md` AD-4/AD-6, and
  `TECHNICAL-DESIGN.md` §9 (buildRAGContext context-line format + reframed SYSTEM_PROMPT note)
  and §12 (SSE citation wire shape +title).
- AC-8 (verification): endpoint verification ran via the `search`/`documents`/`chat` integration
  suites (createApp + real Postgres/Redis + injected fake DiscordOAuthClient — the concrete
  §3.3 verification path for this repo): 200 shape vs Zod, RBAC never leaked a fragment outside
  `allowedChannelIds`, 401/400/404 unified `{error, code}` shapes, and the SSE `token`→`citation`
  (title+link)→`done` frame sequence — all passing. Gate green: `npm run lint` (0) &&
  `npm run test` (86 files / 800 passed, 1 skipped) && `npm run build` (5 packages clean) &&
  `npm run test:integration` (19 files / 120 passed) && `npm run test:e2e -w @hivly/web` (13
  chromium, pass-count unchanged). No DDL, no migration, no new dependency — confirmed by the
  clean `tsc --noEmit` + `drizzle-kit` untouched.

### File List

**Shared:**
- packages/shared/src/schemas/linkRefine.ts
- packages/shared/src/schemas/linkRefine.test.ts
- packages/shared/src/schemas/citation.ts
- packages/shared/src/schemas/citation.test.ts
- packages/shared/src/schemas/search.ts
- packages/shared/src/schemas/search.test.ts
- packages/shared/src/schemas/documents.ts
- packages/shared/src/schemas/documents.test.ts
- packages/shared/src/schemas/sse.test.ts
- packages/shared/src/schemas/conversations.test.ts
- packages/shared/src/db/schema.ts

**Backend:**
- packages/backend/src/agent/graph.ts
- packages/backend/src/agent/graph.test.ts
- packages/backend/src/agent/prompt.ts
- packages/backend/src/agent/prompt.test.ts (new)
- packages/backend/src/app.ts
- packages/backend/src/main.ts
- packages/backend/src/infrastructure/ragRetriever.drizzle.ts
- packages/backend/src/infrastructure/ragRetriever.drizzle.test.ts (new)
- packages/backend/src/application/services/chatService.ts
- packages/backend/src/application/services/chatService.test.ts
- packages/backend/src/application/services/conversationService.test.ts
- packages/backend/src/application/services/searchService.test.ts
- packages/backend/src/application/services/documentService.test.ts
- packages/backend/src/e2e/seed.ts
- packages/backend/src/search.integration.test.ts
- packages/backend/src/documents.integration.test.ts
- packages/backend/src/readStatus.integration.test.ts
- packages/backend/src/chat.integration.test.ts
- packages/backend/src/conversations.integration.test.ts
- packages/backend/src/infrastructure/embeddingSearchRepository.drizzle.integration.test.ts
- packages/backend/src/infrastructure/documentRepository.drizzle.integration.test.ts
- packages/backend/src/infrastructure/readStatusRepository.drizzle.integration.test.ts

**Web:**
- packages/web/src/components/ChatWidget.tsx
- packages/web/src/components/ChatWidget.test.tsx
- packages/web/src/components/SearchView.test.tsx
- packages/web/src/components/DocsView.test.tsx
- packages/web/src/App.test.tsx
- packages/web/src/api/chat.test.ts
- packages/web/src/api/conversations.test.ts

**Docs:**
- _bmad-output/implementation-artifacts/operational-backlog.md
- docs/api-spec.yml
- docs/data-model.md
- docs/context/ARCHITECTURE-SPINE.md
- docs/context/TECHNICAL-DESIGN.md

## Change Log

- 2026-07-09 — Story created (bmad-create-story). 3 forks confirmed with Borja: F1 strict link
  contract (linkRefine drops the `''` tolerance; clean-slate runbook covers legacy data), F2
  ragRetriever skip-and-warn per row (closes the 7.1 review deferral), F3 Citation gains required
  `title` (7.5 sources chip can show the resource title). Scope: prompt semantics + retriever
  resilience + realistic e2e seed + fixture/assertion upgrades + shared contract tightening +
  docs/runbook sync. No DDL, no migration, no new dependency. Status: ready-for-dev.
- 2026-07-09 — Story implemented (bmad-dev-story): strict link contract (`isHttpUrl`) +
  `Citation.title` landed in shared; RAG SYSTEM_PROMPT reframed to curated-resource semantics
  (FR13); `ragRetriever` skip-and-warn on a malformed row (F2, closes the 7.1 review deferral);
  e2e seed gained realistic titles/links; 8 backend integration suites upgraded with real
  salted fixtures + first title/description/link round-trip assertions; docs/runbook synced.
  Gate green: lint 0 / 800 unit+web (+9) / build clean (5 pkgs) / 120 integration (+2) / 13 e2e
  chromium unchanged. No DDL, no migration, no new dependency. Status: review.

## Review Findings (bmad-code-review 2026-07-09)

_3 layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor), all at Opus. Auditor verified all 8
ACs FULLY SATISFIED with no scope leaks; grep-confirmed zero `isEmptyOrHttpUrl` and zero active
`link: ''`. 1 decision, 1 patch, 2 deferred, 3 dismissed as noise._

- [x] [Review][Decision → DISMISSED by Borja 2026-07-09: accept the ratified D3 asymmetry — fail-fast on search/documents is the intended diagnostic signal; the clean-slate runbook covers deploy and steady-state is assumed clean] Read-back parse 500 blast radius on corrupt/legacy persisted rows — `/api/search` + `/api/documents` still `.parse()` the whole aggregate (D3 fail-fast, unchanged), so a single unparseable row (e.g. `link: ''`) 500s the endpoint and discards every valid result too; `getConversation` parses raw `citations` jsonb through the now-strict schema, so one legacy citation 500s the conversation on open while it still lists in the sidebar. Ratified for DEPLOY-time via the clean-slate wipe (D3/F1/runbook), but STEADY-STATE single-row corruption (partial enrichment write, manual insert, future migration) was not weighed. Asymmetric vs chat's F2 skip-and-warn. [blind+edge]
- [x] [Review][Patch] APPLIED 2026-07-09 — now logs `parsed.error.issues.map((i) => ({ path, code }))` (structural, content-free); test updated to assert the new shape (3/3 green, tsc + eslint clean). ragRetriever logged full `parsed.error.message` (whole ZodError dump) instead of structural issue codes/paths [packages/backend/src/infrastructure/ragRetriever.drizzle.ts:51] — no content leak today (Zod v4 messages carry no input values; link failures emit the static LINK_REFINE_MESSAGE — both reviewers verified), but it leaves the "never log content" DoD invariant incidental not structural, and the dump is verbose. Fix: log `parsed.error.issues.map((i) => ({ path: i.path, code: i.code }))`.
- [x] [Review][Defer] Citation/fragment `title: z.string()` accepts `''` [packages/shared/src/schemas/citation.ts:16] — deferred, consistent with the ratified D2 plain-z.string() convention for descriptive fields (channel/author/title); contract enforces link quality but not title non-emptiness despite F3's chip intent. Future: `.min(1)` if 7.5 needs the guarantee.
- [x] [Review][Defer] All-rows-malformed retrieval returns `[]` → chat answers a false "not enough information" [packages/backend/src/infrastructure/ragRetriever.drizzle.ts:57] — deferred, edge (post-wipe should not occur); F2 handles availability but there is no observability distinction between skipped-all and genuinely-found-none. Future: a skipped-count metric/flag.
