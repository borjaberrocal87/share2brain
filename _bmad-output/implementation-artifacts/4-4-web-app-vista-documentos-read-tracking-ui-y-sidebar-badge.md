---
baseline_commit: ebad05e
---

# Story 4.4: Web App — vista Documentos, read tracking UI y sidebar badge

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a community member,
I want to browse every indexed fragment in a table, filter down to the ones I haven't read, and manage my read status,
so that I know what new knowledge I still have pending to review.

## Acceptance Criteria

**AC1 — View header + table header.** When the Documentos view loads it shows the title "Documentos indexados" (Space Grotesk 600, 25px, `letter-spacing:-0.02em`) and the description "Cada chunk proviene de mensajes agrupados por autor y ventana temporal. El punto ámbar marca las fuentes sin leer — tocá una fila para marcarla como leída." (14px, `--text-tertiary`). The table renders inside a rounded container (`border:1px solid var(--border)`, `border-radius:14px`, `overflow:hidden`, `background:var(--surface)`) whose header row uses `grid-template-columns:1fr 130px 130px 96px`, `gap:14px`, `padding:12px 20px`, `background:var(--bg)`, and the labels "chunk / canal / autor / indexado" in IBM Plex Mono uppercase 10.5px `letter-spacing:0.06em` `--text-subtle` (the "indexado" label is right-aligned).

**AC2 — Row read/unread styling.** Each data row uses the same `1fr 130px 130px 96px` grid (`gap:14px`, `padding:15px 20px`, `border-bottom:1px solid var(--line)`, `align-items:center`, `cursor:pointer`). An **unread** fragment (`isRead:false`) shows: a 7px round dot `background:#F5A623` with `box-shadow:0 0 0 3px rgba(245,166,35,0.16)`, content `color:var(--text-primary)` `font-weight:500`. A **read** fragment shows: dot `background:var(--dot-read)` with `box-shadow:none`, content `color:var(--text-muted)` `font-weight:400`. Hovering a row applies `background:var(--hover-row)`.

**AC3 — Click a row → mark read.** Clicking an **unread** row calls `POST /api/read-status/:embeddingId` and the dot turns grey optimistically (the row restyles to read). A click on an already-read row is a no-op (no request). A failed request reverts the optimistic change.

**AC4 — "Sin leer · N" toggle + empty state.** The toggle chip "Sin leer · N" (leading 7px amber dot, mono 12.5px 500, pill) shows `N` = unread count for the current channel scope (all allowed channels when the channel filter is "todos", else the active channel's unread count). Clicking it filters the table to only unread fragments (server-side `unreadOnly=true`, page reset to 1). When the filter is on and there are no unread fragments, show the empty state: a check icon in a green circle (`#3BA55D` on `rgba(59,165,93,0.12)`, 38px, `border-radius:50%`) + "¡Estás al día! No te quedan fuentes sin leer." (15px, `--text-primary`) + "Quitá el filtro "Sin leer" para ver todo el conocimiento indexado." (13px, `--text-subtle`), inside a `border:1px dashed var(--border-strong)`, `border-radius:14px` block.

**AC5 — Channel filter chips.** A chips row (reusing `GET /api/channels`, RBAC-scoped) filters the table by channel **server-side** (`channelId=…`, page reset to 1). Active/inactive chip styling matches the Búsqueda view (active `background:rgba(245,166,35,0.14)` / `border:1px solid rgba(245,166,35,0.45)` / `color:var(--accent-ink)`; inactive `background:var(--surface)` / `border:1px solid var(--border)` / `color:var(--text-tertiary)`; pills `border-radius:999px`, mono 12.5px 500, `padding:7px 14px`). A "todos" chip clears the channel filter.

**AC6 — "Marcar todas como leídas".** The button (`padding:7px 12px`, `border:1px solid var(--border)`, `border-radius:999px`, transparent bg, `color:var(--text-tertiary)`, 12px; hover `color:var(--text-primary)` + `border-color:var(--border-hover)`) is visible only when the current scope has unread fragments (`unread > 0`). Clicking it calls `POST /api/read-status/mark-all` with `{ channelId }` = the active channel (or the body omits `channelId` when the filter is "todos"). The loaded rows update to read optimistically and the "Sin leer" counts + sidebar badge refresh.

**AC7 — Sidebar "Documentos" badge.** The "Documentos" nav item shows an amber circular badge (IBM Plex Mono 10.5px 600, `min-width:18px`, `height:18px`, `border-radius:9px`, `background:#F5A623`, `color:var(--on-accent)`) with the **total** unread count across all allowed channels when it is `> 0`; when the total is `0` the badge is not rendered. The badge is visible from any screen (it lives in the sidebar), and updates after mark-read / mark-all actions.

**AC8 — "Cargar más" pagination.** The table loads 20 fragments per page. A "Cargar más" button (`padding:9px 20px`, `border:1px solid var(--border-strong)`, `border-radius:10px`, `background:var(--surface)`, `color:var(--text-secondary)`, 13px 500; hover `border-color:var(--accent-ink)` + `color:var(--accent-ink)`) appears at the foot of the table only while more fragments are available (`loaded < total`). Clicking it fetches the next page and **appends** the rows to the list. A count line "mostrando N de TOTAL" (mono 11.5px, `--text-subtle`) sits to its left.

**AC9 — Backend: documents filter params (dependency).** `GET /api/documents` accepts two new optional query params: `channelId` (string) restricts the page to that channel **inside the query** (AD-12 — narrow the RBAC scope, never post-filter; an out-of-scope or unknown `channelId` yields an empty page, no existence leak); `unreadOnly` (boolean, default `false`) restricts to fragments the caller has not read. `total` reflects the same filters. Existing behavior (no params) is unchanged. Contract lives in `@share2brain/shared` (AD-6).

## Tasks / Subtasks

### Backend — shared contract first (AD-5, AD-6)

- [x] **Task 1 — extend `DocumentsQuerySchema`** (AC: 9)
  - [x] In `packages/shared/src/schemas/documents.ts` add to `DocumentsQuerySchema`:
    - `channelId: z.string().min(1).optional()` — Discord snowflake of the channel to filter to; omitted ⇒ all allowed channels.
    - `unreadOnly` — a boolean coerced **safely** from the query string. 🔴 Do **NOT** use `z.coerce.boolean()` — `Boolean("false") === true`, so `?unreadOnly=false` would wrongly parse to `true`. Use Zod 4.4's `z.stringbool().default(false)` (parses `"true"/"false"/"1"/"0"/"yes"/"no"`). If `stringbool` proves awkward with `.default`, fall back to `z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false)`. Add a one-line comment naming the coercion trap.
  - [x] Extend `packages/shared/src/schemas/documents.test.ts`: `channelId` optional passes through; `unreadOnly=true`→`true`, `unreadOnly=false`→`false`, absent→`false`, `unreadOnly=1`→`true`. (Guards the coercion trap.)

### Backend — documents filter (AC9)

- [x] **Task 2 — repository: `unreadOnly` in the SQL** (AC: 9)
  - [x] In `packages/backend/src/domain/repositories/documentRepository.ts` change the port:
    - `listDocuments(userId, allowedChannelIds, limit, offset, unreadOnly)` — add `unreadOnly: boolean`.
    - `countDocuments(userId, allowedChannelIds, unreadOnly)` — add `userId: string` (first arg) **and** `unreadOnly: boolean` (needed to join `user_read_status` for the unread count). Update the doc comments.
  - [x] In `packages/backend/src/infrastructure/documentRepository.drizzle.ts`:
    - `listDocuments`: when `unreadOnly` is `true`, add `AND urs.embedding_id IS NULL` to the WHERE (the LEFT JOIN to `user_read_status` already exists; `IS NULL` = "no read row" = unread). Keep everything else identical.
    - `countDocuments`: it currently does **not** join `user_read_status`. Add the same `LEFT JOIN user_read_status urs ON urs.embedding_id = e.id AND urs.user_id = ${userId}` and, when `unreadOnly`, `AND urs.embedding_id IS NULL`. Keep the empty-scope short-circuit (`if (allowedChannelIds.length === 0) return 0;`). `channelId` is **not** a repo param — it is applied by narrowing `allowedChannelIds` in the service (Task 3), so the existing `inArray(e.channel_id, allowedChannelIds)` filter does the work (AD-12, one code path).
  - [x] Update `documentRepository.drizzle.integration.test.ts`: seed a mix of read/unread fragments for a user (insert into `user_read_status`) across ≥2 channels; assert `unreadOnly=true` returns only the unread ones and its `count` matches; assert narrowing `allowedChannelIds` to `[oneChannel]` returns only that channel's rows and the correct `total`. Follow the **run-unique role/channel-id suffix** isolation pattern (see Dev Notes).

- [x] **Task 3 — service: thread `channelId` + `unreadOnly`** (AC: 9)
  - [x] In `packages/backend/src/application/services/documentService.ts` change the port + impl:
    `listDocuments(userId, page, limit, allowedChannelIds, channelId?, unreadOnly)`.
    - **channelId narrowing (AD-12):** `const scope = channelId ? (allowedChannelIds.includes(channelId) ? [channelId] : []) : allowedChannelIds;`. Use `scope` for both repo calls. An out-of-scope/unknown `channelId` ⇒ `scope=[]` ⇒ the existing empty-scope fast path returns an empty page (no 403, no existence leak — asymmetric with mark-all's 403 because this is a read/list, matching search's deny-by-default).
    - Pass `unreadOnly` to `listDocuments` and `countDocuments` (and `userId` to `countDocuments`).
    - Keep the `DocumentsResponseSchema.parse(...)` validation (AD-6).
  - [x] Update `documentService.test.ts` fakes for the new repo signatures; add cases: `channelId` in scope → narrowed; `channelId` out of scope → empty page + `total:0`; `unreadOnly` forwarded to both repo methods.

- [x] **Task 4 — controller + api-spec** (AC: 9)
  - [x] In `packages/backend/src/presentation/controllers/documentController.ts` pass `parsed.data.channelId` and `parsed.data.unreadOnly` into `documentService.listDocuments(userId, page, limit, allowedChannelIds, channelId, unreadOnly)`. No new status codes (a bad `channelId`/`unreadOnly` already 400s via `DocumentsQuerySchema.safeParse`; existing `[documents] failed` 500 path unchanged).
  - [x] Update `documentController.test.ts` for the new pass-through args.
  - [x] In `docs/api-spec.yml` add `channelId` (string, optional) and `unreadOnly` (boolean, default false) as query parameters on `GET /api/documents`.

### Frontend — API clients (browser-safe)

- [x] **Task 5 — documents + read-status clients** (AC: 3, 4, 5, 6, 7, 8)
  - [x] Create `packages/web/src/api/documents.ts` mirroring `api/search.ts`: `fetchDocuments(params: { page: number; limit: number; channelId?: string; unreadOnly?: boolean }, signal?: AbortSignal): Promise<DocumentsResponse>`. Build the query with `URLSearchParams` (`page`, `limit`, plus `channelId` / `unreadOnly=true` **only when set** — never send `unreadOnly=false` or an empty `channelId`). `fetch('/api/documents?' + qs, { credentials: 'include', signal })`; throw on `!res.ok`; `return DocumentsResponseSchema.parse(await res.json())`. Import **only** from `@share2brain/shared/schemas`.
  - [x] Create `packages/web/src/api/readStatus.ts` with:
    - `markRead(embeddingId: string): Promise<void>` → `fetch('/api/read-status/' + embeddingId, { method: 'POST', credentials: 'include' })`; throw on `!res.ok` (so the optimistic UI can revert). Response body `{}` — no parse needed.
    - `markAll(channelId?: string): Promise<MarkAllResponse>` → `fetch('/api/read-status/mark-all', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(channelId ? { channelId } : {}) })`; `return MarkAllResponseSchema.parse(await res.json())`.
    - `fetchUnreadCount(signal?: AbortSignal): Promise<UnreadCountResponse>` → `fetch('/api/read-status/unread-count', { credentials: 'include', signal })`; `return UnreadCountResponseSchema.parse(await res.json())` (a `{ [channelId]: number }` map).
    - Do **NOT** wire the `DELETE` (unmark) endpoint — out of scope this story (row click is mark-read only, decision D2).

### Frontend — unread state lifted to App (AC7 badge + AC4/AC6 counts)

- [x] **Task 6 — own the unread map in `App.tsx`** (AC: 4, 6, 7)
  - [x] The badge must show on **every** screen (it lives in the sidebar), and the Documentos view also needs the per-channel counts. So the unread map is owned above both. In `packages/web/src/App.tsx`:
    - Add state `unreadCounts: UnreadCountResponse` (`{}` initial). After auth resolves, `fetchUnreadCount()` into it (reuse the `active` unmount-guard pattern; a failure just leaves it `{}` — don't block).
    - Add a `refreshUnread` callback = re-run `fetchUnreadCount()` and set state.
    - Compute `totalUnread = Object.values(unreadCounts).reduce((a, b) => a + b, 0)`.
    - Pass `unreadCount={totalUnread}`, `unreadCounts={unreadCounts}`, and `onUnreadChange={refreshUnread}` to `<AppLayout>`.
  - [x] Update `App.test.tsx`: mock `../api/readStatus` (`fetchUnreadCount` resolving a map); assert the "Documentos" badge renders the total when `> 0` and is absent when the map is empty/zero.

### Frontend — Documentos view (AC1–AC8)

- [x] **Task 7 — check icon** (AC: 4)
  - [x] Add `CheckIcon` to `packages/web/src/components/icons.tsx` (path `M20 6L9 17l-5-5`, default `size=20`, stroke 2.4, `stroke-linecap`/`stroke-linejoin` round — per mockup line 265). Used by the "estás al día" empty state.

- [x] **Task 8 — DocsView component** (AC: 1–8)
  - [x] Create `packages/web/src/components/DocsView.tsx` accepting `{ unreadCounts: UnreadCountResponse; onUnreadChange: () => void }`.
  - [x] State: `docs: DocumentFragment[]` (accumulated across pages), `page` (1-based), `total` (number), `channels: Channel[]`, `activeChannelId: 'all' | string`, `unreadOnly: boolean`, `status: 'idle'|'loading'|'error'`, `loadingMore: boolean`.
  - [x] On mount: `fetchChannels()` into `channels` (guard with `active`, failure ⇒ empty chips, don't block).
  - [x] **Page-1 fetch effect** keyed on `[activeChannelId, unreadOnly]`: reset to page 1, `fetchDocuments({ page: 1, limit: 20, channelId: activeChannelId==='all'?undefined:activeChannelId, unreadOnly: unreadOnly || undefined }, signal)` with an `AbortController` (abort superseded requests). On success `setDocs(res.results)`, `setTotal(res.total)`, `setPage(1)`, `status='idle'`. On abort ignore; other errors `status='error'`. Changing a chip or the toggle re-runs this (page resets to 1) — server-side filtering, so it is correct with pagination.
  - [x] **"Cargar más"**: `fetchDocuments({ page: page+1, ... }, signal)`; **append** `res.results` to `docs`; `setPage(page+1)`; keep `total` fresh from the response. Guard with `loadingMore`. Button visible only when `docs.length < total`.
  - [x] **Row click (mark read)** — only for unread rows: optimistically set that row's `isRead=true` in `docs`; call `markRead(id)`; on success call `onUnreadChange()` (refresh the badge/map) and, if `unreadOnly`, the row naturally drops from `visibleDocs` (see below); on failure revert the row's `isRead` to `false`. Already-read row → no-op.
  - [x] **"Marcar todas como leídas"** (visible when `scopeUnread > 0`): `markAll(activeChannelId==='all'?undefined:activeChannelId)`; optimistically set `isRead=true` on all loaded rows in the active scope; then `onUnreadChange()`. On failure, `onUnreadChange()` to reconcile.
  - [x] `visibleDocs` = `unreadOnly ? docs.filter((d) => !d.isRead) : docs` — so an optimistic mark-read while the "Sin leer" filter is on removes the row immediately without a refetch (the server list was already unread-only; this keeps local state consistent).
  - [x] `scopeUnread` = `activeChannelId==='all' ? Object.values(unreadCounts).reduce((a,b)=>a+b,0) : (unreadCounts[activeChannelId] ?? 0)` — drives the "Sin leer · N" label, the mark-all visibility, and (indirectly) matches the sidebar total when "todos".
  - [x] Empty state (AC4): render when `unreadOnly && visibleDocs.length === 0 && status !== 'loading'`. (A general "no documents at all" scope shows the empty table container + the "mostrando 0 de 0" line — no special copy required by the ACs.)
  - [x] Render structure per the mockup (see "Exact Documentos spec" in Dev Notes): container `padding:34px 40px 60px`, inner `max-width:980px; margin:0 auto`; title + description; the controls row (chips left, spacer, "Marcar todas" when unread, "Sin leer · N" toggle right); the table (header + `visibleDocs` rows) OR the empty state; the footer count line + "Cargar más".
  - [x] Row fields: dot (color/glow per `isRead`, AC2); content (2-line clamp — `display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; text-overflow:ellipsis`, 13.5px, `line-height:1.5`, color/weight per `isRead`); `#{d.channelName}` (mono 12px `--accent-ink`); author (20px avatar `authorColor(d.authorId)` + white initials `initialsFromUsername(d.authorName)`, name 12.5px `--text-tertiary`, ellipsis); date = `Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(new Date(d.indexedAt))` (the "indexado" column → **`indexedAt`**, not `createdAt`), right-aligned mono 11.5px `--text-muted`.

- [x] **Task 9 — hover/focus CSS** (AC: 2, 6, 8)
  - [x] Add to `packages/web/src/styles/components.css` (inline styles can't do `:hover`): `.kh-doc-row:hover { background: var(--hover-row); }`; `.kh-load-more:hover { border-color: var(--accent-ink); color: var(--accent-ink); }`; `.kh-mark-all:hover { color: var(--text-primary); border-color: var(--border-hover); }`; `.kh-unread-toggle:hover { border-color: var(--border-hover); }`. Reuse the existing `.kh-chip` class for the channel chips (already defined by Story 4.3).

- [x] **Task 10 — mount the view + thread props** (AC: 1, 7)
  - [x] In `packages/web/src/components/AppLayout.tsx`: add `unreadCount: number`, `unreadCounts: UnreadCountResponse`, `onUnreadChange: () => void` to `AppLayoutProps`. Replace the `docs` placeholder branch (the `else` after the `search` ternary) with `<DocsView unreadCounts={unreadCounts} onUnreadChange={onUnreadChange} />`. Pass `unreadCount={unreadCount}` into `<Sidebar>`. Remove the now-unused `DOCS_PLACEHOLDER` / `contentAreaStyle` if nothing else uses them.
  - [x] `Sidebar.tsx` already accepts `unreadCount` and renders the badge (Story 2.2) — just pass it through from `AppLayout`. Update the prop's JSDoc (drop the "Real count lands in Epic 4" note).

### Frontend — tests

- [x] **Task 11 — component + client tests** (AC: 1–8)
  - [x] `packages/web/src/components/DocsView.test.tsx` (Vitest + Testing Library, jsdom): `vi.mock` `../api/documents`, `../api/readStatus`, `../api/channels` (mirror `SearchView.test.tsx`). Assert: title + table header labels render; rows render from the mocked page; clicking an unread row calls `markRead` with the row id and flips it to read (assert on a stable marker, e.g. `data-read` attr or the row text weight is not assertable in jsdom — use a `data-*` you set from `isRead`); toggling "Sin leer" refetches with `unreadOnly` (assert the mock was called with the flag); clicking a channel chip refetches with `channelId`; "Cargar más" appends the next page and hides when `loaded >= total`; the empty state text shows when `unreadOnly` + mock returns `[]`. Use `toBeTruthy()`/`toBeNull()` (no jest-dom matchers).
  - [x] Optional: `api/documents.test.ts` — asserts the query string omits `unreadOnly` when false and `channelId` when "all".

### Verification gate (AGENT runs it — mandatory)

- [x] **Task 12** — Run and paste output of `npm run lint && npm run test && npm run build`. Then integration tests (`npm run test:integration` — needs `docker compose up -d postgres redis`). Then smoke the real backend slice (see Dev Notes → Manual verification). Never mark an AC done without evidence.
  - [x] 🔶 **Visual ACs unverifiable here** (AC1/AC2/AC4 exact fonts, the dot `box-shadow` glow, token colors, the table grid): jsdom ignores external CSS and this env has no browser automation / real Discord OAuth. These are covered **retroactively by Story 4.5** (the Playwright visual harness explicitly asserts the 4.4 Documentos ACs via `getComputedStyle`). Flag them as deferred-to-4.5 in the completion notes (do **not** claim them verified). A quick manual browser pass by Borja before merge is still recommended.

### Review Findings

_bmad-code-review 2026-07-07 (Blind Hunter + Edge Case Hunter + Acceptance Auditor, Opus 4.8, over the uncommitted working tree, baseline ebad05e). Acceptance Auditor: 0 hard AC violations — every functionally-verifiable AC (AC1–AC9) MET; visual ACs correctly deferred to Story 4.5. Below are the correctness findings from the adversarial layers._

- [x] [Review][Patch] (resuelto de decision→patch: opción (b) revert de filas) `handleMarkAll` no revierte el update optimista si el POST falla — snapshot de `docs` + `setDocs(snapshot)` en `.catch` (mirroring `handleRowClick`), luego `onUnreadChange()`. `[blind+edge+auditor]` — FIXED
- [x] [Review][Patch] `loadMore` no es abortable ni valida el filtro → corrupción de estado cross-filtro — ahora pasa `controller.signal`, se guarda en `loadMoreControllerRef`, y la cleanup del efecto de filtro lo aborta + resetea `loadingMore` (cubre también el gotcha de `loadingMore` colgado). [packages/web/src/components/DocsView.tsx:81] — FIXED
- [x] [Review][Patch] `status === 'error'` nunca se renderiza → fallo silencioso mostraba tabla vacía como corpus vacío; añadida rama de error "No se pudieron cargar los documentos. Reintentá." + footer oculto en error (espeja `SearchView`). [packages/web/src/components/DocsView.tsx] — FIXED
- [x] [Review][Patch] `refreshUnread`/`onUnreadChange` concurrentes hacían carrera → token de generación `unreadReqRef`: sólo la última petición despachada hace commit. [packages/web/src/App.tsx:62] — FIXED

- [x] [Review][Defer] Paginación por offset salta/duplica filas bajo `unreadOnly` tras mark-read optimista + "Cargar más" [packages/web/src/components/DocsView.tsx:81] — deferred, inherente al diseño de offset elegido (D1); baja frecuencia, corregirlo requiere cursor o refetch desde page 1

#### Second pass (re-review of the applied patches — Epic 3 retro AI#1: patches are new un-reviewed code)

_bmad-code-review 2ª pasada 2026-07-07 (Blind Hunter + Edge Case Hunter, Opus 4.8) sobre los 4 patches. Patches 2/3/4 verificados CORRECTOS (sin wedge del botón, token de generación monótono, rama de error con precedencia correcta). Nuevos hallazgos:

- [x] [Review][Patch] `handleMarkAll` revert descarta filas apiladas tras el click → FIXED: revert por `isRead` de un `Map` del snapshot en updater funcional (preserva filas apiladas por "Cargar más"). Medium `[blind+edge]`
- [x] [Review][Patch] "Cargar más" clickeable durante el reload de page-1 (carrera de páginas) → FIXED: `loadMore` guardado con `status==='loading'` + botón `disabled={loadingMore || status==='loading'}`. Medium `[edge]`
- [x] [Review][Patch] Cobertura de regresión de los 4 patches → FIXED: +4 tests en `DocsView.test.tsx` (rama error + footer oculto, revert de mark-all, guard de page-race, swallow del abort de loadMore) y +1 en `App.test.tsx` (token de generación con respuestas fuera de orden). Suite 355→360. Medium `[edge]`

## Dev Notes

### Scope shape (decisions locked with Borja at creation)

Like 4.3, this is a **thin full-stack** story — bulk is the frontend Documentos view, plus a small additive backend change:

- **D1 — filtering is server-side** (Borja, recommended). `GET /api/documents` gains `channelId?` + `unreadOnly?` query params. Rationale: the endpoint is **paginated** (unlike `/api/search`, which returns the whole result set at once and let 4.3 filter chips client-side). Client-side filtering over paginated pages is genuinely misleading ("Cargar más" would page the global list, not the filtered one). Server-side params keep filter + pagination coherent: any filter change resets to page 1 and refetches. `channelId` is applied by **narrowing `allowedChannelIds` to `[channelId]` in the service** (AD-12 stays "RBAC inside the query", zero repo signature change for channelId); `unreadOnly` needs SQL (`urs.embedding_id IS NULL`) in both `listDocuments` and `countDocuments`.
- **D2 — row click marks read only** (Borja, recommended). Clicking an unread row → `POST /api/read-status/:id`, optimistic dot→grey. Already-read row = no-op. Matches AC3 + the mockup (`markRead(i)` is a one-way no-op if already read). The `DELETE /api/read-status/:id` (unmark) endpoint exists but is **out of scope** this story.

### 🔴 CRITICAL: design tokens were renamed — translate the mockup names

The mockup `docs/context/design/Share2Brain Web.dc.html` (Documentos view, lines 218-280) uses `--tx`…`--tx5`. Story 2.1 renamed these (values identical, only names changed). **All other tokens the ACs use already exist unchanged** in `packages/web/src/styles/global.css` (verified): `--line`, `--hover-row`, `--dot-read`, `--track`, `--bg`, `--surface`, `--border`, `--border-strong`, `--border-hover`, `--accent-ink`, `--on-accent`.

| Mockup name | Implemented token | Where used in 4.4 |
|---|---|---|
| `--tx`  | `--text-primary`   | unread row content; empty-state line 1; mark-all hover |
| `--tx2` | `--text-secondary` | "Cargar más" text |
| `--tx3` | `--text-tertiary`  | description; author name; mark-all button; inactive chip |
| `--tx4` | `--text-muted`     | read row content; date column |
| `--tx5` | `--text-subtle`    | table header labels; count line; empty-state line 2 |

Fixed brand hexes (only raw hex allowed): amber `#F5A623`, positive `#3BA55D`. Do NOT invent `--tx*` tokens in CSS — they don't exist.

### Exact Documentos spec (source: `Share2Brain Web.dc.html` lines 218-280, JS 534-548 & 745-839)

- **Container**: `padding:34px 40px 60px`, inner `max-width:980px; margin:0 auto` (note: **980px**, wider than Búsqueda's 860px).
- **Title** `h2`: Space Grotesk 600, 25px, `letter-spacing:-0.02em`. **Description** `p`: `margin:7px 0 0`, 14px `--text-tertiary`.
- **Controls row** (`margin-top:20px; display:flex; flex-wrap:wrap; align-items:center; gap:10px`): chips group (`display:flex; flex-wrap:wrap; gap:8px`) → spacer (`flex:1; min-width:12px`) → "Marcar todas como leídas" (only when unread) → "Sin leer · N" toggle.
  - **"Sin leer" toggle** style (from `unreadChipStyle`): `display:flex; align-items:center; gap:7px; padding:7px 14px; border-radius:999px; cursor:pointer; font-size:12.5px; font-weight:500; font-family:'IBM Plex Mono',monospace`. Active (filter on): `background:rgba(245,166,35,0.14); border:1px solid rgba(245,166,35,0.45); color:var(--accent-ink)`. Inactive: `background:var(--surface); border:1px solid var(--border); color:var(--text-tertiary)`. Leading dot: `width:7px; height:7px; border-radius:50%; background:#F5A623`.
- **Table container**: `margin-top:20px; border:1px solid var(--border); border-radius:14px; overflow:hidden; background:var(--surface)`.
  - **Header row**: `display:grid; grid-template-columns:1fr 130px 130px 96px; gap:14px; padding:12px 20px; background:var(--bg); border-bottom:1px solid var(--border); font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:0.06em; text-transform:uppercase; color:var(--text-subtle)`. Cells: `chunk`, `canal`, `autor`, `indexado` (last `text-align:right`).
  - **Data row** (`.kh-doc-row`): same grid, `gap:14px; padding:15px 20px; border-bottom:1px solid var(--line); align-items:center; cursor:pointer`, hover `background:var(--hover-row)`.
    - **chunk cell**: `display:flex; gap:11px; align-items:flex-start; min-width:0`. Dot span: `width:7px; height:7px; margin-top:6px; flex-shrink:0; border-radius:50%`, `background` + `box-shadow` per read state (unread `#F5A623` + `0 0 0 3px rgba(245,166,35,0.16)`; read `var(--dot-read)` + `none`). Content span: `font-size:13.5px; line-height:1.5; color:<textColor>; font-weight:<500|400>; overflow:hidden; text-overflow:ellipsis; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical`.
    - **canal cell**: `font-family:'IBM Plex Mono',monospace; font-size:12px; color:var(--accent-ink)` → `#{channelName}`.
    - **autor cell**: `display:flex; align-items:center; gap:7px; min-width:0`. Avatar: `width:20px; height:20px; flex-shrink:0; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:9.5px; font-weight:600; color:#fff; background:authorColor(authorId)` (white text — matches 4.3's ResultCard). Name: `font-size:12.5px; color:var(--text-tertiary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap`.
    - **indexado cell**: `text-align:right; font-family:'IBM Plex Mono',monospace; font-size:11.5px; color:var(--text-muted)` → formatted `indexedAt`.
- **Empty state** (AC4): `margin-top:20px; text-align:center; padding:48px 20px; border:1px dashed var(--border-strong); border-radius:14px`. Icon wrapper: `margin:0 auto 14px; width:38px; height:38px; display:flex; align-items:center; justify-content:center; color:#3BA55D; background:rgba(59,165,93,0.12); border-radius:50%` containing `<CheckIcon size={20}/>` (stroke 2.4). Line 1: 15px `--text-primary`. Line 2: `margin-top:6px`, 13px `--text-subtle`.
- **Footer** (`margin-top:18px; display:flex; align-items:center; justify-content:space-between`): count `<span>` (mono 11.5px `--text-subtle`) `mostrando {visibleDocs.length} de {total}`; "Cargar más" `<button class="kh-load-more">` (`padding:9px 20px; border:1px solid var(--border-strong); border-radius:10px; background:var(--surface); color:var(--text-secondary); font-size:13px; font-weight:500; cursor:pointer`), rendered only when `docs.length < total`.
- **UI copy is Spanish verbatim** (from the mockup); all identifiers/comments/logs English (project rule).

### Frontend architecture & conventions (must follow — carried from 4.3)

- **No router** (UX-DR5): the `docs` screen is already `Screen='docs'` (`Sidebar.tsx:10`) with a placeholder branch in `AppLayout.tsx:80-100`. You **replace that placeholder**, not add a route.
- **No data library**: `useState` + `useEffect` + `fetch` + `AbortController`. Mirror `SearchView.tsx` (debounce is not needed here — filters fire on discrete clicks, not keystrokes).
- **API client pattern** (`api/auth.ts` / `api/search.ts` / `api/channels.ts`): native `fetch` to same-origin `/api/*`, **`credentials: 'include'`** on every call, validate responses with the shared Zod schema, throw on unexpected status.
- **Import boundary (AD-3, ESLint `no-restricted-imports`)**: from `packages/web` import contracts **only** from `@share2brain/shared/schemas`. `@share2brain/shared/schemas` already re-exports `documents`, `readStatus`, `channels` (no `index.ts` change needed this story).
- **Hover** → `kh-*` classes in `styles/components.css` (Task 9); static layout stays inline. Reuse `.kh-chip` (from 4.3) for the channel chips.
- **Reuse**: `initialsFromUsername` (`lib/initials.ts`); `authorColor` (`lib/authorColor.ts`); `fetchChannels` (`api/channels.ts`); the chip component pattern from `SearchView.tsx` (a small local `ChannelChip` is fine — copy it or extract; do not over-engineer a shared component this story). Do **not** add an icon library.

### Backend contracts (from real source — do not redefine locally)

- `DocumentFragmentSchema` (`packages/shared/src/schemas/documents.ts`): `{ id(uuid), content, channelId, channelName, authorId, authorName, createdAt(ISO), indexedAt(ISO), messageId, isRead(bool) }`. `DocumentsResponseSchema = { results: DocumentFragment[], page, limit, total }`. The "indexado" column = `indexedAt`.
- `DocumentsQuerySchema` currently `{ page(1..1e6, default 1), limit(1..100, default 20) }` → add `channelId?`, `unreadOnly`.
- Read-status contracts (`packages/shared/src/schemas/readStatus.ts`): `EmbeddingIdParamSchema` (uuid); `MarkAllRequestSchema = { channelId?: string.min(1) }` (explicit `null` is a validation error — omit for "all"); `MarkAllResponseSchema = { markedCount }`; `UnreadCountResponseSchema = Record<string, number>` (a **bare per-channel map**, D7). `READ_STATUS_ERROR = { VALIDATION_ERROR, NOT_FOUND, FORBIDDEN, INTERNAL }`.
- Backend endpoints (already built in 4.2 — do not rebuild): `POST /api/read-status/:embeddingId` → 200 `{}` / 404 `NOT_FOUND` (not visible/absent) / 400 bad uuid; `DELETE …/:embeddingId` → 200 (idempotent, **unused this story**); `POST /api/read-status/mark-all` → 200 `{ markedCount }` / 403 `FORBIDDEN` (channel out of scope) / 400; `GET /api/read-status/unread-count` → 200 `{ [channelId]: count }`. All behind the `/api` gate (401 `AUTH_REQUIRED` with no session). RBAC (`allowedChannelIds`) is populated by the middleware on every `/api/*` request.
- Repo mirror targets — `documentRepository.drizzle.ts` (the `unreadOnly` SQL edit; LEFT JOIN `user_read_status` already present in `listDocuments`); `documentService.ts` (the channelId-narrowing + param threading); `documentController.ts` (query pass-through). Composition root `app.ts` — no wiring change (the documents route is already mounted at `:121`; the service/controller are constructed there — just the constructors gain args through their existing call sites).

### 🔴 Test-isolation gotcha (learned in 4.2/4.3 — do NOT repeat)

Integration suites share one real Postgres. (1) Scope `afterAll` deletes to **this suite's own** ids (never a broad `LIKE 'itest-%'` — it races other suites into FK 500s). (2) RBAC expansion resolves against the **whole** `channel_permissions` table, so a shared literal role like `'member'` leaks other suites' channels into scope. Any test that asserts the **full** scope (documents `total`, unread counts, channel narrowing) must use a **run-unique role + channel-id suffix** (see `search.integration.test.ts:19` / `channels.integration.test.ts` for the pattern). Seed `user_read_status` for the test user to exercise `isRead`/`unreadOnly`; clean it up by the suite's own user/embedding ids.

### Author display (deferred state — carried from 4.1/4.3)

`authorName === authorId` today (no display name persisted; the bot stores only `authorId`). Render `authorName` as-is (forward-compatible — when usernames land later the field populates with zero frontend change), avatar initials via `initialsFromUsername(authorName)`, color via `authorColor(authorId)`. Do not build a display-name lookup.

### Testing standards

- Frontend: Vitest + `@testing-library/react` (jsdom). **No jest-dom matchers** (`toBeTruthy()`/`toBeNull()`). Mock the api modules with `vi.mock(...)` (see `SearchView.test.tsx` / `App.test.tsx` for the `importOriginal` spread + `vi.mocked` pattern). **jsdom does not apply external CSS** → the dot glow, exact colors, fonts and the grid can't be asserted in unit tests (Story 4.5 harness covers them via `getComputedStyle`).
- Backend integration: `vitest` + `supertest` against **real** Postgres+Redis via `createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([...]) }))`; drive the real login→callback flow with `request.agent`; seed `channel_permissions` + `embeddings`/`discord_messages` + `user_read_status`.
- **Always test RBAC + the new filters**: `unreadOnly=true` returns only unread; `channelId` narrows to one channel; a `channelId` outside scope returns an empty page (no leak); `total` matches the applied filters.

### Manual verification (Task 12 smoke)

Start the real Express app (`createApp`) against real Postgres/Redis with an injected fake Discord OAuth client, drive the HTTP login→callback flow, then curl: `GET /api/documents?limit=2` (200, `{results,page,limit,total}`), `GET /api/documents?unreadOnly=true` (only unread), `GET /api/documents?channelId=<seeded>` (only that channel), `POST /api/read-status/<id>` then re-GET documents (that row now `isRead:true`), `GET /api/read-status/unread-count` (map decremented). Delete any scratch script afterward.

### Project Structure Notes

- **New**: `packages/web/src/api/documents.ts`, `api/readStatus.ts`, `components/DocsView.tsx`, `components/DocsView.test.tsx` (+ optional `api/documents.test.ts`).
- **Modified**: `packages/shared/src/schemas/documents.ts` (+`.test.ts`); `packages/backend/src/{domain/repositories/documentRepository.ts, infrastructure/documentRepository.drizzle.ts (+integration test), application/services/documentService.ts (+test), presentation/controllers/documentController.ts (+test)}`; `packages/web/src/{App.tsx (+App.test.tsx), components/AppLayout.tsx, components/Sidebar.tsx (JSDoc only), components/icons.tsx, styles/components.css}`; `docs/api-spec.yml`.
- **No DB migration** (read-only + reuses `user_read_status` which already exists). **No `app.ts` wiring change** (route already mounted; constructor arg lists change at their existing call sites). **No `@share2brain/shared/schemas/index.ts` change** (documents/readStatus/channels already re-exported).
- Naming: modules `camelCase.ts`, React components `PascalCase.tsx`; endpoints `/api/<resource>` kebab plural.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Historia 4.4 (lines 703-743)] — the 7 epic ACs + goal.
- [Source: docs/context/design/Share2Brain Web.dc.html lines 218-280 (markup), 534-548 (unreadChipStyle/markRead), 745-839 (docs view-model, badge)] — the pixel-exact Documentos mockup.
- [Source: packages/shared/src/schemas/documents.ts] — `DocumentsQuerySchema`, `DocumentFragmentSchema`, `DocumentsResponseSchema`, `DOCUMENTS_ERROR`.
- [Source: packages/shared/src/schemas/readStatus.ts] — `EmbeddingIdParamSchema`, `MarkAllRequestSchema`, `MarkAllResponseSchema`, `UnreadCountResponseSchema`, `READ_STATUS_ERROR`.
- [Source: packages/backend/src/infrastructure/documentRepository.drizzle.ts] — `listDocuments`/`countDocuments` SQL (the `unreadOnly` edit target; LEFT JOIN already present).
- [Source: packages/backend/src/application/services/documentService.ts] — the channelId-narrowing + param-threading target.
- [Source: packages/backend/src/presentation/controllers/documentController.ts + readStatusController.ts] — query pass-through + the read-status endpoint behaviors (404/403/200).
- [Source: packages/backend/src/app.ts:115-131] — documents/read-status/channels mounts (no change needed).
- [Source: packages/web/src/components/SearchView.tsx] — the view/chip/avatar/date patterns to mirror.
- [Source: packages/web/src/api/{search.ts,channels.ts,auth.ts}] — fetch-client pattern to mirror.
- [Source: packages/web/src/components/{App.tsx,AppLayout.tsx,Sidebar.tsx,icons.tsx}, styles/{components.css,global.css}, lib/{initials.ts,authorColor.ts}] — files to modify/reuse. `Sidebar.tsx:48-62,102` already renders the badge.
- [Source: _bmad-output/implementation-artifacts/4-3-web-app-vista-busqueda.md] — the immediately-prior frontend story: token-rename table, test-isolation gotcha, client patterns, visual-verification gap → Story 4.5.
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 4.5] — the E2E visual harness that verifies these ACs retroactively (blocks 5.3/5.4).
- Invariants: AD-3 (static SPA, browser-safe imports), AD-6 (Zod contracts in shared), AD-12 (RBAC inside the query) — `docs/context/ARCHITECTURE-SPINE.md`.

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5)

### Debug Log References

None — no blocking failures. `search.integration.test.ts` had one transient
"Parse Error: Expected HTTP/, RTSP/ or ICE/" failure on a full concurrent
`npm run test:integration` run; re-ran in isolation (passed) and re-ran the
full suite again (76/76 passed) — confirmed flaky test-port contention,
unrelated to this story's changes.

### Completion Notes List

- Backend: extended `DocumentsQuerySchema` with `channelId` (optional) and
  `unreadOnly` (`z.stringbool().default(false)` — avoids the
  `Boolean("false") === true` coercion trap). Threaded through
  `documentRepository` (port + Drizzle impl: `unreadOnly` → `AND
  urs.embedding_id IS NULL` in both `listDocuments` and `countDocuments`,
  the latter gaining a `LEFT JOIN user_read_status`) → `documentService`
  (channelId narrowing per AD-12: an out-of-scope/unknown channelId narrows
  to `[]`, hitting the existing empty-scope fast path — no existence leak) →
  `documentController` → `docs/api-spec.yml`.
- Frontend: new `api/documents.ts` + `api/readStatus.ts` clients; unread
  state lifted into `App.tsx` (`unreadCounts` map, `refreshUnread`,
  `totalUnread` → sidebar badge on every screen); new `DocsView.tsx`
  (AC1-8: table, channel chips, "Sin leer · N" toggle, mark-read/mark-all
  optimistic updates, "Cargar más" pagination, empty state) mounted in
  `AppLayout` replacing the placeholder; `CheckIcon` added; hover CSS for
  `.kh-doc-row` / `.kh-load-more` / `.kh-mark-all` / `.kh-unread-toggle`.
- TDD followed throughout: each schema/repo/service/controller/component
  change was preceded by a failing test, confirmed red, then made green.
- Extended the existing `documents.integration.test.ts` (real Express app +
  real Postgres + fake Discord OAuth, predates this story) with 3 new cases
  covering `unreadOnly`/`channelId` at the HTTP level, instead of writing a
  throwaway manual-smoke script — same verification value, permanent
  regression coverage.
- Verification gate: `npm run lint` (0 issues) · `npm run test` (355/355) ·
  `npm run build` (clean across all 5 packages) · `npm run test:integration`
  (76/76, incl. 2 new repo-level + 3 new route-level documents cases).
- 🔶 **Visual ACs deferred to Story 4.5** (not verified here, per the story's
  own flag): AC1/AC2/AC4 exact fonts, the unread-dot `box-shadow` glow,
  design-token colors, and the `1fr 130px 130px 96px` grid — jsdom ignores
  external CSS and this environment has no browser automation / real
  Discord OAuth. The 4.5 Playwright harness asserts these via
  `getComputedStyle`. A manual browser pass by Borja before merge is
  recommended.

### File List

**New:**
- `packages/web/src/api/documents.ts`
- `packages/web/src/api/documents.test.ts`
- `packages/web/src/api/readStatus.ts`
- `packages/web/src/components/DocsView.tsx`
- `packages/web/src/components/DocsView.test.tsx`

**Modified:**
- `packages/shared/src/schemas/documents.ts`
- `packages/shared/src/schemas/documents.test.ts`
- `packages/backend/src/domain/repositories/documentRepository.ts`
- `packages/backend/src/infrastructure/documentRepository.drizzle.ts`
- `packages/backend/src/infrastructure/documentRepository.drizzle.integration.test.ts`
- `packages/backend/src/application/services/documentService.ts`
- `packages/backend/src/application/services/documentService.test.ts`
- `packages/backend/src/presentation/controllers/documentController.ts`
- `packages/backend/src/presentation/controllers/documentController.test.ts`
- `packages/backend/src/documents.integration.test.ts`
- `docs/api-spec.yml`
- `packages/web/src/App.tsx`
- `packages/web/src/App.test.tsx`
- `packages/web/src/components/AppLayout.tsx`
- `packages/web/src/components/Sidebar.tsx`
- `packages/web/src/components/icons.tsx`
- `packages/web/src/styles/components.css`

## Change Log

- 2026-07-07 (bmad-dev-story): Implemented the Documentos view (`DocsView`) with
  server-side channel/unread filtering and pagination (D1), plus the small
  additive backend change it depends on — `channelId`/`unreadOnly` on
  `GET /api/documents` (AD-12 channelId narrowing, `unreadOnly` SQL in both
  `listDocuments`/`countDocuments`). Lifted the unread-count map into
  `App.tsx` so the sidebar "Documentos" badge (AC7) is live on every screen.
  Status → review.
