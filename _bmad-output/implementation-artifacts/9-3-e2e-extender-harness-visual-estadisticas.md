---
baseline_commit: 23cdbe39e07488c07c4c0068730bbfbc1a22fea8
---

<!-- story_key: 9-3-e2e-extender-harness-visual-estadisticas -->

# Story 9.3: e2e — Extender el harness visual (Playwright) a la vista Estadísticas

Status: done

<!-- Ultimate context engine analysis completed - comprehensive developer guide created
     (deep-dive: full harness current-state incl. seed math + spec ordering, StatsView
     merged source, 9.2 deferred-by-name visual ACs, 7.6 e2e-story precedent, 9.5
     topUsers COALESCE semantics, precomputed Chromium-assertable values). -->

## Story

As a **maintainer trusting that the Estadísticas view is actually correct for members**,
I want **the Playwright visual harness extended to the stats view with a deterministic,
RBAC-consistent seed — including real `author_name` values for the Top 5 section and a
denied-channel canary — asserting the computed pixel/CSS reality that Story 9.2 rendered
but explicitly deferred by name**,
so that **every visual acceptance criterion of Epic 9 is machine-verified (getComputedStyle,
not jsdom inline-style strings) and any future RBAC leak in `/api/stats` flips a visible,
asserted figure — closing Epic 9 with the same harness discipline as Epics 4, 5 and 7**.

**Scope**: `packages/web/tests/` (one NEW spec file + README) and `packages/backend/src/e2e/seed.ts`
(seed extension ONLY — no production backend code). FINAL story of Épico 9; after its review,
`epic-9` can flip to done (retrospective optional). Epic line: *"Historia 9.3 · e2e: extender el
harness visual Playwright (patrón Epic 4/7) a la vista de estadísticas con seed determinista y
RBAC-consistente, incluyendo la sección Top 5 usuarios (seed de autores con `author_name` y assert
de orden/exclusión de canal denegado)"* [Source: _bmad-output/planning-artifacts/epics.md:1074-1076].

**Out of scope**: any change under `packages/web/src/` (StatsView shipped and merged via PR #58 —
this story ASSERTS it; if a component change seems necessary, a real 9.2 defect was found → record
it, do NOT silently patch the harness to match); `packages/shared`; production backend code
(`src/app.ts`, services, repositories); the existing 4 spec files (`chat/docs/interactions/search
.spec.ts` — ZERO edits); `playwright.config.ts`; `helpers/session.ts`; any migration/DDL; the
9.2-deferred *product* fixes (name-span truncation, `statsInitials` emoji degradation — they stay
in `deferred-work.md`; this story seeds short, non-emoji names so they are not exercised).

**Critical context — what 9.2 already did and explicitly left here**: on `main @ 23cdbe3` (PR #58
merged) the StatsView renders all 5 blocks and the 16 existing chromium specs pass unchanged, but
9.2's completion notes named exactly what jsdom could NOT verify and handed it to this story:
computed styles (fonts, gradients, grid geometry) for `stats-kpi-card`, `stats-activity-chart`/
`stats-activity-bar`, `stats-channel-row`, `stats-coverage-donut`/`stats-coverage-legend`,
`stats-top-user-row` — "Story 9.3 owns the permanent Playwright harness coverage (with a real
author-name seed for the Top-5 section)" [Source: 9-2-…md:209]. 9.5 declared the same downstream:
"9.3 seeds `author_name` + asserts order/exclusion in Playwright". **This story writes tests and
seed rows, not features.**

## Design decisions D1–D8 (ratified defaults — veto at review, do not re-litigate mid-implementation)

- **D1 — New spec file is `analytics.spec.ts`, NOT `stats.spec.ts`.** Playwright discovers spec
  files alphabetically with `workers: 1` (tests/README.md); the current order is `chat → docs →
  interactions → search`, and `chat` (streaming test) MUTATES `conversations` (+1 user message →
  the `queries` KPI) while `docs` (bubbling + mark-all) MUTATES `user_read_status` (coverage
  becomes 5/5/100). A `stats.spec.ts` would sort LAST and read post-mutation state that diverges
  from a standalone run (fresh backend boot = fresh reseed). `analytics.spec.ts` sorts FIRST
  (`a < c`), so every assert binds to seed-fresh figures (coverage 2/5/40, queries 1) identically
  in full-suite and standalone runs. The name is legitimate — Épico 9 is titled "Estadísticas del
  Conocimiento (Analytics)". All its tests are non-mutating (logins only), so no later spec is
  affected. Record the ordering rationale in `tests/README.md` (Task 5).
- **D2 — Partial `author_name` seeding (the no-backfill reality, live).** Add `author_name` ONLY
  to the LATEST message of each author: `e2e-msg-r1` → `'Linus Torvalds'`, `e2e-msg-r2` →
  `'Ada Lovelace'`; `g1/g2/g3` stay NULL. Why partial: (1) `search.spec.ts:67-68` asserts the top
  card avatar initials `'E2'` derived from `'e2e-author-ada'` — g1's fragment must keep resolving
  to the raw author_id (COALESCE tier 3), or an existing spec breaks (this story edits NO existing
  spec); (2) the 9.5 topUsers name pick is *latest scoped non-blank* `author_name` per author —
  r2 (2026-06-05) is ada's latest and r1 (2026-06-04) is linus's latest, so BOTH Top-5 rows show
  real names while the mixed NULL/named rows prove the COALESCE tier-1-vs-tier-3 degradation
  end-to-end (exactly the post-9.4 no-backfill production shape). Search/Docs cards for r1/r2 will
  now show the real names — verified unasserted (no existing assertion binds to them).
- **D3 — RBAC canary trio: denied channel + message + embedding.** New channel
  `e2e-ch-secreto` (name `secreto`, `allowed_roles ['e2e-role-none']` — held by NO fake-OAuth
  identity), message `e2e-msg-s1` (author `e2e-author-eve`, `author_name 'Eve Intrusa'`,
  `created_at` = seed-boot `new Date().toISOString()` — "today"), embedding `e2e-msg-s1:0`
  (anchor s1, `created_at` today, `unitVector(0.9)`; a UTC-midnight crossing between seed boot
  and test run changes nothing — every member assert on it is a zero/absence). One denied row
  discriminates ALL five
  blocks: a leak flips resources 5→6 (+sub `+0`→`+1 esta semana`), channels KPI 2→3 + a
  `#secreto` row, authors 2→3, activity total 0→1 + a tall today bar, coverage footer 5→6 docs
  (readPct 40→33), and a 3rd topUsers row `Eve Intrusa`. The pinned non-leak values in AC3–AC6
  ARE the canaries; AC6 adds explicit absence asserts. `e2e-empty` is unaffected (role mismatch —
  its search empty state stays reachable), and every new id keeps the `e2e-` prefix so
  `resetAndSeed`'s cleanup covers it.
- **D4 — Conversation timestamps go relative (defuses a time bomb).** The seeded conversation is
  hardcoded at `2026-07-01T09:00:00Z`; the `queries` KPI counts user-role messages in the last
  30 days, so the KPI silently drops 1→0 after 2026-07-31 and any exact assert would rot. Change
  `CONVERSATION_CREATED_AT/UPDATED_AT` to seed-boot-relative (`now − 5 days`, `+5s` for the
  reply). Verified safe: chat.spec asserts only the derived title text and message/citation
  content, never dates. This makes `queries: 1` durable.
- **D5 — Activity stays all-zero; do NOT re-date the 5 existing embeddings.** Their fixed June
  dates sit outside the 14-day window, so all 14 bars render as 4px min-height stubs with the
  today-gradient on the last one — deterministic forever. Re-dating would ripple into the
  Documentos ordering and date cells the 4.4/7.6/8.1 specs sit on. Proportional bar *geometry* is
  still exercised where the seed has real ratios: channel fills (100%/67%) and top-user fills
  (100%/67%). Value-level activity math is 9.1 integration's job; the harness asserts the render.
- **D6 — Assertion mechanics.** Colors/gradients/fonts/sizes via `toHaveCSS` (computed): vars
  resolve to dark-theme `rgb(...)`, hex gradients serialize as
  `linear-gradient(180deg, rgb(255, 203, 107), rgb(245, 166, 35))`. Proportional fill WIDTHS via
  the inline style attribute (`toHaveAttribute('style', /width: 67%/)`) — React writes the exact
  `Math.round` percentage; computed px would bind to viewport-derived track widths (brittle). The
  donut's `conic-gradient` computed serialization is Chromium-defined — assert with a regex
  (`/conic-gradient\(rgb\(245, 166, 35\) 40%/`) and calibrate the exact tail on the first live
  run (7.6 precedent: values verified against Chromium on first run; if a serialization quirk
  appears, document it and assert the meaningful properties, never delete the assertion). Zero
  bars: `min-height 4px` + `height '0%'` → computed `height` is exactly `'4px'`.
- **D7 — Seven tests in the one new file, all non-mutating** (final e2e count 16→23: analytics 7 /
  chat 7 / docs 4 / interactions 2 / search 3): (1) nav entry + active state + view mounts;
  (2) header + KPI cards; (3) activity chart; (4) channels + coverage donut; (5) top users +
  RBAC absence canaries; (6) error state via `page.route('**/api/stats', …)` fulfilling a
  malformed body (`{}` → ZodError at the `.parse` edge → "Reintentá." copy; closes the 9.2-deferred
  real-parse-failure gap at the e2e level); (7) empty scope via `loginAs(page, 'e2e-empty')`.
  Do NOT assert `stats-loading` (transient → flake). Every test screenshots
  (`testInfo.outputPath(...)`, fullPage) per file convention.
- **D8 — Docs sync is `packages/web/tests/README.md` only.** Document the new spec, the D1
  ordering rationale (analytics reads mutation-sensitive per-user figures → must sort before
  chat/docs), and the seed additions. No `docs/*`, PRD, api-spec or data-model change (9.1/9.5
  synced the contract docs; the harness is documented in-tree). State this explicitly in the
  completion notes so review doesn't expect §3.5 beyond it.

## Acceptance Criteria

```gherkin
AC1  Given packages/backend/src/e2e/seed.ts, When the e2e backend boots, Then the seed carries:
     author_name 'Linus Torvalds' on e2e-msg-r1 and 'Ada Lovelace' on e2e-msg-r2 (g1/g2/g3 stay
     NULL — D2); the D3 canary trio (e2e-ch-secreto/'secreto'/['e2e-role-none'], e2e-msg-s1 by
     e2e-author-eve 'Eve Intrusa' dated seed-boot today, embedding e2e-msg-s1:0 dated today);
     and seed-relative conversation timestamps (now−5d / +5s, D4)
     And GET /api/stats for the member session returns exactly the JSON in Dev Notes §Expected
     responses (agent-verified via curl per §3.3 before writing specs)
     And the 16 pre-existing Playwright tests pass UNCHANGED — zero edits to the 4 existing
     spec files (git diff proves it).

AC2  Given the new packages/web/tests/analytics.spec.ts (D1 — sorts alphabetically before every
     mutating spec), When it runs with loginAs(page, 'e2e-member'), Then it asserts the 3rd
     sidebar nav entry: .kh-nav-item count 3, nth(2) has accessible name 'Estadísticas' with the
     18px line-chart SVG; after click it carries aria-current="page", background-color
     rgba(245, 166, 35, 0.12) and color ACCENT_INK; the view mounts (h2 'Estadísticas' Space
     Grotesk 600 25px --text-primary; intro p 14px --text-tertiary; inner container max-width
     1040px) — closing 9.2's deferred nav→StatsView mount coverage.

AC3  Given the KPI grid, Then exactly 4 [data-testid="stats-kpi-card"] render in data-kpi order
     resources→channels→authors→queries with seed-exact API-verbatim content — values 5/2/2/1,
     labels 'Recursos indexados'/'Canales'/'Autores'/'Tus consultas al agente', subs
     '+0 esta semana'/'de 2 accesibles'/'en tus canales'/'últimos 30 días' — and computed design
     truth on one card: value Space Grotesk 700 29px TEXT_PRIMARY; icon chip 32×32 border-radius
     9px, color ACCENT_INK, background rgba(245, 166, 35, 0.12); card SURFACE bg + BORDER border.

AC4  Given the activity section, Then stats-activity-chart contains exactly 14
     stats-activity-bar columns whose fills ALL compute height '4px' (zero stubs, D5); the LAST
     fill computes background-image linear-gradient(180deg, rgb(255, 203, 107), rgb(245, 166, 35))
     and every other fill computes background-color TRACK; the bar area computes height 180px;
     stats-activity-total reads '0 recursos · últimos 14 días' (IBM Plex Mono 11.5px TEXT_MUTED);
     the axis row reads 'hace 14 días' / 'hoy'.

AC5  Given the 2-up grid, Then 'Recursos por canal' renders exactly 2 stats-channel-row in API
     order: first '#general' (count '3', fill style width 100%), second '#random' (count '2',
     fill style width: 67%); channel names are mono 12.5px ACCENT_INK; fills compute
     linear-gradient(90deg, rgb(245, 166, 35), rgb(255, 203, 107)) on a 9px TRACK track. And
     'Cobertura de lectura' renders the 120×120 donut with conic-gradient at 40% (regex per D6),
     center '40%' (Space Grotesk 700 23px) + 'leído', legend rows 'Leídos · 2' (swatch
     rgb(245, 166, 35)) and 'Sin leer · 3' (swatch TRACK), footer '5 documentos en total'.

AC6  Given 'Top 5 · usuarios más activos', Then exactly 2 stats-top-user-row render in API order
     (count DESC): rank '1' → initials 'AL', name 'Ada Lovelace', count '3', fill width 100%;
     rank '2' → initials 'LT', name 'Linus Torvalds', count '2', fill width: 67%; avatars compute
     30×30 border-radius 50% with background-color rgb(245, 166, 35) (ada) and rgb(199, 146, 234)
     (linus) — the D4-9.2 hash precomputed in Dev Notes; fills compute
     linear-gradient(90deg, rgb(88, 101, 242), rgb(136, 145, 245)) on a 7px TRACK track.
     And RBAC exclusion is asserted explicitly: getByText('#secreto') and getByText('Eve Intrusa')
     each toHaveCount(0) page-wide, row counts pinned (2 channels / 2 top users) — combined with
     the AC3–AC5 pinned figures these are the D3 leak canaries.

AC7  Given degraded responses, Then (a) with page.route fulfilling GET /api/stats with a
     malformed 200 body ({}), the view shows stats-error 'No se pudieron cargar las estadísticas.
     Reintentá.' (real ZodError path); (b) logged in as e2e-empty, the view renders zeros:
     4 KPI values '0' (channels sub 'de 1 accesibles'), 14 stub bars, stats-channels-empty 'Sin
     datos en tus canales todavía.', stats-top-users-empty 'Sin autores todavía.', donut center
     '0%', footer '0 documentos en total', total '0 recursos · últimos 14 días'.

AC8  Gate (AGENT-run, §3.1/§3.4): npm run test:e2e -w @share2brain/web → 23 chromium green
     (analytics 7 / chat 7 / docs 4 / interactions 2 / search 3), ordering invariants preserved
     (docs mark-all and chat streaming stay their files' terminal mutations); npm run lint → 0;
     npm run test (unit+web) → unchanged; npm run build → clean (5 pkgs). Integration suite NOT
     run — no shared contract, production backend, or DDL change; seed.ts is imported only by
     src/e2e/server.ts (record this reasoning in Completion Notes; 7.6 precedent). git diff
     touches ONLY seed.ts, tests/analytics.spec.ts, tests/README.md (+ story/sprint tracking).
     Traceability: completion notes name each 9.2-deferred visual AC now asserted, and which
     deferred items remain (Dev Notes §Deferred traceability).
```

## Tasks / Subtasks

- [x] Task 0 — Branch + baseline (AC: all)
  - [x] `git switch -c feat/9-3-e2e-stats-harness` off `main` @ `23cdbe3`.
  - [x] Preconditions: `docker compose up -d postgres redis` (Homebrew Redis for local :6379 —
        two-Redis gotcha), OPS-2: app containers stopped, `npx drizzle-kit migrate` applied,
        chromium installed. Baseline `npm run test:e2e -w @share2brain/web` → **16 passed** pre-change.
- [x] Task 1 — Seed extension (AC1)
  - [x] `MessageSpec` gains `authorName?: string`; the discord_messages INSERT (seed.ts:156-161)
        gains the `author_name` column (`${m.authorName ?? null}`). Set D2 names on r1/r2 only.
  - [x] Append the D3 trio: `CHANNELS` + `e2e-ch-secreto`, `MESSAGES` + `e2e-msg-s1` (Spanish
        content, e.g. 'Mensaje en canal privado fuera de tu alcance.'), `EMBEDDINGS` +
        `e2e-msg-s1:0` (Spanish title/description, link `https://example.com/e2e/canal-secreto`,
        `unitVector(0.9)`). Today-dates via a module-level `const SEED_NOW = new Date()` so
        message and embedding share one clock.
  - [x] D4: derive `CONVERSATION_CREATED_AT/UPDATED_AT` from `SEED_NOW` (−5 days / −5 days +5s).
  - [x] Update the seed header comment (dataset description) for the 9.3 additions; keep every
        new id `e2e-`-prefixed (cleanup + the 4.2 broad-LIKE lesson).
  - [x] Smoke per §3.3: boot `npm run e2e:server -w @share2brain/backend`, acquire a member session with
        a curl cookie jar directly against :3100 (`curl -c jar -sD- http://127.0.0.1:3100/api/auth/login`
        → extract `state` from the Location header → `curl -b jar -c jar
        '.../api/auth/callback?code=e2e-member&state=<state>'` → `curl -b jar .../api/stats`; the
        helpers/session.ts flow is Playwright-mediated, don't try to reuse it), and diff the JSON
        against Dev Notes §Expected responses. Paste it in the Dev Agent Record.
- [x] Task 2 — `analytics.spec.ts`: nav + KPIs + activity (AC2, AC3, AC4)
  - [x] New file with the dark-token constants it needs (copy exact rgb from neighbors, D6 table
        in Dev Notes) and `test.describe('Story 9.3 — Estadísticas visual harness')`.
  - [x] Test 1 nav (AC2), Test 2 KPIs (AC3), Test 3 activity (AC4) — selectors per Dev Notes
        §Selector map; screenshots each.
- [x] Task 3 — channels + donut + top users (AC5, AC6)
  - [x] Test 4 (AC5) and Test 5 (AC6 incl. the absence canaries).
- [x] Task 4 — degraded states (AC7)
  - [x] Test 6 error: `await page.route('**/api/stats', (route) => route.fulfill({ status: 200,
        contentType: 'application/json', body: '{}' }))` BEFORE clicking the nav entry.
  - [x] Test 7 empty scope: `loginAs(page, 'e2e-empty')` → nav → zeros per AC7(b).
- [x] Task 5 — Gate + docs + wrap-up (AC8, D8)
  - [x] Full e2e run → 23 green; verify counts per file and that existing specs are byte-identical.
  - [x] `npm run lint` && `npm run test` && `npm run build` — paste outputs. Integration skipped
        with recorded reasoning.
  - [x] `tests/README.md`: (a) REWRITE the stale order line (README:77 currently lists
        `chat → docs → search`, already omitting interactions) to the full 5-file order
        `analytics → chat → docs → interactions → search` + the D1 rationale; (b) update the
        seed-identities table (README:64-67 — member row still says "5 embeddings"; note the
        invisible secreto trio and the r1/r2 author names); (c) one sentence on cross-RUN
        sensitivity: analytics figures are seed-fresh (queries 1, coverage 40) — every suite run
        needs a fresh backend boot/reseed; a manually kept-alive `e2e:server` from a prior run
        will fail it (same failure mode chat.spec's `toHaveCount(1)` already has).
  - [x] Completion Notes: deferred-AC traceability (§Deferred traceability), integration-skip
        reasoning, D8 no-docs-sync statement. Commit in slices (suggested: `test(backend): extend
        e2e seed with stats fixtures` / `test(web): add Estadísticas visual harness spec` /
        `docs(web): document analytics spec ordering in e2e README`), PR, sprint-status → review,
        hand off to `bmad-code-review`. Note: FINAL Epic 9 story — after review, epic-9 → done.

## Dev Notes

### Expected responses (the exact JSON the asserts bind to — verify via Task 1 smoke)

`GET /api/stats` as **e2e-member** (fresh seed; analytics.spec runs before any mutation, D1):

```jsonc
{
  "kpis": [
    { "key": "resources", "label": "Recursos indexados", "value": 5, "sub": "+0 esta semana" },
    { "key": "channels",  "label": "Canales",            "value": 2, "sub": "de 2 accesibles" },
    { "key": "authors",   "label": "Autores",            "value": 2, "sub": "en tus canales" },
    { "key": "queries",   "label": "Tus consultas al agente", "value": 1, "sub": "últimos 30 días" }
  ],
  "activity": [ /* 14 × { date: 'YYYY-MM-DD', count: 0 } — June seed dates are outside the window */ ],
  "channels": [
    { "channelId": "e2e-ch-general", "channelName": "general", "count": 3 },
    { "channelId": "e2e-ch-random",  "channelName": "random",  "count": 2 }
  ],
  "coverage": { "readCount": 2, "totalCount": 5, "readPct": 40 },
  "topUsers": [
    { "authorId": "e2e-author-ada",   "authorName": "Ada Lovelace",   "count": 3 },
    { "authorId": "e2e-author-linus", "authorName": "Linus Torvalds", "count": 2 }
  ]
}
```

Derivations: ada anchors g1+g3+r2 = 3, linus g2+r1 = 2; topUsers names = latest scoped non-blank
`author_name` (ada's latest = r2 'Ada Lovelace', linus's = r1 'Linus Torvalds' — D2); readPct =
round(2/5×100) = 40; queries = the 1 seeded user message (D4 keeps it inside the 30d window).
`e2e-msg-s1`/secreto appears NOWHERE (AD-12 in-SQL scoping) — that absence is the AC6 canary.

As **e2e-empty**: kpis values 0/0/0/0 with subs `+0 esta semana` / `de 1 accesibles` (its scope is
the 1 void channel) / `en tus canales` / `últimos 30 días`; activity 14×0; `channels: []`;
coverage 0/0/0; `topUsers: []`.

### Precomputed Chromium values (dark theme — loginAs forces it)

Token constants for the new file (copy verbatim; they are global.css :root dark values):
`ACCENT_INK = 'rgb(245, 166, 35)'` · `TEXT_PRIMARY = 'rgb(230, 233, 239)'` ·
`TEXT_TERTIARY = 'rgb(154, 163, 178)'` · `TEXT_MUTED = 'rgb(124, 132, 148)'` ·
`TEXT_SUBTLE = 'rgb(100, 108, 124)'` · `SURFACE = 'rgb(18, 22, 29)'` ·
`BORDER = 'rgb(32, 38, 47)'` · `TRACK = 'rgb(34, 41, 52)'` (#222934 — first use in the harness).

- Gradients (computed `background-image`): activity today
  `linear-gradient(180deg, rgb(255, 203, 107), rgb(245, 166, 35))`; channel fill
  `linear-gradient(90deg, rgb(245, 166, 35), rgb(255, 203, 107))`; top-user fill
  `linear-gradient(90deg, rgb(88, 101, 242), rgb(136, 145, 245))` (#5865F2→#8891F5); donut —
  expected full serialization `conic-gradient(rgb(245, 166, 35) 40%, rgb(34, 41, 52) 0%)` (the
  `0`→`0%` normalization is the quirk to expect); start the D6 regex from this candidate and
  calibrate on first run.
- KPI icon chip `background-color` computes `rgba(245, 166, 35, 0.12)` (alpha preserved).
- Percent math is `Math.round((count / max) * 100)` in all three bar groups (StatsView.tsx:244,
  297, 420): 2/3 → **67** → inline `width: 67%`; max row → `width: 100%`. Assert via style
  attribute (D6), e.g. `await expect(fill).toHaveAttribute('style', /; width: 67%/)` (the `; `
  anchor keeps it from ever matching a future `min-width`).
- Avatar hash (StatsView.tsx:44-48): charCode sum of `authorId` % 6 over
  `['#F2A03D','#5BC0DE','#C792EA','#57C98A','#EE6C8A','#F5A623']`. Precomputed:
  `'e2e-author-ada'` sum 1295 → index 5 → `#F5A623` = **rgb(245, 166, 35)**;
  `'e2e-author-linus'` sum 1556 → index 2 → `#C792EA` = **rgb(199, 146, 234)**.
- Initials (StatsView.tsx:51-55): split on `[_- ]+` → `'Ada Lovelace'` → **AL**,
  `'Linus Torvalds'` → **LT** (uppercased first chars of first two parts).
- Zero activity bars: fill has inline `height: '0%'` + `minHeight: 4` → computed
  `height` = `'4px'` for ALL 14 (a leak makes the last one tall — canary).
- Fonts as regex like the neighbors: `/Space Grotesk/`, `/IBM Plex Mono/`; sizes serialize
  `'25px'`, `'29px'`, `'23px'`, `'12.5px'`, `'11.5px'`, `'10.5px'`.

### Selector map (StatsView has testids on rows/sections, NOT on fills/avatars/titles)

Testids (StatsView.tsx): `stats-loading` (do not assert — transient), `stats-error`,
`stats-kpi-card` ×4 with `data-kpi` attr, `stats-activity-chart`, `stats-activity-total`,
`stats-activity-bar` ×14 (the OUTER flex column; its only child div is the colored fill),
`stats-channels-empty`, `stats-channel-row` (children: name/count line div + track div > fill
div), `stats-coverage-donut` (the conic circle; center hole + `{readPct}%`/`leído` are
descendants), `stats-coverage-legend`, `stats-top-users-empty`, `stats-top-user-row` (children:
rank span, avatar div, right block with name/count + track > fill).

- Nav buttons have NO testid: `page.locator('.kh-nav-item')` (exactly 3) / `getByRole('button',
  { name: 'Estadísticas' })`; active state on the button (`aria-current="page"`,
  `background-color rgba(245, 166, 35, 0.12)`, `color` ACCENT_INK — components.css:43-47). The
  icon: `navButton.locator('svg')` + `toHaveAttribute('width', '18')` (it is `aria-hidden`, no
  testid/class — the width ATTRIBUTE is the clean discriminating assert; icons.tsx:171-188).
- KPI order: `const cards = page.getByTestId('stats-kpi-card')` → `cards.nth(i)` +
  `toHaveAttribute('data-kpi', …)`; content via `cards.nth(i).getByText(…)`.
- Fills: `bar.locator('div')` (activity), `row.locator('div div')` / scoped `.last()` for
  channel/top-user tracks — anchor on the row testid first, never page-wide.
- The 180px bar area (AC4) has no testid: reach it as
  `page.getByTestId('stats-activity-bar').first().locator('..')` (the columns' direct parent) —
  do not invent a page-wide `div` chain.
- Avatars: `row.getByText('AL', { exact: true })` (the search.spec:68 idiom).
- Section titles are `h3` text — 'Actividad de indexado', 'Recursos por canal', 'Cobertura de
  lectura', 'Top 5 · usuarios más activos'; header `h2` 'Estadísticas';
  `getByRole('heading', …)` disambiguates from the nav button label.
- Legend rows: span text is `'Leídos · 2'` / `'Sin leer · 3'` (value inside a nested `<strong>`
  TEXT_PRIMARY; row 13px `--text-secondary`; swatch = first child span 11×11 radius 3).
- Container: assert `max-width 1040px` on the inner div (e.g. the h2's parent via `locator('..')`).

### Architecture / harness constraints

- **AD-3**: the harness runs the BUILT SPA against the deterministic e2e backend — that is the
  point (jsdom resolves no custom properties; 9.2's unit tests asserted inline-style strings only).
- **AD-2**: web never imports backend; the seed lives in `packages/backend/src/e2e/` and is
  exercised via HTTP. **AD-12**: RBAC is in-SQL — the canary asserts (AC6) verify it end-to-end.
- **§3.4** (bmad-story-mandatory-steps): this story IS the §3.4 obligation 9.2 deferred by name.
  §3.3 smoke for the seed change (Task 1). English-only code/comments/commits; asserted UI strings
  and seed display data are Spanish (product copy) — assert them verbatim.
- Harness conventions: `@playwright/test` `toHaveCSS`/`toHaveAttribute` (auto-retry); scoped
  locators; screenshot per test; `loginAs(page, code)` from `helpers/session.ts` (forces dark
  theme BEFORE first navigation) — reuse, do not add helpers; `workers: 1`; viewport 1280×720.
- Discrimination DoD (operational-backlog): every new assertion must FAIL against a plausible
  regression — sanity-check each against (a) the pre-9.2 render (no stats view), (b) an RBAC leak
  (D3 figures flip), (c) a token/cascade regression (computed color changes). No tautologies
  (e.g. don't assert `width: 100%` alone on the max bar — pair it with the 67% sibling).

### Deferred traceability (write this mapping into the Completion Notes)

Closed here (9.2 deferrals → this story): computed-style truth for all 6 named testid groups
(9-2-…md:209) → AC2–AC6; nav→StatsView mount coverage (deferred-work.md:212) → AC2; real
author-name Top-5 seed + order/exclusion (epics.md:1074-1076, 9.5 handoff) → AC1/AC6; real
parse-failure (ZodError) path → AC7(a) at the e2e level.
Stays deferred (do NOT close): name-span truncation product fix (deferred-work.md:210 — this
story seeds short names; the design call remains open); `statsInitials` emoji/separator
degradation (D4-pinned algorithm); unit-level gaps that stay unit-level (`readPct===100` donut,
channel row with `count===0`, single-part alphabetic initials).

### Previous-story intelligence (7.6 + 9.2 + 4.5)

- **7.6 lesson 1 — dynamic locators**: anchor rows on stable identity, not on state that your
  assert changes. Nothing here mutates, but the same trap exists with `getByText` on duplicated
  text ('Estadísticas' = nav label AND h2 — use roles).
- **7.6 lesson 2 — Chromium computed-value quirks are real**: `display: -webkit-box` computed as
  `flow-root`. Expect the same class of surprise on `conic-gradient` serialization (D6): verify
  live, substitute the meaningful property, document — never delete.
- **9.2 environment gotcha**: a stale `e2e:server` on :3100 was once reused by
  `reuseExistingServer` and served a stale response — if the view inexplicably errors or misses
  a block on first run, kill leftover processes on :3100/:4173 before debugging.
- **4.5**: the harness exists to catch real regressions (it found a 4.3 focus-ring defect) —
  keep assertions strict; do not soften to green.
- **Two Redis instances** (memory): localhost:6379 is Homebrew Redis; compose Redis publishes no
  ports — the e2e backend needs the local one running.

### Do-NOT-touch look-alikes

`packages/web/src/**` (StatsView/Sidebar/AppLayout/components.css/global.css) · the 4 existing
spec files · `playwright.config.ts` · `helpers/session.ts` · `packages/shared/**` · production
backend (`app.ts`, statsService/statsRepository) · integration suites and their fixtures ·
migrations · `Share2Brain.config.yml` · `deferred-work.md` product entries (traceability notes only).
If an assertion cannot pass without editing a non-seed, non-test file, STOP: wrong selector
(fix the test) or a real 9.2 regression (record + surface it, don't patch product code here).

### Git intelligence

Main @ `23cdbe3` (PR #58 merged — 9.2 StatsView; feature e5a35f2, tests af86ecc, review patch
3525689). Working tree clean. Branch: `feat/9-3-e2e-stats-harness`. All five Epic 9 siblings
done; this is the last one.

### Project Structure Notes

- New file: `packages/web/tests/analytics.spec.ts`.
- Modified: `packages/backend/src/e2e/seed.ts` (seed extension only), `packages/web/tests/README.md`.
- Nothing else (plus story/sprint tracking). The seed change compiles under the backend
  workspace — `npm run build` covers it; no unit test imports it.

### References

- [Source: _bmad-output/planning-artifacts/epics.md:1048-1103 — Épico 9, Historia 9.3 bullet,
  KPI ratification, Top-5 note]
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10-stats.md:124-131 —
  base 9.3 ACs] + [sprint-change-proposal-2026-07-10-topusers.md:107-118 — Top-5 e2e extension]
- [Source: _bmad-output/implementation-artifacts/9-2-…md:150-152 (testids), :209 (deferred by
  name), :219-221 (review defers routed here)] + [deferred-work.md:208-212]
- [Source: _bmad-output/implementation-artifacts/7-6-…md — the e2e-story pattern this follows:
  ordering invariants, discrimination DoD, first-run calibration, tests-only discipline]
- [Source: packages/web/src/components/StatsView.tsx:42-55 (avatar/initials algos), :227-259
  (activity), :284-321 (channels), :327-404 (coverage), :406-477 (top users)] +
  [Sidebar.tsx:66-70,93-108; components.css:32-47 (nav)] + [api/stats.ts:8-12 (.parse edge)]
- [Source: packages/backend/src/e2e/seed.ts (all constants + resetAndSeed FK order) +
  src/e2e/server.ts:34-66 (fake OAuth, createApp)] + [app.ts:227-234 (stats route mounted)]
- [Source: packages/backend/src/application/services/statsService.ts (KPI literals, 14d/7d/30d
  windows) + infrastructure/statsRepository.drizzle.ts:154-183 (topUsers SQL, name pick)]
- [Source: packages/web/tests/README.md (boot, Redis, alphabetical-order invariant) +
  playwright.config.ts (workers:1, ports, webServers)]
- [Source: docs/bmad-story-mandatory-steps.md §3.1/§3.3/§3.4; docs/context/ARCHITECTURE-SPINE.md
  AD-2/AD-3/AD-12]

## Change Log

- 2026-07-10 — Story created via `bmad-create-story` (ultimate context engine analysis completed —
  comprehensive developer guide created). Sources: epics.md §Épico 9 + both 2026-07-10 SCPs,
  9.2/9.5/7.6 story intelligence, full harness + seed + StatsView source analysis (2 parallel
  research subagents), precomputed Chromium-assertable values (avatar hash sums 1295/1556,
  Math.round bar percentages, gradient rgb serializations). 8 ratified defaults D1–D8 flagged for
  review — notably D1 (`analytics.spec.ts` name to sort before mutating specs), D2 (PARTIAL
  author_name seed to preserve search.spec's 'E2' assert while exercising COALESCE tiers), D3
  (denied-channel canary trio discriminating all five blocks), D4 (relative conversation dates —
  defuses the 2026-07-31 queries-KPI time bomb), D5 (activity stays all-zero; no re-dating).
  Fresh-context checklist validation: 0 critical (every seed derivation, verbatim literal, hash
  sum and cited line survived source verification), 6 enhancements applied (curl cookie-jar smoke
  guidance; README stale-order-line + identities-table rewrite + cross-run seed-fresh note; donut
  serialization candidate pinned; 180px bar-area locator; nav-icon width-attribute assert) + 3
  optimizations (css:43-47 cite, SEED_NOW midnight parenthetical, `; width:` regex anchor).
  Status: ready-for-dev.

- 2026-07-10 — Story implemented via `bmad-dev-story` on branch
  `feat/9-3-e2e-stats-harness` off `23cdbe3`. Seed extended (D1–D4) and
  `analytics.spec.ts` written with the 7 tests exactly per D7. All 8 ACs
  satisfied; gate green (23 e2e / lint 0 / 892 unit+web / build clean, 5 pkgs).
  Status: review.

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5).

### Debug Log References

**Task 0 — baseline**: `npm run test:e2e -w @share2brain/web` on `main @ 23cdbe3` →
**16 passed** (13.8s). Infra: Homebrew Redis confirmed running (`redis-cli
PING` → `PONG`), no stale `:3100`/`:4173` processes, app containers
(backend/bot/workers/nginx) stopped per OPS-2 (postgres/redis kept up),
`npx drizzle-kit migrate` → up to date.

**Task 1 — §3.3 seed smoke** (curl cookie-jar against a manually-booted
`npm run e2e:server -w @share2brain/backend` on :3100):

- `e2e-member` `GET /api/stats` returned, byte-for-byte, the exact JSON in Dev
  Notes §Expected responses: `kpis` 5/2/2/1 with the exact labels/subs,
  `activity` 14×0, `channels` `[{general,3},{random,2}]`,
  `coverage {2,5,40}`, `topUsers [{Ada Lovelace,3},{Linus Torvalds,2}]`. No
  `secreto`/`Eve Intrusa` leak anywhere in the payload.
- `e2e-empty` `GET /api/stats` returned all-zero kpis (`channels` sub `de 1
  accesibles`), `channels: []`, `coverage {0,0,0}`, `topUsers: []` — matches
  Dev Notes §Expected responses exactly.
- Manually-started `e2e:server` process killed before running Playwright
  (avoids the 9.2 stale-process gotcha).

**Task 2/3/4 — first live run of `analytics.spec.ts` standalone** (`npx
playwright test tests/analytics.spec.ts`): 6/7 passed on the first try; 1
failure — the D6-predicted Chromium serialization quirk materialized exactly
as flagged: the activity chart's last-bar `background-image` computed as
`linear-gradient(rgb(255, 203, 107), rgb(245, 166, 35))`, dropping the
`180deg` direction entirely (Chromium omits the default "to bottom" direction
from the serialized value, it does not echo it back). Fixed by asserting the
color-only regex (documented inline, per the 7.6 precedent — verify live,
assert the meaningful property, never delete the check). Re-run: 7/7 green.
Every other precomputed value (avatar hashes, KPI/channel/top-user/donut
figures, gradients, fonts, sizes) matched on the first try with zero
adjustment.

**Task 5 — full gate**: `npm run test:e2e -w @share2brain/web` → **23 passed**
(17.2s) — analytics 7 / chat 7 / docs 4 / interactions 2 / search 3; ordering
invariants held (docs "mark all read" and chat streaming stayed their files'
terminal mutations). `git diff --stat` confirmed zero changes to the 4
existing spec files, `playwright.config.ts`, `helpers/session.ts`, and all of
`packages/web/src` (do-not-touch list, verified empirically not just
asserted). `npm run lint` → 0 problems. `npm run test` → 892 passed / 1
skipped (unchanged from the 9.2 baseline). `npm run build` → all 5 packages
clean (backend/bot/shared/workers tsc --noEmit, web vite build).

### Completion Notes List

- **AC1–AC8 all satisfied.** Full traceability to the 9.2 deferrals (per Dev
  Notes §Deferred traceability):
  - Computed-style truth for all 6 named testid groups (9-2 deferred by
    name) → closed by AC2 (nav/heading/intro/container), AC3 (KPI card
    typography/icon chip/chrome), AC4 (activity bars/gradient/total),
    AC5 (channel rows/fills/donut/legend), AC6 (top-user rows/avatars/fills).
  - Nav → StatsView mount coverage (deferred-work.md) → closed by AC2.
  - Real author-name Top-5 seed + order/exclusion (epics.md 9.3 bullet, 9.5
    handoff) → closed by AC1 (seed) + AC6 (order + RBAC absence canary).
  - Real parse-failure (ZodError) path at the e2e level → closed by AC7(a).
  - **Stays deferred, NOT closed here** (by design, per the story's Out-of-
    scope + Dev Notes §Deferred traceability): name/channelName span
    truncation product fix (deferred-work.md — still seeds short names, so
    still unexercised); `statsInitials` emoji/separator degradation
    (D4-pinned algorithm, cosmetic); unit-level gaps that stay unit-level
    (`readPct===100` donut, `count===0` channel row, single-part alphabetic
    initials).
- **Integration suite NOT run** — no `packages/shared` contract change, no
  production backend code change, no DDL/migration. `seed.ts` is imported
  only by `src/e2e/server.ts` (never by `main.ts` or any integration test
  fixture), so the seed extension has zero reach into the integration
  suites. Same reasoning precedent as Story 7.6.
- **D8 — no `docs/*` sync.** This story's only documentation change is
  `packages/web/tests/README.md` (spec-discovery order + seed-identities
  table + RBAC-canary note). No PRD/api-spec/data-model/ARCHITECTURE-SPINE
  edit — 9.1 and 9.5 already synced the `/api/stats` contract docs; this
  story only adds test/harness coverage over the existing contract.
- **Discrimination DoD**: every new bar-fill/channel-fill/top-user-fill
  assertion is paired with its sibling (100% max row asserted alongside the
  67% row, in both the channels and top-users sections) so no assertion is a
  tautology against a broken-width regression. The AC6 absence canaries
  (`#secreto` / `Eve Intrusa` both `toHaveCount(0)` page-wide) are combined
  with the AC3–AC6 pinned figures (5/2/2/1, 2/5/40, 2 channels, 2 top users)
  as the RBAC leak detector — a leak in any of the 5 blocks flips at least
  one of these.
- **Git diff scope**: touches only `packages/backend/src/e2e/seed.ts` (D1–D4
  additions), `packages/web/tests/analytics.spec.ts` (new file, 7 tests),
  `packages/web/tests/README.md` (D8 docs sync), plus story/sprint tracking.
  Zero production code changed under `packages/web/src`, `packages/shared`,
  or backend application/domain/infrastructure code.

### File List

- `packages/backend/src/e2e/seed.ts` — modified (D1 `authorName?` field on
  `MessageSpec`; D2 `author_name` set on `e2e-msg-r1`/`e2e-msg-r2`; D3 RBAC
  canary trio `e2e-ch-secreto`/`e2e-msg-s1`/`e2e-msg-s1:0` behind a shared
  `SEED_NOW` clock; D4 conversation timestamps derived from `SEED_NOW`;
  header comment updated).
- `packages/web/tests/analytics.spec.ts` — new (7 tests: nav/mount AC2, KPI
  cards AC3, activity chart AC4, channels+donut AC5, top users + RBAC
  canaries AC6, error state AC7a, empty scope AC7b).
- `packages/web/tests/README.md` — modified (seed-identities table extended
  with the RBAC canary trio + `/api/stats` figures; spec-discovery order
  rewritten to the full 5-file alphabetical order with the D1 rationale).

### Review Findings

Code review 2026-07-10 (`bmad-code-review`): 3 adversarial layers (Blind Hunter,
Edge Case Hunter — full source access, Acceptance Auditor). Auditor verdict PASS
(AC1–AC8 + D1–D8 all conformant); Edge Case Hunter found 0 High/Medium after
source verification and refuted 2 of Blind Hunter's findings. 0 decision-needed,
0 patch, 2 defer, 7 dismissed.

- [x] [Review][Defer] Activity chart has no positive-path (non-zero data) coverage [packages/web/tests/analytics.spec.ts:305-307,486-488] — deferred, ratified by D5. Every activity-chart assertion binds to all-zero seed data (all 14 bars asserted `height 4px`); a regression that ignored its data array and always emitted 4px stubs would pass green. Ratified out of scope by D5 ("activity stays all-zero; value-level activity math is 9.1 integration's job — the harness asserts the render"); the shared `Math.round((count/max)*100)` bar-scaling IS exercised end-to-end via the channel (100%/67%) and top-user (100%/67%) fills, so only the activity-chart height mapping is uncovered at the e2e level.
- [x] [Review][Patch] APPLIED — Seed header comment "Only r1/r2 carry author_name" is factually wrong [packages/backend/src/e2e/seed.ts:18-20] — the `e2e-role-none` bullet states "Only `e2e-msg-r1`/`e2e-msg-r2` carry `author_name` … the rest resolve via COALESCE fallback to the raw `author_id`", but `e2e-msg-s1` (the D3 canary) also carries `authorName: 'Eve Intrusa'` and does NOT resolve via fallback. Comment-only inaccuracy (the README at tests/README.md:139-140 already scopes it correctly to ada/linus); reword to "Among the member-visible messages, only r1/r2 carry `author_name` (the out-of-scope canary `e2e-msg-s1` also carries one, deliberately, so the leak canary is meaningful)". Found in 2nd review pass (Blind Hunter). Zero-risk documentation fix.
- [x] [Review][Defer] `page.route('**/api/stats', …)` glob would miss a future query-string variant [packages/web/tests/analytics.spec.ts:460] — deferred, robustness. The AC7a error-state intercept uses `**/api/stats`, which Playwright anchors at the URL end — it matches `/api/stats` (the endpoint is param-free today, verified) but would silently NOT match `/api/stats?days=14`, letting the real backend response through and failing the error assertion. Not a current defect; future-proof with `**/api/stats*`. Found in 2nd review pass (Blind Hunter).
- [x] [Review][Defer] RBAC text canaries are narrower than the count-based canaries [packages/web/tests/analytics.spec.ts:449-450] — deferred, mitigated. `getByText('#secreto')`/`getByText('Eve Intrusa')` `toHaveCount(0)` implement AC6 verbatim but would miss a leak rendering the raw channel name (`secreto` without `#`) or the `author_id` COALESCE fallback (`e2e-author-eve`) instead of the display name. Mitigated on two fronts: (1) the count/figure assertions (KPI resources 5, 2 channel rows, 2 top-user rows, authors 2) are the primary leak discriminators per the discrimination DoD and flip on ANY leak; (2) given the seed, a real leak renders as `#secreto` (StatsView prefixes `#`) and `Eve Intrusa` (Eve has a non-null `author_name`), so the text canaries do catch the realistic leak. Optional hardening: add `secreto`/`e2e-author-eve` to the absence set.
