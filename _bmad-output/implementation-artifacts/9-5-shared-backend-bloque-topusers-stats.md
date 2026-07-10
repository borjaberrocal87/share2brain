---
baseline_commit: 5e0621b (main — PR #56 / story 9.4 merged; verify `git log -1` shows it before branching)
---

# Story 9.5: shared + backend — `topUsers` block in `StatsResponse` (Top 5 users)

Status: done

## Story

As an authenticated community member viewing the Statistics view,
I want `GET /api/stats` to include a "Top 5 most active users" block with real display names,
so that the upcoming StatsView section (9.2) can show who drives the community's knowledge — without ever counting or naming activity from channels I cannot read.

> Approved via `bmad-correct-course` (2026-07-10, `_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10-topusers.md` §4.2). Promoted from Story 9.1 review decision D9. **No new FR** — part of the Statistics view (FR24), respects FR25. Binding sequence: **9.4 (done, merged) → 9.5 (this) → (9.2 render, 9.3 e2e)**.

## Scope (what this story is and is NOT)

- **IS:** extend the `StatsResponse` contract with a required `topUsers` block (AD-6); new RBAC-scoped aggregation in the stats port/adapter/service (AD-12, in-SQL); **plus the `authorName` COALESCE upgrade in the search/documents repositories that Story 9.4 explicitly reserved for 9.5** (see D6 — the `-- D2: no display name persisted yet` stubs are now false); integration + unit tests; docs sync (`api-spec.yml`, TECHNICAL-DESIGN §11 row).
- **IS NOT:** no DDL, no migration, no new index (9.4 added the column; guild-scale aggregation needs nothing new — state this explicitly at the gate); no web render (9.2); no e2e/seed change (`packages/backend/src/e2e/seed.ts` is 9.3's — the COALESCE upgrade degrades to `author_id` for its NULL-name/no-users rows, so all 16 Playwright specs stay byte-identical, do NOT run them); no backfill (ratified 9.4-D5); no changes to controller/routes/app.ts wiring (the service is already composed; a new port method rides the existing objects); no bot/workers change.
- Downstream: 9.2 renders `topUsers` via `z.infer`; 9.3 seeds `author_name` + asserts order/exclusion in Playwright.

## Acceptance Criteria

1. **AC1 — Contract extension (shared, AD-6).** `packages/shared/src/schemas/stats.ts` gains `StatsTopUserSchema` = `{ authorId: z.string().min(1), authorName: z.string().min(1), count: z.number().int().min(1) }` (+ `z.infer` type export, JSDoc) and `StatsResponseSchema` gains a **required** 5th key `topUsers: z.array(StatsTopUserSchema).max(5)` with a `superRefine` that structurally pins the `count DESC, authorId ASC` ordering (same P3 precedent as the pinned KPI order — the contract, not just the SQL, is 9.2's safety net). `authorName` can use `.min(1)` because the SQL COALESCE bottoms out at `author_id`, which is `notNull` and never empty. No barrel change (`export * from './stats.js'` already covers it). `STATS_ERROR` unchanged (D8 of 9.1 — still no input, no new codes).
2. **AC2 — RBAC-scoped topUsers query (AD-12, in-SQL).** New port method `getTopUsers(allowedChannelIds)` on `StatsRepository` + Drizzle implementation: top 5 `author_id` by count of **scoped, non-deleted** embeddings whose anchor (`e.message_ids[1]`) is authored by that `author_id` — the exact same `JOIN discord_messages d ON d.id = e.message_ids[1]` + `inArray(e.channel_id, allowedChannelIds)` + D4 `NOT EXISTS` deleted-message predicate the `authors` KPI already uses (count basis consistency: summing every author's count over an unlimited version of this query equals the `resources` KPI). `authorName = COALESCE(<latest scoped non-blank author_name — D1>, u.username, d.author_id)` with `LEFT JOIN users u ON u.discord_id = d.author_id`; the name pick treats `''` like NULL via `NULLIF` (see D1 — the create path has no runtime guard on `displayName`, 9.4's deferred Low, and one `''` row must not 500 the endpoint through `authorName.min(1)`). `ORDER BY count DESC, d.author_id ASC`, `LIMIT 5` in the SQL (D4). Empty `allowedChannelIds` returns `[]` **without touching the DB** (deny-by-default; `inArray` throws on `[]`).
3. **AC3 — Service assembly.** `statsService.getStats` adds the `getTopUsers` call to its existing `Promise.all`; the D6 empty-scope fast path short-circuits it to `[]` (it IS channel-scoped — unlike `countUserAgentQueries` it must NOT run on empty scope); the assembled payload includes `topUsers` and still leaves the service only through `StatsResponseSchema.parse(...)` (AD-6). Controller, routes, and `app.ts` are byte-untouched.
4. **AC4 — `authorName` stub upgrade (reserved by 9.4).** `packages/backend/src/infrastructure/embeddingSearchRepository.drizzle.ts:43` and `documentRepository.drizzle.ts:36` replace `dm.author_id AS "authorName"   -- D2: no display name persisted yet` with `COALESCE(NULLIF(dm.author_name, ''), u.username, dm.author_id) AS "authorName"` + `LEFT JOIN users u ON u.discord_id = dm.author_id` (anchor-level resolution — one row, no aggregation; `NULLIF` for the same `''`-hardening as D1). No contract change (`authorName` stays `z.string()` in `SearchFragmentSchema`/`DocumentFragmentSchema`). The RAG retriever and chat citations inherit real names for free (`ragRetriever.drizzle.ts` composes `EmbeddingSearchRepository` — zero code change there). `/api/search`, `/api/documents`, and citations now show real names as data converges; old rows degrade to the snowflake exactly as before.
5. **AC5 — Tests.** Shared schema tests for `StatsTopUserSchema` + the new `StatsResponseSchema` cases (missing key rejects; `[]` passes; 6 rows rejects; **misordered rejects** — the superRefine must be discriminated, not just decorative). Service unit tests: fakes gain the new method (compile fix), empty-scope skips `getTopUsers`, pass-through into the payload, and **a fake returning misordered rows makes the service throw**. Integration: `stats.integration.test.ts` extended per the seed plan in Dev Notes — proves all 3 COALESCE tiers, the latest-name pick, `count DESC, authorId ASC` ordering, **LIMIT-5 truncation with a 6th author**, denied-channel exclusion, cross-channel count/name isolation (an author's channel-B rows contribute neither count nor name), and deleted-anchor exclusion; the 4 existing absolute-count assertions it inflates are updated (exact new values in the Test Impact map). `embeddingSearchRepository.drizzle.integration.test.ts` upgrades its `authorName === authorId` stub assert to a real-name assert (seed one anchor with `author_name`). Idempotency/RBAC invariants of sibling suites untouched.
6. **AC6 — Gate + docs sync.** `npm run lint` → `npm run test` → `npm run build` → `npm run test:integration` green, outputs pasted (infra per §3.2: `docker compose up -d postgres redis`, app containers stopped). §3.3 endpoint check: 401 without session (existing test) + 200 body re-validated against the extended schema (the integration suite is the evidence; a manual curl is optional). §3.4 e2e explicitly N/A (no web change; COALESCE degrades identically on the e2e seed). Docs (this list is definitive, grep-verified at story creation — do not hunt further): `docs/api-spec.yml` adds `components.schemas.StatsTopUser` (with its own `required: [authorId, authorName, count]` — every sibling component carries one) + a `topUsers` array property (maxItems 5) on `StatsResponse` **and appends `topUsers` to `StatsResponse.required`** (the Zod key is required, D3) and mentions the block in the `/api/stats` description; `docs/context/TECHNICAL-DESIGN.md` §11 `GET /api/stats` row description gains "top 5 usuarios". `data-model.md` needs **nothing** (no DDL); `ARCHITECTURE-SPINE.md` AD-12 Binds already lists `/api/stats`; `epics.md`/PRD already updated by the correct-course — no action.

## Decisions embedded in the ACs (ratified defaults — veto at review)

| # | Decision | Rationale |
|---|---|---|
| **D1** | **Name resolution inside the aggregation:** `COALESCE((array_agg(NULLIF(d.author_name, '') ORDER BY d.created_at DESC) FILTER (WHERE NULLIF(d.author_name, '') IS NOT NULL))[1], u.username, d.author_id)`. The pick considers **only the user's scoped, non-deleted anchor rows** — never a name captured in a denied channel — and treats `''` like NULL. | The SCP writes `COALESCE(dm.author_name, …)` but `GROUP BY author_id` needs an aggregate when one author has several anchor messages with differing captured names. Latest-non-blank = "newer display name is newer truth" (9.4-D4). A plain `max(d.author_name)` would pick alphabetically, not newest. Scoping the pick to the already-filtered rowset keeps FR25 airtight AND costs nothing. The `NULLIF` hardening matters: the 9.4 edit path normalizes `''` → untouched, but the **create path** inserts `message.author.displayName` with no runtime guard (9.4's deferred Low) — without `NULLIF`, one `''` row would flow into `authorName.min(1)` and the outgoing `.parse()` would 500 the whole endpoint. |
| **D2** | **Count basis = scoped non-deleted embeddings (resources), attributed to the anchor author** — identical join/predicates as the `authors` KPI. A message with 3 links = 3 resources = 3 counted. | Consistency: `topUsers` counts must reconcile with the `resources`/`authors` KPIs on the same screen (9.2 renders them side by side). Counting distinct messages instead would disagree with every other figure. |
| **D3** | Contract details: `topUsers` **required** (not optional), `.max(5)` (NOT `.length(5)` — fewer than 5 authors is legal, empty `[]` is legal), `count: .min(1)` (a GROUP BY row cannot exist with 0), ordering pinned via `superRefine` (for each `i>0`: `count[i] < count[i-1]`, or equal count and `authorId[i] > authorId[i-1]` — strict, so duplicate authorIds within a tie also reject). | Required is safe: 9.2 doesn't exist yet and this story updates the only producer + every fixture. `.min(1)` deviates from `StatsChannelSchema.count.min(0)` deliberately — flag if you prefer sibling consistency over precision. Order-pinning mirrors the 9.1 review patch P3 (a per-item schema alone would let a reordered array pass). |
| **D4** | `LIMIT 5` is a named constant in the **adapter** (`TOP_USERS_LIMIT = 5`) interpolated into the SQL; the port JSDoc states "at most 5"; `.max(5)` in the schema is the AD-6 net. No `limit` parameter on the port method. | Nobody else needs a different limit; a parameter would be speculative surface. Three layers (SQL, JSDoc, schema) already encode it. |
| **D5** | Empty scope → `topUsers: []` via the existing D6 fast-path pattern: the service short-circuits (adapter also guards defensively, like every other channel-scoped method). | `topUsers` is channel-scoped — the one-exception rule (`countUserAgentQueries` always runs) does NOT extend to it. |
| **D6** | **The search/documents `authorName` stub upgrade lands in this story.** Both repositories move to the anchor-level `COALESCE(dm.author_name, u.username, dm.author_id)` + `LEFT JOIN users` (single anchor row — no aggregate needed, unlike D1). | Story 9.4's Dev Notes ratified this ownership verbatim: "that COALESCE upgrade is **9.5's**, leave it alone". Leaving the stubs would ship a Stats view with real names next to Search/Docs/citations showing snowflakes forever. Veto option: split to a follow-up story — but it is ~4 lines + 1 assert, and 9.3's seed work assumes it landed. |
| **D7** | `users` join key = `u.discord_id = d.author_id` (unique index `idx_users_discord_id` guarantees ≤1 row; `username` is `notNull`). Tier 2 only ever helps authors who logged into the web app — accepted (SCP §2). | Schema facts, not choices — recorded so nobody "fixes" the join into `users.id`. |

## Tasks / Subtasks

- [x] Task 0 — Preconditions (AC6)
  - [x] Verify PR #56 merged (`git log -1 --oneline` on updated `main` shows `5e0621b` or later); `git switch -c feat/9-5-stats-top-users`
  - [x] `docker compose up -d postgres redis`; app containers stopped (`docker compose stop bot backend workers` — OPS-2 guard); migrations current (`npx drizzle-kit migrate` is a no-op — 0005 already applied)
- [x] Task 1 — shared: contract extension, tests-first (AC1)
  - [x] Extend `packages/shared/src/schemas/stats.test.ts` red first: new `describe('StatsTopUserSchema')` (valid fixture + rejects: `''` authorId, `''` authorName, `count: 0`, non-int count) + new `StatsResponseSchema` cases (missing `topUsers` rejects; `[]` passes; 6 rows rejects; equal-count rows ordered `authorId DESC` reject; `count ASC` rejects; a valid 5-row descending fixture passes). Add `topUsers` to the existing `validResponse` fixture (line ~144) — several existing cases parse it and will fail red until the schema lands.
  - [x] Implement in `packages/shared/src/schemas/stats.ts`: `StatsTopUserSchema` + type + `topUsers` key with the ordering `superRefine` (comment it like the KPI-order one: the service is the sole producer, the contract is 9.2's safety net). Keep the header comment's "no links → no linkRefine" note true (authorName is not a link).
- [x] Task 2 — backend: port + adapter (AC2)
  - [x] `packages/backend/src/domain/repositories/statsRepository.ts`: add `TopUserRow { authorId: string; authorName: string; count: number }` + `getTopUsers(allowedChannelIds: string[]): Promise<TopUserRow[]>` with JSDoc covering: order `count DESC, authorId ASC`, at most 5 rows, the D1 COALESCE chain, empty scope resolves `[]` without touching the DB.
  - [x] `packages/backend/src/infrastructure/statsRepository.drizzle.ts`: implement per the Query sketch below — `TOP_USERS_LIMIT = 5` const, early-return on empty scope, `sql`/`inArray` from `@share2brain/shared/db` only (AD-2; no new re-export needed), row coercion `String()`/`Number()` like the sibling methods.
- [x] Task 3 — backend: service, tests-first (AC3)
  - [x] Extend `packages/backend/src/application/services/statsService.test.ts` red first: `fakeRepo` gains `getTopUsers: vi.fn(async (): Promise<TopUserRow[]> => [])` (compile fix for every existing test); new cases: (a) empty scope → `getTopUsers` **not called** and `topUsers` is `[]` (extend the existing D6 test), (b) rows pass through verbatim into the response, (c) a fake returning misordered rows (e.g. counts `[1, 2]`) makes `getStats` **reject** (proves the outgoing `.parse()` + superRefine actually guard).
  - [x] `packages/backend/src/application/services/statsService.ts`: add the call to the `Promise.all` (`emptyScope ? Promise.resolve([]) : statsRepo.getTopUsers(allowedChannelIds)`), add `topUsers` to the parsed payload, extend the `getStats` JSDoc's empty-scope enumeration ("…channels is `[]`, topUsers is `[]`, coverage is `0/0/0`").
- [x] Task 4 — backend: authorName stub upgrade (AC4, D6)
  - [x] `embeddingSearchRepository.drizzle.ts`: swap the alias line for the COALESCE + add `LEFT JOIN users u ON u.discord_id = dm.author_id` (after the `dm` join, before the WHERE; keep every comment that still holds, delete the stale `-- D2: no display name persisted yet`).
  - [x] `documentRepository.drizzle.ts`: identical change (only in `listDocuments` — `countDocuments` selects no author fields, verify and leave it alone).
  - [x] Confirm `ragRetriever.drizzle.ts` needs zero changes (it maps `r.authorName` from the repo rows) and `packages/web` compiles untouched.
- [x] Task 5 — integration tests (AC5) — follow the Seed plan + Test Impact map in Dev Notes exactly
  - [x] Extend `packages/backend/src/stats.integration.test.ts`: seed additions, the 4 updated absolute asserts, new `topUsers` describe (exact 5-row `toEqual`, truncation, exclusions).
  - [x] Update `embeddingSearchRepository.drizzle.integration.test.ts`: seed `author_name` on the `-a` anchor + flip the stub assert to the real name.
- [x] Task 6 — docs + gate (AC6)
  - [x] Sync `docs/api-spec.yml` (StatsTopUser component, `topUsers` property with `maxItems: 5`, `/api/stats` description) + `docs/context/TECHNICAL-DESIGN.md` §11 row (~line 828).
  - [x] Full gate; paste outputs; state explicitly: no migration (no DDL), e2e not run (no web change, COALESCE inert on the e2e seed).
  - [x] Commit slices: `feat(shared): …` (contract — shared-scoped even though backend motivated it; additive required key consumed by no one yet → **no `!`**), `feat(backend): …` (topUsers query/service + stub upgrade), `test(backend): …` if separate, `docs(repo): …`. PR from `feat/9-5-stats-top-users`; never auto-merge → `bmad-code-review`.

## Dev Notes

### Query sketch (adapter reference — predicates and ordering are binding, style is dev's)

```sql
SELECT
  d.author_id AS "authorId",
  COALESCE(
    -- D1: latest display name captured among the user's SCOPED, non-deleted anchor
    -- rows (9.4-D4 "newer name is newer truth"); never a denied channel's capture.
    -- NULLIF: the create path has no runtime '' guard (9.4 deferred Low) — a blank
    -- must fall through the chain, not 500 the endpoint via authorName.min(1).
    (array_agg(NULLIF(d.author_name, '') ORDER BY d.created_at DESC)
       FILTER (WHERE NULLIF(d.author_name, '') IS NOT NULL))[1],
    u.username,      -- tier 2: OAuth-known authors (idx_users_discord_id unique)
    d.author_id      -- tier 3: notNull snowflake — never NULL, never ''
  ) AS "authorName",
  count(*)::int AS "count"
FROM embeddings e
JOIN discord_messages d ON d.id = e.message_ids[1]
LEFT JOIN users u ON u.discord_id = d.author_id
WHERE ${inArray(sql`e.channel_id`, allowedChannelIds)}
  AND NOT EXISTS (
    SELECT 1 FROM discord_messages dd
    WHERE dd.id = ANY(e.message_ids) AND dd.deleted_at IS NOT NULL
  )
GROUP BY d.author_id, u.username
ORDER BY count DESC, d.author_id ASC
LIMIT 5   -- TOP_USERS_LIMIT
```

Notes: alias `count` in ORDER BY is the existing `getChannelCounts` convention; `u.username` in GROUP BY is safe (≤1 users row per author, unique index); `array_agg … FILTER` is standard PG (9.4+; we run PG 17) — no new capability, no new dependency, no new index (the composite `idx_embeddings_channel_created` + `discord_messages` PK serve this at guild scale).

### Current state of every file you will modify

| File | Today | Change |
| --- | --- | --- |
| `packages/shared/src/schemas/stats.ts` | 4 sub-schemas + `KPI_ORDER` + `StatsResponseSchema` (kpis `.length(4)` + order superRefine, activity `.length(14)`, channels, coverage) + `STATS_ERROR` | +`StatsTopUserSchema`/type; +required `topUsers` key with ordering superRefine |
| `packages/shared/src/schemas/stats.test.ts` | 36 `it` blocks (one `it.each` expands to 4 cases); `validResponse` fixture at ~144 | +topUsers describes; fixture gains `topUsers` |
| `packages/backend/src/domain/repositories/statsRepository.ts` | 5 methods; header states `countUserAgentQueries` is the ONE channel-scope exception | +`TopUserRow` + `getTopUsers` (channel-scoped — the exception note stays true) |
| `packages/backend/src/infrastructure/statsRepository.drizzle.ts` | 5 methods; every channel-scoped one: empty-scope early return → `db.execute(sql\`…\`)` with `inArray` + D4 NOT EXISTS → `String()`/`Number()` coercion (`countUserAgentQueries` deliberately has no scope guard, D6) | +`getTopUsers` (channel-scoped shape) |
| `packages/backend/src/application/services/statsService.ts` | `Promise.all` of 5 reads (4 gated on `emptyScope`), assembles KPIs/activity/coverage, `StatsResponseSchema.parse` at the end | +6th read gated on `emptyScope`; +`topUsers` in payload |
| `packages/backend/src/application/services/statsService.test.ts` | `fakeRepo(overrides)` builds all 5 methods with `vi.fn`; 8 tests | fake gains `getTopUsers` (compile fix); +3 tests |
| `packages/backend/src/infrastructure/embeddingSearchRepository.drizzle.ts:42-43` | selects `dm.author_id AS "authorId"`, `dm.author_id AS "authorName" -- D2 stub`; joins `cp` + anchor `dm`; no users join | COALESCE + `LEFT JOIN users u` |
| `packages/backend/src/infrastructure/documentRepository.drizzle.ts:35-36` | same stub inside `listDocuments`; `countDocuments` has no author fields | COALESCE + `LEFT JOIN users u` in `listDocuments` only |
| `packages/backend/src/stats.integration.test.ts` | 7 tests; seed helpers `seedMessage(id, channelId, authorId, deleted)` (no author_name), `seedEmbedding(chunkKey, channelId, messageIds, createdAt)`; `memberOAuth` returns `username: discordId` | see Seed plan |
| `packages/backend/src/infrastructure/embeddingSearchRepository.drizzle.integration.test.ts` | `seedMessage` has no author_name; line ~161 asserts `top.authorName === top.authorId // D2: no display name yet` | seed a name on `-a`; assert the real name |
| `docs/api-spec.yml` (~161-176, ~449-457) | `/api/stats` path + `StatsResponse` with 4 properties | +`StatsTopUser` component + `topUsers` property |
| `docs/context/TECHNICAL-DESIGN.md` (~828) | §11 row: "KPIs de conocimiento, actividad 14 días, volumen por canal, cobertura de lectura (RBAC-scoped)" | +"top 5 usuarios" |

Untouched by design (stop if you find yourself editing): `statsController.ts`, `statsRoutes.ts`, `app.ts`, `main.ts`, `packages/shared/src/schemas/index.ts` (barrel already re-exports), `packages/shared/src/db/schema.ts` (NO DDL), `ragRetriever.drizzle.ts`, anything under `packages/{web,bot,workers}`, `packages/backend/src/e2e/seed.ts` (9.3), `Share2Brain.config.yml`. No new npm dependency.

### Seed plan for `stats.integration.test.ts` (binding invariants; exact ids are dev's choice)

The suite asserts ABSOLUTE counts, so every added row must be accounted for. Design goal: prove all three COALESCE tiers, the latest-name pick, ordering, truncation, and three exclusion classes — while leaving the **activity and weekly-delta asserts untouched** by giving every new embedding `created_at` = 20 days ago (outside both the 14-day and 7-day windows).

1. `seedMessage` gains TWO optional params: `authorName?: string` → INSERT includes `author_name` (`${authorName ?? null}`), **and `createdAt?: string`** (default stays `now()`) — the helper today hardcodes `created_at ... now(), now()` (line 64-68), but step 3's latest-name-pick discrimination REQUIRES controlled message timestamps (3d-ago / now−1h / now); without the param the pick would ride on sub-second insert order, i.e. not discriminate `ORDER BY d.created_at DESC` at all. Mirror `seedEmbedding`, which already takes `createdAt`.
2. `memberOAuth` for MEMBER returns a **distinct** `username` (e.g. `` `${suffix}-member-username` ``) instead of `discordId` — otherwise tier 2 (username fallback) is indistinguishable from tier 3 (snowflake fallback).
3. New rows (messages + one embedding each unless noted, all embeddings at `twentyDaysAgo`):
   - `-a-top0`: author `${suffix}-author-today`, `author_name: 'Nombre Antiguo'`, **message** `created_at` 3 days ago.
   - `-a-top1`: author `${suffix}-author-today`, `author_name: 'Nombre Visible'`, **message** `created_at` = `now() - interval '1 hour'`.
   - `-a-member`: author `MEMBER_DISCORD_ID`, NULL name, **×2 embeddings** (two messages or two chunk keys on one message — two messages is simpler for the anchor join).
   - `-a-z1`, `-a-zz`: two fresh authors, NULL name, 1 embedding each — `-a-zz`'s author must sort lexically LAST among the count-1 authors (e.g. `${suffix}-author-z1` / `${suffix}-author-zz`; both sort before `${suffix}-member`? No — verify: `-author-…` < `-member` because `a` < `m`, which would drop MEMBER instead. That is WHY member gets count 2: it ranks by count, not name. The dropped row must be the lexically-last **count-1** author — with authors `author-20d`, `author-3d`, `author-z1`, `author-zz` at count 1, `author-zz` is dropped).
   - `-b2` (channel B): author `${suffix}-author-today`, `author_name: 'Nombre B'`, **message** `created_at = now()` (strictly newest) + 1 embedding in B. If the D1 name-pick were unscoped, 'Nombre B' would win — this row is the leak detector for both count and name.
4. Expected `topUsers` (exact `toEqual`):
   1. `{ authorId: ${suffix}-author-today, authorName: 'Nombre Visible', count: 3 }` — tier 1 + latest-pick ('Nombre Antiguo' older, 'Nombre B' denied-channel) + B row not counted (3, not 4)
   2. `{ authorId: MEMBER_DISCORD_ID, authorName: ${suffix}-member-username, count: 2 }` — tier 2
   3. `{ authorId: ${suffix}-author-20d, authorName: ${suffix}-author-20d, count: 1 }` — tier 3, tie broken `authorId ASC`
   4. `{ authorId: ${suffix}-author-3d, authorName: ${suffix}-author-3d, count: 1 }`
   5. `{ authorId: ${suffix}-author-z1, authorName: ${suffix}-author-z1, count: 1 }`
   Plus: `author-zz` absent (LIMIT 5), `author-b` absent (RBAC), `author-del` absent (D4), length exactly 5.
5. Cleanup: the existing `afterAll` LIKE-scoped deletes already cover every new row (all ids/chunk_keys carry the suffix; B-channel rows match `chunk_key LIKE suffix%` and `id LIKE suffix%`). Verify, don't rewrite.

### Test Impact map (AC5) — existing assertions that WILL break and their exact new values

New A-channel live embeddings: `-a-top0`, `-a-top1`, `-a-member`×2, `-a-z1`, `-a-zz` = **+6** (all at 20d-ago; `-b2` is in B and invisible). Updates:

- `resources.value`: 3 → **9**; `resources.sub` stays `'+2 esta semana'` (new rows outside the 7-day window).
- `authors.value`: 3 → **6** (today, 3d, 20d, member, z1, zz — del still excluded).
- `channels[0]`: `count: 3` → **`count: 9`** (same single-row `toEqual`).
- `coverage`: `{ readCount: 1, totalCount: 3, readPct: 33 }` → **`{ readCount: 1, totalCount: 9, readPct: 11 }`**.
- Activity test: **unchanged** (today still 1, 3d-ago still 1 — the new embeddings sit at 20d-ago, outside the 14-day window; only three of the new *messages* have recent timestamps (`-a-top0`/`-a-top1`/`-b2`), and activity counts `e.created_at`, not message time).
- Queries KPI test: unchanged.
- Shape test: passes automatically once the schema and service land (parse includes topUsers).
- `statsService.test.ts`: every existing test compiles only after `fakeRepo` gains `getTopUsers` (returning `[]` keeps them green — `.max(5)` accepts empty).
- `embeddingSearchRepository.drizzle.integration.test.ts` ~161: assert flips from `toBe(top.authorId)` to the seeded display name; also delete the stale `// D2: no display name yet` comment. The other suites (`documents.integration.test.ts`, `search.integration.test.ts`, web specs) assert no `authorName` — grep-verified, no impact.
- `searchService.test.ts:73` carries a stale `// D2: equals authorId` comment on a fake row — the fake is repo-independent so nothing breaks; update the comment while there (comment-only).

### Architecture constraints (verbatim anchors)

- **AD-6:** the ONLY definition of the stats shape is `packages/shared/src/schemas/stats.ts`; backend `.parse()`s outgoing; 9.2 will `z.infer`. **AD-12:** RBAC inside each SQL statement (`inArray`), never post-filter; `getTopUsers` is channel-scoped and MUST honor the empty-scope guard. **AD-2:** backend imports `sql`/`inArray` from `@share2brain/shared/db` re-exports only. **AD-5:** no DDL anywhere in this story — if you think you need a migration, stop and re-read the scope.
- Commit-scope rule (base-standards §8): the contract change is `feat(shared)` even though backend motivated it; additive required key with a single producer updated in the same story → no `!`.
- English-only code/comments/tests/commits; Spanish ONLY inside user-facing string literals — `topUsers` has none (names come from data), but integration seed literals like `'Nombre Visible'` are data, not UI copy — fine.
- Logging posture (9.4-D6): author names are PII-adjacent — never log them. The stats path logs nothing per-row today; keep it that way.

### Previous-story intelligence

- **9.4 (merged, PR #56):** `author_name` is nullable, captured on create (`persistMessage`) and edit (Sync worker UPDATE); old rows are NULL forever (no backfill, D5); `''` never reaches the column (parse normalizes → undefined). Known accepted staleness: out-of-order edit redelivery can revert a name (deferred, pre-existing) — irrelevant to this story's read path.
- **9.1 review patches to honor as standing patterns:** structural order-pinning in the schema (P3) — replicated here for `topUsers`; single-clock windows via injected `now` (RP1) — `getTopUsers` has no time window, nothing to thread; discrimination tests that fail if the predicate is dropped (RP4) — the `-b2`/`author-zz`/misordered-fake cases are this story's equivalents.
- Integration determinism: suffix-unique ids AND role names (this suite asserts absolute counts — a literal role leaks sibling suites' channels); `rbac.integration.test.ts` has a known load-sensitive flake — rerun before blaming your diff; `readStatus.integration.test.ts` threw one unrelated ECONNRESET in 9.4's gate — same advice.
- Two Redis instances on this Mac (manual checks only): Homebrew owns `localhost:6379`; compose Redis publishes no ports. `SHARE2BRAIN_CONFIG_PATH=<repo-root>/Share2Brain.config.yml` when running a workspace dev server from a subdir.
- No web research needed: zero new dependencies; `array_agg … FILTER` and `count(*) FILTER` (already used in 9.1) are long-standing PG features on the pinned `pgvector/pgvector:pg17` image.

### Project Structure Notes

- Zero new files except nothing — every change is an UPDATE to existing files (contract, port, adapter, service, 2 repo upgrades, 2 test suites, 2 docs). No root `src/`, no cross-service imports (AD-2).
- Branch `feat/9-5-stats-top-users` off updated `main` (PR #56 merged at `5e0621b`).

### References

- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10-topusers.md §4.2, §5] — shape, order, limit, COALESCE chain, integration-test mandate, sequencing.
- [Source: _bmad-output/planning-artifacts/epics.md §Épico 9 — Historia 9.5 bullet + Top-5 blockquote] — ratified scope.
- [Source: _bmad-output/implementation-artifacts/9-4-…md — Dev Notes "Blast radius" (stub ownership), D2/D4/D5 (name semantics), D6 (PII)] .
- [Source: _bmad-output/implementation-artifacts/9-1-…md — D3/D4/D6/D7 (KPI basis, deleted predicate, empty scope, ordering), Review P3/RP4 (order-pinning, discrimination tests), integration conventions].
- [Source: docs/context/ARCHITECTURE-SPINE.md AD-2, AD-5, AD-6, AD-12 (Binds already lists /api/stats)].
- [Source: docs/data-model.md §1 discord_messages (author_name), §3 users (discord_id unique, username notNull)].
- [Source: docs/bmad-story-mandatory-steps.md §2, §3.2, §3.3, §3.5].
- [Source: packages/backend/src/{statsRepository.drizzle,statsService,documentRepository.drizzle,embeddingSearchRepository.drizzle}.ts + stats.integration.test.ts] — the live code this story extends (read before editing).

## Dev Agent Record

### Agent Model Used

claude-sonnet-5 (Amelia / bmad-dev-story)

### Debug Log References

None — no failures requiring debug-log capture; every red phase failed exactly as expected (schema/service not yet extended) and every green phase passed on the first implementation attempt.

### Completion Notes List

- Task 1 (AC1): `StatsTopUserSchema` + required `topUsers` key with a `count DESC, authorId ASC` ordering `superRefine` added to `stats.ts`. Tests-first: 11 new cases in `stats.test.ts` confirmed red (schema/key did not exist), then green after implementation. Full file: 50/50 passing.
- Task 2 (AC2): `TopUserRow` + `getTopUsers(allowedChannelIds)` added to the `StatsRepository` port; Drizzle adapter implements the D1 `array_agg … FILTER` latest-non-blank-name pick with `NULLIF('')` hardening, `TOP_USERS_LIMIT = 5` named constant, empty-scope guard, and the D4 deleted-anchor `NOT EXISTS` predicate — verbatim per the query sketch in Dev Notes.
- Task 3 (AC3): `statsService.getStats` wires `getTopUsers` into the existing `Promise.all`, gated on `emptyScope` (channel-scoped, unlike `countUserAgentQueries`). Tests-first: 2 new `it` blocks in `statsService.test.ts` (pass-through; misordered-fake throws via the outgoing `.parse()`) plus the empty-scope assertion folded into the existing D6 test — confirmed red then green. Full file: 10/10 passing.
- Task 4 (AC4, D6): `embeddingSearchRepository.drizzle.ts` and `documentRepository.drizzle.ts` (`listDocuments` only — `countDocuments` selects no author fields, left untouched) swap the `authorId`-stub alias for `COALESCE(NULLIF(dm.author_name, ''), u.username, dm.author_id)` + a new `LEFT JOIN users u`. `ragRetriever.drizzle.ts` needed zero changes (verified — it only maps repo rows).
- Task 5 (AC5): `stats.integration.test.ts` extended per the Dev Notes seed plan — `seedMessage` gained `authorName`/`createdAt` optional params, `memberOAuth` gained a distinct `username`, and 9 new rows prove all 3 COALESCE tiers, the latest-non-blank-name pick, `count DESC, authorId ASC` ordering, LIMIT-5 truncation (6th author dropped), and all 3 exclusion classes (RBAC-denied channel, soft-deleted anchor, LIMIT truncation) in one exact `toEqual` assertion. The 4 existing absolute-count assertions were updated to their exact new values per the Test Impact map (resources 3→9, authors 3→6, channels[0].count 3→9, coverage totalCount 3→9/readPct 33→11); the activity and queries-KPI assertions were verified unchanged (all new embeddings seeded at 20-days-ago, outside both the 14-day and 7-day windows). `embeddingSearchRepository.drizzle.integration.test.ts` seeded a real `author_name` on its `-a` anchor and flipped the stub assertion (`authorName === authorId`) to the real captured name. `searchService.test.ts` had a stale comment updated (comment-only, fake row is repo-independent). Full integration suite: 20 files / 128 tests passing (+1 over the 127 baseline).
- Task 6 (AC6): `docs/api-spec.yml` gained the `StatsTopUser` component + `topUsers` array property (`maxItems: 5`) on `StatsResponse`, added `topUsers` to `StatsResponse.required`, and reworded the `/api/stats` description. `docs/context/TECHNICAL-DESIGN.md` §11 row appended "top 5 usuarios". `data-model.md`/`ARCHITECTURE-SPINE.md`/`epics.md`/PRD confirmed to need no changes (no DDL; AD-12 Binds already lists `/api/stats`).
- Full gate, run in order: `npm run lint` → 0 problems. `npm run test` → 882 passed, 1 skipped (883; +13 over the 869 baseline: +11 shared schema, +2 service). `npm run build` → clean across all 5 workspaces (backend/bot/shared/workers tsc --noEmit, web vite build). `npm run test:integration` → 20 files / 128 tests passing (backend-integration + bot-integration + workers-integration projects). No migration, no DDL — `npx drizzle-kit migrate` confirmed a no-op before starting. e2e explicitly NOT run per scope (no web change; the COALESCE upgrade is inert on the e2e seed, which has no `author_name`/`users.username` rows to differentiate — degrades identically to `author_id`).
- Scope discipline: `statsController.ts`, `statsRoutes.ts`, `app.ts`, `main.ts`, `packages/shared/src/schemas/index.ts` (barrel already re-exports via `export *`), `packages/shared/src/db/schema.ts`, and everything under `packages/{web,bot,workers}` and `packages/backend/src/e2e/seed.ts` were confirmed untouched, as scoped.

### File List

- `packages/shared/src/schemas/stats.ts` (modified)
- `packages/shared/src/schemas/stats.test.ts` (modified)
- `packages/backend/src/domain/repositories/statsRepository.ts` (modified)
- `packages/backend/src/infrastructure/statsRepository.drizzle.ts` (modified)
- `packages/backend/src/application/services/statsService.ts` (modified)
- `packages/backend/src/application/services/statsService.test.ts` (modified)
- `packages/backend/src/infrastructure/embeddingSearchRepository.drizzle.ts` (modified)
- `packages/backend/src/infrastructure/documentRepository.drizzle.ts` (modified)
- `packages/backend/src/infrastructure/embeddingSearchRepository.drizzle.integration.test.ts` (modified)
- `packages/backend/src/stats.integration.test.ts` (modified)
- `packages/backend/src/application/services/searchService.test.ts` (modified, comment-only)
- `docs/api-spec.yml` (modified)
- `docs/context/TECHNICAL-DESIGN.md` (modified)

## Change Log

- 2026-07-10 — Story created (bmad-create-story). `topUsers` block in `StatsResponse` + RBAC-scoped Top-5 query, per `sprint-change-proposal-2026-07-10-topusers.md` §4.2. 7 ratified defaults (D1–D7) flagged for review, notably D1 (latest-scoped-non-NULL name pick via `array_agg … FILTER` — the SCP's bare `COALESCE(dm.author_name, …)` is under-specified under GROUP BY), D3 (required key, `.max(5)`, `count.min(1)`, ordering pinned structurally), and D6 (the search/documents `authorName` stub upgrade rides here — ownership ratified by Story 9.4's Dev Notes). No DDL, no migration, no new dependency, no new index. Fresh-context checklist validation applied 1 critical fix (seedMessage needs a `createdAt` override or the latest-name-pick test doesn't discriminate) + 2 enhancements (`NULLIF('')` hardening in every COALESCE — the create path has no runtime blank guard, and one `''` row must not 500 the endpoint via `authorName.min(1)`; api-spec `required` lists called out explicitly) + 4 accuracy nits. Status: ready-for-dev.
- 2026-07-10 — Story implemented (bmad-dev-story) on branch `feat/9-5-stats-top-users`. All 6 tasks complete, red-green-refactor followed throughout (Tasks 1 and 3 explicitly tests-first). Gate green: lint 0 / 882 unit+web (+13, 1 pre-existing skip) / build clean (5 pkgs) / 128 integration (+1, 20 files). No DDL, no migration, no new dependency, no new index, no web/bot/workers change, no e2e run (scoped out). Docs synced (api-spec.yml, TECHNICAL-DESIGN.md §11). Status: review.

## Review Findings

_bmad-code-review 2026-07-10 — 3 adversarial layers @ Opus (Blind Hunter / Edge Case Hunter / Acceptance Auditor). Acceptance Auditor: 0 AC/D/AD violations — AC1–AC6 + D1–D7 all verified faithful against source, schema, and the integration seed math (3+2+1+1+1+1=9 reconciles with `resources`). Triage: 0 decision-needed, 2 patch (applied), 3 defer, 7 dismissed._

_Re-run (2nd pass, extra scrutiny at Borja's request; identical logic, +2 comment-only patch lines): Auditor re-confirmed 0 AC/D/AD violations and verified both applied patches are truthful (search/docs SQL confirmed anchor-row-only, no array_agg; Completion Notes now +13/+11/+2 matching real `it`-block counts). Edge Hunter re-cleared fan-out/pagination/countDocuments. +2 new defers (both Low after source verification): tier-2 `u.username=''` asymmetry (folded into the COALESCE-tiers defer below) and the documents-repo/blank-fallback coverage gap. Dismissed the redundant empty-scope guard nit (ratified D5 defensive pattern) and 2 duplicates of existing defers. Review converged._

### Patches

- [x] [Review][Patch] Completion Notes test-delta breakdown is arithmetically inconsistent — reads "+12 (+9 shared, +3 service)" but the real delta is **+13 (+11 shared, +2 service)**: 869+13=882 (the headline 882 IS correct); `stats.test.ts` gains 11 `it` blocks (46 total), `statsService.test.ts` gains 2 (10 total; the empty-scope case folded into the existing D6 test). Tasks 1 ("9 new cases") and 3 ("+3 tests") carry the same miscount. [`9-5-…-topusers-stats.md` Completion Notes / Tasks] — **FIXED**: corrected the gate line, Task 1, Task 3, and the Change Log bullet.
- [x] [Review][Patch] Comment "same COALESCE chain as the stats topUsers aggregate" overstates parity — the tier chain (author_name → username → author_id) is identical, but topUsers picks the **latest non-blank name across all the author's scoped messages** (`array_agg … FILTER`), while search/docs resolve the **anchor row only**. Clarify so a maintainer doesn't assume identical name resolution. [`embeddingSearchRepository.drizzle.ts:44`, `documentRepository.drizzle.ts:37`] — **FIXED**: reworded both comments to state the anchor-vs-aggregate difference.

### Deferred (real, Low, unreachable/cosmetic for the current data domain)

- [x] [Review][Defer] SQL-vs-JS ordering-collation coupling — `getTopUsers` emits `ORDER BY … d.author_id ASC` (DB collation) and the `topUsers` `superRefine` re-checks the tie order with JS `curr.authorId <= prev.authorId` (UTF-16). For pure-numeric Discord snowflakes they always agree, so no reachable 500; latent only if `author_id` ever held non-ASCII/case-varying chars. [`statsRepository.drizzle.ts` ORDER BY vs `stats.ts` superRefine] — deferred, unreachable for snowflake domain (blind+edge)
- [x] [Review][Defer] Non-deterministic latest-name pick on `created_at` ties — `array_agg(… ORDER BY d.created_at DESC)[1]` has no secondary key; two of the same author's anchors with different names at the identical timestamp (e.g. 6.3 offline batch insert) pick arbitrarily. Cosmetic (chooses between that author's own names); a `, d.id DESC` secondary key would make it deterministic. [`statsRepository.drizzle.ts` array_agg] — deferred, cosmetic (edge)
- [x] [Review][Defer] COALESCE name tiers assume non-empty strings enforced by neither NULLIF nor DB CHECK — `NULLIF` guards tier-1 `author_name`, but **tier-2 `u.username` and tier-3 `d.author_id` are unguarded**; both are `notNull` yet have no CHECK against `''`. A `users` row with `username = ''` (blank captured name, non-empty deny) or a `''` `author_id` would resolve `authorName` to `''` and 500 `GET /api/stats` via `authorName.min(1)`. Theoretical only (OAuth usernames are ≥2 chars, snowflakes are digits). Not cleanly fixable in isolation — hardening only tier-2 leaves tier-3 exposed; the coherent fix is a DB CHECK or accepting it unreachable. Harmless on `/api/search` & `/api/documents` (their `authorName` is `z.string()`, no `.min(1)`). Same class as 9.4's deferred create-path `''` guard. [`statsRepository.drizzle.ts` COALESCE tiers 2/3] — deferred, theoretical, mirrors 9.4 Low (edge, both passes)
- [x] [Review][Defer] `documentRepository.listDocuments` COALESCE `authorName` upgrade has no dedicated test assertion, and the search/docs tier-2 (username) + blank (`NULLIF`) fallbacks are unexercised — only `embeddingSearchRepository...integration.test.ts` asserts tier-1 (`'Ada Lovelace'`); `stats.integration.test.ts` covers all 3 tiers for `getTopUsers` only. Source-verified correct (identical SQL to the tested search repo; unique `idx_users_discord_id` rules out fan-out) so residual risk is low, but the two repo projections are trusted-not-tested — copies drift. AC5 only mandated the search-repo assertion, so this exceeds ratified scope. Quality follow-up: add a documents-repo `authorName` assert + a blank-name/username-fallback case. [`documentRepository.drizzle.ts` listDocuments; `embeddingSearchRepository.drizzle.integration.test.ts`] — deferred, coverage gap beyond AC5 scope (blind, downgraded to Low via source verification)
