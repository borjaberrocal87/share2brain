# Story 9.1: shared + backend — contrato StatsResponse + endpoint de agregación RBAC-scoped

Status: review

baseline_commit: 4b14064 (main — story 8.1 merged tree state at creation time; verify PR #53 is merged before branching)

> Approved via `bmad-correct-course` (2026-07-10,
> `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10-stats.md`). First story of
> Épico 9 (Estadísticas del Conocimiento). Inner→outer layering: this story is **shared + backend
> only** — no web changes (9.2), no e2e harness changes (9.3).

## Story

As an authenticated community member,
I want a `GET /api/stats` endpoint that aggregates knowledge KPIs, 14-day indexing activity, per-channel volume, and my personal read coverage — all scoped to the channels I can access,
so that the upcoming Statistics view (9.2) can show me the pulse of the community's knowledge without ever leaking data from channels I cannot read.

## Acceptance Criteria

1. **AC1 — Contract in shared (AD-6).** `StatsResponse` Zod schema lives in
   `packages/shared/src/schemas/stats.ts` (exported via the `schemas/index.ts` barrel), and the
   backend validates the outgoing payload with `StatsResponseSchema.parse()` before it leaves the
   service layer (same pattern as `documentService.ts`). Shape (ratified SCP §4.2):
   - `kpis`: array of **exactly 4** `{ key, label, value, sub }` in fixed order
     `resources · channels · authors · queries` (see D3 for definitions).
   - `activity`: array of **exactly 14** `{ date: 'YYYY-MM-DD', count }` (see AC4).
   - `channels`: array of `{ channelId, channelName, count }`, ordered `count DESC, channelId ASC`.
   - `coverage`: `{ readCount, totalCount, readPct }` (see AC5).
2. **AC2 — RBAC in-SQL (AD-12).** `GET /api/stats` is mounted **after** the generic
   `/api` gate in `app.ts` (so it inherits `requireAuth` + RBAC middleware + `api` rate-limit tier
   automatically), and **every channel-scoped aggregation query embeds
   `WHERE channel_id = ANY(:allowedChannelIds)`** (via the shared `inArray` re-export) inside the
   SQL — never as a post-filter. The only exception is the per-user `queries` KPI, which has no
   `channel_id` (ratified SCP §4.4).
3. **AC3 — RBAC exclusion proven.** An integration test (real Postgres, `createApp`, fake OAuth —
   pattern `documents.integration.test.ts` / `rbac.integration.test.ts`) seeds an allowed channel A
   and a denied channel B and asserts that **no** figure — KPI values, weekly delta sub, activity
   counts, channels list, coverage totals — includes rows from channel B. Channel B must not even
   appear in `channels[]` (no existence leak).
4. **AC4 — 14-day activity series, zero-filled, indexed.** `activity` returns exactly the last 14
   UTC days (today inclusive, oldest first), each as `{ date, count }` with `count = 0` for days
   with no indexed resources. The series counts `embeddings.created_at` (see D1 — the
   `embeddings` table has **no** `indexed_at` column; `created_at` IS the `indexedAt` surfaced by
   `/api/documents`). Backed by a new composite btree index
   `idx_embeddings_channel_created` on `embeddings(channel_id, created_at DESC)` defined in
   `packages/shared/src/db/schema.ts` (AD-5) with its generated migration (see D2).
5. **AC5 — Personal coverage.** `coverage.readCount` counts the session user's `user_read_status`
   rows joined to **scoped** embeddings only; `coverage.totalCount` is the scoped embeddings count
   (identical figure to the `resources` KPI value); `readPct` is an integer
   `0–100` = `totalCount === 0 ? 0 : Math.round(readCount / totalCount * 100)`.
6. **AC6 — Gate.** `npm run lint` + `npm run test` + `npm run build` +
   `npm run test:integration` green (agent runs them and pastes output); migration generated with
   `npx drizzle-kit generate` and applied against local Postgres with `npx drizzle-kit migrate`
   (§3.2 of `docs/bmad-story-mandatory-steps.md`); endpoint exercised per §3.3 (200 shape vs Zod,
   401 without session, unified `{ error, code }` on failure). Docs synced per §3.5 (see Task 7).

## Decisions embedded in the ACs (ratified defaults — veto at review)

| # | Decision | Rationale |
|---|---|---|
| **D1** | The activity timeseries and the new index use **`embeddings.created_at`**, not `indexed_at`. | The epic text says "index on embeddings(indexed_at)" but `embeddings` has no such column (`indexed_at` lives on `discord_messages`, means "evaluated by the Indexer", and is nullable). The API already treats `embeddings.created_at` as `indexedAt` (`packages/shared/src/schemas/documents.ts` + `documentRepository.drizzle.ts` mapping). AC4's own hedge "[or composite (channel_id, indexed_at)]" resolves to `(channel_id, created_at)`. |
| **D2** | The new composite index **replaces** the now-redundant single-column `idx_embeddings_channel`: in `schema.ts`, swap `index('idx_embeddings_channel').on(t.channelId)` for `index('idx_embeddings_channel_created').on(t.channelId, t.createdAt.desc())`. One migration does DROP + CREATE. | `(channel_id)` is a prefix of `(channel_id, created_at DESC)` — every existing query served by the old index is served by the new one; keeping both only costs write overhead. Mirrors the existing `idx_discord_messages_channel(channel_id, created_at DESC)` convention. If review vetoes, keep both (add-only migration). |
| **D3** | KPI definitions (keys/labels ratified SCP §4.4; subs are this story's defaults): `resources` → label `Recursos indexados`, value = scoped embeddings count, sub = `+{n} esta semana` (n = scoped count with `created_at >= now() - interval '7 days'`, renders `+0 esta semana` when none) · `channels` → label `Canales`, value = scoped `count(DISTINCT channel_id)` over embeddings, sub = `de {allowedChannelIds.length} accesibles` · `authors` → label `Autores`, value = scoped `count(DISTINCT d.author_id)` joining `discord_messages d ON d.id = e.message_ids[1]`, sub = `en tus canales` · `queries` → label `Tus consultas al agente`, value = all-time `count(*)` of `messages.role = 'user'` rows in the session user's own `conversations`, sub = `en total`. | Ratified KPI list overrides the mock's pre-pivot labels (`Mensajes indexados`, `Usuarios activos`…). `authors` needs the join because `embeddings` has no author column. `channels` sub uses the user's own scope size (no leak); the mock's `de 6 del guild` would leak total guild channel count and is rejected. `queries` is per-user (no `channel_id` → no channel filter, no leak); all-time chosen over the mock's `últimos 30 días` because the ratified definition carries no window — flag at review if Borja prefers 30d. |
| **D4** | Every embeddings-based aggregation (KPIs 1–3, activity, channels, coverage) also embeds the **deleted-message exclusion predicate** used by documents/search: `AND NOT EXISTS (SELECT 1 FROM discord_messages d WHERE d.id = ANY(e.message_ids) AND d.deleted_at IS NOT NULL)`. | Stats figures must equal what `/api/documents` shows (DocsView total = coverage.totalCount), otherwise 9.2's donut and the sidebar disagree. Covers the delete-event→purge window. |
| **D5** | Zero-fill of the 14-day series happens **in the service layer** (TS), not with SQL `generate_series`; the adapter returns only non-zero `(day, count)` rows bucketed as `(e.created_at AT TIME ZONE 'UTC')::date`. Dates serialize as `YYYY-MM-DD`; the window is computed once in the service (UTC today − 13 days … today). | Simpler SQL, deterministic and unit-testable without a DB; UTC bucketing matches "dates ISO 8601 UTC" convention. |
| **D6** | Empty scope (`allowedChannelIds.length === 0`) short-circuits **channel-scoped queries only**: KPIs 1–3 = 0 (subs `+0 esta semana` / `de 0 accesibles` / `en tus canales`), activity = 14 zero days, `channels: []`, coverage `0/0/0` — no DB round-trip for those (documents-service fast-path pattern + the shared `inArray`-throws-on-empty guard). The per-user `queries` KPI **still runs** (it is the user's own data). | Deny-by-default without a 500 (`inArray` throws on `[]`), while a role-less user still sees their own agent-usage count. |
| **D7** | `channelName` resolves by joining `channel_permissions` with `COALESCE(cp.name, e.channel_id)` fallback — same resolution `/api/documents` uses. Ordering `count DESC, channelId ASC` for determinism. No row limit (guild channels are bounded). | Consistency + deterministic e2e/integration assertions. |
| **D8** | Error contract: `STATS_ERROR = { INTERNAL: 'INTERNAL' }` only — the endpoint takes **no** query params, so no `VALIDATION_ERROR` code and no query schema. 401 comes from `requireAuth` (`AUTH_REQUIRED`), 500 from the controller try/catch with the unified `{ error, code }` shape. | Minimal surface; mirrors documents/search error mapping minus the input path. |
| **D9** | The mock's 5th section **`Top 5 · usuarios más activos` is OUT of the contract** — the ratified SCP §4.2 shape has exactly `kpis/activity/channels/coverage` and 9.2's AC2 lists only those 4 blocks. Adding it later is a contract extension (new story/AC). | Scope honesty: silently widening the ratified contract invites review churn. Flag to Borja. |
| **D10** | FR bookkeeping: the proposal drafted the new FRs as "FR22/FR23" but the FR inventory in `_bmad-output/planning-artifacts/epics.md` already has FR22 (config) and FR23 (compose/migrator) → the stats FRs land as **FR24/FR25**, and the Épico 9 header "FRs cubiertos: FR22, FR23 (nuevos)" is corrected to FR24/FR25. `docs/context/PRD.md` has no FR-numbered list (its IDs are SNF-x) — it gets a short Statistics-view feature mention only; the numbered FRs live in epics.md's Inventario. | Avoids two different requirements both claiming FR22/FR23. |

## Tasks / Subtasks

- [x] **Task 0 — Preconditions** (AC6)
  - [x] Verify PR #53 (story 8.1) is merged; branch from up-to-date `main`:
        `git switch -c feat/9-1-stats-endpoint` (branch name ratified in the SCP §5).
  - [x] `docker compose up -d postgres redis`; ensure app containers are **stopped**
        (OPS-2 `assertNoCompetingWriter` guard in integration helpers will fail otherwise).
- [x] **Task 1 — shared: `StatsResponse` contract (tests-first)** (AC1)
  - [x] Write `packages/shared/src/schemas/stats.test.ts` red first (schema-test style of
        `documents.test.ts`: `safeParse` + narrowing, `const valid` fixture + per-field rejects,
        boundary tests, final `describe('STATS_ERROR')`).
  - [x] Create `packages/shared/src/schemas/stats.ts`: `StatsKpiSchema`
        (`key: z.enum(['resources','channels','authors','queries'])`, `label: z.string().min(1)`,
        `value: z.number().int().min(0)`, `sub: z.string()`), `StatsActivityPointSchema`
        (`date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`, `count: z.number().int().min(0)`),
        `StatsChannelSchema` (`channelId: z.string().min(1)`, `channelName: z.string()`,
        `count: z.number().int().min(0)`), `StatsCoverageSchema` (`readCount`/`totalCount` ints ≥ 0,
        `readPct: z.number().int().min(0).max(100)`), `StatsResponseSchema`
        (`kpis: z.array(StatsKpiSchema).length(4)`, `activity: z.array(StatsActivityPointSchema).length(14)`,
        `channels: z.array(StatsChannelSchema)`, `coverage: StatsCoverageSchema`), `z.infer` types
        after each schema, `STATS_ERROR` const map (D8). File header comment naming the endpoint
        ("Stats API contract (AD-6)…"). **No links in this contract → do NOT import linkRefine.**
  - [x] Add `export * from './stats.js';` to `packages/shared/src/schemas/index.ts`
        (alphabetized barrel; `.js` extension — ESM).
- [x] **Task 2 — shared: index migration (AD-5, AD-9)** (AC4)
  - [x] In `packages/shared/src/db/schema.ts` embeddings table callback: replace
        `idx_embeddings_channel` with `index('idx_embeddings_channel_created').on(table.channelId, table.createdAt.desc())` (D2).
  - [x] `npx drizzle-kit generate` → new `packages/shared/src/db/migrations/0004_*.sql`
        (expect DROP INDEX + CREATE INDEX; **never hand-edit** the generated SQL).
  - [x] `npx drizzle-kit migrate` against local Postgres; verify with
        `\di idx_embeddings*` (or `pg_indexes` query) that the composite exists and the old one is gone.
- [x] **Task 3 — backend: domain port + Drizzle adapter** (AC2, AC4, AC5)
  - [x] `packages/backend/src/domain/repositories/statsRepository.ts` — port with the aggregate
        reads the service needs, e.g.: `getScopedKpiCounts(allowedChannelIds, weekStart)` →
        `{ resources, resourcesThisWeek, channels, authors }`; `getActivity(allowedChannelIds, fromDate)` →
        `Array<{ day: string; count: number }>`; `getChannelCounts(allowedChannelIds)` →
        `Array<{ channelId, channelName, count }>`; `getCoverageReadCount(userId, allowedChannelIds)` →
        `number`; `countUserAgentQueries(userId)` → `number`. (Exact grouping of methods is dev's
        call; the RBAC + deleted-filter predicates are NOT.)
  - [x] `packages/backend/src/infrastructure/statsRepository.drizzle.ts` — raw
        `db.execute(sql\`…\`)` with the re-exported `sql`/`inArray` from `@hivly/shared/db`
        (backend never imports drizzle-orm directly, AD-2). Every embeddings query embeds
        `${inArray(sql\`e.channel_id\`, allowedChannelIds)}` **and** the D4 `NOT EXISTS` deleted
        filter (copy the predicate verbatim from `documentRepository.drizzle.ts`). KPIs 1–2 +
        weekly delta can be one query with `count(*) FILTER (WHERE e.created_at >= ${weekStart})`;
        `authors` joins `discord_messages d ON d.id = e.message_ids[1]` (Postgres arrays are
        1-based); activity groups by `(e.created_at AT TIME ZONE 'UTC')::date` (D5); channels
        joins `channel_permissions` with `COALESCE` (D7); coverage joins `user_read_status urs ON urs.embedding_id = e.id AND urs.user_id = ${userId}`
        (or WHERE-form); agent queries: `count(*)` over `messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ${userId} AND m.role = 'user'`.
        Adapters short-circuit `allowedChannelIds.length === 0` before building SQL (never
        `ANY('{}')` — and `inArray` **throws** on `[]`). Coerce rows: `count(*)::int` + `Number()`,
        dates via `to_char(day, 'YYYY-MM-DD')` or TS-side ISO slice — pg may return `Date` objects.
- [x] **Task 4 — backend: service + controller + route + wiring (tests-first for the service)** (AC1, AC2, AC5)
  - [x] `packages/backend/src/application/services/statsService.test.ts` red first (fake port
        objects with `vi.fn`, no module mocks — style of `documentService.test.ts`). Must cover:
        empty-scope fast path (channel-scoped port fns **not called**, `countUserAgentQueries`
        **still called**, D6); zero-fill produces exactly 14 dates ending at UTC today, oldest
        first, missing days = 0; `readPct` rounding incl. `0/0 → 0` and a rounding case (e.g.
        1/3 → 33); KPI array order/keys/labels and sub strings (`+0 esta semana` at zero); channels
        ordering pass-through; outgoing payload validated with `StatsResponseSchema.parse` (a fake
        port returning an invalid row must make the service throw).
  - [x] `packages/backend/src/application/services/statsService.ts` — depends only on the port;
        computes the UTC 14-day window + week start; assembles the 4 KPIs (D3), zero-fills
        activity (D5), computes `readPct` (AC5), and returns `StatsResponseSchema.parse(payload)`.
  - [x] `packages/backend/src/presentation/controllers/statsController.ts` — no input parsing
        (D8): `const userId = req.session.userId as string;`,
        `const allowedChannelIds = req.allowedChannelIds ?? [];`, try/catch →
        `console.error('[stats] failed:', …)` + 500 `{ error: 'Internal error', code: STATS_ERROR.INTERNAL }`
        (exact documents-controller error mapping; never leak the DB error).
  - [x] `packages/backend/src/routes/statsRoutes.ts` — 13-line router à la `documentRoutes.ts`:
        `router.get('/', (req, res) => void controller.get(req, res));`.
  - [x] Wire in `packages/backend/src/app.ts` **after the L192 generic gate** (order is
        load-bearing): build repo → service → controller →
        `app.use('/api/stats', createStatsRouter(statsController));` next to the documents block.
        No extra rate limiter (inherits `api` tier), no changes to `main.ts` needed.
- [x] **Task 5 — backend: RBAC integration test** (AC3, AC4, AC5)
  - [x] `packages/backend/src/stats.integration.test.ts` — real Postgres+Redis via
        `openTestClients()` + `buildTestAppOptions()` + `loginMember(agent)` (fake OAuth). Seed
        with **run-unique suffix ids AND suffix-unique role names** (a literal role like `member`
        makes RBAC expansion leak sibling suites' channels into counts — this suite asserts
        absolute numbers, so this is critical; see `documents.integration.test.ts` L21–25).
        Seed: channel A (allowed role) + channel B (denied) in `channel_permissions`;
        `discord_messages` + `embeddings` in both (spread `created_at` across today / 3 days ago /
        20 days ago for the window assert; one embedding in A with `deleted_at` set on its message
        for D4); mark one A-embedding read via `POST /api/read-status/:embeddingId` (or direct
        insert); seed a conversation + `user`/`assistant` messages for the logged-in user and a
        second conversation for **another** user.
  - [x] Assert: 200 body passes `StatsResponseSchema.parse`; `resources` counts only
        non-deleted A rows; `authors`/`channels` KPIs exclude B; `channels[]` contains A's
        channelId with `channel_permissions.name` and **does not contain B at all**; `activity`
        has length 14, today's count right, the 20-days-ago row absent, missing days 0; `coverage`
        = `{1, totalA, round}` for the session user; `queries` counts only own `role='user'`
        messages (not the other user's, not `assistant` rows); unauthenticated agent → 401
        `{ error, code: 'AUTH_REQUIRED' }`. Cleanup deletes only this run's suffixed rows, FK
        order: user_read_status → embeddings → discord_messages → channel_permissions →
        messages → conversations → users.
- [x] **Task 6 — endpoint verification (§3.3, agent executes)** (AC6)
  - [x] With the local stack (backend `npm run dev -w @hivly/backend` against compose
        postgres/redis — beware the **two-Redis gotcha**: Homebrew Redis owns localhost:6379,
        compose Redis publishes no ports): curl `/api/stats` without session → 401; with a session
        → 200 and paste the body; confirm shape with a quick `StatsResponseSchema.parse` script or
        the integration suite output.
- [x] **Task 7 — docs sync (§3.5)** (AC6)
  - [x] `docs/api-spec.yml`: add `stats` tag + `/api/stats` path (place it after
        `/api/documents`; imitate the **conversations** pattern — response `$ref` to a new
        `components.schemas.StatsResponse` described as "(schemas/stats.ts)"; description states
        the AD-12 in-query scoping like the documents block does; responses 200/401).
  - [x] `docs/data-model.md`: Critical Indexes block — replace the `idx_embeddings_channel` line
        with `CREATE INDEX idx_embeddings_channel_created ON embeddings(channel_id, created_at DESC);` (D2).
  - [x] `docs/context/ARCHITECTURE-SPINE.md`: AD-12 **Binds** list gains `/api/stats`.
  - [x] `docs/context/TECHNICAL-DESIGN.md` §11 endpoint table: add `GET /api/stats` row.
  - [x] `_bmad-output/planning-artifacts/epics.md`: Inventario de Requisitos gains
        **FR24** ("La Web App debe presentar una vista de Estadísticas con KPIs de conocimiento,
        actividad de indexado en el tiempo, volumen por canal y cobertura de lectura personal.")
        and **FR25** ("Toda estadística debe limitarse a los canales accesibles del usuario
        (AD-12); ninguna métrica expone datos de canales que el usuario no puede leer.") — Spanish
        one-liners matching the file's FR style; fix the Épico 9 header to "FRs cubiertos: FR24,
        FR25 (nuevos)" (D10).
  - [x] `docs/context/PRD.md`: short Statistics-view feature mention in the appropriate features
        section (no FR numbering there — D10).
- [x] **Task 8 — gate + handoff** (AC6)
  - [x] `npm run lint && npm run test && npm run build` then `npm run test:integration` — paste
        output; never commit red. E2e unaffected (no web change) — state that explicitly rather
        than skipping silently.
  - [x] Commit in slices (Conventional Commits, English, ≤72 chars): `feat(shared): …` (contract +
        index/migration — schema changes are scoped `shared` even though backend motivated them),
        `feat(backend): …` (endpoint), `test(backend): …` if separate, `docs(repo): …` (spec/PRD/
        epics sync). Story artifacts ride along per repo convention. PR from
        `feat/9-1-stats-endpoint`; never auto-merge → `bmad-code-review`.

## Dev Notes

### Architecture compliance (binding)

- **AD-6**: the ONLY definition of the stats shape is `packages/shared/src/schemas/stats.ts`.
  Backend `.parse()`s the outgoing payload; 9.2 will `z.infer` it. Do not define any stats type
  in `packages/backend`.
- **AD-12**: RBAC lives inside each SQL statement. Do-not-do: fetching unscoped aggregates and
  filtering rows in TS; caching `allowedChannelIds` in session; running any embeddings query
  before the middleware resolved the scope. Reference predicates:
  `packages/backend/src/infrastructure/documentRepository.drizzle.ts` L27–57 (inArray + NOT
  EXISTS deleted filter) and `readStatusRepository.drizzle.ts` L108–128 (GROUP BY per-channel
  count — the closest template for the channels bars).
- **AD-5/AD-9**: DDL only in shared's `schema.ts`; `drizzle-kit generate` produces the SQL; the
  compose `migrator` applies it in deployments (you apply locally with `npx drizzle-kit migrate`
  for the gate only).
- **AD-2**: backend imports `sql`/`inArray` from `@hivly/shared/db` re-exports, never from
  `drizzle-orm`. If you need another helper (e.g. `gte`), re-export it from
  `packages/shared/src/db/index.ts` first.
- **AD-10**: session user id = `req.session.userId` (UUID of `users.id`), guaranteed by
  `requireAuth`; `user_read_status.user_id` and `conversations.user_id` key off it directly.

### Schema facts you must not guess

- `embeddings`: `id` uuid PK · `chunk_key` · `title`/`description`/`link` · `embedding` vector ·
  `channel_id` text (RBAC column) · `message_ids` text[] (length 1, anchor = `message_ids[1]` in
  SQL) · `created_at` timestamptz. **No author, no channel_name, no indexed_at.**
- Author → `discord_messages.author_id` via the anchor id. Channel name →
  `channel_permissions.name` (`channel_id` PK). Read state → `user_read_status(user_id,
  embedding_id, read_at)` composite PK. Agent usage → `messages.role` enum
  `['user','assistant','system']` + `conversations.user_id`.
- Existing embeddings indexes: `idx_embeddings_chunk_key` (unique), `idx_embeddings_vector`
  (hnsw), `idx_embeddings_channel` (btree — replaced by this story, D2).

### Backend layering (follow the documents feature end-to-end)

Route (`routes/documentRoutes.ts`) → controller (`presentation/controllers/documentController.ts`,
Zod at edge, error mapping) → service (`application/services/documentService.ts`, empty-scope fast
path L49–51, outgoing `.parse()` L75) → port (`domain/repositories/…`) → adapter
(`infrastructure/….drizzle.ts`). All are factory functions taking a deps object; `createApp` in
`app.ts` is the single composition root — integration tests build the exact same app. Mounting
after the L192 gate gives you auth (401 `AUTH_REQUIRED`), `req.allowedChannelIds`, and the `api`
rate-limit tier for free; rate limits are OFF in tests (`buildTestAppOptions` omits
`opts.rateLimit`).

### Testing standards

- Unit: colocated `*.test.ts`, Vitest, AAA, `should <behavior> when <condition>`, fake port
  objects with `vi.fn` (no module mocking, no DB). Tests-first for the contract (shared schema
  tests red→green) and the service (orchestration).
- Integration: `*.integration.test.ts` at `packages/backend/src/`, real Postgres+pgvector+Redis
  (`npm run test:integration`), supertest against `createApp`, fake `DiscordOAuthClient` +
  `loginMember`. **Suffix-unique ids AND role names** (this suite asserts absolute counts).
  `openTestClients()` enforces the no-competing-writer guard — stop app containers.
- English-only code/comments/test names/commits; Spanish is allowed ONLY inside user-facing
  string literals (KPI labels/subs — precedent: `'Parámetros inválidos'` in documentController).

### Previous-story intelligence (7.4 = last backend story, 8.1 = last story)

- 7.4 review patch that is now a standing DoD: **log structural info only** — if you log a Zod
  failure, log `issues.map(i => ({ path: i.path, code: i.code }))`, never message/resource content.
- 7.4 pattern: bidirectional `satisfies` guards (see `schemas/citation.ts:34–35`) — not needed
  here (no db-jsonb interface mirrors the stats contract), don't cargo-cult them.
- Integration determinism learnings: salted ids per run; cleanup scoped to own suffix (never broad
  `LIKE`); `rbac.integration.test.ts` has a documented pre-existing load-sensitive flake — rerun
  before assuming your change broke it.
- 8.1 (frontend) is irrelevant to this story's code but its review re-confirmed: state explicitly
  which gates you skipped and why (e.g. e2e untouched); silent skips get flagged.
- Two Redis instances on this Mac: localhost:6379 is Homebrew's; compose Redis publishes no
  ports. Local `npm run dev` and dockerized services hit **different** Redis unless you configure
  ports — matters for manual endpoint verification (Task 6).

### Query sketches (adapter reference — adjust freely, predicates are binding)

```sql
-- KPIs resources/channels + weekly delta (one round-trip)
SELECT count(*)::int AS resources,
       count(*) FILTER (WHERE e.created_at >= ${weekStart})::int AS resources_week,
       count(DISTINCT e.channel_id)::int AS channels
FROM embeddings e
WHERE ${inArray(sql`e.channel_id`, allowedChannelIds)}
  AND NOT EXISTS (SELECT 1 FROM discord_messages d
                  WHERE d.id = ANY(e.message_ids) AND d.deleted_at IS NOT NULL);

-- authors KPI
SELECT count(DISTINCT d.author_id)::int AS authors
FROM embeddings e JOIN discord_messages d ON d.id = e.message_ids[1]
WHERE <same RBAC + deleted predicates>;

-- activity (non-zero days only; service zero-fills)
SELECT to_char((e.created_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, count(*)::int AS count
FROM embeddings e
WHERE <RBAC + deleted> AND e.created_at >= ${fromUtc}
GROUP BY 1;

-- channels bars
SELECT e.channel_id, COALESCE(cp.name, e.channel_id) AS channel_name, count(*)::int AS count
FROM embeddings e LEFT JOIN channel_permissions cp ON cp.channel_id = e.channel_id
WHERE <RBAC + deleted>
GROUP BY e.channel_id, cp.name
ORDER BY count DESC, e.channel_id ASC;

-- coverage readCount
SELECT count(*)::int AS read FROM user_read_status urs
JOIN embeddings e ON e.id = urs.embedding_id
WHERE urs.user_id = ${userId} AND <RBAC + deleted>;

-- queries KPI (per-user, NO channel filter by design)
SELECT count(*)::int AS queries FROM messages m
JOIN conversations c ON c.id = m.conversation_id
WHERE c.user_id = ${userId} AND m.role = 'user';
```

### Project Structure Notes

- New files: `packages/shared/src/schemas/stats.ts` + `stats.test.ts`;
  `packages/shared/src/db/migrations/0004_*.sql` (generated);
  `packages/backend/src/{domain/repositories/statsRepository.ts, infrastructure/statsRepository.drizzle.ts, application/services/statsService.ts(+.test.ts), presentation/controllers/statsController.ts, routes/statsRoutes.ts, stats.integration.test.ts}`.
- Modified: `packages/shared/src/schemas/index.ts`, `packages/shared/src/db/schema.ts`,
  `packages/backend/src/app.ts`, plus the Task-7 docs.
- Out of scope — stop if you find yourself editing: anything under `packages/web` or
  `packages/bot`/`packages/workers`, the Playwright harness/seed (9.3), nav/StatsView (9.2), the
  chat/SSE pipeline, `Hivly.config.yml` (no new config), rate-limit config, any Redis stream code.
  No new npm dependency is needed or allowed.

### References

- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10-stats.md] — §4.2 contract shape, §4.3 ACs, §4.4 ratified KPIs, §5 branch name.
- [Source: _bmad-output/planning-artifacts/epics.md#Épico-9] — epic goal + KPI ratification note.
- [Source: docs/context/ARCHITECTURE-SPINE.md#AD-12] — RBAC-in-query rule (Binds list to extend).
- [Source: docs/data-model.md#embeddings + #Critical-Indexes] — column truth + index block to edit.
- [Source: docs/bmad-story-mandatory-steps.md#3.2/#3.3/#3.5] — DB/API verification + docs-update gates.
- [Source: docs/backend-standards.md] — layering, error shape, testing, RBAC test mandate.
- [Source: packages/backend/src/{documentController,documentService,documentRepository.drizzle,app}.ts] — the end-to-end pattern to mirror.
- [Source: packages/backend/src/{documents,rbac}.integration.test.ts + test-helpers.ts] — integration harness + suffix-unique seeding rules.

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5)

### Debug Log References

None — no failing gate runs or blocking issues. Unit (shared contract + service) written
red-first and confirmed failing before implementation, then green. `npm run lint`, `npm run
test`, `npm run build`, and `npm run test:integration` (backend/bot/workers projects) all
passed; the new `stats.integration.test.ts` passed on its first run against real Postgres.
One environment-only hiccup during Task 6 manual verification: `npm run dev -w @hivly/backend`
resolves `Hivly.config.yml` relative to the workspace cwd, not the repo root — worked around
with `HIVLY_CONFIG_PATH=<repo-root>/Hivly.config.yml` (not a code change).

### Completion Notes List

- Contract (`packages/shared/src/schemas/stats.ts`) matches AC1 exactly: `kpis` fixed at 4
  (`z.array(...).length(4)`), `activity` fixed at 14, `channels` unbounded, `coverage` with
  `readPct` clamped `0–100`. No `linkRefine` import (no links in this contract). 37 schema
  tests, tests-first (confirmed red on the missing module before writing `stats.ts`).
- Index migration (D1/D2): `schema.ts` embeddings table now defines
  `idx_embeddings_channel_created` on `(channel_id, created_at DESC)`, replacing
  `idx_embeddings_channel`. `npx drizzle-kit generate` produced a DROP + CREATE migration
  (`0004_rapid_quicksilver.sql`) exactly as D2 predicted; applied locally with
  `npx drizzle-kit migrate` and verified via `\di idx_embeddings*` (old index gone, composite
  present) before writing any repository code.
- Domain port (`statsRepository.ts`) + Drizzle adapter (`statsRepository.drizzle.ts`) mirror
  `documentRepository.drizzle.ts`'s AD-12 pattern: every channel-scoped query embeds
  `inArray(e.channel_id, allowedChannelIds)` **and** the D4 `NOT EXISTS` deleted-message
  predicate copied verbatim; every method short-circuits `allowedChannelIds.length === 0`
  before building SQL (never `= ANY('{}')`). `authors` needed its own query joining
  `discord_messages d ON d.id = e.message_ids[1]` (no author column on `embeddings`).
  `countUserAgentQueries` is the one method with NO channel filter by design (D3/D6 — per-user
  agent usage, no leak surface).
- Service (`statsService.ts`) computes the UTC 14-day window + week start itself (`now: Date =
  new Date()` default param, overridable in tests for a deterministic window), assembles the 4
  fixed-order KPIs with D3's ratified labels/subs, zero-fills missing activity days in TS (D5),
  computes `readPct` (`totalCount === 0 ? 0 : Math.round(readCount/totalCount*100)`), and
  validates the outgoing payload with `StatsResponseSchema.parse` before returning (AD-6). D6
  empty-scope fast path: 4 of 5 port calls are skipped entirely, but `countUserAgentQueries`
  ALWAYS runs. 7 service unit tests (tests-first), all with plain `vi.fn()` fakes — no Drizzle,
  no Express.
- Controller/route/wiring mirror `documentController.ts`/`documentRoutes.ts` exactly (D8 — no
  input parsing, no query schema, unified `{ error, code }` on 500, never leaks the raw DB
  error). Mounted in `app.ts` right after the `documents`/`read-status` block, inheriting
  `requireAuth` + the RBAC middleware + the `api` rate-limit tier from the generic gate — no new
  limiter, no `main.ts` change.
- Integration test (`stats.integration.test.ts`) seeds channel A (allowed) + channel B (denied)
  with suffix-unique ids AND a suffix-unique role name (a literal role would leak sibling
  suites' channels into this suite's absolute-count assertions). Seeds embeddings at
  today/3-days-ago/20-days-ago (window boundary coverage) plus one embedding whose anchor
  message is soft-deleted (D4 exclusion) and one in channel B (must never surface, not even in
  `channels[]`). Asserts exact KPI/activity/channels/coverage figures, the `queries` KPI counts
  only the session user's own `user`-role messages (not the assistant reply, not another user's
  message), and 401 `AUTH_REQUIRED` without a session. All 7 assertions passed first run.
- Manual verification (Task 6): real HTTP 401 without a session confirmed against the compose
  `docker compose up -d postgres redis` stack; a real 200 + full shape was captured via the
  deterministic e2e backend (`npm run e2e:server -w @hivly/backend`, fake-OAuth login flow —
  the only practical way to mint a real session headlessly) and explicitly validated with
  `StatsResponseSchema.safeParse` (`success: true`).
- Docs synced (Task 7): `api-spec.yml` gained the `stats` tag, the `/api/stats` path, and 5 new
  `components.schemas` entries (`StatsResponse` + its 4 sub-schemas); `data-model.md` and
  `TECHNICAL-DESIGN.md` both updated to the composite index (the latter had its own stale copy
  of the old single-column index, fixed for consistency even though only `data-model.md` was
  named in the task); `ARCHITECTURE-SPINE.md` AD-12 Binds gained `/api/stats`;
  `TECHNICAL-DESIGN.md` §11 endpoint table gained the `GET /api/stats` row; `epics.md` gained
  FR24/FR25 (+ the FR→Épico mapping table) and the Épico 9 header fix
  (FR22/23 → FR24/25, D10) — also corrected the Historia 9.1 bullet's stale
  `embeddings(indexed_at)` mention to the actual composite index and `created_at` (D1);
  `PRD.md` gained a one-line Statistics-view row in the "Vistas principales" table (no FR
  numbering there, per D10).
- Gate: `npm run lint` 0 errors; `npm run test` 860 passed (unit+web, +44 from this story: 37
  shared schema + 7 service); `npm run build` clean across all 5 packages; `npm run
  test:integration` 127 passed across 20 files (backend/bot/workers, +7 from
  `stats.integration.test.ts`), no regressions. E2e (`packages/web` Playwright) intentionally
  NOT run — this story touches only `shared`/`backend`, no `packages/web` change (9.2/9.3 scope).

### File List

- `packages/shared/src/schemas/stats.ts` (new — `StatsResponse` contract, AC1)
- `packages/shared/src/schemas/stats.test.ts` (new — 37 tests, tests-first)
- `packages/shared/src/schemas/index.ts` (modified — barrel export for `stats.ts`)
- `packages/shared/src/db/schema.ts` (modified — `idx_embeddings_channel` →
  `idx_embeddings_channel_created`, D2)
- `packages/shared/src/db/migrations/0004_rapid_quicksilver.sql` (new — generated, DROP + CREATE)
- `packages/shared/src/db/migrations/meta/0004_snapshot.json` (new — generated)
- `packages/shared/src/db/migrations/meta/_journal.json` (modified — generated)
- `packages/backend/src/domain/repositories/statsRepository.ts` (new — port)
- `packages/backend/src/infrastructure/statsRepository.drizzle.ts` (new — Drizzle adapter)
- `packages/backend/src/application/services/statsService.ts` (new — orchestration)
- `packages/backend/src/application/services/statsService.test.ts` (new — 7 tests, tests-first)
- `packages/backend/src/presentation/controllers/statsController.ts` (new — HTTP handler)
- `packages/backend/src/routes/statsRoutes.ts` (new — router)
- `packages/backend/src/app.ts` (modified — wired `/api/stats` after the generic `/api` gate)
- `packages/backend/src/stats.integration.test.ts` (new — 7 tests, RBAC exclusion proof)
- `docs/api-spec.yml` (modified — `stats` tag, `/api/stats` path, 5 new schemas)
- `docs/data-model.md` (modified — Critical Indexes block, D2)
- `docs/context/TECHNICAL-DESIGN.md` (modified — §5 index block + §11 endpoint table)
- `docs/context/ARCHITECTURE-SPINE.md` (modified — AD-12 Binds gains `/api/stats`)
- `docs/context/PRD.md` (modified — Statistics-view row in §4.3 Vistas principales)
- `_bmad-output/planning-artifacts/epics.md` (modified — FR24/FR25, FR→Épico table, Épico 9
  header + Historia 9.1 bullet corrected)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified — story 9-1 status
  progression ready-for-dev → in-progress → review)

## Change Log

- 2026-07-10 — Story created (bmad-create-story). Shared `StatsResponse` contract +
  RBAC-scoped `GET /api/stats` endpoint, per `sprint-change-proposal-2026-07-10-stats.md`. 10
  ratified defaults (D1–D10) flagged for review, notably D1 (`embeddings.created_at` not
  `indexed_at` — no such column exists), D2 (composite index replaces the single-column one),
  D6 (empty-scope fast path still runs the per-user `queries` KPI), D9 (mock's "Top 5 usuarios"
  section out of the ratified contract), D10 (FR22/23 collision → stats FRs land as FR24/25).
  Status: ready-for-dev.
- 2026-07-10 — Story implemented (bmad-dev-story). Shared contract + composite index migration
  (Task 1–2); backend domain port + Drizzle adapter with AD-12 in-SQL RBAC + D4 deleted-message
  exclusion on every channel-scoped query (Task 3); service assembling the 4 KPIs (D3),
  zero-filling the 14-day activity series (D5), and computing `readPct` (AC5), validated
  against the shared contract before leaving the service (Task 4); controller/route/wiring
  mounted after the generic `/api` gate (Task 4); RBAC integration test proving channel B never
  surfaces in any figure (Task 5); manual 401/200 verification against both the compose stack
  and the deterministic e2e backend (Task 6); docs synced across api-spec/data-model/
  ARCHITECTURE-SPINE/TECHNICAL-DESIGN/epics/PRD (Task 7). Gate green: lint 0 / 860 unit+web
  (+44) / build clean (5 packages) / 127 integration (+7, 20 files). No new dependency, no web
  change (9.2/9.3 out of scope). Status: review.

---

Ultimate context engine analysis completed — comprehensive developer guide created.
