---
baseline_commit: 784c1e514e5ebfe50f956ef711f37ccd1284cb4c
---

# Story 2.4: RBAC, protección de rutas y conexión UI

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a member of the Discord community,
I want the app to show only the content I have access to according to my Discord roles,
so that the guild's private channels stay protected.

This is the **last story of Epic 2**. It closes the auth loop opened by Story 2.3
(backend OAuth2 + Redis sessions) by adding the per-request RBAC expansion, the
generic `/api/*` auth gate, the `channel_permissions` startup materialization, the
`GET /api/auth/roles` endpoint, **and** replaces the mock login in `packages/web`
with the real session flow.

## Acceptance Criteria

1. **`channel_permissions` materialized at startup.** On backend boot, the service upserts `channel_permissions` from `config.access_control.channel_permissions` **before accepting any request**. `default_policy: "deny"` means a user with no matching rule resolves to `allowedChannelIds = []` (this is the natural result of the roles↔permissions join — no separate deny branch needed).
2. **Generic auth gate on `/api/*`.** Any request to `/api/*` **except** `/api/auth/*` and `/health`, when processed without a valid Redis session, returns HTTP 401 `{ error: "Unauthorized", code: "AUTH_REQUIRED" }` (shape from `@share2brain/shared` `ErrorSchema` + `AUTH_ERROR.AUTH_REQUIRED`).
3. **Per-request RBAC expansion.** With a valid session, on **every** request the middleware joins `session.discordRoles` against `channel_permissions` with `WHERE allowed_roles && discordRoles` (array overlap), attaches `req.allowedChannelIds` for handlers, and recomputes it **per request** (never cached in the session), so a config/permission change takes effect on the next request.
4. **`GET /api/auth/roles`.** With a valid session, returns HTTP 200 `{ roles: string[], allowedChannels: string[] }` (the user's Discord roles and the channel IDs they can access). Without a valid session → 401 `AUTH_REQUIRED`.
5. **Web shows the authenticated layout from a real session.** When the SPA loads with a valid session cookie present, it calls `GET /api/auth/me`; on 200 it renders the authenticated layout (sidebar + header) with the user's **name and initials** derived from the real profile. The community name in the header comes from configuration (see Dev Notes → "Community name in a static SPA"). On 401 it renders the login screen.
6. **Real login/logout wiring.** The "Continuar con Discord" button navigates the browser to `GET /api/auth/login` (full-page redirect, not fetch). When the user clicks logout and `POST /api/auth/logout` succeeds, the app renders the login screen, and any subsequent `/api/*` request from that session returns HTTP 401.

## Tasks / Subtasks

- [x] **Task 1 — Shared: roles contract + array-overlap helper re-export** (AC: 3, 4) — scope: `shared` (AD-6)
  - [x] In `packages/shared/src/schemas/auth.ts` add: `export const AuthRolesResponseSchema = z.object({ roles: z.array(z.string()), allowedChannels: z.array(z.string()) })` and `export type AuthRolesResponse = z.infer<typeof AuthRolesResponseSchema>`. Already re-exported via `schemas/index.ts` (`export * from './auth.js'`) — no barrel change needed.
  - [x] Extend the existing `AUTH_ERROR` map with `RBAC_EXPANSION_FAILED: 'RBAC_EXPANSION_FAILED'` (used when the per-request join throws — mapped to a structured 500, never a raw DB error).
  - [x] Extend `packages/shared/src/schemas/auth.test.ts` with a parse/round-trip case for `AuthRolesResponseSchema` (empty arrays + populated).
  - [x] In `packages/shared/src/db/index.ts` add `export { arrayOverlaps } from 'drizzle-orm';` right beside the existing `export { sql } from 'drizzle-orm';`. Rationale is identical to why `sql` is re-exported: services depend only on `@share2brain/shared` (AD-2) and must not import `drizzle-orm` directly. `arrayOverlaps` is confirmed present in the installed `drizzle-orm` (`arrayOverlaps(col, values)`).

- [x] **Task 2 — Backend domain port: `ChannelPermissionRepository`** (AC: 1, 3) — pure interface, no external deps
  - [x] Create `packages/backend/src/domain/repositories/channelPermissionRepository.ts` exporting the interface:
    ```ts
    export interface ChannelPermissionInput { channelId: string; name: string; allowedRoles: string[]; categoryId?: string | null }
    export interface ChannelPermissionRepository {
      upsertMany(perms: ChannelPermissionInput[]): Promise<void>;
      findAllowedChannelIds(discordRoles: string[]): Promise<string[]>;
    }
    ```
  - [x] No Drizzle import here (contract only) — mirrors `userRepository.ts` from Story 2.3.

- [x] **Task 3 — Backend infrastructure: Drizzle impl** (AC: 1, 3) — implements the port
  - [x] Create `packages/backend/src/infrastructure/channelPermissionRepository.drizzle.ts` → `createDrizzleChannelPermissionRepository(db: Database): ChannelPermissionRepository`. Import `channelPermissions` from `@share2brain/shared/db` and `arrayOverlaps` from `@share2brain/shared/db`.
  - [x] `upsertMany(perms)`: if `perms` is empty, return early. Otherwise `db.insert(channelPermissions).values(rows).onConflictDoUpdate({ target: channelPermissions.channelId, set: { name: ..., allowedRoles: ..., categoryId: ... } })`. `categoryId` defaults to `null` (see Dev Notes — the config schema has no `category_id` field). `channelId` is the PK, so it is the conflict target. Consider a single multi-row insert with per-row `set` via `sql`/excluded, or loop per row — pick the simplest correct form and keep it idempotent.
  - [x] `findAllowedChannelIds(discordRoles)`: **short-circuit** — if `discordRoles.length === 0` return `[]` immediately (avoids a needless query and the empty-array cast edge). Otherwise `db.select({ channelId: channelPermissions.channelId }).from(channelPermissions).where(arrayOverlaps(channelPermissions.allowedRoles, discordRoles))` and map to `r.channelId`. This is the `WHERE allowed_roles && discordRoles` overlap from the ACs and TECHNICAL-DESIGN §5.4.

- [x] **Task 4 — Backend application: `RbacService`** (AC: 3, 4) — orchestration, depends on the port
  - [x] Create `packages/backend/src/application/services/rbacService.ts` → `createRbacService(deps: { channelPermissions: ChannelPermissionRepository })` exposing:
    - `expandAllowedChannelIds(discordRoles: string[]): Promise<string[]>` → delegates to `channelPermissions.findAllowedChannelIds`.
    - `getRolesResponse(discordRoles: string[]): Promise<AuthRolesResponse>` → `{ roles: discordRoles, allowedChannels: await expandAllowedChannelIds(discordRoles) }`, validated with `AuthRolesResponseSchema.parse(...)` before returning (AD-6, mirrors `authService.getMe`).
  - [x] Depends only on the domain interface (no `db`, no `express`) so it is unit-testable with a plain fake repo — same pattern as `authService` (Story 2.3).

- [x] **Task 5 — Backend middleware: `requireAuth` + `attachAllowedChannelIds`** (AC: 2, 3) — new `src/middleware/` layer
  - [x] Create `packages/backend/src/middleware/requireAuth.ts` → `requireAuth(req, res, next)`: if `!req.session.userId` respond 401 `{ error: 'Unauthorized', code: AUTH_ERROR.AUTH_REQUIRED }`; else `next()`.
  - [x] Create `packages/backend/src/middleware/rbac.ts` → `createRbacMiddleware(rbac: RbacService)` returning an async handler: read `req.session.discordRoles ?? []`, `req.allowedChannelIds = await rbac.expandAllowedChannelIds(roles)`, then `next()`. On a thrown DB error, map to 500 `{ error: 'Internal error', code: AUTH_ERROR.RBAC_EXPANSION_FAILED }` (try/catch — never leak the raw error, per the language rule).
  - [x] Augment the Express request type — add `packages/backend/src/middleware/request-augment.d.ts` (or inline in `rbac.ts`): `declare module 'express-serve-static-core' { interface Request { allowedChannelIds?: string[] } }`. This is the ONLY place `allowedChannelIds` is typed on the request (mirrors how `SessionData` is augmented once in `sessionStore.ts`).

- [x] **Task 6 — Backend presentation + routes: `/api/auth/roles` and the generic gate** (AC: 2, 4) — wire into `createApp`
  - [x] Add a `roles` handler. Simplest: extend `createAuthController` deps with `rbacService` and add a `roles(req, res)` handler → 401 if no `req.session.userId` (defensive; the route also runs `requireAuth`), else `res.status(200).json(await rbacService.getRolesResponse(req.session.discordRoles ?? []))` wrapped in try/catch → 500 `RBAC_EXPANSION_FAILED`.
  - [x] In `authRoutes.ts` add `router.get('/roles', requireAuth, (req, res) => void controller.roles(req, res))`. `/api/auth/roles` is under the auth router, so it is **exempt from the generic gate** (AC2 excludes `/api/auth/*`) but enforces its own auth via the route-level `requireAuth`.
  - [x] In `app.ts` (composition root), **after** `app.use('/api/auth', createAuthRouter(...))`, register the generic gate: `app.use('/api', requireAuth, createRbacMiddleware(rbacService))`. Ordering is load-bearing — see Dev Notes → "Middleware ordering & the `/api/auth` exemption". Compose `rbacService` from `createDrizzleChannelPermissionRepository(db)` in the same composition block that already builds `authService`.

- [x] **Task 7 — Backend startup: materialize `channel_permissions` before listen** (AC: 1)
  - [x] Create `packages/backend/src/infrastructure/materializeChannelPermissions.ts` (or add an exported function) that maps `config.access_control.channel_permissions` (`{ channel_id, name, allowed_roles }`) to `ChannelPermissionInput` (`{ channelId, name, allowedRoles, categoryId: null }`) and calls `repo.upsertMany(...)`.
  - [x] In `main.ts`: make `main` `async`. After `createDatabase(...)` and before `app.listen(...)`, `await` the materialization. **This is the first DB query** — if it throws (DB unreachable), abort startup (log + `process.exit(1)`); do NOT start listening with an unmaterialized RBAC table. This is correct because Compose gates the backend on `depends_on: { migrator: service_completed_successfully }` and the postgres healthcheck — DB is expected up. (Redis still connects in the background as in 2.3; only the DB-backed upsert blocks listen.)
  - [x] Keep `loadConfig()` first (AD-8), then the `requireEnv(...)` calls, unchanged. The try/catch around `main()` already converts a thrown error into `exit(1)` — verify the async version still surfaces the rejection (wrap the `await` or add `.catch` on `main()`).

- [x] **Task 8 — Frontend: replace the mock login with the real session flow** (AC: 5, 6) — `packages/web`
  - [x] Create `packages/web/src/api/auth.ts` — a tiny fetch client (browser-safe; import types/codes only from `@share2brain/shared/schemas`, never the root barrel or `/db` — ESLint enforces this, see Dev Notes):
    - `fetchMe(): Promise<AuthMeResponse | null>` → `fetch('/api/auth/me', { credentials: 'include' })`; 200 → `AuthMeResponseSchema.parse(json)`; 401 → `null`; else throw.
    - `logout(): Promise<void>` → `fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })`.
    - `LOGIN_URL = '/api/auth/login'` (same-origin path; works via nginx in prod and the Vite proxy in dev — see Dev Notes).
  - [x] Rewrite `App.tsx`: replace the `MOCK_LOGIN_DELAY_MS`/`setTimeout` mock with real state — `authState: 'loading' | 'anon' | 'authed'` and `user: AuthMeResponse | null`. On mount (`useEffect`), call `fetchMe()`: 200 → `authed`; 401/null → `anon`. While `loading`, render a minimal loading state (reuse the login card's spinner idiom or a neutral splash — do not flash the login screen before the check resolves). `onLogin` → `window.location.href = LOGIN_URL`. `onLogout` → `await logout()` then set `anon` and reset screen to `search`.
  - [x] Derive header display data from the real profile: `name = user.username`; `initials` = first two alphanumeric chars of `username` uppercased (or first letters of the first two whitespace-separated words) — put this in a small pure helper and unit-test it. Pass `user.avatar` through if you choose to render it, else keep the initials avatar.
  - [x] **Community name** in the header: comes from a build-time Vite env var `VITE_COMMUNITY_NAME` (`import.meta.env.VITE_COMMUNITY_NAME ?? 'Share2Brain'`). See Dev Notes → "Community name in a static SPA" for why this, not a backend call. `statsLine` stays a placeholder (real stats are Epic 4) — keep a neutral placeholder string, not fake numbers, or hide it until Epic 4.
  - [x] Add the dev proxy so the SPA and the auth flow are same-origin in dev — see Dev Notes → "Dev cookies & the Vite proxy (critical)". Update `packages/web/vite.config.ts` `server.proxy` for `/api` (and `/health`) → `http://localhost:3000`.
  - [x] **REGRESSION:** `App.test.tsx` is built entirely around the mock (`MOCK_LOGIN_DELAY_MS`, `fireEvent.click` login, fake timers). Rewrite it to mock `fetch` (or mock `./api/auth`): assert the loading→anon path (fetch 401 → login screen), the loading→authed path (fetch 200 → shell with the real username), and logout (POST → back to login). Remove the `MOCK_LOGIN_DELAY_MS` export and its assertions. Keep the nav-switching and theme tests (adapt to the authed state).

- [x] **Task 9 — Tests** (AC: 1, 2, 3, 4, 6)
  - [x] **Unit (backend):** `application/services/rbacService.test.ts` — inject a fake `ChannelPermissionRepository`: `expandAllowedChannelIds(['admin'])` returns the repo's ids; empty roles → `[]`; `getRolesResponse` returns the parsed `{ roles, allowedChannels }` shape. `infrastructure/channelPermissionRepository.drizzle.test.ts` may follow the `health.test.ts` double pattern (`vi.fn()` cast `as unknown as Database`) to assert the empty-roles short-circuit and the query shape — or defer the query assertion to the integration test (adapter glue may test after).
  - [x] **Unit (backend middleware):** `middleware/requireAuth.test.ts` — no `session.userId` → 401 `AUTH_REQUIRED` (assert `res.status`/`res.json` doubles), with `userId` → `next()` called. Behavior-driven names, AAA.
  - [x] **Integration (backend, real Postgres + Redis, supertest):** extend `auth.integration.test.ts` or add `rbac.integration.test.ts`. Seed `channel_permissions` (via the materialization function or direct insert) then, using the member-login agent from the existing helper: (a) `GET /api/auth/roles` with a session whose roles overlap a channel → 200 `{ roles, allowedChannels }` with the expected channel; (b) `GET /api/auth/roles` without a session → 401 `AUTH_REQUIRED`; (c) **the generic gate** — `GET /api/some-protected` (any non-auth `/api/*` path — no route need exist; `app.use('/api', requireAuth)` fires before routing) without a session → 401 `AUTH_REQUIRED`; (d) **per-request recompute** — change `channel_permissions` between two `/roles` calls on the same session and assert `allowedChannels` changes (proves it is not cached in the session). Reuse `openTestClients()`/`buildTestAppOptions({ oauth: memberOAuth() })`; clean up seeded `channel_permissions` rows in `afterAll` (`DELETE FROM channel_permissions WHERE channel_id LIKE 'itest-%'`).
  - [x] **Unit (web):** the initials helper test; the rewritten `App.test.tsx` (mocked fetch) covering loading→anon, loading→authed, and logout.
  - [x] RBAC is a security boundary — explicitly test that a user whose roles do NOT intersect a channel's `allowed_roles` does NOT get that channel id (backend-standards §Testing example).

- [x] **Task 10 — Verification gate (agent runs it, pastes output)** (AC: all)
  - [x] `npm run lint && npm run test && npm run build` — all green, paste output.
  - [x] `docker compose up -d postgres redis && npm run test:integration` — paste output.
  - [x] Manual end-to-end where possible (see Dev Notes → "Manual verification"). Restore any seeded data.

## Dev Notes

### Scope boundary — what this story does and does NOT do
- **IN scope (2.4):** `channel_permissions` startup materialization; the generic `requireAuth` gate over `/api/*`; the per-request `attachAllowedChannelIds` RBAC expansion (`req.allowedChannelIds`); `GET /api/auth/roles`; the shared `AuthRolesResponseSchema`; and the **real** frontend auth wiring in `packages/web` (replace the mock login, add the Vite dev proxy). This closes Epic 2.
- **OUT of scope (do NOT implement here):**
  - The **vector-query RBAC filter** itself (AD-12: `WHERE channel_id = ANY(:allowedChannelIds)` inside the pgvector query). That lives in the search/chat handlers (Epic 4 / Epic 5). This story only *produces* `req.allowedChannelIds`; nothing consumes it yet. Do not add search/documents/chat routes.
  - `user_roles_cache` population — the session already carries `discordRoles`; the join goes straight to `channel_permissions`. Leave that table untouched (as in 2.3).
  - `default_policy: "allow"` semantics and the `access_control.enabled: false` bypass — the ACs only exercise `deny` (the join's natural behavior). Do not build an allow-all branch or a disable switch; note it as future work if you touch that code.
  - Rate-limiting middleware (`security.rate_limit`) — a later hardening story.
  - Real `statsLine`/message counts and the "indexing live" status wiring — Epic 4.

### Current state — extend Story 2.3, don't reinvent (DDD by layer)
Story 2.3 established the backend DDD layout. Extend the **same** layers; do not restructure.
- `packages/backend/src/app.ts` — the composition root. It builds `createDrizzleUserRepository(db)` → `createAuthService(...)` → `createAuthController(...)` and mounts `cors → express.json → session → app.use('/api/auth', authRouter)`. This is exactly where you add the `channelPermissionRepository` → `rbacService`, extend the controller with `rbacService`, and register `app.use('/api', requireAuth, createRbacMiddleware(rbacService))` **after** the auth router. `createApp(db, redis, opts: AppOptions)` — do NOT change its signature (integration tests + `main.ts` depend on it; a 3rd-arg change was the 2.3 regression).
- `packages/backend/src/main.ts` — `loadConfig()` first (AD-8), `requireEnv(...)`, `createDatabase`, background `redis.connect()`, `createApp(...).listen()`. You make `main` async and `await` the channel-permissions materialization before `listen` (Task 7). The single `db`/`redis` instances are reused — do not open new clients.
- `packages/backend/src/presentation/controllers/authController.ts` — the factory-of-handlers pattern to mirror (`createAuthController(deps)` returns `{ login, callback, me, logout }`). Add `roles`. Handlers own HTTP concerns and map errors to `ErrorSchema`; raw Discord/DB errors are never leaked.
- `packages/backend/src/infrastructure/userRepository.drizzle.ts` — the Drizzle repo pattern to mirror for `channelPermissionRepository.drizzle.ts` (`create...(db): Repo`, `onConflictDoUpdate` on a unique/PK target, `returning`/`select`).
- `packages/backend/src/application/services/authService.ts` — the "depends only on the domain interface, validates output with a shared Zod schema" pattern to mirror for `rbacService.ts`.
- `packages/backend/src/test-helpers.ts` — `openTestClients()` (real pg + node-redis) and `buildTestAppOptions(overrides)`. Reuse both; `buildTestAppOptions({ oauth: memberOAuth() })` injects a fake Discord client so tests never hit real Discord.
- `packages/backend/package.json` — deps `@share2brain/shared`, `express@^5.2`, `redis@^6`, `connect-redis@^9`, `express-session@^1.18`, `cors@^2.8`; no new backend dependency is required for this story (the RBAC query uses `arrayOverlaps` re-exported from `@share2brain/shared/db`).

### The RBAC expansion query — the gotcha
- Use `arrayOverlaps(channelPermissions.allowedRoles, discordRoles)` (the `&&` Postgres array-overlap operator), imported from `@share2brain/shared/db` (Task 1 re-exports it, mirroring the existing `sql` re-export so the backend stays AD-2-clean and typed). TECHNICAL-DESIGN §5.4 shows the raw `sql\`${...allowedRoles} && ${discordRoles}\`` form — prefer the typed `arrayOverlaps` helper over hand-rolled `sql` to avoid the empty-array/param-cast pitfalls.
- **Empty roles:** short-circuit `discordRoles.length === 0` → return `[]` before querying. Passing an empty JS array into the overlap operator risks a Postgres `operator does not exist` / cast ambiguity, and the result is trivially `[]` anyway (deny-by-default). This directly satisfies AC1's "no explicit rule ⇒ `allowedChannelIds = []`".
- **This is NOT the AD-12 vector-query filter.** AD-12 requires the RBAC filter *inside the pgvector query*. This story only computes `req.allowedChannelIds` in middleware; Epic 4/5 handlers will pass it into `inArray(embeddings.channelId, req.allowedChannelIds)`. Don't confuse the two — do not add a post-filter anywhere.

### `channel_permissions` data & config mapping
- Table (`packages/shared/src/db/schema.ts:87-92`, owner: backend): `channelId` (PK, snowflake), `name` (notNull), `allowedRoles` (`text[]`, notNull), `categoryId` (nullable). Already migrated — **no schema change or migration for this story**.
- Config source (`config.access_control.channel_permissions`, validated by `ChannelPermissionSchema` in `packages/shared/src/config/index.ts:28-32`): each entry is `{ channel_id, name, allowed_roles }`. **The config schema has NO `category_id` field** → map `categoryId: null` in the upsert. (If category support is ever needed it's a shared-config change, out of scope here.)
- `default_policy`, `role_cache_ttl`, `enabled` also live under `access_control` but are **not** consumed by this story (see scope boundary).

### Middleware ordering & the `/api/auth` exemption (load-bearing)
Register in `createApp` in this exact order:
```
app.get('/health', ...)                         // top-level, auth-exempt (unchanged from 2.3)
app.use(cors(...)); app.use(express.json()); app.use(session(...));   // unchanged
app.use('/api/auth', createAuthRouter(...));    // handles its own auth semantics → EXEMPT from the gate
app.use('/api', requireAuth, createRbacMiddleware(rbacService));      // the generic gate for everything else
// future Epic 4/5: app.use('/api/search', ...) etc. run AFTER the gate, so they inherit it
```
- `/api/auth/login|callback` are public and `/api/auth/me|logout|roles` enforce their own session checks — all handled by the auth router, which is registered **before** the gate and short-circuits (sends a response, no `next()`), so the `/api` gate never runs for matched auth routes. ✔ AC2 "except `/api/auth/*`".
- `/health` is registered top-level (not under `/api`) → never hits the gate. ✔ AC2 "except `/health`".
- `app.use('/api', requireAuth)` fires for **any** `/api/*` request, including paths with no defined route — so the 401 gate is testable *now* via any non-auth `/api/*` path (e.g. `GET /api/anything` → 401 without a session, 404 with one). This is how AC2 is verified before Epic 4 adds real routes.

### Frontend: replacing the mock (AC5, AC6)
- `App.tsx` currently owns `authed`/`loggingIn`/`screen`/theme and passes display data (`COMMUNITY_NAME`, `STATS_LINE`, `USER`) as props to `AppLayout`/`Header`. Keep that shape — it was deliberately designed so 2.4 swaps the mock for a fetch "without restructuring the components" (see the 2.3-era comment in `App.tsx`). Only `App.tsx`, a new `api/auth.ts`, a tiny initials helper, `App.test.tsx`, and `vite.config.ts` change; `Header`/`AppLayout`/`Sidebar`/`LoginScreen` stay as-is (they are pure presentational props consumers).
- `LoginScreen` already takes `{ loggingIn, onLogin }`. For the real flow, `onLogin` becomes `window.location.href = '/api/auth/login'` (a full navigation — the browser must leave the SPA so Discord can redirect back). You can drop the `loggingIn` spinner (there's no in-page async before the redirect) or keep it briefly; simplest is to pass `loggingIn={false}` and navigate on click.
- Loading state: the SPA must call `/api/auth/me` before deciding which screen to show. Render a neutral loading state during that call — do NOT render `LoginScreen` first (it would flash for authenticated users on every reload).

### Community name in a static SPA
The web app is a **static SPA (AD-3)** — it cannot read `Share2Brain.config.yml` (that's server-side). AC5 says the community name comes from `config.discord.guild_id` "o nombre configurable". There is **no backend endpoint** that returns a community name and no `/api/auth/me` field for it, and adding one expands scope. The in-scope, least-surprise solution: a **build-time Vite env var `VITE_COMMUNITY_NAME`** (`import.meta.env.VITE_COMMUNITY_NAME ?? 'Share2Brain'`), documented in `.env.example`. This honors "nombre configurable" without a new backend contract. (Alternative — a backend `/api/config` or a `communityName` field on `/me` — is deferred; note it if you disagree, but do not build it here.)

### Dev cookies & the Vite proxy (critical)
In production nginx fronts `/api` same-origin, so the `sid` cookie just works. In dev the SPA runs on `:5173` and the backend on `:3000` — **different origins**, so the session cookie set by `:3000` is not sent by the SPA on `:5173`, and `SameSite=Lax` blocks cross-origin fetch cookies (and `SameSite=None` needs HTTPS, which dev is not). Fix by making the whole dev flow same-origin through a **Vite dev proxy**:
- `packages/web/vite.config.ts` → add `server: { proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true }, '/health': { target: 'http://localhost:3000', changeOrigin: true } } }`. Now the SPA calls same-origin `/api/*` (proxied to the backend); the `sid` cookie is scoped to `:5173` and rides along.
- For the OAuth round-trip to also land the cookie on `:5173`, the dev **`DISCORD_REDIRECT_URI` should route through the proxy**: `http://localhost:5173/api/auth/callback`, and `FRONTEND_URL=http://localhost:5173`. Update `.env`/`.env.example` accordingly and note it in the story's Debug Log. (Story 2.3 used the direct-to-backend `:3000/api/auth/callback`; 2.4's frontend integration is why it moves behind the proxy. The Discord application's registered OAuth redirect must match whatever value you use.)
- Because everything is same-origin via the proxy in dev, CORS is effectively bypassed for the SPA; the existing `cors({ origin: allowedOrigins, credentials: true })` stays (harmless, and still correct if someone hits the backend directly).

### Anti-patterns to avoid (project-context)
❌ Post-filtering RBAC (this story doesn't filter results at all — it computes `allowedChannelIds`; Epic 4 must filter *inside* the query, AD-12). ❌ Caching `allowedChannelIds` in the session (AC3 — recompute per request). ❌ Defining the roles Zod shape or importing `drizzle-orm` outside `@share2brain/shared` (AD-6/AD-2). ❌ A `sessions` table. ❌ Web importing `@share2brain/shared` root barrel or `/db`/`/config` — only `/schemas` and `/types/events` are browser-safe (ESLint `no-restricted-imports` on `packages/web/**` enforces this — see `eslint.config.js`). ❌ Leaking raw DB errors from the RBAC middleware/roles handler (map to `RBAC_EXPANSION_FAILED`). ❌ Changing `createApp`'s signature. ❌ Rendering the login screen before `/api/auth/me` resolves. ❌ Marking an AC done without pasting verification output.

### Regression checklist
- `App.test.tsx` — fully coupled to the mock (`MOCK_LOGIN_DELAY_MS`, fake timers, click-to-login). Must be rewritten (Task 8). Removing `MOCK_LOGIN_DELAY_MS` breaks its import — update both.
- `createApp` callers: `main.ts`, `auth.integration.test.ts`, `health.integration.test.ts` (all via `buildTestAppOptions`). The signature stays the same, so these keep compiling — verify after wiring the new middleware. Grep `createApp(` before finishing.
- The generic `app.use('/api', requireAuth, ...)` must NOT break the existing `/api/auth/*` integration tests — confirm they still pass (they should, since the auth router is registered first and short-circuits).
- `main.ts` becoming async: ensure the top-level `try { main() } catch` still turns a rejected materialization into `exit(1)` (await inside `main`, or add `.catch`).

### Testing standards (project-context §Testing, backend-standards §Testing)
- Vitest; co-located `*.test.ts`; integration `*.integration.test.ts` run via `npm run test:integration` against real Postgres+Redis (`docker compose up -d postgres redis`). Root `vitest.config.ts` uses `test.projects` (unit / web / backend-integration).
- **Tests-first where it pays** here = the RBAC expansion (`rbacService`, the overlap query, the requireAuth gate) — this is a security boundary, write red first. Adapter glue (the Drizzle repo, the Express controller/route) may test after.
- Mock external deps in units; integration tests hit real Postgres (assert the overlap join returns exactly the channels whose `allowed_roles` intersect the roles, and NOT others) and real Redis (session-backed `/roles` 401 vs 200). Never hit real Discord — inject the fake `DiscordOAuthClient` via `buildTestAppOptions`.
- Web: jsdom project; mock `fetch`/`./api/auth`. jsdom has `fetch` — stub it with `vi.stubGlobal('fetch', vi.fn())` or mock the `api/auth` module.

### Manual verification (Task 10)
With real Discord creds in `.env` and the Vite proxy wired: run `npm run dev -w @share2brain/backend` and `npm run dev -w @share2brain/web`, open `http://localhost:5173` → login screen; click "Continuar con Discord" → Discord authorize → land back at `:5173` authenticated → header shows your username/initials; `curl -b <sid> http://localhost:3000/api/auth/roles` → `{ roles, allowedChannels }`; `GET http://localhost:3000/api/anything` without the cookie → 401 `AUTH_REQUIRED`; click logout → login screen, and `/api/auth/roles` → 401. Without real creds, the injected-fake integration tests are the authoritative end-to-end check. Restore any seeded `channel_permissions` rows.

### Project Structure Notes — new files extend the 2.3 DDD layout
```
packages/backend/src/
├── domain/repositories/
│   └── channelPermissionRepository.ts        # NEW — port (interface + input type)
├── application/services/
│   ├── rbacService.ts                         # NEW — expandAllowedChannelIds + getRolesResponse
│   └── rbacService.test.ts                    # NEW — unit (fake repo)
├── presentation/controllers/
│   └── authController.ts                       # EXTEND — add roles() handler + rbacService dep
├── infrastructure/
│   ├── channelPermissionRepository.drizzle.ts # NEW — Drizzle impl (upsertMany + overlap query)
│   └── materializeChannelPermissions.ts        # NEW — config → upsert at startup
├── middleware/                                 # NEW layer
│   ├── requireAuth.ts                          # NEW — 401 gate
│   ├── requireAuth.test.ts                     # NEW — unit
│   ├── rbac.ts                                 # NEW — attach req.allowedChannelIds
│   └── request-augment.d.ts                    # NEW — Request.allowedChannelIds typing
├── routes/authRoutes.ts                        # EXTEND — GET /roles (requireAuth)
├── app.ts                                      # EXTEND — wire rbacService + app.use('/api', gate)
├── main.ts                                     # EXTEND — async; await materialize before listen
└── (rbac.integration.test.ts)                  # NEW — or extend auth.integration.test.ts

packages/shared/src/
├── schemas/auth.ts                             # EXTEND — AuthRolesResponseSchema + AUTH_ERROR.RBAC_EXPANSION_FAILED
├── schemas/auth.test.ts                        # EXTEND — roles round-trip
└── db/index.ts                                 # EXTEND — re-export arrayOverlaps

packages/web/src/
├── api/auth.ts                                 # NEW — fetchMe/logout/LOGIN_URL
├── App.tsx                                     # REWRITE — real session flow (loading/anon/authed)
├── App.test.tsx                                # REWRITE — mocked fetch
└── (initials helper + test)                    # NEW
packages/web/vite.config.ts                     # EXTEND — server.proxy /api + /health
.env / .env.example                             # EXTEND — dev DISCORD_REDIRECT_URI via proxy; VITE_COMMUNITY_NAME
```
- Naming: files `camelCase.ts`; types/classes `PascalCase`; constants `UPPER_SNAKE_CASE`; endpoints kebab-case plural under `/api/`. English only in code/comments/logs/tests/commits.
- No root `src/`; no cross-service imports (AD-2); DB schema & Zod contracts only in `packages/shared` (AD-5/AD-6).

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 2.4] — ACs (authoritative).
- [Source: _bmad-output/planning-artifacts/architecture/architecture-share2brain-2026-06-30/TECHNICAL-DESIGN.md#5.4] — auth+RBAC middleware pseudocode (`allowed_roles && discordRoles`, per-request expansion, `req.allowedChannelIds`).
- [Source: .../TECHNICAL-DESIGN.md#10] — RBAC roles→channels diagram, `/api/auth/roles`, why expansion is per-request not cached.
- [Source: docs/backend-standards.md#Authentication & RBAC] — RBAC middleware on every `/api/*` except auth/health; `channel_permissions` materialized from config at startup.
- [Source: docs/backend-standards.md#Layered Architecture, #Testing Standards] — DDD layers (add `middleware/`); RBAC test example (exclude non-intersecting channels).
- [Source: docs/data-model.md#5 channel_permissions] — columns, `category_id` nullable, per-request join note (AD-12), backend write ownership.
- [Source: _bmad-output/project-context.md#Backend framework rules (AD-12)] — RBAC inside the vector query (NOT this story — this story only produces `allowedChannelIds`); sessions store only `{userId, discordRoles}`.
- [Source: _bmad-output/implementation-artifacts/2-3-backend-discord-oauth2-y-sesiones-en-redis.md] — the DDD layout, DI patterns, test helpers, and the explicit "2.4 replaces the mock login + adds RBAC middleware + channel_permissions upsert + /api/auth/roles" scope handoff.
- Current code: `packages/backend/src/{app,main}.ts`, `packages/backend/src/{application/services/authService.ts, presentation/controllers/authController.ts, routes/authRoutes.ts, infrastructure/userRepository.drizzle.ts, test-helpers.ts, auth.integration.test.ts}`; `packages/shared/src/{db/schema.ts:87-92, db/index.ts, schemas/auth.ts, config/index.ts:28-68}`; `packages/web/src/{App.tsx, App.test.tsx, components/{Header,AppLayout,LoginScreen}.tsx, main.tsx}`, `packages/web/vite.config.ts`, `eslint.config.js` (web import guard), `.env.example`, `Share2Brain.config.yml.example` (access_control).

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m] (bmad-dev-story workflow).

### Debug Log References

- **Dev redirect URI moved behind the Vite proxy.** Per Dev Notes, `.env.example` `DISCORD_REDIRECT_URI` now points at `http://localhost:5173/api/auth/callback` (was `:3000` in 2.3), so the `sid` cookie lands on the SPA origin in dev. The Discord app's registered redirect must match whatever value is used. `FRONTEND_URL` stays `:5173`.
- **Pre-existing failing integration test fixed (Story 2.3 regression, not introduced here).** `auth.integration.test.ts` "member flow" asserted `sess:<login-sid>` exists after the callback, but the P1 session-fixation `regenerate()` patch (added during 2.3 code review) changes the session id on callback — the login-time key is destroyed. Verified the failure reproduces on the baseline commit (784c1e5) before any 2.4 change. Fixed the assertion to read the authenticated `sid` from the callback response's Set-Cookie. This is the only change to an existing test file.
- **Manual boot smoke-test** (backend on :3999, sourced `.env`, `SHARE2BRAIN_CONFIG_PATH` → repo-root `Share2Brain.config.yml`): startup materialized `channel_permissions` from config (`general` → `{admin,mod,member}`, `category_id` NULL) before listening; `GET /api/anything` → 401 `AUTH_REQUIRED` (generic gate); `GET /api/auth/roles` (no session) → 401; `GET /api/auth/me` → 401; `GET /health` → 200 (exempt). Seeded config row deleted afterwards to restore the empty DB.

### Completion Notes List

Implemented the full RBAC + route-protection loop and the real frontend auth wiring, closing Epic 2. All 6 ACs satisfied; verification gate green (lint 0 warnings · 83 unit/web tests · build all 5 workspaces · 12 backend integration tests).

- **AC1** — `materializeChannelPermissions` maps `config.access_control.channel_permissions` → `ChannelPermissionInput` (`categoryId: null`) and upserts before `app.listen` in an async `main()`. Deny-by-default is the natural join result (no separate branch). Boot aborts (`exit(1)`) if the upsert throws (first DB query).
- **AC2** — `requireAuth` mounted `app.use('/api', requireAuth, createRbacMiddleware(...))` AFTER the auth router, so `/api/auth/*` (router short-circuits) and top-level `/health` are exempt; every other `/api/*` path (even undefined routes) → 401 `AUTH_REQUIRED`.
- **AC3** — `createRbacMiddleware` recomputes `req.allowedChannelIds` per request from `session.discordRoles` (never cached); a DB throw maps to 500 `RBAC_EXPANSION_FAILED` (raw error never leaked). Integration test proves per-request recompute (policy change between two calls on the same session changes the result).
- **AC4** — `GET /api/auth/roles` (route-level `requireAuth`) returns `{ roles, allowedChannels }` validated by `AuthRolesResponseSchema`; no session → 401.
- **AC5/AC6** — `App.tsx` rewritten: `loading | anon | authed`, `fetchMe()` on mount (neutral splash, never flashes login), username/initials from the real profile, community name from `VITE_COMMUNITY_NAME`. Login = full-page nav to `/api/auth/login`; logout POSTs then returns to login. Vite dev proxy added for `/api` + `/health`.
- **RBAC query**: `arrayOverlaps(channelPermissions.allowedRoles, discordRoles)` (`&&`) re-exported from `@share2brain/shared/db` (AD-2); empty-roles short-circuit to `[]` avoids the empty-array cast pitfall. This is the AD-12 *expansion* only — the vector-query filter is Epic 4/5 (nothing consumes `req.allowedChannelIds` yet).
- Out-of-scope items (allow-policy branch, `access_control.enabled` bypass, `user_roles_cache`, rate-limiting, real stats) intentionally NOT built — noted in the story scope boundary.

### File List

**Added**
- `packages/backend/src/domain/repositories/channelPermissionRepository.ts`
- `packages/backend/src/infrastructure/channelPermissionRepository.drizzle.ts`
- `packages/backend/src/infrastructure/channelPermissionRepository.drizzle.test.ts`
- `packages/backend/src/infrastructure/materializeChannelPermissions.ts`
- `packages/backend/src/application/services/rbacService.ts`
- `packages/backend/src/application/services/rbacService.test.ts`
- `packages/backend/src/middleware/requireAuth.ts`
- `packages/backend/src/middleware/requireAuth.test.ts`
- `packages/backend/src/middleware/rbac.ts`
- `packages/backend/src/middleware/request-augment.d.ts`
- `packages/backend/src/rbac.integration.test.ts`
- `packages/web/src/api/auth.ts`
- `packages/web/src/lib/initials.ts`
- `packages/web/src/lib/initials.test.ts`
- `packages/web/src/vite-env.d.ts`

**Modified**
- `packages/shared/src/schemas/auth.ts` (AuthRolesResponseSchema + `RBAC_EXPANSION_FAILED`)
- `packages/shared/src/schemas/auth.test.ts` (roles round-trip + new error code)
- `packages/shared/src/db/index.ts` (re-export `arrayOverlaps`)
- `packages/backend/src/app.ts` (wire rbacService + generic `/api` gate)
- `packages/backend/src/main.ts` (async; materialize before listen; `.catch` on `main()`)
- `packages/backend/src/presentation/controllers/authController.ts` (`roles` handler + `rbacService` dep)
- `packages/backend/src/routes/authRoutes.ts` (`GET /roles` with `requireAuth`)
- `packages/backend/src/auth.integration.test.ts` (fix pre-existing regenerate-sid assertion)
- `packages/web/src/App.tsx` (real session flow, replaces the mock)
- `packages/web/src/App.test.tsx` (rewritten around mocked fetch client)
- `packages/web/vite.config.ts` (dev proxy for `/api` + `/health`)
- `.env.example` (dev redirect URI via proxy; `VITE_COMMUNITY_NAME`)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (2-4 → in-progress → review)

### Review Findings

- [x] [Review][Patch] Logout `.finally()` sets `anon` even if fetch fails [`packages/web/src/App.tsx:65-71`] — `apiLogout()` could throw (network error), but `.finally()` always sets `authState = 'anon'` and clears `user`. The UI shows the login screen but the server-side session (`sid` cookie) remains valid. A subsequent login with the same browser still carries the old (valid) cookie. Fix: use `.catch()` to keep the authed state on failure and/or show an error notification.
- [x] [Review][Patch] `loggingIn={false}` dead prop on `LoginScreen` [`packages/web/src/App.tsx:77`] — login is now a full-page navigation so the `loggingIn` prop is always `false`. Remove the prop from `LoginScreen` (and its interface) for clarity.

- [x] [Review][Defer] `access_control.enabled` not checked during materialization [`packages/backend/src/main.ts:54-57`] — deferred, explicitly out of scope per story Dev Notes ("Do not build an allow-all branch or a disable switch").
- [x] [Review][Defer] `discordRoles` typed as non-optional in `SessionData` [`packages/backend/src/infrastructure/sessionStore.ts:16`] — deferred, pre-existing pattern (mirrors `userId` which is also non-optional).
- [x] [Review][Defer] Short-circuit in `findAllowedChannelIds([])` not integration-tested against real Postgres [`packages/backend/src/infrastructure/channelPermissionRepository.drizzle.ts:44`] — deferred, intentional optimization; covered by unit tests in `rbacService.test.ts`.

## Change Log

| Date | Change |
|---|---|
| 2026-07-04 | Story 2.4 implemented: RBAC expansion + generic `/api` auth gate + `channel_permissions` startup materialization + `GET /api/auth/roles` + real frontend session wiring (replaces the 2.2 mock). Closes Epic 2. |
| 2026-07-05 | Code review: all 6 ACs satisfied. Fixed logout failure edge case and removed dead `loggingIn` prop. Status → done. |
