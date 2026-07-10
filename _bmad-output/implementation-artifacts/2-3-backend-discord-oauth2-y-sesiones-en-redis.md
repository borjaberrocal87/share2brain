---
baseline_commit: 64106e4ee5b1f37b16265250a666337bf2a724d9
---

# Story 2.3: Backend — Discord OAuth2 y sesiones en Redis

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a member of the Discord community,
I want to authenticate with my Discord account,
so that the system verifies I belong to the guild and creates a secure session without storing my credentials.

## Acceptance Criteria

1. **`GET /api/auth/login` redirects to Discord.** When the endpoint is hit, it responds with a 302 redirect to `https://discord.com/oauth2/authorize` carrying `response_type=code`, scopes `identify` and `guilds.members.read`, the `client_id`, and the `redirect_uri` configured in `.env`.
2. **`GET /api/auth/callback?code=...` completes the OAuth2 handshake.** The backend exchanges the code for an `access_token` via `POST https://discord.com/api/oauth2/token`, fetches the user via `GET https://discord.com/api/users/@me`, and fetches guild membership + roles via `GET https://discord.com/api/users/@me/guilds/{guild_id}/member`.
3. **Member → session created.** When the user IS a member of the guild, the backend upserts the user into `users` (`discord_id`, `username`, `avatar`), stores the session in Redis as `{ userId, discordRoles }` with a TTL configurable via `SESSION_TTL_DAYS` (default 7), sets an httpOnly cookie named `sid`, and redirects to the frontend at `/`.
4. **Non-member → 403.** When the user is NOT a member of the guild, the endpoint returns HTTP 403 with body `{ error: "No eres miembro del guild", code: "GUILD_MEMBER_REQUIRED" }` (shape from `@share2brain/shared` `ErrorSchema`).
5. **`GET /api/auth/me` returns the current user.** With a valid session in Redis, returns HTTP 200 with `{ id, discordId, username, avatar }`. Without a valid session, returns HTTP 401 `{ error: "Unauthorized", code: "AUTH_REQUIRED" }`.
6. **`POST /api/auth/logout` destroys the session.** With a valid session, the Redis session key is deleted immediately, the `sid` cookie is invalidated (cleared), and it returns HTTP 200.

## Tasks / Subtasks

- [x] **Task 1 — Add dependencies & config (env) plumbing** (AC: 1, 3)
  - [x] Add to `packages/backend/package.json` dependencies: `express-session@^1.18`, `connect-redis@^9.0`; devDependency `@types/express-session@^1.18`. (`ioredis@^5.4`, `express@^5.2`, `cors` — see below — and `supertest` already available; add `cors@^2.8` + `@types/cors` to dependencies/devDependencies for the SPA cookie flow.)
  - [x] Add the two **missing** secrets to `.env` **and** `.env.example` (keep them ordered near the existing Discord/session keys): `DISCORD_REDIRECT_URI=http://localhost:3000/api/auth/callback` (dev value) and `SESSION_TTL_DAYS=7`. Do NOT add these to `Share2Brain.config.yml` — they are secrets/deploy values, not behavior (secrets/behavior split; see Dev Notes).
  - [x] Run `npm install` at the repo root so the root lockfile picks up the new deps (the backend Dockerfile installs from the root lockfile — no Dockerfile change needed).

- [x] **Task 2 — Add the auth Zod contract in `@share2brain/shared`** (AC: 4, 5) — scope: `shared` (AD-6)
  - [x] Create `packages/shared/src/schemas/auth.ts` exporting `AuthMeResponseSchema = z.object({ id: z.string().uuid(), discordId: z.string(), username: z.string(), avatar: z.string().nullable() })` and `export type AuthMeResponse = z.infer<typeof AuthMeResponseSchema>`.
  - [x] Export stable error-code constants used across auth endpoints so backend and (later) web share them: `export const AUTH_ERROR = { AUTH_REQUIRED: 'AUTH_REQUIRED', GUILD_MEMBER_REQUIRED: 'GUILD_MEMBER_REQUIRED' } as const`.
  - [x] Re-export from `packages/shared/src/schemas/index.ts` (add `export * from './auth.js';`). Do NOT define these shapes inside `packages/backend` (AD-6).
  - [x] Add a co-located `packages/shared/src/schemas/auth.test.ts` (parse/round-trip, nullable avatar) — mirror `sse.test.ts`.

> **Layout: DDD por capas (backend-standards.md §Layered Architecture).** New auth code establishes the `domain / application / presentation / infrastructure / routes` layout for the backend. The existing `/health` skeleton (`app.ts`, `main.ts`, `health.ts`) stays flat at `src/` root — migrate incrementally, don't refactor it here. Dependency rule: `presentation → application → domain`; `infrastructure` implements `domain` interfaces; `domain` depends on nothing.

- [x] **Task 3 — Domain ports (interfaces, pure — no external deps)** (AC: 2, 4, 5)
  - [x] Create `packages/backend/src/domain/repositories/userRepository.ts` — interface `UserRepository { upsertByDiscordId(u: { discordId: string; username: string; avatar: string | null }): Promise<{ id: string }>; findById(id: string): Promise<{ id: string; discordId: string; username: string; avatar: string | null } | null> }`. No Drizzle import here (contract only).
  - [x] Create `packages/backend/src/domain/repositories/discordOAuthClient.ts` — the outbound port `DiscordOAuthClient { exchangeCode(code: string): Promise<{ accessToken: string }>; getCurrentUser(accessToken: string): Promise<{ id: string; username: string; avatar: string | null }>; getGuildMember(accessToken: string, guildId: string): Promise<{ roles: string[] } | null> }`. Also declare the domain error `export class GuildMembershipError extends Error {}` here (pure domain concept).

- [x] **Task 4 — Infrastructure adapters** (AC: 2, 3, 4)
  - [x] `packages/backend/src/infrastructure/userRepository.drizzle.ts` — `createDrizzleUserRepository(db: Database): UserRepository`. `upsertByDiscordId`: `db.insert(users).values({ discordId, username, avatar }).onConflictDoUpdate({ target: users.discordId, set: { username, avatar } }).returning({ id: users.id })`. The `idx_users_discord_id` unique index (already migrated) backs the conflict target — verify before relying on it. `findById`: select by `users.id`. Import `users` from `@share2brain/shared/db`.
  - [x] `packages/backend/src/infrastructure/discordOAuthClient.fetch.ts` — `createFetchDiscordOAuthClient(cfg: { clientId; clientSecret; redirectUri }): DiscordOAuthClient` using the global `fetch` (Node 24). Do NOT pull in `discord.js` (that lib is for the bot's Gateway; the backend only needs the Discord REST OAuth endpoints).
    - `exchangeCode`: `POST https://discord.com/api/oauth2/token`, `Content-Type: application/x-www-form-urlencoded`, body `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret`.
    - `getCurrentUser`: `GET https://discord.com/api/users/@me` with `Authorization: Bearer <accessToken>`.
    - `getGuildMember`: `GET https://discord.com/api/users/@me/guilds/{guildId}/member` with the Bearer token. Return `null` on Discord **404** (user not in guild) — the not-a-member signal for AC4. Any other non-2xx throws.
  - [x] `packages/backend/src/infrastructure/sessionStore.ts` — `createSessionMiddleware(redis: Redis, opts: { secret: string; ttlDays: number; cookieSecure: boolean })` returning the `express-session` middleware. Use `connect-redis`'s `RedisStore` bound to the **same** `redis` instance via its `client` option (single Redis client for sessions + streams — backend-standards §Authentication & RBAC). Configure `name: 'sid'` (NOT the default `connect.sid` — AC3/AC6 require `sid`), `resave: false`, `saveUninitialized: false`, `cookie: { httpOnly: true, secure: cookieSecure, sameSite: 'lax', maxAge: ttlDays * 86_400_000 }`, store `ttl: ttlDays * 86_400` (seconds). Put the express-session module augmentation here (or in a sibling `session-augment.d.ts`): `declare module 'express-session' { interface SessionData { userId: string; discordRoles: string[]; oauthState?: string } }` — the ONLY place session fields are typed.

- [x] **Task 5 — Application service (orchestration)** (AC: 2, 3, 4, 5)
  - [x] Create `packages/backend/src/application/services/authService.ts` — `createAuthService(deps: { users: UserRepository; oauth: DiscordOAuthClient; guildId: string })`. Depends on the domain **interfaces**, never on `db` or `fetch` directly (that's what makes it unit-testable with fakes and keeps the layering honest).
  - [x] `handleCallback(code)`: `oauth.exchangeCode` → `oauth.getCurrentUser` → `oauth.getGuildMember(accessToken, guildId)`. If it returns `null` → throw `GuildMembershipError`. Otherwise `users.upsertByDiscordId(...)` and return `{ userId, discordRoles }`.
  - [x] `getMe(userId)`: `users.findById(userId)`; return `{ id, discordId, username, avatar }` validated with `AuthMeResponseSchema.parse(...)` before it leaves the service. (The session stores only `userId` + `discordRoles`; `me` must read the DB for the display fields.)

- [x] **Task 6 — Presentation controller + routes + authorize URL** (AC: 1, 2, 3, 4, 5, 6)
  - [x] Create `packages/backend/src/presentation/controllers/authController.ts` — handler functions (login, callback, me, logout) built from `deps: { authService, discordCfg, frontendUrl }`. Controllers own HTTP concerns and map thrown errors to the unified `ErrorSchema` (never leak raw Discord/DB errors — AD language rule).
    - `login`: build `https://discord.com/oauth2/authorize?response_type=code&client_id=...&scope=identify%20guilds.members.read&redirect_uri=<encoded>&state=<random>`; store `state` in `req.session.oauthState` (CSRF); `res.redirect(302, url)`.
    - `callback`: verify the returned `state` matches `req.session.oauthState` (mismatched/absent → 400, CSRF guard); `authService.handleCallback(code)`; on success set `req.session.userId` + `req.session.discordRoles`, clear `oauthState`, `res.redirect(frontendUrl + '/')`; on `GuildMembershipError` → 403 `{ error: 'No eres miembro del guild', code: 'GUILD_MEMBER_REQUIRED' }`.
    - `me`: no `req.session.userId` → 401 `{ error: 'Unauthorized', code: 'AUTH_REQUIRED' }`; else 200 with `authService.getMe(req.session.userId)`.
    - `logout`: `req.session.destroy(...)` (connect-redis deletes the Redis key), `res.clearCookie('sid')`, 200. Handle the destroy callback error path.
  - [x] Create `packages/backend/src/routes/authRoutes.ts` — `createAuthRouter(deps): Router` wiring the controller handlers onto an `express.Router()` (`GET /login`, `GET /callback`, `GET /me`, `POST /logout`), mounted at `/api/auth` in `createApp`.

- [x] **Task 7 — Wire everything into `createApp` and `main.ts` without breaking `/health`** (AC: all)
  - [x] `app.ts` is the **composition root**: it assembles the layers (`createDrizzleUserRepository(db)` → `createAuthService({ users, oauth, guildId })`; `createFetchDiscordOAuthClient(cfg)` → `oauth`; `createSessionMiddleware(redis, ...)`; `createAuthRouter({ authService, discordCfg, frontendUrl })`). Extend `createApp` to `createApp(db, redis, opts: AppOptions)` where `AppOptions` carries `{ sessionSecret, sessionTtlDays, cookieSecure, discord: { clientId, clientSecret, redirectUri, guildId }, frontendUrl, allowedOrigins }`. Register, in order: `cors({ origin: allowedOrigins, credentials: true })`, `express.json()`, the session middleware (Task 4), then `app.use('/api/auth', createAuthRouter(...))`. Keep `app.get('/health', ...)` exactly as-is (top-level, auth-exempt, before/independent of the auth router).
  - [x] To keep the composition root testable, let `AppOptions` optionally accept a pre-built `oauth?: DiscordOAuthClient` (default: `createFetchDiscordOAuthClient(opts.discord)`); the integration test injects a fake here instead of hitting real Discord.
  - [x] **REGRESSION GUARD:** `packages/backend/src/health.integration.test.ts:26` calls `createApp(clients.db, clients.redis)` with two args. Update that call site to pass a test `AppOptions` (or give `opts` a safe default) so the existing health integration test still compiles and passes. Do not remove or weaken the health test.
  - [x] In `main.ts`: after `loadConfig()`, read the new env (`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_REDIRECT_URI`, `SESSION_SECRET` via the existing `requireEnv` helper; `SESSION_TTL_DAYS` optional with default 7; `guildId` from `config.discord.guild_id`; `frontendUrl` from env `FRONTEND_URL`; `allowedOrigins` from `config.security.allowed_origins`; `cookieSecure` from `process.env.NODE_ENV === 'production'`). Pass them to `createApp`. `loadConfig()` MUST still run first (AD-8).

- [x] **Task 8 — Tests** (AC: 2, 3, 4, 5, 6)
  - [x] **Unit** (`*.test.ts`, node, co-located with the class under test): `application/services/authService.test.ts` — inject a **fake `UserRepository`** and a **fake `DiscordOAuthClient`** (plain objects implementing the domain interfaces — no `db`, no `fetch`): member path upserts + returns `{ userId, discordRoles }`; non-member path (`getGuildMember` → `null`) throws `GuildMembershipError`; `getMe` returns the parsed shape. `infrastructure/discordOAuthClient.fetch.test.ts` — mock global `fetch`; assert token/user/member requests are shaped correctly and 404 on member → `null`. (This clean fake-injection is the payoff of the layered/DDD structure — the service test needs no infra.)
  - [x] **Integration** (`*.integration.test.ts`, real Postgres + Redis, supertest): mount `createApp` with an **injected fake `DiscordOAuthClient`** (do not hit real Discord). Cover: member callback → user row upserted in `users` + session key present in Redis + `sid` cookie set + 302 to frontend; `GET /me` with the session cookie → 200 with correct fields; `GET /me` without cookie → 401 `AUTH_REQUIRED`; non-member callback → 403 `GUILD_MEMBER_REQUIRED`; `POST /logout` → Redis session key deleted (assert via the real `redis` client) + 200. Reuse `openTestClients()` from `test-helpers.ts`. Clean up test rows/keys in `afterEach`/`afterAll`.
  - [x] Behavior-driven test names (`should <behavior> when <condition>`), AAA. No real Discord network in any test.

- [x] **Task 9 — Verification gate (agent runs it, pastes output)** (AC: all)
  - [x] `npm run lint && npm run test && npm run build` — all green, paste output.
  - [x] `docker compose up -d postgres redis && npm run test:integration` — paste output.
  - [x] Exercise the real endpoints end-to-end where possible (see Dev Notes "Manual verification") and restore state.

## Dev Notes

### Scope boundary — what this story does and does NOT do
- **IN scope (2.3):** the four auth endpoints (`/api/auth/login|callback|me|logout`), the Redis session infrastructure, guild-membership verification, and the `users` upsert. Backend only.
- **OUT of scope — belongs to Story 2.4 (do NOT implement here):**
  - `channel_permissions` upsert at startup, and the per-request RBAC middleware that expands `discordRoles → allowedChannelIds` (AD-12).
  - The generic auth-guard middleware over all `/api/*` (the 401 gate in 2.4-AC2). In 2.3, only `/api/auth/me` enforces its own 401 at the endpoint level.
  - `GET /api/auth/roles` (roles + accessible channels).
  - **Frontend wiring.** Do NOT touch `packages/web`. `App.tsx` still uses the mock login (`MOCK_LOGIN_DELAY_MS`); 2.4 replaces it with a real `GET /api/auth/me` check and points the "Continuar con Discord" button at `/api/auth/login`.
  - `user_roles_cache` table population — not needed; the session stores `discordRoles` directly. Leave the table untouched.

### Current backend state — extend, don't reinvent
The backend is a thin Express 5 skeleton. Preserve its structure and DI style.
- `packages/backend/src/app.ts` — `createApp(db, redis): Express`, **routes only** (factory, deliberately separate from `main.ts` so integration tests build the same app). Currently registers only `app.get('/health', ...)`. This is the exact seam for the session middleware + `/api/auth` router. It does NOT yet call `express.json()` or `cors()` — you add those.
- `packages/backend/src/main.ts` — process wiring: `loadConfig()` first (AD-8), then `requireEnv('DATABASE_URL'|'REDIS_URL')`, `createDatabase(url)`, `new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 })` (with an `error` listener that warns, so a Redis outage degrades rather than crashes), then `createApp(...).listen(PORT)`, with SIGTERM/SIGINT shutdown (`server.close()` + `redis.quit()`). **Reuse this single `redis` instance for the session store** — do not open a second Redis client.
- `packages/backend/src/health.ts` — the handler-factory pattern to mirror: `createXHandler(db, redis) => (req, res) => ...`. Follow it for auth handlers/routers (DI the startup clients + options).
- Response validation: `health.ts` validates its output with a shared Zod schema before sending (`HealthResponseSchema.parse`). Do the same for `/me` (`AuthMeResponseSchema.parse`).
- `packages/backend/package.json` currently: deps `@share2brain/shared`, `express@^5.2`, `ioredis@^5.4`; devDeps `@types/express`, `supertest@^7.1`, `@types/supertest`. Uses `tsx` (no build step; `build`/`typecheck` are both `tsc --noEmit`).

### Shared kernel — what already exists (AD-2, AD-5, AD-6)
- **`users` table** — `packages/shared/src/db/schema.ts:63-74`: `id uuid pk defaultRandom`, `discordId text notNull`, `username text notNull`, `avatar text` (nullable), `createdAt`. **`uniqueIndex('idx_users_discord_id')` on `discordId`** (already migrated in `0001_tough_skrulls.sql`) — this is your `onConflictDoUpdate` target. No schema change or migration is needed for this story.
- **`ErrorSchema`** = `{ error: string, code: string }` — `packages/shared/src/schemas/errors.ts`, exported via `@share2brain/shared/schemas`. Use it for the 403/401 bodies.
- **`loadConfig()`** — `packages/shared/src/config/index.ts`. Exposes `config.discord.guild_id`, `config.security.allowed_origins`, `config.access_control.*`. It has **NO** `client_id`/`client_secret`/`redirect_uri`/`session` keys by design — those are `.env` secrets. Do **not** extend `Share2BrainConfigSchema` for this story.
- **`createDatabase` / `Database` / `sql`** — `packages/shared/src/db/index.ts`. `schema` re-exported; import tables as `import { users } from '@share2brain/shared/db'`.
- No logger and no Redis-client factory exist in shared — current code uses `console.*` and constructs `new Redis(...)` directly. Match that (don't invent a logging framework here).

### Secrets vs behavior — hard rule
`.env` holds secrets/deploy values; `Share2Brain.config.yml` holds behavior (referenced as `${VAR}`). Never mix them. Therefore `DISCORD_REDIRECT_URI` and `SESSION_TTL_DAYS` go in `.env`/`.env.example` (they are already partly represented: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID`, `SESSION_SECRET`, `REDIS_URL`, `FRONTEND_URL` exist; `DISCORD_REDIRECT_URI` and `SESSION_TTL_DAYS` are the two you must add). The AC text "TTL configurable via `SESSION_TTL_DAYS`" confirms it is an env var, not a YAML key.

### Sessions in Redis (AD-10) — non-negotiable
- **No `sessions` table.** `schema.ts:6-7` explicitly forbids adding one. Sessions live only in Redis via `express-session` + `connect-redis`.
- Session payload is exactly `{ userId, discordRoles }` (`userId` = `users.id` UUID; `discordRoles` = Discord role-id strings). `allowedChannelIds` are NOT stored (that's the per-request expansion in 2.4).
- The httpOnly `sid` cookie carries only the session id; revocation = deleting the Redis key (what `req.session.destroy()` does with connect-redis).
- `connect-redis@9` binds to an existing client via `new RedisStore({ client: redis, prefix: 'sess:', ttl: ttlSeconds })`. Since the project standardizes on **ioredis**, pass the ioredis instance (ioredis auto-connects on first command; no manual `.connect()` needed, unlike node-redis).

### Discord OAuth2 flow (TECHNICAL-DESIGN §10)
`login` → 302 to `discord.com/oauth2/authorize` (scopes `identify guilds.members.read`) → user authorizes → Discord redirects to `/api/auth/callback?code=...` → backend `POST /oauth2/token` (exchange) → `GET /users/@me` → `GET /users/@me/guilds/{guild_id}/member` (needs the `guilds.members.read` scope) → verify membership → `SET session {userId, discordRoles}` in Redis → `Set-Cookie: sid` → redirect to `/`. A user not in the guild yields a **404** on the member endpoint → map to 403 `GUILD_MEMBER_REQUIRED`.
- **CSRF `state`:** the ACs don't spell it out, but this is an auth path — implement the OAuth `state` param (random value stored in session on `/login`, verified on `/callback`). A security review of this diff will flag its absence.
- Use raw `fetch` to the Discord REST API; do not add `discord.js` to the backend.

### nginx / routing
`nginx.conf` routes `location = /health` and `location /api/` to `backend:3000`; `/` serves the SPA. Your endpoints live under `/api/auth/*`, so they are reachable through the single exposed port. Keep `/health` top-level and untouched. `redirect_uri` in dev is `http://localhost:3000/api/auth/callback` (direct to backend); in prod it is the public origin behind nginx — hence it's an env var, not hardcoded.

### Testing standards (project-context §Testing, backend-standards §Testing)
- Vitest, co-located `*.test.ts`; integration specs are `*.integration.test.ts` (excluded from `npm run test`, run via `npm run test:integration` against real Postgres+Redis brought up with `docker compose up -d postgres redis`).
- Root `vitest.config.ts` uses `test.projects` (Vitest 4 removed `vitest.workspace.ts`); `unit` project globs `packages/*/src/**/*.test.ts`.
- **Tests-first where it pays** here = the auth domain logic (membership verification, upsert, session payload). Adapter glue (fetch client, Express router) may be tested after.
- Mock external deps: mock the `DiscordOAuthClient` (and global `fetch` in the client's own unit test). Never hit real Discord. Integration tests hit real Redis (assert the session key is created and, after logout, deleted) and real Postgres (assert the `users` upsert is idempotent — a second callback for the same `discord_id` updates, doesn't duplicate).
- Follow existing patterns: `health.test.ts` (`vi.fn()` doubles cast `as unknown as Database`) for units; `health.integration.test.ts` (`openTestClients()` + supertest) for integration.

### Manual verification (Task 9)
With real Discord creds in `.env` you can drive the browser flow (`/api/auth/login` → authorize → land at `/` with an `sid` cookie; `curl` `/api/auth/me` with the cookie → 200; `POST /api/auth/logout` → cookie cleared, `/me` → 401). Without real creds, the injected-fake integration tests are the authoritative end-to-end check. Restore any test data.

### Project Structure Notes — DDD by layer (decided for this story)
This story establishes the DDD-aligned layout from backend-standards.md §Layered Architecture for the backend. New code:
```
packages/backend/src/
├── domain/repositories/
│   ├── userRepository.ts            # UserRepository interface (+ types)
│   └── discordOAuthClient.ts        # DiscordOAuthClient port + GuildMembershipError
├── application/services/
│   └── authService.ts               # createAuthService (orchestration, depends on interfaces)
├── presentation/controllers/
│   └── authController.ts            # HTTP handlers, error → ErrorSchema mapping
├── infrastructure/
│   ├── userRepository.drizzle.ts    # Drizzle impl of UserRepository
│   ├── discordOAuthClient.fetch.ts  # fetch impl of the OAuth port
│   └── sessionStore.ts              # express-session + connect-redis + SessionData augmentation
├── routes/
│   └── authRoutes.ts                # createAuthRouter → /api/auth
├── app.ts   # composition root: wires layers + registers cors/json/session/router (extended)
├── main.ts  # reads env + config, passes AppOptions (extended)
└── health.ts # UNCHANGED — stays flat (migrate incrementally; do NOT refactor here)
```
- **Dependency rule (must hold):** `presentation → application → domain`; `infrastructure` implements `domain` interfaces; `domain` imports nothing external (no Drizzle, no fetch, no express). `authService` talks to `UserRepository`/`DiscordOAuthClient` interfaces, never to `db`/`fetch`. This is what makes the service unit-testable with plain fakes.
- Mixed state is expected and acceptable: `/health` remains flat while `/auth` is layered — exactly the "migrate incrementally" path the standard endorses. Future backend stories (search, documents, chat/RAG) extend these same layers.
- Zod contracts go in `packages/shared/src/schemas/auth.ts` (AD-6). No root `src/`; no cross-service imports (AD-2).
- Naming: files `camelCase.ts`; types/classes `PascalCase`; constants `UPPER_SNAKE_CASE`; endpoints kebab-case plural under `/api/`. English only in all code/comments/logs/tests/commits.
- **Regression risk:** the `createApp` signature change. The only current caller besides `main.ts` is `health.integration.test.ts:26` — update it. Grep for `createApp(` before finishing.

### Anti-patterns to avoid (project-context)
❌ A `sessions` table. ❌ Defining the auth Zod shape or a table outside `packages/shared`. ❌ Opening a second Redis client for sessions (reuse the startup one). ❌ Leaking raw Discord/DB errors to the client (map to `ErrorSchema`). ❌ Cookie name `connect.sid` (must be `sid`). ❌ Storing `allowedChannelIds` in the session. ❌ Adding `discord.js` to the backend. ❌ Marking an AC done without pasting verification output.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 2.3] — ACs (authoritative).
- [Source: _bmad-output/planning-artifacts/architecture/architecture-share2brain-2026-06-30/TECHNICAL-DESIGN.md#10 (Auth: OAuth2 flow, Sessions in Redis, RBAC)] — flow diagram, session shape, endpoint list, `ErrorSchema`.
- [Source: docs/data-model.md#3 users, #5 channel_permissions] — table columns, write ownership (`users` owned by backend).
- [Source: docs/backend-standards.md#Authentication & RBAC] — single ioredis client for connect-redis; store only `{userId, discordRoles}`.
- [Source: docs/backend-standards.md#Layered Architecture, #Project Structure] — DDD layer layout (domain/application/presentation/infrastructure/routes) this story establishes for the backend.
- [Source: _bmad-output/project-context.md#Backend framework rules (AD-10)] — sessions in Redis, no `sessions` table.
- [Source: docs/context/ARCHITECTURE-SPINE.md] — AD-2 (no cross-service imports), AD-5/AD-6 (schema/contracts only in shared), AD-8 (loadConfig first), AD-10 (Redis sessions).
- Current code: `packages/backend/src/{app,main,health,test-helpers}.ts`, `packages/backend/src/health.integration.test.ts`, `packages/shared/src/db/schema.ts:63-92`, `packages/shared/src/schemas/{errors,index}.ts`, `packages/shared/src/config/index.ts`, `.env.example`, `Share2Brain.config.yml.example`, `nginx.conf`.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8[1m] (Opus 4.8, 1M context)

### Debug Log References

**Architectural deviation from the story spec — Redis client (approved by Borja mid-implementation):**
The story's Dev Notes (and the ARCHITECTURE-SPINE, AD-10/AD-13) assumed `connect-redis@9` binds to an **ioredis** client. This is false: `connect-redis@9` targets **node-redis v5+** — it calls `client.set(k, v, { expiration: { type: 'EX', value } })` and `client.mGet(...)`, an API ioredis does not implement (`set(k,v,'EX',n)`, `mget`). Investigation also found the only ioredis-native session store (`connect-ioredis`) is abandoned (2022, ioredis v2), while node-redis is the maintained client recommended for Redis 8.

**Decision:** standardize the whole project on **node-redis (`redis@6`)** and drop ioredis. Done now because the repo's ioredis footprint was tiny (only the backend skeleton) and the Streams consumers (bot/workers) are not written yet — so Epic 3+ will use node-redis from day one. Corrected AD-10, AD-13 and the stack tables in `docs/context/ARCHITECTURE-SPINE.md`, `docs/context/TECHNICAL-DESIGN.md`, `docs/backend-standards.md`, and `_bmad-output/project-context.md`. (Story task text still says "ioredis"/"express-session@^1.18" per the original spec; the implemented deps are `redis@^6.1.0` + `connect-redis@^9` + `express-session@^1.18` + `cors@^2.8`.)

Consequence in code: `infrastructure/redis.ts` wraps `createClient` with a bounded `reconnectStrategy` + `error` handler; `main.ts` connects in the background so a Redis outage degrades `/health` (503) instead of crashing startup (preserving the Epic-1 behavior that used ioredis `lazyConnect`).

### Completion Notes List

- **All 6 ACs implemented and verified.** Endpoints under `/api/auth`: `GET /login` (302 → Discord authorize, scopes `identify guilds.members.read`, CSRF `state`), `GET /callback` (code exchange → `/users/@me` → guild member → user upsert → Redis session → `sid` cookie → 302 to frontend; non-member → 403 `GUILD_MEMBER_REQUIRED`; bad state → 400), `GET /me` (200 profile / 401 `AUTH_REQUIRED`), `POST /logout` (destroy Redis key + clear cookie + 200).
- **DDD-by-layer** established for the backend: `domain/repositories` (ports + `GuildMembershipError`), `application/services` (`authService`, depends only on interfaces), `presentation/controllers`, `infrastructure` (Drizzle repo, fetch OAuth client, session store, redis factory), `routes`. `app.ts` is the composition root. `/health` skeleton left flat (migrate incrementally).
- **CSRF `state`** implemented beyond the ACs (auth path) — random nonce in the session, verified on callback.
- **AD-6:** the `AuthMeResponseSchema` + `AUTH_ERROR` contract lives in `@share2brain/shared/schemas/auth.ts`, not in the backend.
- **AD-10 preserved:** sessions live only in Redis (`sess:` prefix), payload `{ userId, discordRoles }`, cookie `sid` (not `connect.sid`); no `sessions` table.
- **Regression guard:** `createApp` gained a 3rd `AppOptions` arg; the existing `health.integration.test.ts` call site was updated (via `buildTestAppOptions`). `/health` behavior unchanged.
- **Verification gate (all green):** `npm run lint` (0), `npm run test` (59 unit+web), `npm run build` (all workspaces + vite), `npm run test:integration` (7, real Postgres+Redis). Manual: live backend on :3010 → `/health` 200 healthy (node-redis connected), `/api/auth/login` 302 to Discord with `sid` cookie, `/api/auth/me` 401. Test session keys cleaned from Redis afterwards.
- **Scope honored:** no `packages/web` changes, no RBAC middleware / `channel_permissions` upsert / `/api/auth/roles` (all Story 2.4), `user_roles_cache` untouched.

### File List

**New — packages/shared:**
- `packages/shared/src/schemas/auth.ts`
- `packages/shared/src/schemas/auth.test.ts`

**New — packages/backend:**
- `packages/backend/src/domain/repositories/userRepository.ts`
- `packages/backend/src/domain/repositories/discordOAuthClient.ts`
- `packages/backend/src/application/services/authService.ts`
- `packages/backend/src/application/services/authService.test.ts`
- `packages/backend/src/presentation/controllers/authController.ts`
- `packages/backend/src/infrastructure/redis.ts`
- `packages/backend/src/infrastructure/userRepository.drizzle.ts`
- `packages/backend/src/infrastructure/discordOAuthClient.fetch.ts`
- `packages/backend/src/infrastructure/discordOAuthClient.fetch.test.ts`
- `packages/backend/src/infrastructure/sessionStore.ts`
- `packages/backend/src/routes/authRoutes.ts`
- `packages/backend/src/auth.integration.test.ts`

**Modified — packages/backend:**
- `packages/backend/package.json` (deps: +redis, +connect-redis, +express-session, +cors, +@types/*; −ioredis)
- `packages/backend/src/app.ts` (composition root + `AppOptions`)
- `packages/backend/src/main.ts` (node-redis + env + wiring)
- `packages/backend/src/health.ts` (ioredis type → node-redis `RedisClient`)
- `packages/backend/src/health.test.ts` (redis double type)
- `packages/backend/src/health.integration.test.ts` (`await openTestClients()`, `createApp` 3-arg)
- `packages/backend/src/test-helpers.ts` (node-redis, async `openTestClients`, `buildTestAppOptions`)

**Modified — shared/config/docs:**
- `packages/shared/src/schemas/index.ts` (export auth)
- `.env`, `.env.example` (+DISCORD_REDIRECT_URI, +SESSION_TTL_DAYS)
- `docs/context/ARCHITECTURE-SPINE.md`, `docs/context/TECHNICAL-DESIGN.md`, `docs/backend-standards.md`, `_bmad-output/project-context.md` (ioredis → node-redis)

### Change Log

- 2026-07-04 — Implemented Story 2.3 (Discord OAuth2 + Redis sessions, backend) following DDD-by-layer. Added 4 `/api/auth` endpoints, Redis session infra, guild-membership verification, `users` upsert, and the shared auth Zod contract. 20 new tests (13 unit + 7 integration). All ACs verified.
- 2026-07-04 — **Architecture decision:** dropped ioredis, standardized on node-redis (`redis@6`) project-wide (connect-redis@9 is node-redis-only; node-redis is the Redis-8-recommended client). Corrected AD-10/AD-13 + stack tables across the authoritative docs.

### Review Findings

- [x] [Review][Patch] Session fixation — session ID not regenerated after OAuth auth [authController.ts:56]
- [x] [Review][Patch] `/me` handler has no try/catch — DB/parse errors crash or return unstructured 500 [authController.ts:77]
- [x] [Review][Patch] No fetch timeout on Discord API calls — callback can hang indefinitely [discordOAuthClient.fetch.ts:27,40,54]
- [x] [Review][Patch] Discord `access_token` response shape not validated — silent `undefined` token [discordOAuthClient.fetch.ts:35]
- [x] [Review][Patch] Session not saved before redirect — `oauthState` may not persist under Redis latency [authController.ts:33]
- [x] [Review][Patch] Logout doesn't clear cookie when Redis is down — stale cookie persists [authController.ts:93]
- [x] [Review][Patch] `upsertByDiscordId` assumes row returned — `TypeError` on empty result [userRepository.drizzle.ts:14]
- [x] [Review][Patch] Inconsistent error codes — `INVALID_OAUTH_STATE`, `OAUTH_CALLBACK_FAILED`, `LOGOUT_FAILED` not in `AUTH_ERROR` [auth.ts + authController.ts]
- [x] [Review][Patch] `clearCookie('sid')` missing explicit path/options — fragile against future config changes [authController.ts:102]
- [x] [Review][Defer] No 429 retry logic for Discord rate limits [discordOAuthClient.fetch.ts] — deferred, unlikely at current scale
- [x] [Review][Defer] Error message leakage in logs [authController.ts:69] — deferred, observability concern for future story
