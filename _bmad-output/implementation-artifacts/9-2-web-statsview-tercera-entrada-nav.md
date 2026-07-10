---
baseline_commit: 10e071f2fe6bc76c162ee3c08657175d159d523a
---

# Story 9.2: web — StatsView + 3ª entrada de nav

Status: done

## Story

As a **community member using the Share2Brain web app**,
I want **a Statistics view reachable from a third sidebar nav entry, showing knowledge KPIs, 14-day indexing activity, per-channel volume, my read coverage, and the top 5 most active users**,
so that **I can see the pulse of the community's knowledge — what gets indexed, who participates, and how much the agent is consulted — scoped to the channels I can access**.

## Context

Final render slice of the Épico 9 layered sequence **9.1 (contract+endpoint, done) → 9.4 (author_name capture, done) → 9.5 (topUsers block, done, PR #57 merged) → (9.2 render · 9.3 e2e)**. Both prerequisites are merged to `main` (`10e071f`); the `StatsResponse` contract is stable with **five required blocks**. This story is `packages/web` ONLY: no shared/backend/bot/workers change, no e2e-harness/seed change (that is 9.3).

- Epic: `_bmad-output/planning-artifacts/epics.md` §Épico 9 (FR24/FR25; Historia 9.2 bullet incl. the Top-5 extension).
- SCPs: `sprint-change-proposal-2026-07-10-stats.md` (§4.3 Historia 9.2 ACs) + `sprint-change-proposal-2026-07-10-topusers.md` (§4.3 extends 9.2 with the Top 5 section).
- Design authority: `docs/context/design/Share2Brain Web.dc.html` (`isStats` screen). All values extracted below — **do not re-parse the 467KB mock**.

## Acceptance Criteria

```gherkin
AC1  Given the sidebar, When the app renders, Then a 3rd nav item "Estadísticas" appears after
     Búsqueda and Documentos (same kh-nav-item pattern: icon 18px stroke 1.8, active state
     rgba(245,166,35,0.12) bg + var(--accent-ink), aria-current="page" when active, no badge)
     And clicking it routes to StatsView via the existing AppLayout screen-branch (no router).

AC2  Given StatsView with a successful GET /api/stats response, Then it renders, in order inside
     a max-width 1040px container: header (h2 "Estadísticas" + intro), the 4 KPI cards grid,
     the "Actividad de indexado" 14-bar chart, the 2-up grid [per-channel bars | read-coverage
     donut], and the "Top 5 · usuarios más activos" section — per the isStats design values
     in Dev Notes (§Design spec).

AC3  Given the topUsers block (≤5 rows, possibly empty), Then each row renders rank (1..N),
     initials avatar, authorName, count, and a proportional bar; rows keep the API order
     (count DESC, authorId ASC — superRefine-pinned; the view never re-sorts)
     And a raw-snowflake authorName (pre-9.4 rows / non-OAuth authors) renders gracefully (D4).

AC4  Given types, Then every shape comes from z.infer of StatsResponseSchema imported from
     @share2brain/shared/schemas, parsed client-side in a new src/api/stats.ts (.parse at the edge);
     no stats shape is redefined in web (AD-6) and nothing imports the shared root barrel (AD-3).

AC5  Given rendering, Then bars and donut are plain flex/grid + CSS gradients
     (linear-gradient bars, conic-gradient donut) — no new dependency of any kind
     (packages/web/package.json deps unchanged: react, react-dom, @share2brain/shared).

AC6  Given the theme toggle, Then the view is correct in dark AND light: every UI color uses the
     --text-*/--surface/--border/--track tokens (mock var names translated per Dev Notes map);
     raw hex only for the sanctioned brand literals (#F5A623, #FFCB6B, #5865F2 gradient pair,
     rgba(245,166,35,0.12), avatar palette).

AC7  Given a degraded response, Then the view stays correct and crash-free:
     - empty scope (200 with zeros): KPI values 0 with API-provided subs ("+0 esta semana",
       "de 0 accesibles"), 14 stub bars (min-height 4px, no NaN widths/heights — divisors
       clamped per D6), channels [] and topUsers [] show inline empty lines, donut 0% "leído";
     - fetch/parse failure: error state "No se pudieron cargar las estadísticas. Reintentá."
       (SearchView pattern); loading state shows mono "Cargando estadísticas…".

AC8  Gate: npm run lint + web unit tests + npm run build green (agent-run, output pasted).
     The 16 existing Playwright e2e specs still pass unchanged (no spec edits expected — nav
     assertions are name-based). NEW stats visual/CSS assertions are deferred BY NAME to
     Story 9.3 (7.5→7.6 precedent), not silently passed. Integration suite not run — no
     shared/backend change (state this explicitly in Completion Notes).
```

## Tasks / Subtasks

- [x] Task 1 — Branch + API module (AC4)
  - [x] `git switch -c feat/9-2-web-statsview` off `main` @ `10e071f`.
  - [x] New `packages/web/src/api/stats.ts`: `fetchStats(signal?: AbortSignal): Promise<StatsResponse>` — same-origin `fetch('/api/stats', { credentials: 'include', signal })`, throw on `!res.ok`, `StatsResponseSchema.parse(await res.json())`. Header comment mirrors `api/search.ts` (browser-safe, `@share2brain/shared/schemas` only, AD-3).
- [x] Task 2 — Nav plumbing (AC1)
  - [x] `icons.tsx`: add `StatsIcon` (line-chart glyph from the mock: `M3 3v18h18` + `M7 14l3-4 3 3 4-6`, viewBox 24, `strokeWidth={1.8}` per the nav-icon convention comment).
  - [x] `Sidebar.tsx:10`: `export type Screen = 'search' | 'docs' | 'stats';`
  - [x] `Sidebar.tsx` `NAV_ITEMS`: append `{ screen: 'stats', label: 'Estadísticas', icon: <StatsIcon size={18} /> }` — active class/aria/hover come free from the map.
  - [x] `AppLayout.tsx:74-78`: binary ternary → 3-way branch mounting `<StatsView />`; add import. `App.tsx` needs no change.
  - [x] Refresh the now-stale header comments: `Sidebar.tsx:1-2` ("two nav items" → three) and `AppLayout.tsx:2-3` (screen list gains Estadísticas, 9.2).
- [x] Task 3 — StatsView skeleton: fetch + status states (AC2, AC7) — tests-first for the state machine
  - [x] New `packages/web/src/components/StatsView.tsx`. Container idiom: `flex:1; overflowY:'auto'; padding:'34px 40px 60px'` + inner `maxWidth: 1040; margin:'0 auto'` (NOTE: 1040, wider than Search 860 / Docs 980 — design-verbatim).
  - [x] `useEffect` fetch-on-mount with `AbortController` + `AbortError` early-return (SearchView.tsx:71-76 pattern); `type Status = 'loading' | 'done' | 'error'` (no idle — fetch fires immediately).
  - [x] Header: h2 "Estadísticas" (Space Grotesk 600 25px, letterSpacing -0.02em) + p intro "El pulso del conocimiento de la comunidad: qué se indexa, quién participa y cuánto se consulta al agente." (14px, `--text-tertiary`).
  - [x] Loading: "Cargando estadísticas…" mono 12px `--text-muted`; error: 14px `--text-tertiary` sentence per AC7.
- [x] Task 4 — KPI cards + activity chart (AC2, AC7)
  - [x] KPI grid + cards per §Design spec; label/value/sub straight from `kpis[i]` (D1), icon by `kpi.key` map (D1), value via `toLocaleString('es')` (D5).
  - [x] Activity: 14 columns from `activity` (already zero-filled, oldest→today); heights scaled to `Math.max(1, ...counts)` (D6); last bar amber gradient, rest `--track`; native `title` tooltip "N recursos" (D2); right label "`{sum} recursos · últimos 14 días`" (D2); endpoints row "hace 14 días"/"hoy".
- [x] Task 5 — Channels + coverage 2-up grid (AC2, AC7)
  - [x] Section title "Recursos por canal" (D2 rename); rows from `channels` in API order; `#` + channelName (may be a raw snowflake — render as-is); amber gradient fill scaled to `Math.max(1, maxCount)`; `[]` → inline empty line (D6).
  - [x] Donut: conic-gradient `#F5A623 {readPct}%, var(--track) 0`, 120px, inset-14px center painted `--surface`, center "{readPct}% / leído"; legend Leídos/Sin leer (sin leer = `totalCount - readCount`); footer "`{totalCount} documentos en total`". Subtitle "Documentos indexados que ya revisaste."
- [x] Task 6 — Top 5 usuarios (AC3)
  - [x] Full-width card "Top 5 · usuarios más activos"; rows from `topUsers` verbatim order; rank mono, 30px initials avatar (D4 initials + palette hash), name 13.5px `--text-primary`, count mono, blurple gradient bar `#5865F2→#8891F5` scaled to top row (D3, divisor clamped D6); `[]` → inline empty line (D6).
- [x] Task 7 — Unit tests + gate (AC7, AC8)
  - [x] New `StatsView.test.tsx` (DocsView.test.tsx skeleton: `vi.mock('../api/stats')`, typed fixtures, `should … (ACn)` names, `findByText` post-fetch, cleanup+clearAllMocks). Cover: happy render of all 5 sections w/ API-provided KPI labels/subs; order preserved (topUsers/channels rendered as delivered); snowflake authorName; empty-scope fixture (zeros + [] + no NaN in style widths/heights); error state; loading state; abort no-op. jsdom can't compute conic-gradient → assert the inline style string (8.1-documented workaround; robust computed coverage is 9.3's).
  - [x] Update `App.test.tsx` only if it breaks (it mocks the api modules the shell touches; StatsView never mounts on the default 'search' screen so no new mock should be needed — verify, don't assume). No Sidebar test file exists; nav coverage rides App tests.
  - [x] Gate: `npm run lint` + `npx vitest run --project web` (then full `npm run test`) + `npm run build`. Paste outputs. Baseline: 882 passed +1 skipped; expect + your new StatsView tests, 0 regressions.
- [x] Task 8 — E2E no-regression + manual verification (AC8)
  - [x] Run the existing 16 Playwright specs (`npm run test:e2e -w @share2brain/web` with test Postgres+Redis up, OPS-2: app containers stopped). All 16 must stay green with the 3rd nav item present. Do NOT add stats specs (9.3).
  - [x] Manual smoke via the deterministic e2e backend (`npm run e2e:server -w @share2brain/backend` + fake-OAuth + Vite preview proxy) — open the view in both themes, verify sections render with seeded data. If browser automation is unavailable, use the §3.4 fallback and flag every unverified visual AC in notes + PR.
- [x] Task 9 — Docs sync (documentation-standards)
  - [x] `epics.md`: UX-DR5 "Solo 2 ítems de navegación" → 3 ítems (Búsqueda, Documentos, Estadísticas); UX-DR6 "Nav vertical: 2 botones" → 3 botones (+ stats icon); ADD new **UX-DR24** describing the Estadísticas view (condensed §Design spec incl. D1–D6 resolutions, tagged *(Historia 9.2)*). NOT UX-DR23 — that number is taken by "Animaciones del sistema" (epics.md:135; 9.1-D10 collision discipline).
  - [x] `docs/context/TECHNICAL-DESIGN.md` §5.5: "Cuatro vistas principales" table → cinco (add Statistics row: 5 secciones, RBAC-scoped server-side, zero chart deps, Historia 9.2).
  - [x] `docs/frontend-standards.md` §Views & Components: table gains the Statistics row AND the intro line "Four primary views" → "Five primary views" (frontend-standards.md:126).
  - [x] `packages/web/src/styles/global.css:10-12`: extend the raw-hex policy comment with the 9.2-sanctioned literals (blurple gradient tail `#8891F5`, the 6-color avatar palette) — D3/D4 ratify the deviation, the comment must record it or review trips on it.
  - [x] No PRD/api-spec/data-model change (already synced by 9.1/9.5; PRD.md:409 already lists Statistics incl. top contribuidores).
- [x] Task 10 — Story wrap-up: File List + Completion Notes (explicitly: integration not run — web-only; new stats visual ACs deferred to 9.3 by name), commit slices (`feat(web): …` / `test(web): …` / `docs(…)`), PR, hand off to `bmad-code-review`.

## Dev Notes

### Ratified defaults (D1–D6) — flag any objection at review, do not re-litigate mid-implementation

- **D1 — KPI content comes from the API, never the mock.** The mock's KPI labels/subs (`Mensajes indexados / +312 esta semana / Canales activos / de 6 del guild / Consultas al agente / Usuarios activos / +7 vs mes previo`) are **pre-ratification placeholders**; "de 6 del guild" was explicitly rejected in 9.1 as a guild-size leak. Render `kpis[i].label/value/sub` verbatim. The service emits (order superRefine-pinned via exported `KPI_ORDER`): `resources`·"Recursos indexados"·"+N esta semana" / `channels`·"Canales"·"de N accesibles" / `authors`·"Autores"·"en tus canales" / `queries`·"Tus consultas al agente"·"últimos 30 días". Icon map keyed on `kpi.key` (mock glyphs, 17px, viewBox 24, fill none, stroke currentColor, strokeWidth 1.9, strokeLinecap+strokeLinejoin round) — verbatim paths so the mock never needs opening:
  - `resources` (speech-bubble): `M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z`
  - `channels` (hash): `M4 9h16M4 15h16M10 3L8 21M16 3l-2 18`
  - `authors` (users): `M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2` + `<circle cx="9" cy="7" r="4" />` + `M23 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11`
  - `queries` (spark): `M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2z`
- **D2 — De-"mensajes" the copy (post-Epic-7 pivot; 7.5-F4 precedent).** Mock says "Mensajes por canal", "N mensajes · últimos 14 días", tooltip "N mensajes" — the data is scoped non-deleted **embeddings (recursos)**. Render "**Recursos por canal**", "`{sum(activity)} recursos · últimos 14 días`", tooltip "`{count} recursos`". Section titles are frontend copy; KPI labels are not (D1).
- **D3 — Top-5 bars KEEP the mock's blurple gradient** (`linear-gradient(90deg,#5865F2,#8891F5)`). Unlike 8.1's blurple leftover, here it is semantically apt (Discord users) and deliberately distinct from the amber channel bars. Sanctioned literal.
- **D4 — Avatars are derived, not mapped.** The mock's per-username color map (`marina_dev:#F2A03D…`) is placeholder. Use a deterministic pick over the mock's 6-color palette `['#F2A03D','#5BC0DE','#C792EA','#57C98A','#EE6C8A','#F5A623']` by a simple hash of `authorId` (stable across renders). Initials per the mock rule: split `authorName` on `[_\- ]`, first char of first two parts uppercased; single part → first 2 chars. A raw snowflake yields its 2 leading digits — accepted graceful degradation (ratified in 9.4/9.5: no backfill).
- **D5 — Numbers via `toLocaleString('es')`** (mock-verbatim: `12.847`). Applies to KPI values, activity total, channel counts, top-user counts. Node 24 / browsers ship full ICU — safe in jsdom too.
- **D6 — Zero-safety.** Every proportional width/height divisor is clamped: `Math.max(1, maxValue)` (empty scope would otherwise yield `0/0 → NaN%`). `channels: []` / `topUsers: []` render an inline empty line inside the card (mono 12px `--text-muted`): "Sin datos en tus canales todavía." / "Sin autores todavía." — NOT the dashed empty-box pattern (these are sections inside cards, not whole-view empties). Donut at 0/0: `readPct` is already 0 from the API → full-track ring + "0% leído" + "0 documentos en total".

### Contract (shipped, main @ 10e071f) — `packages/shared/src/schemas/stats.ts`

Import: `import { StatsResponseSchema, type StatsResponse, type StatsKpi, … } from '@share2brain/shared/schemas'` (re-exported via `schemas/index.ts:14`; ESLint bans the root barrel/`db`/`config`/`providers` in web).

Five REQUIRED top-level keys:
- `kpis`: exactly 4, order pinned `resources·channels·authors·queries` (superRefine + exported `KPI_ORDER`; "consumers may index positionally"). Item `{ key: enum, label: min(1), value: int ≥0, sub: string }`.
- `activity`: exactly 14 `{ date: 'YYYY-MM-DD', count: int ≥0 }` — **UTC** days, oldest first, today (UTC) at index 13, zero-filled server-side. Don't recompute dates client-side; a local-midnight "today" can legitimately disagree with the UTC series (contract is UTC by design).
- `channels`: unbounded `{ channelId: min(1), channelName: string, count: int ≥0 }`, ordered `count DESC, channelId ASC` **by SQL (not schema)** — rely on it, never re-sort. `channelName` may equal the raw snowflake (COALESCE fallback).
- `coverage`: `{ readCount ≥0, totalCount ≥0, readPct int 0–100 }` — self-consistent (readCount clamped ≤ totalCount server-side; readPct = Math.round). `totalCount` equals the `resources` KPI value AND `/api/documents`' total (9.1-D4: donut and DocsView sidebar must agree — a mismatch on screen means a bug upstream, not something to patch in web).
- `topUsers`: `≤5` `{ authorId min(1), authorName min(1), count int ≥1 }`, order `count DESC, authorId ASC` superRefine-pinned. `[]` and <5 are legal. `authorName` never empty but MAY be a raw snowflake.

Endpoint: `GET /api/stats`, no params/body. Errors: 401 `{ error, code: 'AUTH_REQUIRED' }` (generic api gate); 500 `{ error: 'Internal error', code: 'INTERNAL' }`. **Empty scope is 200 with zeros, never an error** (KPIs 1–3 zero with subs "+0 esta semana"/"de 0 accesibles"/"en tus canales"; `queries` still runs per-user and can be nonzero; activity = 14 zero days; channels/topUsers `[]`; coverage 0/0/0). No 401-redirect plumbing in api modules — only `auth.ts` special-cases 401; other clients throw and views show the error state (follow that).

### Design spec (extracted from `isStats` — do NOT re-parse the mock)

**Token translation (mock → code)**: the mock uses `--tx*`; the codebase tokens are `--text-*` with IDENTICAL values: `--tx`→`--text-primary`, `--tx2`→`--text-secondary`, `--tx3`→`--text-tertiary`, `--tx4`→`--text-muted`, `--tx5`→`--text-subtle`. `--surface/--border/--track/--hover/--accent-ink/--on-accent` exist verbatim (`src/styles/global.css:19-30`). `--accent-ink` is amber `#F5A623` in dark but brown `#9A5B00` in light — use the var for text/icons, raw amber literals for fills/gradients.

- **Page**: view scrolls itself (`overflowY:auto`, padding `34px 40px 60px`), inner `maxWidth 1040`. Section order: header → KPI grid (`marginTop 24`) → activity (full-width, `marginTop 22`) → 2-up grid `repeat(auto-fit,minmax(300px,1fr)); gap 18px; alignItems:start` (channels | donut, `marginTop 22`) → Top 5 (full-width, `marginTop 22`).
- **Section-card recipe** (activity/channels/donut/top5): `padding:'22px 24px'; background:'var(--surface)'; borderRadius:16` + border `1px solid var(--border)`. Section titles: Space Grotesk 600 16px `--text-primary` (use `<h3>` with margin 0 — semantic HTML per standards; mock uses divs).
- **KPI grid**: `display:grid; gridTemplateColumns:'repeat(auto-fit,minmax(210px,1fr))'; gap:14`. Card: `padding:'18px 20px'`, radius 14, surface+border. Top row space-between: label 12.5px `--text-tertiary` | icon chip 32×32 radius 9, color `var(--accent-ink)`, bg `rgba(245,166,35,0.12)`, glyph 17px stroke 1.9. Value: Space Grotesk 700 29px, letterSpacing -0.01em, `--text-primary`, marginTop 12. Sub: 12px `--text-muted`, marginTop 4.
- **Activity chart**: header row space-between (title | right label mono 11.5px `--text-muted`). Bars: `marginTop 22; display:flex; alignItems:flex-end; gap:8; height:180`. Each of 14 columns `flex:1; column; justifyContent:flex-end; height:'100%'` with native `title` tooltip; inner bar `width:'100%'; height:'{pct}%'; minHeight:4; borderRadius:'5px 5px 3px 3px'`; **today (index 13)** `linear-gradient(180deg,#FFCB6B,#F5A623)`, others `var(--track)`. Endpoints row `marginTop 10`, space-between, mono 10.5px `--text-subtle`: "hace 14 días" / "hoy". No per-bar date labels.
- **Channel bars**: rows column gap 15 (`marginTop 18`). Per row: name/count line space-between `marginBottom 7` — `#name` mono 12.5px `var(--accent-ink)`, count mono 12px `--text-tertiary`; track `height:9; borderRadius:5; background:'var(--track)'; overflow:'hidden'`, fill `height:'100%'; width:'{pct}%'; borderRadius:5; background:'linear-gradient(90deg,#F5A623,#FFCB6B)'` (largest channel = 100%).
- **Donut card**: subtitle `marginTop 6`, 12.5px `--text-muted`. Body `marginTop 18; flex; alignItems:center; gap:24`. Donut 120×120 `borderRadius:'50%'; background:'conic-gradient(#F5A623 {readPct}%, var(--track) 0)'`; center `position:absolute; inset:14; borderRadius:'50%'; background:'var(--surface)'` (needs `position:relative` on the outer), centered column: `{readPct}%` Space Grotesk 700 23px + "leído" 10.5px `--text-muted`. Legend column gap 12, rows flex gap 9 with 11×11 radius-3 swatches: `#F5A623`→"Leídos · **{readCount}**", `var(--track)`→"Sin leer · **{totalCount-readCount}**" (row 13px `--text-secondary`, strong `--text-primary`); footer mono 11px `--text-subtle` `{totalCount} documentos en total` (marginTop 2).
- **Top 5**: list `marginTop 18; column; gap:14`. Row `flex; alignItems:center; gap:14`: rank mono 12px `--text-subtle` width 16 centered flexShrink 0 → avatar 30×30 circle, initials 11px 600 `var(--on-accent)`, bg per D4 → right block `flex:1; minWidth:0` with name/count row (space-between, marginBottom 6; name 13.5px `--text-primary`, count mono 12px `--text-tertiary`) + bar (track `height:7; borderRadius:4; var(--track); overflow hidden`, fill blurple gradient per D3, top row = 100%).
- **No hover/focus states anywhere in this screen** (only native `title` tooltips) → per the cascade convention, everything can be inline styles; **no new `components.css` classes are required**. The nav item reuses the existing `kh-nav-item` classes untouched. If you do add a class with a state, remember: base value in the class, never an inline shorthand (Epic 4 retro AI#4).
- Mock leftovers to IGNORE: chat2brain branding, all hardcoded KPI/daily/perChannel/tops arrays, the per-user avatar color map, "de 6 del guild".

### Testids (define now; 9.3 will assert against them — pick these exact names)

`stats-loading`, `stats-error`, `stats-kpi-card` (×4, with `data-kpi={key}`), `stats-activity-chart`, `stats-activity-bar` (×14), `stats-activity-total`, `stats-channel-row`, `stats-channels-empty`, `stats-coverage-donut`, `stats-coverage-legend`, `stats-top-user-row`, `stats-top-users-empty`.

### Architecture / testing constraints

- AD-3 static SPA (no router — screen-state branch); AD-6 z.infer only; AD-2 web imports shared only. RBAC is entirely server-side — the view renders what it gets, no client-side filtering.
- English-only code/comments/tests/commits; Spanish ONLY in user-facing string literals.
- Vitest 4 + jsdom + RTL, **no jest-dom matchers** (`toBeTruthy()`/`toBeNull()`); mock api MODULES with `vi.mock('../api/stats')`, never global fetch; colocated `src/**/*.test.tsx`; web project: `npx vitest run --project web`.
- jsdom limits: conic-gradient/computed layout unverifiable → assert inline style strings where needed (documented 8.1 workaround) and leave computed-style truth to 9.3's Playwright harness.
- Known suite flakes (don't chase): `rbac.integration.test.ts` load-sensitive; one historical ECONNRESET in `readStatus.integration.test.ts` — rerun before blaming your diff (you shouldn't be running integration anyway).

### Previous-story intelligence

- 9.5 declared downstream verbatim: "9.2 renders `topUsers` via `z.infer`; 9.3 seeds `author_name` + asserts order/exclusion in Playwright". Counts reconcile by design (9.5-D2): topUsers counts, `resources` KPI, `channels[].count` sum and `coverage.totalCount` share the same basis (scoped non-deleted embeddings) — seeded side-by-side render will look self-consistent.
- 9.1 KPI decisions that shape copy: queries KPI is per-user, 30-day (`'últimos 30 días'` sub — Borja vetoed all-time at review); "de N accesibles" is the user's own scope size, never guild total.
- 8.1: gate discipline — silent skips get flagged; state "integration not run (web-only)" explicitly. A11y: new interactive elements need `:focus-visible` (this view adds none — nav item already has it).
- 4.5/7.6: visual/CSS ACs live in the Playwright harness; deferring them to the e2e story BY NAME is the accepted pattern (name each deferred visual AC in Completion Notes).

### Project Structure Notes

- New files: `packages/web/src/api/stats.ts`, `packages/web/src/components/StatsView.tsx`, `packages/web/src/components/StatsView.test.tsx`.
- Edited files: `packages/web/src/components/Sidebar.tsx` (Screen union + NAV_ITEMS), `packages/web/src/components/AppLayout.tsx` (3-way branch + import), `packages/web/src/components/icons.tsx` (StatsIcon), possibly `App.test.tsx` (only if it breaks). `components.css` expected UNTOUCHED (no hover states).
- **Out of scope — stop if you find yourself editing**: anything under `packages/shared`, `packages/backend`, `packages/bot`, `packages/workers`; the Playwright specs/seed (`packages/web/tests/`, `packages/backend/src/e2e/`) beyond running them; `Share2Brain.config.yml`; any migration. The contract is done — if it seems wrong, flag it, don't patch it.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Épico-9 (1046–1101)] — story bullet, KPI ratification note, Top-5 note.
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10-stats.md §4.3] — base ACs 9.2.
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-10-topusers.md §4.3] — Top-5 scope extension.
- [Source: packages/shared/src/schemas/stats.ts] — contract (KPI_ORDER:51, topUsers superRefine:79-97).
- [Source: packages/backend/src/application/services/statsService.ts:87-112] — exact KPI label/sub literals; :35-43 contract JSDoc (empty-scope enumeration + `now` determinism note, useful for test fixtures).
- [Source: packages/web/src/components/Sidebar.tsx:10,66-69,88-110; AppLayout.tsx:74-78; App.tsx:37,125-139] — nav plumbing.
- [Source: packages/web/src/api/search.ts; src/components/SearchView.tsx:20,25-26,71-76,157-180,316-335] — api/view/status/bar patterns.
- [Source: packages/web/src/styles/global.css:10-12,19-30] — tokens + sanctioned literals; [components.css:64-68] cascade rule.
- [Source: docs/context/design/Share2Brain Web.dc.html (isStats)] — design authority, values extracted above.
- [Source: docs/frontend-standards.md; docs/bmad-story-mandatory-steps.md §3.1/§3.4/§4] — gate + e2e/fallback + docs sync.
- [Source: docs/context/TECHNICAL-DESIGN.md §5.5] — views table to sync.

## Change Log

- 2026-07-10 — Story created via `bmad-create-story` (ultimate context engine analysis completed — comprehensive developer guide created). Sources: epics.md §Épico 9, both 2026-07-10 SCPs, 9.1/9.5 story intelligence, full `isStats` design extraction, `packages/web` pattern analysis. Fresh-context validation applied 2 critical fixes (UX-DR24 not UX-DR23 — number taken by "Animaciones del sistema"; 4 KPI icon SVG paths embedded verbatim so the 467KB mock never needs re-parsing), 3 enhancements (frontend-standards "Four→Five primary views" intro line; stale Sidebar/AppLayout header comments added to Task 2; global.css raw-hex policy comment update for the D3/D4 sanctioned literals) and 1 reference widening (statsService JSDoc :35-43).
- 2026-07-10 — Story implemented via `bmad-dev-story` on `feat/9-2-web-statsview` (off `main` @ `10e071f`): StatsView + 3rd nav entry shipped exactly per plan (D1–D6 honored verbatim). Gate green: lint 0 / 892 unit+web (+10) / build clean (5 pkgs) / 16 existing e2e chromium unchanged. Docs synced (epics.md UX-DR5/6 + new UX-DR24, TECHNICAL-DESIGN.md §5.5, frontend-standards.md, global.css raw-hex comment). Status → review.
- 2026-07-10 — Code review via `bmad-code-review` (3 adversarial layers @ Opus). Acceptance Auditor: 0 AC/D violations (AC1–AC8 + D1–D6 verified against real source). Triage: 0 decision-needed, 1 patch (applied), 3 defer (Low, → deferred-work.md), 5 dismissed (2 Blind FPs refuted at source: `unread` clamp via `readCount=Math.min(readCount,totalCount)`, top-users order superRefine-pinned; "Reintentá." = ratified SearchView pattern; date-key & donut-title non-issues). Patch: activity per-bar tooltip → `toLocaleString('es')` for consistency with the total. Gate re-run green (lint 0 / web unit 119 / build 5 pkgs). Status → done.

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5), via `bmad-dev-story`.

### Debug Log References

None — no blocking failures. One environment hiccup during Task 8 manual smoke: an unrelated stale `e2e:server` process (leftover from an earlier session, listening on :3100 for hours) was reused by Playwright's `reuseExistingServer` and served a pre-9.5 response missing `topUsers`, causing the SPA to show the error state on first manual-smoke attempt. Killed the stale process; a freshly spawned backend served the correct 5-block response and the manual smoke passed (nav, header, all 4 KPI cards, activity chart with today's amber bar, donut, and channel/Top-5 sections all confirmed visible in both themes via a throwaway Playwright spec, not committed). A second re-run to re-capture full-page screenshots collided with an external `docker compose` full-stack restart (bot/backend/nginx/workers containers appeared with fresh `Up` timestamps) that this session did not trigger — Postgres connections were cut mid-run. Screenshots from the first successful pass were not preserved (Playwright clears `test-results/` per run). Did not stop the newly-running app containers (unclear if user-initiated) — flagging this to the user rather than acting on it.

### Completion Notes List

- All 8 ACs satisfied. AC1 (nav), AC2 (section order + content), AC3 (topUsers order/graceful snowflake degradation), AC4 (z.infer-only contract, no shape redefinition), AC5 (no new dependency — `packages/web/package.json` unchanged), AC6 (theme tokens + sanctioned raw-hex literals only), AC7 (loading/error/empty-scope zero-safety, no NaN), AC8 (gate green, e2e no-regression) all directly verified.
- **Integration suite not run** — this story is `packages/web` ONLY; no shared/backend/bot/workers file was touched (verified via `git status` before commit).
- **New stats visual/CSS assertions deferred BY NAME to Story 9.3** (7.5→7.6 precedent), per AC8: exact computed styles (fonts, gradients, grid geometry) for `stats-kpi-card`, `stats-activity-chart`/`stats-activity-bar`, `stats-channel-row`, `stats-coverage-donut`/`stats-coverage-legend`, `stats-top-user-row` — these are asserted only via inline style strings in `StatsView.test.tsx` (jsdom limitation, 8.1-documented workaround), not `getComputedStyle`. Story 9.3 owns the permanent Playwright harness coverage (with a real author-name seed for the Top-5 section).
- Manual smoke (Task 8) confirmed real-data rendering in both dark and light themes via the deterministic e2e backend + fake-OAuth (header, 4 KPI cards with icons/values/subs, 14-bar activity chart with the today gradient bar, donut + legend, channel bars, Top-5 section) — see Debug Log for the environment hiccups encountered and why no screenshot artifact was preserved. The 16 pre-existing Playwright specs pass unchanged with the 3rd nav item present.
- D4 avatar/initials helpers (`avatarColor`, `statsInitials`) are defined locally in `StatsView.tsx`, NOT in `lib/authorColor.ts`/`lib/initials.ts` — those existing libs use a different 8-color palette and a whitespace-only split rule (used by Search/Docs author avatars), while D4 mandates a distinct 6-color mock-verbatim palette and an `[_- ]`-split initials rule specific to this view. Reusing the existing libs would have silently violated D4.
- No new dependency added; `packages/web/package.json` diff is empty (AC5 verified).

### Review Findings

Code review 2026-07-10 (`bmad-code-review`) — 3 adversarial layers @ Opus (Blind Hunter / Edge Case Hunter / Acceptance Auditor). **Acceptance Auditor: 0 AC/D violations** — AC1–AC8 + D1–D6 all verified faithful against real source (contract `schemas/stats.ts`, service literals `statsService.ts:87-112`, tokens, sibling patterns). Triage: 0 decision-needed, 1 patch, 3 defer, 5 dismissed.

- [x] [Review][Patch] Activity per-bar tooltip is not locale-formatted [`packages/web/src/components/StatsView.tsx:249`] — FIXED: `title={`${point.count.toLocaleString('es')} recursos`}`; gate re-run green (lint 0 / web unit 119 / build 5 pkgs). — `title={`${point.count} recursos`}` uses the raw number while the adjacent activity-total and every other count use `toLocaleString('es')`. A daily count ≥1000 reads "1234 recursos" in the tooltip vs "1.234" everywhere else. LOW, cosmetic. Spec-defensible (D5's enumeration omits the tooltip, D2 pins it as `{count} recursos`) — discretionary consistency fix, applying `toLocaleString('es')` still satisfies D2.
- [x] [Review][Defer] No overflow/truncation on `authorName` / `channelName` spans [`StatsView.tsx:302,454`] — deferred, visual-AC domain owned by 9.3. Long unbroken names / raw-snowflake channel names have `minWidth:0` on the container but no `overflow/textOverflow/whiteSpace` on the child span, so they can wrap or push the count. Cosmetic; the design spec does not mandate ellipsis (no hover/tooltip in this screen), so the fix is not spec-unambiguous.
- [x] [Review][Defer] `statsInitials` degrades on separator-only / emoji names [`StatsView.tsx:51-55`] — deferred, cosmetic + rare inputs. Separator-only name (`"___"`) → `parts=[]` → falls back to `slice(0,2)`="__"; a two-part emoji name (`"🎉_dev"`) → `"🎉".charAt(0)` yields a lone high surrogate → avatar shows `�`. `authorName` is schema-`min(1)` so never empty; the realistic degradation (snowflake → 2 leading digits) is D4-ratified and correct. Fix, if promoted: `Array.from()` for surrogate-safe first-chars + a `?` fallback — but D4 pins the exact algorithm, so not unambiguous.
- [x] [Review][Defer] Unit-test coverage gaps vs enumerated boundaries [`StatsView.test.tsx`] — deferred, 9.3's Playwright harness owns computed-visual coverage. Uncovered: single-part *alphabetic* initials (`.slice(0,2)` on letters), emoji/unicode names, `coverage.readPct===100` donut, a non-empty channel row with `count===0` (0%-width fill), the real ZodError parse-failure path (error test throws a generic `Error`), and any nav→`StatsView` mount assertion (no `App.test.tsx` change shipped; spec deferred nav coverage to App tests / 9.3). State-machine coverage (loading/error/empty-scope/abort) IS present.

**Dismissed (5, verified false-positives / spec-sanctioned):**
1. Error copy "Reintentá." offers no retry affordance (Blind, Medium) — AC7 pins the exact string + "SearchView pattern"; `SearchView.tsx:178` and `DocsView.tsx:260` both say "Reintentá" with no dedicated retry button (retry = re-search / re-filter / re-nav). Product-wide ratified pattern, not this story's defect. *(surfaced to Borja as a cross-view UX observation)*
2. `unread = totalCount - readCount` can go negative (Blind, Low) — refuted: service ships `coverage.readCount = Math.min(readCount, totalCount)` (`statsService.ts:84,119`); `unread ≥ 0` guaranteed upstream.
3. Top-users bar assumes API pre-sorted by count DESC (Blind, Low) — refuted: `topUsers` order is `superRefine`-pinned `count DESC, authorId ASC` in the contract, so `topUsers[0]` IS the max; spec mandates the view rely on API order and never re-sort.
4. `activity` React key `point.date` relies on schema-unenforced date distinctness (Edge, Low) — defensive/hypothetical; the service zero-fills 14 distinct UTC days, keys are unique. Reachable only via an upstream regression the contract is the safety net for.
5. Donut title "Cobertura de lectura" is a dev-chosen literal (Auditor, info) — spec-consistent (AC2 calls it the "read-coverage donut"), semantically correct; the design spec pins only the subtitle, not the `<h3>`. Not a violation.

### File List

**New:**
- `packages/web/src/api/stats.ts`
- `packages/web/src/components/StatsView.tsx`
- `packages/web/src/components/StatsView.test.tsx`

**Modified:**
- `packages/web/src/components/Sidebar.tsx` (Screen union + NAV_ITEMS + header comment)
- `packages/web/src/components/AppLayout.tsx` (3-way screen branch + import + header comment)
- `packages/web/src/components/icons.tsx` (new `StatsIcon`)
- `packages/web/src/styles/global.css` (raw-hex policy comment extended, D3/D4)
- `_bmad-output/planning-artifacts/epics.md` (UX-DR5/6 updated, new UX-DR24)
- `docs/context/TECHNICAL-DESIGN.md` (§5.5 views table: Cuatro → Cinco, Statistics row)
- `docs/frontend-standards.md` (Views & Components table: Four → Five, Statistics row)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (story status tracking)
