---
baseline_commit: c7ef787dd089c6f17f4fe9024d06dd4262f352a3
---

# Story 4.3: Web App — vista Búsqueda

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a community member,
I want to search the indexed knowledge from the web app and see the results with their relevance score, source metadata and a link back to Discord,
so that I can quickly find the information I need — scoped to the channels I'm allowed to see.

## Acceptance Criteria

**AC1 — View header.** When the Búsqueda view loads it shows the title "Búsqueda de conocimiento" (Space Grotesk 600, 25px, `letter-spacing:-0.02em`), the description "Búsqueda semántica sobre los mensajes indexados de Discord. Cada resultado cita su fuente original." (14px, `--text-tertiary`), the search bar (height 54px, magnifier icon at `left:17px`, `--text-muted`), and channel filter chips for the channels the user can access.

**AC2 — Search-bar focus state.** The focused search bar shows `border-color: var(--accent-ink)` and `box-shadow: 0 0 0 3px rgba(245,166,35,0.12)`.

**AC3 — Query → results.** When the user types and the trimmed query has **at least 2 characters**, the app calls `GET /api/search?q=…` (debounced) and renders the result cards below. It shows the result count ("N resultados", IBM Plex Mono 12px, `--text-muted`) and "ordenado por similitud" (mono 11px, `--text-subtle`). A query under 2 chars runs no request and renders neither results nor the empty state.

**AC4 — Result card.** Each card shows: channel badge ("#{channelName}", mono 12px 500, `--accent-ink` on `background: rgba(245,166,35,0.1)`, `padding:3px 9px`, `border-radius:6px`); date (12px, `--text-subtle`); a similarity bar (54×5px, `border-radius:3px`, track `--track`, fill `linear-gradient(90deg,#F5A623,#FFCB6B)` width = similarity %) with the numeric similarity (mono 11.5px, `--text-tertiary`); content (14.5px, `line-height:1.6`, `--text-primary`); author avatar (24px circle, initials, deterministic color) + author name (13px, `--text-tertiary`); and a "ver en Discord" link with an external-link icon (`hover color: #5865F2`) pointing at `https://discord.com/channels/{guildId}/{channelId}/{messageId}`.

**AC5 — Channel chips.** A chip filters the rendered results client-side by channel. The active chip has `background: rgba(245,166,35,0.14)`, `border: 1px solid rgba(245,166,35,0.45)`, `color: var(--accent-ink)`; the inactive chip has `background: var(--surface)`, `border: 1px solid var(--border)`, `color: var(--text-tertiary)`. A "todos" chip clears the filter. Chips are pills (`border-radius:999px`, mono 12.5px 500, `padding:7px 14px`).

**AC6 — Empty state.** When a search returns 0 results, show the empty state: `border: 1px dashed var(--border-strong)`, `border-radius:16px`, centered, with "Sin coincidencias en el conocimiento indexado." (15px, `--text-tertiary`) and the suggestion "Probá con otros términos o consultá al agente en el chat." (13px, `--text-subtle`).

**AC7 — Backend: channels endpoint (dependency).** `GET /api/channels` with a valid session returns `{ channels: [{ id, name }] }` scoped by the caller's roles (RBAC array-overlap inside the query, AD-12). Channels the user cannot access are absent. No session → 401 `{ error, code: "AUTH_REQUIRED" }` from the `/api` gate.

**AC8 — Backend: guildId on /api/auth/me.** `GET /api/auth/me` includes `guildId` (the deployment's Discord guild snowflake, from `config.discord.guild_id`) alongside `id`, `discordId`, `username`, `avatar`.

## Tasks / Subtasks

### Backend — shared contracts first (AD-5, AD-6)

- [x] **Task 1 — `guildId` on the auth contract** (AC: 8)
  - [x] In `packages/shared/src/schemas/auth.ts` add `guildId: z.string()` to `AuthMeResponseSchema` (Discord snowflake).
  - [x] In `packages/backend/src/application/services/authService.ts` `getMe`, include `guildId` in the `AuthMeResponseSchema.parse({...})` object. The service already receives `guildId` via `createAuthService` deps (`const { users, oauth, guildId } = deps;`) — no `app.ts`/controller wiring change needed. Schema + service change **together** (`.parse()` rejects missing keys).
  - [x] Update the stale `GET /api/auth/me` 200 schema in `docs/api-spec.yml` (currently lists `userId`/`discordRoles` — wrong) to the real shape `{ id, discordId, username, avatar, guildId }`.

- [x] **Task 2 — channels shared schema** (AC: 7)
  - [x] Create `packages/shared/src/schemas/channels.ts`:
    ```ts
    import { z } from 'zod';
    export const ChannelSchema = z.object({ id: z.string(), name: z.string() });
    export type Channel = z.infer<typeof ChannelSchema>;
    export const ChannelsResponseSchema = z.object({ channels: z.array(ChannelSchema) });
    export type ChannelsResponse = z.infer<typeof ChannelsResponseSchema>;
    export const CHANNELS_ERROR = { INTERNAL: 'INTERNAL' } as const;
    export type ChannelsErrorCode = (typeof CHANNELS_ERROR)[keyof typeof CHANNELS_ERROR];
    ```
  - [x] Re-export it from `packages/shared/src/schemas/index.ts` (`export * from './channels.js';`) — the `.js` extension mirrors the existing exports.

### Backend — channels endpoint (AC7)

- [x] **Task 3 — repository method** (AC: 7)
  - [x] In `packages/backend/src/domain/repositories/channelPermissionRepository.ts` add to the interface: `findAllowedChannels(discordRoles: string[]): Promise<{ id: string; name: string }[]>;` with a doc comment mirroring `findAllowedChannelIds` (deny-by-default, array overlap).
  - [x] In `packages/backend/src/infrastructure/channelPermissionRepository.drizzle.ts` implement it by mirroring `findAllowedChannelIds`: keep the `if (discordRoles.length === 0) return [];` short-circuit; `.select({ id: channelPermissions.channelId, name: channelPermissions.name })`; same `.where(arrayOverlaps(channelPermissions.allowedRoles, discordRoles))`; map rows to `{ id, name }`. **No `.distinct()`** — `channel_id` is the PK, so one row per channel.

- [x] **Task 4 — service method** (AC: 7)
  - [x] In `packages/backend/src/application/services/rbacService.ts` add to the interface `getAllowedChannels(discordRoles: string[]): Promise<ChannelsResponse>;` and implement it: `const channels = await channelPermissions.findAllowedChannels(discordRoles); return ChannelsResponseSchema.parse({ channels });` (validate against the shared contract before it leaves the service, AD-6 — matches how `getRolesResponse` does it).

- [x] **Task 5 — controller + router** (AC: 7)
  - [x] Create `packages/backend/src/presentation/controllers/channelsController.ts` mirroring `searchController.ts`: `createChannelsController({ rbacService })` returning `{ async list(req, res) }`. Read roles from `req.session.discordRoles ?? []`; `const payload = await rbacService.getAllowedChannels(roles); res.status(200).json(payload);` in a try/catch that logs `[channels] failed:` and returns `res.status(500).json({ error: 'Internal error', code: CHANNELS_ERROR.INTERNAL })`. Do **not** re-add `requireAuth`/RBAC — the `/api` gate handles them.
  - [x] Create `packages/backend/src/routes/channelsRoutes.ts` mirroring `searchRoutes.ts`: `createChannelsRouter(controller)` → `router.get('/', (req, res) => void controller.list(req, res));`.

- [x] **Task 6 — wire into app** (AC: 7)
  - [x] In `packages/backend/src/app.ts`, after the read-status mount (line ~124), build and mount: `const channelsController = createChannelsController({ rbacService });` (reuse the existing `rbacService` already constructed at ~line 77) then `app.use('/api/channels', createChannelsRouter(channelsController));`. Must be **after** the `/api` gate (`app.use('/api', requireAuth, createRbacMiddleware(rbacService));`, line 95) so the route inherits auth + RBAC.
  - [x] Add `GET /api/channels` to `docs/api-spec.yml` (tags `[channels]`, 200 `{ channels: [{id,name}] }`, 401 `$ref BadRequest/Unauthorized`).

### Backend — tests

- [x] **Task 7 — integration tests** (AC: 7, 8)
  - [x] New `packages/backend/src/channels.integration.test.ts` mirroring `rbac.integration.test.ts`/`search.integration.test.ts`: seed `channel_permissions` (via `createDrizzleChannelPermissionRepository(db).upsertMany([...])` or raw SQL) with a **run-unique role/channel suffix** (see Dev Notes — 4.2 cross-suite race); log in via the real `memberOAuth([role])` login→callback flow with `request.agent`; assert `GET /api/channels` → 200 body `{ channels: [{ id, name }] }` scoped to the member's role, an owner-only channel **absent**; assert no-session `request(app).get('/api/channels')` → 401 `AUTH_REQUIRED`. `afterAll` deletes `channel_permissions WHERE channel_id LIKE '<suffix>%'` and the test user by its own `discord_id`.
  - [x] Extend the existing `/api/auth/me` test in `packages/backend/src/auth.integration.test.ts` to assert `res.body.guildId === 'test-guild'` (the value `buildTestAppOptions` sets) alongside the existing fields.

### Frontend — API clients (browser-safe)

- [x] **Task 8 — search + channels API clients** (AC: 3, 7)
  - [x] Create `packages/web/src/api/search.ts` mirroring `api/auth.ts`: `search(q: string, signal?: AbortSignal): Promise<SearchResponse>` → `fetch('/api/search?q=' + encodeURIComponent(q), { credentials: 'include', signal })`; on `!res.ok` throw; `return SearchResponseSchema.parse(await res.json())`. Import **only** from `@hivly/shared/schemas`.
  - [x] Create `packages/web/src/api/channels.ts`: `fetchChannels(): Promise<Channel[]>` → `fetch('/api/channels', { credentials: 'include' })`; `return ChannelsResponseSchema.parse(await res.json()).channels`.

### Frontend — Search view (AC1–AC6)

- [x] **Task 9 — deterministic author color util** (AC: 4)
  - [x] Create `packages/web/src/lib/authorColor.ts`: pure function `authorColor(seed: string): string` that hashes `seed` (simple char-sum) and indexes a fixed palette (e.g. `['#5865F2','#3BA55D','#F5A623','#ED4245','#9B59B6','#1ABC9C','#E67E22','#3498DB']`). Avatar text is white for contrast. Unit-test it (deterministic same-seed → same color).

- [x] **Task 10 — external-link icon** (AC: 4)
  - [x] Add `ExternalLinkIcon` to `packages/web/src/components/icons.tsx` (13px default, stroke 2, paths `M7 17L17 7` + `M8 7h9v9`, per the mockup line 201). Reuse the existing `SearchIcon` (size 19) for the search-bar magnifier.

- [x] **Task 11 — SearchView component** (AC: 1–6)
  - [x] Create `packages/web/src/components/SearchView.tsx` accepting `{ guildId: string }`. State: `query`, `results` (`SearchFragment[]`), `channels` (`Channel[]`), `activeChannelId` (`'all' | channelId`), `status` (`'idle' | 'loading' | 'done' | 'error'`), `searched` (boolean).
  - [x] On mount, `fetchChannels()` into `channels` (guard with an `active` flag as in `App.tsx`); a failure just leaves chips empty — don't block the view.
  - [x] Debounce the query (~250ms). When trimmed length **≥ 2**, call `search(q, signal)` with an `AbortController` (abort the previous in-flight request on each new keystroke); set `results` + `searched=true`. When length < 2, clear `results`, set `searched=false`.
  - [x] Render: header (AC1), search bar with magnifier (AC1/AC2 — see focus class in Task 12), chips row from `['all', ...channels]` (AC5), the count line + "ordenado por similitud" (AC3), the result cards (AC4), and the empty state when `searched && visibleResults.length === 0` (AC6).
  - [x] `visibleResults` = `results` filtered by `activeChannelId` (client-side; `'all'` = no filter) — do **not** re-sort (backend already returns similarity-DESC).
  - [x] Card fields: badge `#{r.channelName}`; date = formatted `r.createdAt` (e.g. `Intl.DateTimeFormat('es', {dateStyle:'medium'})`); similarity bar width `${Math.round(r.similarity*100)}%`, numeric `${r.similarity.toFixed(2)}`; content `r.content`; avatar initials `initialsFromUsername(r.authorName)` + `authorColor(r.authorId)`; name `r.authorName`; link `https://discord.com/channels/${guildId}/${r.channelId}/${r.messageId}` (`target="_blank"`, add `rel="noopener noreferrer"`).

- [x] **Task 12 — hover/focus CSS classes** (AC: 2, 4, 5)
  - [x] Add to `packages/web/src/styles/components.css` (React inline styles can't express `:hover`/`:focus`): `.kh-search-input:focus { border-color: var(--accent-ink); box-shadow: 0 0 0 3px rgba(245,166,35,0.12); }`; `.kh-result-card:hover { border-color: var(--border-hover); }`; `.kh-chip:hover { border-color: var(--border-hover); }`; `.kh-discord-link:hover { color: #5865F2; }`. Follow the existing token/brand-hex conventions in that file.

- [x] **Task 13 — mount the view + thread guildId** (AC: 1)
  - [x] In `packages/web/src/components/AppLayout.tsx` replace the `search` branch of the placeholder render with `<SearchView guildId={guildId} />`; keep the `docs` placeholder untouched (Story 4.4). This means the `<main>` for `search` no longer centers a placeholder — the view manages its own scroll/padding (`padding:34px 40px 60px`, inner `max-width:860px; margin:0 auto`, per mockup). Add `guildId: string` to `AppLayoutProps`.
  - [x] In `packages/web/src/App.tsx` pass `guildId={user.guildId}` to `<AppLayout>` (the `user` object is the `AuthMeResponse`, now carrying `guildId`). No change to `api/auth.ts` code — `AuthMeResponseSchema.parse` picks up the new field automatically.

### Frontend — tests

- [x] **Task 14 — component + client tests** (AC: 1–6)
  - [x] `packages/web/src/components/SearchView.test.tsx` (Vitest + Testing Library, jsdom): mock `../api/search` and `../api/channels` with `vi.mock` (mirror `App.test.tsx`). Assert: header title renders on load; typing ≥2 chars triggers `search` and renders result content + count; <2 chars renders no results/empty; 0-result response renders the empty-state text; clicking a channel chip filters visible cards; the "ver en Discord" link `href` is the correct `discord.com/channels/{guildId}/{channelId}/{messageId}`. Assert with `toBeTruthy()` / `toBeNull()` (no jest-dom matchers in this project).
  - [x] `packages/web/src/lib/authorColor.test.ts` — determinism + palette membership.

### Verification gate (AGENT runs it — mandatory)

- [x] **Task 15** — Run and paste output of `npm run lint && npm run test && npm run build`. Then integration tests (`npm run test:integration` — needs `docker compose up -d postgres redis`). Then smoke the real flow (see Dev Notes → Manual verification). Never mark an AC done without evidence.

### Review Findings

_Code review 2026-07-07 (bmad-code-review, 3 adversarial layers: Blind Hunter + Edge Case Hunter + Acceptance Auditor over the uncommitted working tree, branch feat/4-3-web-app-vista-busqueda, baseline c7ef787). No hard AC violations; all 8 ACs met in static code. 2 decision-needed (both resolved → patch by Borja), 5 patch total, 1 dismissed._

- [x] [Review][Patch] Error/loading states are never rendered — a failed `search()` (network error, 500, or Zod parse failure) sets `status='error'`, `results=[]`, `searched=true`, so the count band (`{searched && …}`) shows "0 resultados" and the empty-state block (which requires `status==='done'`) does NOT render. A failed search is thus indistinguishable from a genuine 0-hit search, and no error is surfaced. `status='loading'` is likewise set but never rendered. **Resolution (Borja):** add an error line when `status==='error'` ("No se pudo completar la búsqueda. Reintentá.") + a loading indicator, and gate the count banner + empty-state on `status==='done'`. `SearchView.tsx:61-73,84,151`. (blind+edge)
- [x] [Review][Patch] Sticky channel filter → false "0 resultados"/empty-state — the query effect resets `results`/`searched`/`status` but never resets `activeChannelId`, and both the count and `showEmptyState` derive from `visibleResults`. If a chip is active and a new query returns matches only in OTHER channels, the view shows "0 resultados" + "Sin coincidencias" despite real matches existing. **Resolution (Borja):** reset `activeChannelId` to `'all'` on query change (count/empty-state stay on `visibleResults`, consistent with the component test). `SearchView.tsx:50-84,166`. (blind+edge+auditor)
- [x] [Review][Patch] Empty `guildId` yields a malformed "ver en Discord" link (`https://discord.com/channels//{channelId}/{messageId}`) — `AuthMeResponseSchema.guildId` is `z.string()` with no `.min(1)`, so an empty-string config value silently breaks every link. Add `.min(1)` to fail fast at `/me`. `packages/shared/src/schemas/auth.ts` (link at `SearchView.tsx:253`). (edge)
- [x] [Review][Patch] `findAllowedChannels` has no `ORDER BY` → nondeterministic channel-chip order across requests/deploys. Add `.orderBy(name)`. `packages/backend/src/infrastructure/channelPermissionRepository.drizzle.ts`. (edge)
- [x] [Review][Patch] Long unbroken content token (long URL/hash, no whitespace) can overflow the result card horizontally — the content `<p>` has no `overflowWrap`/`wordBreak`. Add `overflowWrap:'anywhere'`. `SearchView.tsx:307`. (edge)

## Dev Notes

### Scope shape

This is a **thin full-stack story**: the bulk is the frontend Búsqueda view, plus two small backend additions decided with Borja at creation:
- **`GET /api/channels`** — the filter chips need "all accessible channels" on load, and no channel-list endpoint exists (there is no `channelId` filter on `/api/search` either, so chip filtering is **client-side** over the returned results). Decision: add the endpoint (shared schema + repo method + controller + route + tests). Chips still filter client-side.
- **`guildId` on `/api/auth/me`** — the "ver en Discord" deep link needs `https://discord.com/channels/{guildId}/{channelId}/{messageId}`; the fragment carries `channelId` + `messageId` but not `guildId` (it's deployment config `discord.guild_id`, never exposed to the SPA). Decision: add one `guildId` field to the existing `/me` response (least wiring — the SPA already fetches `/me` on load). This closes the Epic 3 retro action item "Fix the view-in-Discord link convention for grouped chunks … Before Story 4.3": the linked message is the **anchor** `message_ids[0]`, already exposed as `SearchFragment.messageId` (Story 4.1 decision D2).

Both additions live in the correct owners: contracts in `@hivly/shared/schemas` (AD-6), backend read paths through the existing `rbacService` (AD-12 array-overlap inside the query).

### 🔴 CRITICAL: design tokens were renamed — translate the mockup names

The epic ACs and the design mockup `docs/context/design/KeepHive Web.dc.html` use token names `--tx`, `--tx2`…`--tx5`. Story 2.1 **renamed** these when it built the real design system in `packages/web/src/styles/global.css`. The values are identical; **only the names changed.** Use the implemented names:

| Mockup name | Implemented token | Dark value | Light value |
|---|---|---|---|
| `--tx`  | `--text-primary`   | `#E6E9EF` | `#1B1F27` |
| `--tx2` | `--text-secondary` | `#C7CDD8` | `#39414D` |
| `--tx3` | `--text-tertiary`  | `#9AA3B2` | `#5C6573` |
| `--tx4` | `--text-muted`     | `#7C8494` | `#79828F` |
| `--tx5` | `--text-subtle`    | `#646C7C` | `#99A1AD` |

All other tokens the ACs reference already exist unchanged: `--accent-ink`, `--track`, `--border`, `--border-strong`, `--border-hover`, `--surface`, `--bg`, `--on-accent`, `--hover`. Fixed brand hexes (only raw hex allowed): amber `#F5A623`, highlight `#FFCB6B`, Discord `#5865F2`, positive `#3BA55D`, danger `#ED4245`. Do NOT invent `--tx4`/`--tx5` in CSS — they don't exist.

### Frontend architecture & conventions (must follow)

- **No router** (UX-DR5): navigation is in-app state. The `search` screen is already the default (`useState<Screen>('search')` in `App.tsx:35`) and already has a placeholder in `AppLayout.tsx:48-57`. You **replace the `search` placeholder branch**, not add a route. `Screen = 'search' | 'docs'` is defined in `Sidebar.tsx:10`; the "Búsqueda" nav item already exists (`Sidebar.tsx:67`).
- **No data library** (no react-query/SWR — not in `package.json`). Use `useState` + `useEffect` + `fetch`, mirroring the session load in `App.tsx:39-58` (note the `active` unmount guard). For search, also use an `AbortController` to cancel superseded in-flight requests.
- **API client pattern** (`packages/web/src/api/auth.ts`): native `fetch` to same-origin `/api/*`, **`credentials: 'include'`** on every call (session cookie), validate the response with the shared Zod schema (`Schema.parse(await res.json())`), throw on unexpected status. New files `api/search.ts` + `api/channels.ts` mirror it.
- **Import boundary (AD-3, ESLint `no-restricted-imports`)**: from `packages/web` import contracts **only** from `@hivly/shared/schemas`. The root barrel `@hivly/shared` and `/db`, `/config`, `/providers` are banned (pull `pg`/Node into the browser bundle). `@hivly/shared/schemas` already re-exports `search`, `auth`, `documents`, `readStatus`; add `channels` there (Task 2).
- **Hover/focus** cannot be inline styles → add `kh-*` classes to `styles/components.css` (Task 12), following the existing `.kh-nav-item`/`.kh-icon-btn` pattern. Static layout stays inline.
- **Reuse**: `initialsFromUsername` (`lib/initials.ts`) for avatar initials; `SearchIcon` (`icons.tsx`) for the magnifier; the avatar-circle and pill/chip container patterns from `Header.tsx`. Do **not** add an icon library.
- **UI copy is Spanish verbatim** (from the mockup); all identifiers/comments/logs English (project rule).

### Exact search-view spec (source: `KeepHive Web.dc.html` lines 156-216)

- Container: `padding:34px 40px 60px`, inner wrapper `max-width:860px; margin:0 auto`.
- Title `h2`: Space Grotesk 600, 25px, `letter-spacing:-0.02em`. Description `p`: 14px `--text-tertiary`, `margin:7px 0 0`.
- Search bar wrapper `position:relative; margin-top:22px`. Magnifier `span` absolute `left:17px; top:50%; transform:translateY(-50%)`, `--text-muted`. Input: `width:100%; height:54px; padding:0 18px 0 48px; font-size:15px; color:var(--text-primary); background:var(--surface); border:1px solid var(--border-strong); border-radius:14px; outline:none`. Placeholder: `¿Cómo configuro los canales a indexar?`. Focus (class): `border-color:var(--accent-ink); box-shadow:0 0 0 3px rgba(245,166,35,0.12)`.
- Chips row: `margin-top:16px; display:flex; flex-wrap:wrap; gap:8px`. Chip base: `padding:7px 14px; border-radius:999px; font-size:12.5px; font-weight:500; font-family:'IBM Plex Mono',monospace`. Active vs inactive per AC5. Label: `'todos'` for the all-chip, `'#' + name` otherwise.
- Count row: `margin-top:24px; display:flex; justify-content:space-between`. Left: count (mono 12px `--text-muted`). Right: "ordenado por similitud" (mono 11px `--text-subtle`).
- Cards list: `margin-top:14px; display:flex; flex-direction:column; gap:13px`. Card: `padding:18px 20px; background:var(--surface); border:1px solid var(--border); border-radius:14px`, hover `border-color:var(--border-hover)`.
- Card top row (badge+date left, sim-bar+pct right). Similarity bar: outer `width:54px; height:5px; border-radius:3px; background:var(--track); overflow:hidden`, inner `height:100%; width:{pct}; background:linear-gradient(90deg,#F5A623,#FFCB6B); border-radius:3px`.
- Content `p`: `margin:12px 0 0; font-size:14.5px; line-height:1.6; color:var(--text-primary)`.
- Card bottom row (`margin-top:13px`, space-between): avatar 24px circle (`font-size:10.5px; font-weight:600; color:var(--on-accent)` — but use white text over `authorColor`), name (13px `--text-tertiary`); "ver en Discord" `a` (`font-size:12.5px; color:var(--text-muted)`, hover `#5865F2`) + 13px external-link icon.
- Empty state (`margin-top:30px; text-align:center; padding:50px 20px; border:1px dashed var(--border-strong); border-radius:16px`): line 1 (15px `--text-tertiary`) + line 2 (`margin-top:6px; 13px --text-subtle`).

### Backend contracts (from real source — do not redefine locally)

- `SearchQuerySchema` (`packages/shared/src/schemas/search.ts`): `q` (trimmed, min 1, max 1000), `limit` (coerced int, 1–50, default 5). `SearchResponseSchema = { results: SearchFragment[] }`. `SearchFragmentSchema`: `id`(uuid), `content`, `channelId`, `channelName`, `authorId`, `authorName`, `createdAt`(ISO string), `similarity`(0–1), `messageId`. `SEARCH_ERROR = { VALIDATION_ERROR, INTERNAL }`.
- Backend `GET /api/search` accepts **only** `q` and `limit` (no `channelId`). 200 `{ results }`; 400 `{ error: <Spanish msg>, code: 'VALIDATION_ERROR' }`; 500 `{ error:'Internal error', code:'INTERNAL' }`; 401 from the `/api` gate. Empty RBAC scope short-circuits to `{ results: [] }`. The frontend gate (q ≥ 2 chars) means the backend's own min(1)/400 path is not normally hit from this UI.
- `AuthMeResponseSchema` (`packages/shared/src/schemas/auth.ts`) currently `{ id, discordId, username, avatar }` → add `guildId`. `authService.getMe` (authService.ts:55-67) builds & `.parse()`s it; `guildId` already available in `createAuthService` deps.
- `channel_permissions` (`packages/shared/src/db/schema.ts:103-109`): PK `channel_id`; `name notNull`; `allowed_roles text[] notNull`; `category_id` nullable. **One row per channel** → no DISTINCT needed. RBAC filter is `arrayOverlaps(allowedRoles, discordRoles)` (re-exported by `@hivly/shared/db`; backend never imports `drizzle-orm` directly).
- Repo mirror target — `channelPermissionRepository.drizzle.ts:41-53` `findAllowedChannelIds` (short-circuit on empty roles, `arrayOverlaps` where). Service mirror target — `rbacService.ts` `getRolesResponse` (validates with `AuthRolesResponseSchema.parse`). Controller/router mirror target — `searchController.ts` + `searchRoutes.ts`. Composition root — `createApp` in `app.ts` (repos→services→controllers→routers inline; `rbacService` at ~line 77, mounts after the `/api` gate at line 95).

### Author display (deferred state)

Story 4.1 deferred real author display-names/avatars (no data source persisted — the bot stores only `authorId`, so `SearchFragment.authorName === authorId` today). Decision: render `authorName` as-is (forward-compatible: when the bot later persists usernames, the field populates with **zero frontend change**); derive avatar initials via `initialsFromUsername(authorName)` and a deterministic color via `authorColor(authorId)`. Do not build a display-name lookup — it stays deferred.

### Testing standards

- Frontend: Vitest + `@testing-library/react` in jsdom. **No jest-dom matchers** (`toBeTruthy()`/`toBeNull()`, not `toBeInTheDocument()`). Mock the api module with `vi.mock('../api/search', …)` (see `App.test.tsx` for the `importOriginal` spread + `vi.mocked` pattern). **jsdom does not apply external CSS** — AC2's focus `box-shadow` and the token colors can't be asserted in unit tests; verify them manually in the browser (Task 15).
- Backend integration: `vitest` + `supertest` against **real** Postgres+Redis. Build the app with `createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([...]) }))`. Drive the real login→callback flow with `request.agent` to get a real Redis session (roles passed to `memberOAuth` become `req.session.discordRoles`). Seed `channel_permissions` via the repo or raw SQL. `buildTestAppOptions` sets `guildId: 'test-guild'`.
- **Always test RBAC**: `/api/channels` must never return a channel outside the caller's role scope.

### 🔴 Test-isolation gotcha (learned in 4.2 — do NOT repeat)

Integration suites share one real Postgres. Two traps found in 4.2:
1. Cleanup scoped too broadly (`discord_id LIKE 'itest-%'`) races other `itest-*` suites → intermittent FK 500s. Scope `afterAll` deletes to **this suite's own** ids.
2. RBAC expansion resolves against the **whole** `channel_permissions` table — a shared literal role like `'member'` leaks other suites' channels into scope. For `/api/channels` (which asserts the *full* scope), use a **run-unique role + channel-id suffix** (see `search.integration.test.ts:19` for the suffix pattern) so another suite's rows can't inflate the result.

### Project Structure Notes

- New files: `packages/shared/src/schemas/channels.ts`; `packages/backend/src/presentation/controllers/channelsController.ts`, `.../routes/channelsRoutes.ts`, `.../channels.integration.test.ts`; `packages/web/src/api/search.ts`, `api/channels.ts`, `lib/authorColor.ts`, `lib/authorColor.test.ts`, `components/SearchView.tsx`, `components/SearchView.test.tsx`.
- Modified: `packages/shared/src/schemas/{auth.ts,index.ts}`; `packages/backend/src/{application/services/authService.ts, application/services/rbacService.ts, domain/repositories/channelPermissionRepository.ts, infrastructure/channelPermissionRepository.drizzle.ts, app.ts, auth.integration.test.ts}`; `packages/web/src/{App.tsx, components/AppLayout.tsx, components/icons.tsx, styles/components.css}`; `docs/api-spec.yml`.
- **No DB migration** (read-only over `channel_permissions`; no schema change). **No `Screen` union / sidebar change** in this story (the badge on "Documentos" is Story 4.4). **No `channelId` param added to `/api/search`** (chip filtering is client-side).
- Naming: modules `camelCase.ts`, React components `PascalCase.tsx`; endpoints `/api/<resource>` kebab plural.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Historia 4.3] — the seven ACs and the epic goal.
- [Source: docs/context/design/KeepHive Web.dc.html lines 156-216, 503, 640-745] — the pixel-exact Búsqueda mockup, `this.channels` filter list, `chipStyle`, client-side channel filter.
- [Source: packages/shared/src/schemas/search.ts] — `SearchQuerySchema`, `SearchFragmentSchema`, `SearchResponseSchema`, `SEARCH_ERROR`.
- [Source: packages/shared/src/schemas/auth.ts] — `AuthMeResponseSchema` (+ `guildId` to add).
- [Source: packages/shared/src/db/schema.ts:103-109] — `channel_permissions` (PK `channel_id`, `allowed_roles text[]`).
- [Source: packages/backend/src/infrastructure/channelPermissionRepository.drizzle.ts:41-53] — `findAllowedChannelIds` (mirror target).
- [Source: packages/backend/src/application/services/rbacService.ts] — `getRolesResponse` (validation pattern).
- [Source: packages/backend/src/presentation/controllers/searchController.ts + routes/searchRoutes.ts] — controller/router mirror.
- [Source: packages/backend/src/app.ts:76-124] — composition root, mount order, `/api` RBAC gate.
- [Source: packages/backend/src/application/services/authService.ts:55-67 + main.ts:64-77] — `getMe` + `guildId` already injected.
- [Source: packages/web/src/api/auth.ts] — fetch-client pattern to mirror.
- [Source: packages/web/src/App.tsx, components/AppLayout.tsx, components/Sidebar.tsx, styles/components.css, lib/initials.ts, components/icons.tsx] — files to modify/reuse.
- [Source: packages/backend/src/rbac.integration.test.ts + search.integration.test.ts + test-helpers.ts] — integration test + seeding + `buildTestAppOptions` (`guildId:'test-guild'`).
- [Source: _bmad-output/implementation-artifacts/sprint-status.yaml lines 45-51] — Story 4.1/4.2 learnings (D1/D2 anchor, test-isolation race).
- Invariants: AD-3 (static SPA, browser-safe imports), AD-6 (Zod contracts in shared), AD-12 (RBAC inside the query) — `docs/context/ARCHITECTURE-SPINE.md`.

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (bmad-dev-story, 2026-07-07)

### Debug Log References

- `npm run lint` → 0 problems.
- `npm run test` (unit + web, jsdom) → 45 files, 327 tests passed (313 pre-existing + 14 new: 4 channels.ts schema + 4 channelPermissionRepository.drizzle + 3 rbacService.getAllowedChannels + 3 channelsController + 4 authorColor + 6 SearchView, plus 1 pre-existing authService test updated for `guildId`).
- `npm run build` (all workspaces) → `tsc --noEmit` clean for shared/backend/bot/workers; `vite build` clean for web.
- `npm run test:integration` (real Postgres + pgvector + Redis via `docker compose up -d postgres redis`) → 13 files, 71 tests passed (68 pre-existing + 3 new in `channels.integration.test.ts`; `auth.integration.test.ts` extended with the `guildId` assertion).
- Manual smoke of the real backend slice: started the real Express app (`createApp`) against real Postgres/Redis with an injected fake Discord OAuth client (no real Discord credentials available in this environment), drove the actual HTTP login→callback flow, then curled the live endpoints:
  - `GET /api/auth/me` → `200 { id, discordId, username, avatar, guildId: 'test-guild' }`.
  - `GET /api/channels` (member scoped to a seeded role) → `200 { channels: [{ id, name }] }`, correctly RBAC-scoped.
  - `GET /api/channels` without a session → `401 { error, code: 'AUTH_REQUIRED' }`.
  - The scratch script was deleted after the smoke; not part of the File List.
- **Gap — not verified**: real-browser visual verification of the SearchView (AC1 fonts/spacing, AC2 focus `box-shadow`, exact token colors on AC4/AC5) was **not performed** — this environment has no browser-automation tool and no real Discord OAuth credentials to complete a full login through the actual SPA. jsdom (used by the component tests) does not apply external CSS, so these visual details are unverified by any test in this story. Recommend Borja do a quick manual pass in the browser (`npm run dev -w @hivly/backend` + `npm run dev -w @hivly/web`, login via real Discord) before merging, per the project's own testing-rules note that CSS/token application must be checked manually.

### Completion Notes List

- Backend: added `guildId` to `AuthMeResponseSchema` + `authService.getMe` (Task 1); new `channels` shared schema (Task 2); `findAllowedChannels` repo method mirroring `findAllowedChannelIds` (Task 3); `rbacService.getAllowedChannels` (Task 4); `channelsController`/`channelsRoutes` mirroring `searchController`/`searchRoutes` (Task 5); wired `/api/channels` into `app.ts` after the `/api` RBAC gate, reusing the existing `rbacService` instance (Task 6). `docs/api-spec.yml` updated for both `/api/auth/me` (real shape) and the new `/api/channels` path + `channels` tag.
- Backend tests: new `channels.integration.test.ts` using a run-unique role/channel suffix (not the shared `'member'` literal) per the Story 4.2 test-isolation gotcha, since this suite asserts the *full* RBAC scope; extended `auth.integration.test.ts` for `guildId`; added unit tests for the new repo method, service method, and controller; updated the pre-existing `authService.test.ts` and `rbacService.test.ts` fakes for the new `guildId`/`findAllowedChannels` contract surface.
- Frontend: `api/search.ts` + `api/channels.ts` mirroring `api/auth.ts`; `lib/authorColor.ts` (deterministic char-sum hash over a fixed 8-color palette); `ExternalLinkIcon` added to `icons.tsx`; `SearchView.tsx` — debounced (250ms) query with an `AbortController` cancelling the previous in-flight request, channel chips filtering client-side (no `channelId` param on `/api/search`), result cards per the exact mockup spec (badge, date, similarity bar, content, avatar+author, "ver en Discord" link), and the dashed-border empty state. Mounted in `AppLayout.tsx` replacing the `search` placeholder branch (the `docs` placeholder is untouched — Story 4.4); `App.tsx` now threads `user.guildId` through.
- Design-token translation followed per the story's critical note: mockup `--tx`/`--tx4`/`--tx5` map to `--text-primary`/`--text-muted`/`--text-subtle` (renamed by Story 2.1); no new tokens invented.
- All 15 tasks/subtasks completed and checked. Gate green: lint 0 / 327 unit (+14) / build clean / 71 integration (+3). No DB migration (channels endpoint is read-only over the existing `channel_permissions` table).

### File List

**New:**
- `packages/shared/src/schemas/channels.ts`
- `packages/shared/src/schemas/channels.test.ts`
- `packages/backend/src/presentation/controllers/channelsController.ts`
- `packages/backend/src/presentation/controllers/channelsController.test.ts`
- `packages/backend/src/routes/channelsRoutes.ts`
- `packages/backend/src/channels.integration.test.ts`
- `packages/web/src/api/search.ts`
- `packages/web/src/api/channels.ts`
- `packages/web/src/lib/authorColor.ts`
- `packages/web/src/lib/authorColor.test.ts`
- `packages/web/src/components/SearchView.tsx`
- `packages/web/src/components/SearchView.test.tsx`

**Modified:**
- `packages/shared/src/schemas/auth.ts`
- `packages/shared/src/schemas/auth.test.ts`
- `packages/shared/src/schemas/index.ts`
- `packages/backend/src/application/services/authService.ts`
- `packages/backend/src/application/services/authService.test.ts`
- `packages/backend/src/application/services/rbacService.ts`
- `packages/backend/src/application/services/rbacService.test.ts`
- `packages/backend/src/domain/repositories/channelPermissionRepository.ts`
- `packages/backend/src/infrastructure/channelPermissionRepository.drizzle.ts`
- `packages/backend/src/infrastructure/channelPermissionRepository.drizzle.test.ts`
- `packages/backend/src/app.ts`
- `packages/backend/src/auth.integration.test.ts`
- `packages/web/src/App.tsx`
- `packages/web/src/App.test.tsx`
- `packages/web/src/components/AppLayout.tsx`
- `packages/web/src/components/icons.tsx`
- `packages/web/src/styles/components.css`
- `docs/api-spec.yml`

## Change Log

- 2026-07-07 (bmad-dev-story): Implemented the Búsqueda view (SearchView) and its
  two small backend dependencies — `GET /api/channels` (RBAC-scoped, AD-12) and
  `guildId` on `GET /api/auth/me` — closing the Epic 3 retro action item on the
  view-in-Discord link convention. First frontend story of Epic 4. Status → review.
