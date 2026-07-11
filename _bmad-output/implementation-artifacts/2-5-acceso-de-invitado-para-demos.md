---
baseline_commit: e9dba762544fcb4eae734d11ac4dd6e559c4a42e
---

# Story 2.5: Guest access for demos (config-gated)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an Operator presenting a demo,
I want a guest access on the login screen that does not require Discord,
so that I can show the application without credentials, while keeping RBAC and production security intact.

Epic 2 (Auth & App Shell) was completed on 2026-07-05; this story is **additive**, created via
bmad-correct-course (`sprint-change-proposal-2026-07-11-guest-access.md`, approved by Borja on
2026-07-11). It re-opens epic-2 (now `in-progress`) without reworking any existing story. The
guest is NOT an auth bypass: it is a real, RBAC-limited Redis session behind a config flag that
is **OFF by default**.

## Acceptance Criteria

1. **Disabled by default (gate).** Given `config.access_control.guest_access.enabled: false` — or the `guest_access` block absent entirely (the default) — when `POST /api/auth/guest` is called, it returns HTTP 404 `{ error: "Not found", code: "GUEST_ACCESS_DISABLED" }`, AND the login screen does NOT render the guest link (see D1 — the availability probe `GET /api/auth/guest` also returns the same 404).
2. **Boot seed when enabled.** Given `guest_access.enabled: true`, when the Backend starts, it upserts a guest `users` row (sentinel `discord_id = "guest"`, username from `guest_access.username`) BEFORE accepting requests, AND the synthetic role `guest_access.role` is available for RBAC expansion (i.e. it is just a string that `channel_permissions.allowed_roles` may list — no code registry).
3. **Guest session creation.** Given `guest_access.enabled: true`, when `POST /api/auth/guest` is called, it creates a Redis session `{ userId: <guestUserId>, discordRoles: [config.access_control.guest_access.role], isGuest: true }` with TTL `guest_access.session_ttl_minutes`, sets the httpOnly `sid` cookie, and returns HTTP 200.
4. **RBAC intact (AD-12).** Given a valid guest session, when the RBAC middleware expands roles, it joins `[guestRole]` against `channel_permissions` → `allowedChannelIds` = only the channels whose `allowed_roles` list the guest role, AND every vector/scoped query (search/chat/documents/stats/read-status) stays bounded to those channels. If no channel lists the role, `allowedChannelIds = []` (deny — the natural join result, no special branch).
5. **Guest identity in the UI.** Given a guest session, when the web app calls `GET /api/auth/me`, it returns the guest user with `isGuest: true`, AND the UI shows a visible "Modo invitado" indicator AND the logout button reads "Salir".
6. **Login flow.** Given the user clicks the guest link on the login screen, when `POST /api/auth/guest` completes, the app renders the authenticated layout in guest mode (no full-page reload required).

## Tasks / Subtasks

- [x] **Task 1 — Docs first (docs are the source of truth)** (AC: all) — apply the SCP §4.3/§4.4/§4.6/§4.7 text BEFORE code
  - [x] `docs/context/ARCHITECTURE-SPINE.md`: AD-10 Rule (line ~104) — session shape gains optional `isGuest: true` for guest sessions created via `POST /api/auth/guest`, same shape otherwise, still a real Redis session with TTL. AD-12 Rule (line ~116) — additive sentence: guest access is NOT an RBAC exception; the synthetic `guest_access.role` is expanded against `channel_permissions` like any role; unmapped → `[]` (deny). Anti-bypass note (line ~320, "nunca una ruta de auth-bypass en producción") — additive clarification: guest access (Historia 2.5) does not contradict the principle: it skips no auth/middleware, creates a real RBAC-limited session, is OFF by default, and `POST /api/auth/guest` answers 404 when the flag is off. Use the SCP §4.3 Spanish wording verbatim (the spine is legacy-Spanish; match surrounding language). Also update the State-Ownership `users` row (line ~293) to `backend (login Discord OAuth2 + guest seed)`.
  - [x] `docs/context/TECHNICAL-DESIGN.md`: (a) §10 `### Sesiones en Redis` Session interface (lines ~779–784) gains `isGuest?: boolean`; (b) NEW `### Acceso de invitado (demo)` subsection after line ~811 (before `## 11. API REST`): endpoint pair, config gate, guest user seed at startup, mini-sequence Browser → `POST /api/auth/guest` → Redis session (`isGuest`, short TTL) → cookie → RBAC via the guest role (do NOT touch the Discord OAuth2 mermaid diagram — the guest flow bypasses Discord entirely); (c) §11 endpoint table — add `POST /api/auth/guest` (and the `GET` probe) after the logout row (~L824–826); (d) §13 config example `access_control` block (lines ~970–977) — add the `guest_access` sub-block exactly as in Task 5; (e) §5.4 startup flow list (~L319) — add the conditional guest-user seed step next to the `channel_permissions` upsert.
  - [x] `docs/data-model.md`: Write-Ownership `users` row (~L25) → `backend (Discord OAuth2 login + guest seed at startup)`; `### 3. users` (~L81–89) — add a `**Notes:**` block (mirror the `channel_permissions` one at ~L109): when `access_control.guest_access.enabled`, backend seeds one row with sentinel `discord_id = "guest"` (explicit exception to the "snowflake for Discord entities" convention at ~L8) and a fixed UUID (`GUEST_USER_ID`); `conversations.user_id` FK (~L116) — optional one-liner that guest conversations attach to that row.
  - [x] `docs/api-spec.yml`: add `POST /api/auth/guest` (security: [], 200 → the `/me` object with `isGuest: true` + Set-Cookie `sid`; 404 → `Error` schema, example code `GUEST_ACCESS_DISABLED`) and `GET /api/auth/guest` (security: [], availability probe: 200 `{ enabled: { type: boolean, example: true } }` with a note that disabled is ALWAYS the 404 — never `{ enabled: false }`, matching the Zod `z.literal(true)` in Task 3; 404 same as POST) after `/api/auth/logout` (~L73); add optional `isGuest: { type: boolean }` to the inline `/api/auth/me` 200 schema (~L84–91). English text (documentation-standards).
  - [x] `docs/development_guide.md` §3 Configuration (~L34): one line — guest demo access is a YAML flag (`access_control.guest_access`, OFF by default), no secret involved; distinct from the fake-OAuth e2e harness (~L134–141).

- [x] **Task 2 — Shared: config schema `guest_access`** (AC: 1, 2, 3) — scope: `shared` (AD-5/AD-6/AD-8)
  - [x] `packages/shared/src/config/index.ts`: inside the `access_control` object (:85–90) add `guest_access: z.object({ enabled: z.boolean(), role: z.string().min(1).optional(), username: z.string().min(1).optional(), session_ttl_minutes: z.number().int().positive().optional() }).optional()`. Follow the `streams`/`notifications` precedent (D4): the config schema uses NO `.default()` — the whole block is `.optional()` ("existing configs/fixtures without it remain valid", same rationale as :107–110) and the CONSUMER (backend) resolves defaults. `enabled` is required when the block is present (an explicit block with no `enabled` is a config error — fail loud per AD-8).
  - [x] `packages/shared/src/config/index.test.ts`: extend with the optional-block pattern (mirror `'should parse an optional streams block when present'` :128): absent → `undefined`; present-minimal (`enabled: true` only) → parsed with optional fields undefined; full block → parsed; `enabled: "yes"` / `session_ttl_minutes: 0` → `ConfigError`.

- [x] **Task 3 — Shared: auth contracts** (AC: 1, 3, 5) — scope: `shared` (AD-6)
  - [x] `packages/shared/src/schemas/auth.ts`: (a) `AuthMeResponseSchema` (:7–13) gains `isGuest: z.boolean().optional()`; (b) `AUTH_ERROR` map (:30–38) gains `GUEST_ACCESS_DISABLED: 'GUEST_ACCESS_DISABLED'`; (c) NEW `GuestAvailabilityResponseSchema = z.object({ enabled: z.literal(true) })` + `export type GuestAvailabilityResponse = z.infer<...>` (the 200 body of the GET probe; disabled is expressed by the 404, never `{ enabled: false }`). Barrel `schemas/index.ts` already `export * from './auth.js'` — no change.
  - [x] `packages/shared/src/schemas/auth.test.ts`: round-trip `isGuest` present/absent on `AuthMeResponseSchema`; `GuestAvailabilityResponseSchema` accepts `{ enabled: true }`, rejects `{ enabled: false }`; new error code present.

- [x] **Task 4 — Backend: seed, session, endpoint, wiring** (AC: 1, 2, 3, 4, 5)
  - [x] `packages/backend/src/infrastructure/sessionStore.ts` (:13–19): add `isGuest?: boolean` to the `SessionData` augmentation (the ONLY place the session payload is typed).
  - [x] NEW `packages/backend/src/infrastructure/guestAccess.ts`:
    - `export const GUEST_USER_ID = '00000000-0000-4000-a000-000000000001'` (fixed, v4-shaped — passes `z.uuid()`), `export const GUEST_DISCORD_ID = 'guest'` (sentinel; can never collide with a real snowflake — snowflakes are numeric).
    - `resolveGuestAccessConfig(accessControl: Share2BrainConfig['access_control'])` → `{ enabled: boolean; role: string; username: string; sessionTtlMinutes: number }` with defaults `{ enabled: false, role: 'guest', username: 'Invitado', sessionTtlMinutes: 120 }` (mirrors the workers' `resolveStreamsConfig` consumer-resolves-defaults pattern, D4).
    - `seedGuestUser(db: Database, username: string): Promise<{ id: string }>` — single statement: `db.insert(users).values({ id: GUEST_USER_ID, discordId: GUEST_DISCORD_ID, username, avatar: null }).onConflictDoUpdate({ target: users.discordId, set: { username } }).returning({ id: users.id })` — on conflict Postgres returns the EXISTING row's id, so a pre-existing guest row with a different UUID is honored (use the returned id downstream, never assume `GUEST_USER_ID`). Import `users` only via `@share2brain/shared/db` (AD-2). Mirrors `materializeChannelPermissions.ts` in shape (config-slice in, upsert, no transaction).
  - [x] `packages/backend/src/app.ts`: `AppOptions` (:65–105) gains `guestAccess?: { role: string; sessionTtlMinutes: number; userId: string }` (no `username` — it only feeds `seedGuestUser`; `/me` reads the name from the seeded row) — **presence = enabled** (precedent: `oauth?`, `rateLimit?`; only `main.ts` injects from config, `buildTestAppOptions` omits it so every existing test and the e2e server see guest access disabled). Thread it into `createAuthController` deps. Do NOT change `createApp`'s signature (the 2.3 regression).
  - [x] `packages/backend/src/presentation/controllers/authController.ts`: extend `createAuthController` deps with `guestAccess?`, extend the `AuthController` interface (:16–22, currently `login/callback/me/roles/logout`) with `guestAvailability` and `guestLogin`, and add the two handlers:
    - `guestAvailability(req, res)`: no `deps.guestAccess` → 404 `{ error: 'Not found', code: AUTH_ERROR.GUEST_ACCESS_DISABLED }` (D10 — message verbatim from the AC; the generic English "Not found" also hides existence, consistent with the conversations D9 no-existence-signal precedent); else 200 `GuestAvailabilityResponseSchema.parse({ enabled: true })`.
    - `guestLogin(req, res)`: no `deps.guestAccess` → the same 404. Else replicate the callback's session establishment (:73–91, P1 anti-fixation): `req.session.regenerate(cb)` → set `req.session.userId = guestAccess.userId`, `req.session.discordRoles = [guestAccess.role]`, `req.session.isGuest = true`, **`req.session.cookie.maxAge = guestAccess.sessionTtlMinutes * 60_000`** (D7 — connect-redis v9 computes the Redis `EX` from `sess.cookie.expires`, which express-session derives from `maxAge`, and it WINS over the store-level `ttl` option — verified in `node_modules/connect-redis/dist/connect-redis.js:122–132`; the cookie and the Redis key expire together) → explicit `req.session.save(cb)` → 200 with the guest `AuthMeResponse`: `{ ...me, isGuest: true }` where `me = await authService.getMe(guestAccess.userId)`. **`getMe` returns `AuthMeResponse | null`** — a `null` (seed invariant broken) must respond 500 `AUTH_ERROR.INTERNAL`, never spread `null` into `{ isGuest: true }`. Errors: try/catch → 500 `{ error, code: AUTH_ERROR.INTERNAL }`, `console.error('[auth] guest login failed:', ...)` — never leak internals.
    - `me` handler: when `req.session.isGuest === true`, spread `isGuest: true` into the response (absent otherwise — the schema field is optional, D6).
  - [x] `packages/backend/src/routes/authRoutes.ts` (:8–18): add `router.get('/guest', ...)` and `router.post('/guest', ...)`. Both are public (no `requireAuth`) — the whole `/api/auth` mount is registered BEFORE the generic gate (`app.ts:190` vs `:196`) so they are exempt for free, and they inherit the existing `authLimiters` rate limiting on the mount.
  - [x] `packages/backend/src/main.ts`: after `materializeChannelPermissions` (:88–91), still before `listen`: `const guest = resolveGuestAccessConfig(config.access_control)`; **ONLY inside the `guest.enabled` branch** seed (`const { id } = await seedGuestUser(db, guest.username)`) and build `guestAccess: { role: guest.role, sessionTtlMinutes: guest.sessionTtlMinutes, userId: id }`; when disabled, OMIT the `guestAccess` key from the `createApp` options entirely (presence = enabled — an unconditional pass would enable guest access in production with the flag OFF and only the manual smoke would catch it; `main.ts` has no automated coverage). A seed failure aborts startup (same policy as the permissions upsert — first DB queries, `exit(1)`).

- [x] **Task 5 — Config example** (AC: 1)
  - [x] `Share2Brain.config.yml.example` (`access_control` block, L92–103): add after `role_cache_ttl`, with a comment header:
    ```yaml
    # NEW — guest access for demos. OFF by default (never auth-bypass in prod).
    guest_access:
      enabled: false            # operator sets true only for the demo
      role: "guest"             # synthetic role; add it to allowed_roles of demo channels
      username: "Invitado"      # display name in the UI
      session_ttl_minutes: 120  # short-lived demo session
    ```
    and show `"guest"` appended to ONE example channel's `allowed_roles` (as in the SCP §4.5). Keep TECHNICAL-DESIGN §13 (Task 1) byte-identical to this block. Do NOT touch Borja's untracked local `Share2Brain.config.yml`.

- [x] **Task 6 — Web: login link, guest session, guest-mode UI** (AC: 1, 5, 6) — scope: `web` (AD-3)
  - [x] `packages/web/src/api/auth.ts` (imports ONLY from `@share2brain/shared/schemas` — ESLint-enforced):
    - `fetchGuestAvailability(): Promise<boolean>` → `fetch('/api/auth/guest', { credentials: 'include' })`; 200 → `GuestAvailabilityResponseSchema.parse(json).enabled`; **any non-200 (404 included) → `false`** (fail-hidden, D1 — a probe failure must never break the Discord path).
    - `loginAsGuest(): Promise<AuthMeResponse>` → `fetch('/api/auth/guest', { method: 'POST', credentials: 'include' })`; non-OK → throw; 200 → `AuthMeResponseSchema.parse(json)`.
  - [x] `packages/web/src/components/icons.tsx`: add `UserIcon` (person SVG from the design mock: `<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`, stroke-based like siblings, size prop).
  - [x] `packages/web/src/components/LoginScreen.tsx`: gains prop `onGuest: () => void`. Owns the availability probe (views own their data-fetching): `useEffect` → `fetchGuestAvailability()` → `setShowGuest(boolean)`, default `false` so the link never flashes when disabled; probe rejection → stays hidden. When `showGuest`, render BETWEEN the lock line (item 6) and the footer (item 7), design values extracted verbatim from the mock (`--tx*` → real tokens per tests/README:122–123; **do not re-parse the 576KB mock**):
    - Divider: `marginTop: 22`, flex row `gap: 12`, two `flex:1; height:1px; background: var(--border)` spans around a label `"o para la demo"` — IBM Plex Mono, 10.5px, `letterSpacing: '0.08em'`, uppercase, `var(--text-subtle)`.
    - Guest button `data-testid="guest-login-btn"`, `className="kh-guest-btn"`: `marginTop: 22`, width 100%, height 48, flex center `gap: 10`, borderRadius 12, background transparent, fontSize 14.5, fontWeight 600, cursor pointer, `<UserIcon size={18} />` + `<span>Entrar como invitado</span>`, `onClick={onGuest}`.
  - [x] `packages/web/src/styles/components.css`: NEW `.kh-guest-btn` — **base `border: 1px solid var(--border-strong)` and `color: var(--text-secondary)` MUST live in the class, not inline** (cascade gotcha, Epic 4 retro AI#4: any property that changes on `:hover` needs its base in the class) + `transition: border-color .15s ease, color .15s ease`; `.kh-guest-btn:hover { border-color: var(--accent-ink); color: var(--accent-ink); }` (mock `style-hover` verbatim); add a `:focus-visible` outline mirroring `.kh-discord-btn`'s (8.1 review precedent: interactive elements ship focus-visible).
  - [x] `packages/web/src/App.tsx`: `onGuest` handler — `try { const u = await loginAsGuest(); setUser(u); setAuthState('authed'); } catch { console.error('[web] guest login failed'); }` (stays `anon` on failure, mirrors the logout-failure convention). Pass `onGuest` to `LoginScreen` and `isGuest={user.isGuest === true}` down the layout.
  - [x] `packages/web/src/components/AppLayout.tsx` + `Header.tsx`: thread `isGuest: boolean`. In the Header right cluster, before the avatar: a "Modo invitado" pill `data-testid="guest-mode-badge"` (D3 — no design-mock reference exists; mirror the "indexando en vivo" pill geometry/typography at `Header.tsx:74–97` with amber accent: `color: var(--accent-ink)`, `<UserIcon size={12} />` instead of the pulsing dot, no animation). Logout button (:129–138): `title`/`aria-label` = `"Salir"` when `isGuest`, `"Cerrar sesión"` otherwise (icon-only button — "the logout button reads Salir" is satisfied via its accessible name, D3).

- [x] **Task 7 — Tests (unit + integration)** (AC: all)
  - [x] **Shared** — covered in Tasks 2–3.
  - [x] **Backend unit** — NEW focused unit test (e.g. `presentation/controllers/authController.guest.test.ts` or `infrastructure/guestAccess.test.ts` — NO `authController.test.ts` exists today, only `requireAuth.test.ts`/`authService.test.ts`): disabled (no `guestAccess` dep) → GET and POST both 404 `GUEST_ACCESS_DISABLED` (req/res doubles per `requireAuth.test.ts`); enabled → session fields set (`userId`, `discordRoles: [role]`, `isGuest: true`, `cookie.maxAge = ttl*60_000`) and 200 body has `isGuest: true`; `resolveGuestAccessConfig` defaults (absent block → `enabled: false`; partial block → defaults filled).
  - [x] **Backend integration** — NEW `packages/backend/src/guest.integration.test.ts` (own file: it needs its own `AppOptions`), real Postgres+Redis via `openTestClients()` + `buildTestAppOptions(...)`, RUN-UNIQUE ids `itest-guest-*-${SFX}` (rbac suite pattern), cleanup in `afterAll`:
    - (a) Default app (no `guestAccess`): `GET /api/auth/guest` → 404 `GUEST_ACCESS_DISABLED`; `POST` → 404.
    - (b) App with `guestAccess` (seed first: `seedGuestUser(db, 'Invitado')` → use returned id): `POST /api/auth/guest` → 200, `Set-Cookie sid`, body `isGuest: true`; `sess:<sid>` exists in Redis with the session JSON containing `isGuest: true`; **`redis.ttl('sess:'+sid)` ≤ `sessionTtlMinutes*60` and > `sessionTtlMinutes*60 − 60`** (proves the per-session TTL beat the store default). The `sid` in the Set-Cookie is signed (`s:<sid>.<sig>`) — reuse the existing `sidFromSetCookie` helper pattern (`auth.integration.test.ts:41–47`).
    - (c) RBAC scoping: seed a `channel_permissions` row whose `allowed_roles` = `[guestRole]` and another without it; guest agent `GET /api/auth/roles` → `allowedChannels` contains exactly the mapped channel (and a non-guest channel id is absent — RBAC is a security boundary, test the exclusion explicitly).
    - (d) Deny: `guestAccess.role` mapped to no channel → `allowedChannels: []`.
    - (e) Generic gate: guest agent `GET /api/anything` → passes `requireAuth` (session has `userId`) → 404 route-not-found, NOT 401.
    - (f) Guest chat persists a conversation (D9, SCP §5 success criterion): with the guest agent, drive `POST /api/chat` using the injected fake chat model (mirror the `chat.integration.test.ts` harness — it proves this is cheap) and assert a `conversations` row lands with `user_id = <seeded guest id>` — the FK the seed exists for, proven through the real pipeline.
    - (g) Seed idempotency: `seedGuestUser` twice → one row, same id, username refreshed; pre-existing `discord_id='guest'` row with a random UUID → returned id is the existing one.
    - ⚠️ The guest sentinel row is a SINGLETON, not run-unique like `itest-*-${SFX}` — this suite mutates/deletes `discord_id='guest'` and is NOT concurrency-safe with a running e2e server or a dev's manually-enabled guest row on the shared DB. `afterAll`: delete the guest's `conversations` rows first (FK), then the guest `users` row.
  - [x] **Web unit** — extend `packages/web/src/App.test.tsx` (partial `vi.mock('./api/auth')` keeping `LOGIN_URL` real, per :14–17; PROFILE fixture :35–41 gains an `isGuest` variant): availability `false` → anon screen has NO `guest-login-btn`; availability `true` → button rendered; click → `loginAsGuest` resolves guest profile → authed shell with `guest-mode-badge`, header identity "Invitado"/"IN", logout button accessible-named `/Salir/i`; `loginAsGuest` rejects → stays on login; non-guest profile → no badge and logout still `/Cerrar sesión/i`.

- [x] **Task 8 — E2E (Playwright) + harness wiring** (AC: 4, 5, 6)
  - [x] `packages/backend/src/e2e/server.ts`: enable guest access in the harness only — after `resetAndSeed`, call `seedGuestUser(db, 'Invitado')` and pass `guestAccess: { role: 'e2e-role-guest', sessionTtlMinutes: 120, userId: <returned id> }` into the app options. The prod path is untouched (`main.ts` reads the YAML flag; `buildTestAppOptions` still omits guest). The server keeps refusing `NODE_ENV=production`.
  - [x] `packages/backend/src/e2e/seed.ts`: add `'e2e-role-guest'` to `e2e-ch-general`'s `allowed_roles` ONLY (guest must see general but NOT `e2e-ch-random`'s docs and NEVER the `e2e-ch-secreto` canary). Note this is a structural edit: `ChannelSpec` today is `allowedRole: string` (singular, :44–48) inserted as `ARRAY[${c.allowedRole}]::text[]` (:188–191) — reshape it to `allowedRoles: string[]` and update all four channel entries + the insert; do NOT hack a second row. **Do NOT widen any reset delete** — the predicates are hard-scoped to `e2e-` prefixes ("NEVER widen these predicates", seed.ts:163–166; the shared local DB is the reason) and `discord_id = 'guest'` must never be deleted by the reset; `seedGuestUser`'s upsert on the fixed sentinel makes reseeds idempotent with zero accumulation.
  - [x] `packages/web/tests/helpers/session.ts`: add `loginAsGuest(page)` — `page.request.post('/api/auth/guest')` (shared cookie jar), then theme init-script + `goto('/')` + authenticated-layout assertion, mirroring `loginAs`.
  - [x] NEW `packages/web/tests/auth-guest.spec.ts` — sorts alphabetically SECOND (`analytics` < `auth-guest` < `chat`), so `analytics` still runs first and its seed-fresh figures are structurally unaffected; the spec must STILL be strictly non-mutating (D8) because it runs before the mutating `chat`/`docs` specs: no chat message, no doc-row click (mark-read), no mark-all. Cover: login screen shows `guest-login-btn` (harness has guest enabled) with computed base/border colors; click → authenticated layout + `guest-mode-badge` visible + header shows "Invitado"; DocsView lists only `e2e-ch-general` resources — `#secreto` and `Eve Intrusa` absent (RBAC canaries, README:69–85) and `e2e-ch-random` docs absent (scoping, not just the canary); logout button accessible name "Salir" → click → login screen again.
  - [x] `packages/web/tests/README.md`: sync the spec-ordering table (5 → 6 files, `auth-guest` in position 2 — after `analytics`, before `chat` — with its non-mutating rationale) and the seed-identities table (guest identity + `e2e-role-guest` mapping). README :87–104 documents analytics-first as a load-bearing invariant — it is preserved.

- [x] **Task 9 — Verification gate (the AGENT runs it, pastes output)** (AC: all)
  - [x] `npm run lint && npm run test && npm run build` — green, paste output.
  - [x] `docker compose up -d postgres redis && npm run test:integration` — green, paste output.
  - [x] Playwright e2e suite (full 6-spec run — the new spec changes global ordering, so run ALL specs, not just the new one) — green, paste output.
  - [x] Manual smoke (see Dev Notes → Manual verification). Restore any seeded/local config state.

## Dev Notes

### Scope boundary — what this story does and does NOT do
- **IN scope:** the `guest_access` config block (shared) + resolver/seed/endpoints/wiring (backend) + login link, guest session and guest-mode UI (web) + docs/contract sync + tests/e2e listed above.
- **OUT of scope:** any change to the OAuth flow, RBAC middleware, or vector-query filters. _(Review amendment: the code-review passes added guest **ownership-isolation** guards to existing per-user endpoints — `GET /api/conversations` + `:id`, `POST /api/chat` resume, `POST /api/read-status/*`, `GET /api/stats` — to close the shared-sentinel-identity blast radius. These are additive `isGuest` branches that change NO channel visibility/RBAC and are legitimized by the anti-pattern carve-out below and the `## Review Findings` log; the original "no change to existing endpoints" intent stands for everything else.)_ `access_control.enabled` semantics (2.4 defer — do not reopen); rate-limit tuning (guest inherits the existing `authLimiters`); a guest banner in views other than the header; auto-expiry UX (when the guest TTL lapses, the next API call 401s and the existing App logic lands on the login screen — that is acceptable demo behavior); i18n; the PRD one-liner (SCP §4.2 marks it optional — skipped); fixing adjacent api-spec drift (e.g. logout documented as 204 but implemented as 200 `{ ok: true }` — pre-existing, do NOT widen the diff).
- **No DDL, no migration, no new dependency, no new env var.** The sentinel row rides the existing `users` schema (`discord_id` is plain `text`, NOT NULL + UNIQUE via `idx_users_discord_id`, `schema.ts:91–101`); `id .defaultRandom()` is overridable in `values()`.

### Ratified defaults (flag ANY of these in review if you disagree)
- **D1 — Link-visibility discovery = `GET /api/auth/guest` availability probe.** The AC requires the link *hidden* when disabled, the mock always renders it, and NO unauthenticated config/status endpoint exists. A GET on the same path (200 `{ enabled: true }` / 404 `GUEST_ACCESS_DISABLED`) is the smallest server signal; it lives under the already-401-exempt `/api/auth` mount and leaks nothing (existence-hiding 404). Web treats any non-200 as "hidden".
- **D2 — Guest button/divider design = mock-verbatim** (extracted above; the mock's `sc-camel-on-click="{{ onGuest }}"` button between the lock line and the footer). Token translation `--tx2→--text-secondary`, `--tx4→--text-muted`, `--tx5→--text-subtle`.
- **D3 — "Modo invitado" indicator and "Salir" have NO mock reference** (grep: 0 hits for both; the mock's whole guest presentation is the header identity becoming `Invitado`/`IN`). Ratified: a static amber pill mirroring the "indexando en vivo" pill geometry (`Header.tsx:74–97`) + the icon-only logout button's `title`/`aria-label` flipping to "Salir".
- **D4 — Config defaults live in the backend resolver, not the Zod schema.** The config schema has NO `.default()` anywhere; optional blocks (`streams`, `notifications`) are `.optional()` and consumers resolve defaults. `guest_access` follows `streams` exactly (`resolveGuestAccessConfig` mirrors `resolveStreamsConfig`).
- **D5 — Fixed UUID + honor-existing-row.** `GUEST_USER_ID = '00000000-0000-4000-a000-000000000001'` (v4-shaped so `z.uuid()` passes) is only the id used on FIRST insert; the seed always uses the id RETURNED by the upsert, so a pre-existing guest row keeps its id. Sentinel `discord_id = 'guest'` cannot collide with snowflakes (numeric).
- **D6 — `isGuest` is optional-when-true on `/me` and the POST body** (absent for regular users, never `false`). Web checks `user.isGuest === true`.
- **D7 — Per-session TTL via `req.session.cookie.maxAge`.** connect-redis v9 derives the Redis `EX` from `sess.cookie.expires` (set by express-session from `maxAge`) and it wins over the store-level `ttl` — no store/config change needed. Global `SESSION_TTL_DAYS` behavior for OAuth sessions is untouched.
- **D8 — E2E spec named `auth-guest.spec.ts` sorts SECOND** (alphabetical discovery, `workers: 1`: `analytics → auth-guest → chat → docs → interactions → search`). The analytics-first invariant is preserved; the guest spec must still be strictly non-mutating because it runs before the mutating `chat`/`docs` specs: guest login/session creation touches no seed data those specs assert (no chat → no conversations under the member; no doc clicks → read/unread mix intact; `channel_permissions` extra role does not change member aggregates). Any future mutating guest test must move after the seed-dependent specs or reseed (README:113–116).
- **D9 — "Guest chat persists a conversation" (SCP §5) is proven in integration by driving `POST /api/chat` with the injected fake chat model** (the `chat.integration.test.ts` harness already makes this cheap) and asserting the `conversations` row lands under the seeded guest `user_id` — the FK is the guest-specific risk, and this exercises it through the real pipeline without a live LLM.
- **D10 — 404 message is the AC-verbatim English `"Not found"`** (other 404s use Spanish human messages, e.g. `'Conversación no encontrada'`). The generic English string doubles as existence-hiding; the code `GUEST_ACCESS_DISABLED` is the machine signal.

### Current state — extend the 2.3/2.4 auth stack, don't reinvent
- **Session middleware** `packages/backend/src/infrastructure/sessionStore.ts`: `SessionData` augmentation (:13–19) is the ONLY session typing point (`userId`, `discordRoles`, `oauthState?` → add `isGuest?`). `createSessionMiddleware(redis, { secret, ttlDays, cookieSecure })` (:21–44): `RedisStore({ prefix: 'sess:', ttl: ttlDays*86_400 })`, cookie `sid`, `sameSite: 'lax'`, `maxAge: ttlDays*86_400_000`.
- **401 gate by ORDER, not path checks**: `/api/auth` router mounts at `app.ts:190` BEFORE the generic `app.use('/api', ...apiLimiters, requireAuth, createRbacMiddleware(rbacService))` at `:196` — the new `/guest` routes are exempt for free and inherit `authLimiters`.
- **RBAC middleware** `middleware/rbac.ts:10–29` reads `req.session.discordRoles ?? []` per request → `req.allowedChannelIds`. A guest session with `discordRoles: ['guest']` flows through UNCHANGED — this story adds ZERO RBAC code; guest visibility is purely `channel_permissions.allowed_roles` data (AD-12 intact by construction).
- **Session establishment pattern** (`authController.ts:73–91`, P1 anti-fixation from the 2.3 review): `regenerate` → set fields → explicit `save` → respond. Replicate in `guestLogin`.
- **Startup seed pattern** `infrastructure/materializeChannelPermissions.ts:12–24` called from `main.ts:88–91` ("first DB query; if it throws, abort startup"). The guest seed sits immediately after, same abort policy.
- **User upsert precedent** `infrastructure/userRepository.drizzle.ts:11–21` (`onConflictDoUpdate` on `users.discordId`, `.returning({ id })`) — `seedGuestUser` mirrors it but passes an explicit `id` (do NOT extend the `UserRepository` port for a boot-time seed; a standalone infra function mirrors `materializeChannelPermissions`).
- **`/me` composition** `authService.getMe(userId)` validates against `AuthMeResponseSchema` — reuse it for the guest 200 body and spread `isGuest: true` at the controller layer (the service stays guest-agnostic).
- **Error convention**: inline `res.status(404).json({ error, code })`, codes in per-domain `X_ERROR` maps in shared schemas. No helper middleware.
- **Web auth client** `packages/web/src/api/auth.ts` — bare fetch, `credentials: 'include'`, `Schema.parse`, status-mapping precedent (401→null in `fetchMe`); imports ONLY `@share2brain/shared/schemas` (ESLint `no-restricted-imports` on `packages/web/**`).
- **App state machine** `App.tsx`: `authState: 'loading'|'anon'|'authed'` + `user`; login = full-page nav; logout keeps authed on failure. Guest login is the FIRST in-SPA (no-redirect) auth transition — set `user` + `authed` directly from the POST body (AC6 "no full-page reload").
- **LoginScreen** is currently pure-presentational (`{ onLogin }`); it gains the probe + `onGuest`. Insert point: between the lock line (:130–143) and the footer (:145–161).
- **Header** right cluster order (:73–139): live-pulse pill → avatar+name → theme btn → logout btn (`kh-icon-btn kh-logout-btn`, `title`/`aria-label` "Cerrar sesión", `LogoutIcon`). Web unit tests locate it by accessible name (`App.test.tsx:118`).
- **E2E must stay bypass-free**: `e2e/server.ts` refuses `NODE_ENV=production` (:13–16) and fakes auth ONLY via the injected fake `DiscordOAuthClient`. Guest in the harness = the same real endpoint with the option set — no new bypass surface. This is exactly the reconciliation the spine's anti-bypass note needs (Task 1): a config-gated real session ≠ a bypass route.

### Anti-patterns to avoid (project-context + this story)
❌ A `sessions` table or any session persistence outside Redis (AD-10). ❌ Caching `allowedChannelIds` in the guest session (AD-12 — recompute per request; you change NOTHING in rbac.ts). ❌ A guest branch that alters RBAC/**visibility** (channel scoping, the vector query, `allowedChannelIds`) in any handler — visibility is data (`channel_permissions`), not code; `rbac.ts` stays untouched. **CARVE-OUT (review, D5-forced):** an *ownership-isolation* guest branch IS allowed where the shared sentinel `userId` breaks per-user ownership — i.e. `conversationController` (list empty / detail 404), `chatService.resolveConversation` (per-session `guestConversationIds` allowlist), `readStatusService` (ephemeral no-op writes), `statsService` (per-user aggregates → 0). These change no channel visibility; they compensate for the one-shared-identity decision. The line is: RBAC/visibility branch = forbidden; ownership/session-isolation branch = allowed. ❌ Defining the guest response shapes or config schema outside `packages/shared` (AD-5/AD-6). ❌ `.default()` inside the config schema (breaks the repo convention — resolver-side defaults, D4). ❌ Web importing the shared root barrel or `/db`/`/config`. ❌ Hardcoding `GUEST_USER_ID` downstream of the seed (use the returned id). ❌ Skipping `req.session.regenerate` (session fixation). ❌ Base border/color of `.kh-guest-btn` inline (kills the hover — cascade gotcha). ❌ An always-visible guest link (AC1 requires hidden-when-disabled). ❌ Enabling guest in `buildTestAppOptions` defaults (existing suites must keep seeing 404). ❌ A mutating `auth-guest.spec.ts` (breaks the e2e ordering invariant). ❌ Marking an AC done without pasting verification output.

### Regression checklist
- `AuthMeResponseSchema` gains an optional field — existing parsers unaffected (optional), but `App.test.tsx` PROFILE fixture and e2e `/me` assertions must still pass untouched.
- `createAuthController` deps object grows — update its unit-test fixtures compile-only if any construct it directly.
- `AppOptions` grows an optional field — `buildTestAppOptions`, `main.ts`, `e2e/server.ts` are the only constructors; existing integration suites must stay green with guest disabled (404 branch is their new implicit default).
- `LoginScreen` gains a prop + effect — `App.test.tsx` anon-path tests now render a LoginScreen that fires the probe: the `./api/auth` partial mock MUST stub `fetchGuestAvailability` (unstubbed → real fetch in jsdom → noise/failures).
- New spec enters the e2e alphabetical order in position 2 (`analytics → auth-guest → chat → …`): run the FULL 6-spec suite and confirm the downstream specs (`chat`/`docs`/`interactions`/`search`) still hold with the guest spec running before them (it is non-mutating by design — verify, don't assume).
- `e2e/seed.ts` reset: ensure guest `users` row (non-`e2e-`-prefixed `discord_id='guest'`) doesn't accumulate or break FK-ordered deletes across reseeds.
- Grep `createApp(` and `createAuthController(` before finishing.

### Testing standards
- Vitest; co-located `*.test.ts`; integration `*.integration.test.ts` against real Postgres+Redis (`docker compose up -d postgres redis`; `SHARE2BRAIN_TEST_ALLOW_SHARED_DB=1` guard exists). AAA, behavior-named `should <behavior> when <condition>`.
- **Tests-first where it pays** = the gate semantics (404-when-disabled on both verbs) and the session shape/TTL — security boundary. Adapter glue (routes, seed SQL, LoginScreen JSX) may test after.
- Config faking: backend tests NEVER mock `loadConfig` — config enters as `AppOptions` (`buildTestAppOptions(overrides)`); shared config tests use real temp-file YAML fixtures (`writeFixture` pattern, `config/index.test.ts:84–96`).
- Web: `vi.mock('./api/auth')` partial-mock (keep `LOGIN_URL` real), testing-library, NO jest-dom matchers (`toBeTruthy()`/`toBeNull()`), `cleanup` in `afterEach`.
- RBAC exclusion is always asserted explicitly (a channel NOT listing the guest role must NOT appear).

### Manual verification (Task 9)
Local: set `guest_access.enabled: true` in your local `Share2Brain.config.yml` + add `"guest"` to one channel's `allowed_roles`; `npm run dev -w @share2brain/backend` + `-w @share2brain/web`; open `:5173` → guest button visible under "o para la demo"; click → authenticated layout, header pill "Modo invitado", identity "Invitado"; `redis-cli TTL sess:<sid>` ≈ 7200; DocsView/Search show only the mapped channel; logout ("Salir") → login. Flip the flag off, restart → button hidden, `curl -X POST :3000/api/auth/guest` → 404 `GUEST_ACCESS_DISABLED`. Restore your local config afterwards.

### Project Structure Notes

```
packages/shared/src/
├── config/index.ts                     # EXTEND — guest_access optional block in access_control
├── config/index.test.ts                # EXTEND — optional-block cases
├── schemas/auth.ts                     # EXTEND — isGuest?, GUEST_ACCESS_DISABLED, GuestAvailabilityResponseSchema
└── schemas/auth.test.ts                # EXTEND

packages/backend/src/
├── infrastructure/sessionStore.ts      # EXTEND — SessionData.isGuest?
├── infrastructure/guestAccess.ts       # NEW — GUEST_USER_ID, resolveGuestAccessConfig, seedGuestUser
├── presentation/controllers/authController.ts  # EXTEND — guestAvailability + guestLogin + me isGuest
├── routes/authRoutes.ts                # EXTEND — GET/POST /guest
├── app.ts                              # EXTEND — AppOptions.guestAccess?
├── main.ts                             # EXTEND — resolve + seed (enabled only) before listen
├── guest.integration.test.ts           # NEW
└── e2e/{server.ts,seed.ts}             # EXTEND — harness-only guest enablement + role mapping

packages/web/src/
├── api/auth.ts                         # EXTEND — fetchGuestAvailability, loginAsGuest
├── components/icons.tsx                # EXTEND — UserIcon
├── components/LoginScreen.tsx          # EXTEND — probe + divider + guest button + onGuest
├── components/{AppLayout,Header}.tsx   # EXTEND — isGuest threading + badge + "Salir"
├── styles/components.css               # EXTEND — .kh-guest-btn (+hover/focus-visible)
├── App.tsx                             # EXTEND — onGuest handler + isGuest prop
└── App.test.tsx                        # EXTEND

packages/web/tests/
├── auth-guest.spec.ts                  # NEW — sorts first; strictly non-mutating
├── helpers/session.ts                  # EXTEND — loginAsGuest
└── README.md                           # EXTEND — ordering + identities

docs/context/ARCHITECTURE-SPINE.md · docs/context/TECHNICAL-DESIGN.md · docs/data-model.md ·
docs/api-spec.yml · docs/development_guide.md · Share2Brain.config.yml.example   # EXTEND (Task 1/5)
```
- Branch: `feat/2-5-guest-access` off `main` (`e9dba76`). Conventional Commits, scopes `shared|backend|web|repo`, one commit per meaningful slice (docs → shared → backend → web → e2e is the natural sequence).
- English only in all code/comments/tests/commits; UI copy is Spanish by design ("Entrar como invitado", "Modo invitado", "Salir", "o para la demo").
- No new FR: guest access extends FR9 (OAuth2 + Redis sessions) and FR22 (YAML config); the FR inventory tops out at FR25 — no renumbering, no collision.

### References
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-11-guest-access.md] — approved design, ACs (§4.1), config block (§4.5), contract plan (§4.7), doc edits (§4.3/§4.4/§4.6), non-negotiables (§5).
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 2.5] — AC block (inserted from the SCP).
- [Source: docs/context/ARCHITECTURE-SPINE.md#AD-10 (~L100–104), #AD-12 (~L112–116), anti-bypass note (~L320)] — invariants this story extends without breaking.
- [Source: docs/context/TECHNICAL-DESIGN.md §5.4 (~L316–343), §10 (~L748–811), §11 (~L815–838), §13 (~L970–977)] — auth design, edit slots.
- [Source: docs/api-spec.yml L48–100 (auth paths), L330–336 (Error), L471–491 (responses)] — contract surface.
- [Source: docs/data-model.md L25, L81–89, L111–118] — users/conversations surfaces.
- [Source: _bmad-output/implementation-artifacts/2-4-rbac-proteccion-de-rutas-y-conexion-ui.md] — middleware ordering, RBAC expansion, gate exemption-by-order, web session flow (the stack this story extends).
- [Source: docs/context/design/Share2Brain Web.dc.html] — guest button/divider design (values EXTRACTED into Task 6; 576KB single-line mock — do not re-parse).
- Current code (verified 2026-07-11): `packages/backend/src/{app.ts:65–196, main.ts:30–136, infrastructure/{sessionStore.ts:13–44, materializeChannelPermissions.ts:12–24, userRepository.drizzle.ts:11–21}, middleware/{requireAuth.ts:8–14, rbac.ts:10–29}, presentation/controllers/authController.ts:24–91, routes/authRoutes.ts:8–18, test-helpers.ts:109–153, e2e/{server.ts,seed.ts}}`; `packages/shared/src/{config/index.ts:85–90,107–110,160+, schemas/{auth.ts:7–38, errors.ts:5–8}, db/schema.ts:91–101,124–126}`; `packages/web/src/{App.tsx:26–141, api/auth.ts, components/{LoginScreen.tsx:11–161, Header.tsx:10–139, AppLayout.tsx:21–86, icons.tsx}, styles/components.css:12–60}`; `packages/web/tests/{helpers/session.ts, README.md:62–127}`; `node_modules/connect-redis/dist/connect-redis.js:122–132` (TTL precedence).

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (bmad-dev-story)

### Debug Log References

- E2E first run: `auth-guest.spec.ts` "guest shell" test failed on a Playwright strict-mode
  locator collision — `getByText('Invitado')` matched both the "Modo invitado" pill and the
  header "Invitado" identity. Fixed with `{ exact: true }` on the identity match (no product
  change). Re-ran the full 6-spec suite → 27/27 green.
- Integration + e2e were run with the app containers stopped (`docker compose stop bot backend
  workers`) per the `docs/development_guide.md` precondition — the running backend/bot/workers
  connect to the shared dev DB from a foreign client address and trip the competing-writer guard
  (`test-helpers.ts`), and the guest sentinel row is a singleton not concurrency-safe with a live
  guest-enabled backend. Containers were restarted afterward to restore the dev stack.

### Completion Notes List

- **Docs-first (Task 1):** applied the SCP §4.3/§4.4/§4.6/§4.7 edits verbatim BEFORE any code —
  ARCHITECTURE-SPINE AD-10 (`isGuest?`), AD-12 (guest is not an RBAC exception), the anti-bypass
  note, and the `users` State-Ownership row; TECHNICAL-DESIGN §5.4 seed step, §10 Session
  interface, the NEW "Acceso de invitado (demo)" subsection, §11 endpoint table, §13 config block;
  data-model users Notes + conversations FK; api-spec GET/POST `/api/auth/guest` + `/me` `isGuest`;
  development_guide §3.
- **Shared (Tasks 2–3):** `access_control.guest_access` optional block (NO `.default()`, D4);
  `AuthMeResponseSchema.isGuest?`, `AUTH_ERROR.GUEST_ACCESS_DISABLED`, `GuestAvailabilityResponseSchema
  = z.object({ enabled: z.literal(true) })`. 55 shared unit tests green.
- **Backend (Task 4):** `SessionData.isGuest?`; NEW `guestAccess.ts` (`GUEST_USER_ID`,
  `GUEST_DISCORD_ID`, `resolveGuestAccessConfig` consumer-defaults, `seedGuestUser` upsert honoring
  the returned id, D5); `authController` `guestAvailability` + `guestLogin` (regenerate → set fields
  → `cookie.maxAge = ttl*60_000` (D7) → save → `{ ...me, isGuest: true }`; getMe null → 500) + `me`
  spreads `isGuest: true`; routes GET/POST `/guest` (public, gate-exempt by mount order); `app.ts`
  `AppOptions.guestAccess?` threaded into the controller (presence = enabled); `main.ts` resolves +
  seeds ONLY when enabled and spreads the key so it is absent when off. 8 backend unit tests green.
- **Config (Task 5):** `Share2Brain.config.yml.example` guest_access block + `"guest"` on the
  general channel (byte-identical to TECHNICAL-DESIGN §13). Borja's untracked local config untouched.
- **Web (Task 6):** `fetchGuestAvailability` (non-200 → false) + `loginAsGuest`; `UserIcon`;
  `LoginScreen` owns the availability probe + renders the "o para la demo" divider + guest button
  (default hidden); `.kh-guest-btn` base border/color in the class (+hover/focus-visible, cascade
  gotcha); `App.tsx` in-SPA guest login (no reload, AC6) + `isGuest` threading; Header "Modo
  invitado" pill (D3) + logout accessible name flips to "Salir".
- **Tests (Task 7):** backend unit (`authController.guest.test.ts`), backend integration
  (`guest.integration.test.ts` — gate 404, session shape + per-session TTL bound, RBAC scoping +
  explicit exclusion, deny, generic-gate pass-through, guest chat persists a conversation D9, seed
  idempotency + honor-existing D5), web unit (`App.test.tsx` guest cases + `fetchGuestAvailability`
  stub in the partial mock).
- **E2E (Task 8):** `e2e/server.ts` enables guest in the harness only; `e2e/seed.ts` reshaped
  `ChannelSpec.allowedRole: string` → `allowedRoles: string[]` (`e2e-role-guest` on `e2e-ch-general`
  only, no reset-predicate widened); `helpers/session.ts` `loginAsGuest`; NEW `auth-guest.spec.ts`
  (sorts 2nd, strictly non-mutating); README ordering table (5→6) + seed-identities row.
- **Verification gate (Task 9) — all green:** lint 0; unit+web 914 passed / 1 pre-existing skip;
  build clean (5 pkgs); integration 135 passed (21 files); e2e 27 passed (6 specs, was 23).
- **No DDL / no migration / no new dependency / no new env var** — the guest sentinel rides the
  existing `users` schema. AD-2/AD-5/AD-6/AD-10/AD-12 and "never auth-bypass in production" held.
- **Manual smoke:** the automated `auth-guest.spec.ts` drives the real `POST /api/auth/guest`
  endpoint + real Redis session + RBAC-scoped DocsView + logout end-to-end (the manual-smoke
  path). Per the story, Borja's untracked local `Share2Brain.config.yml` was NOT flipped/modified.

### File List

**New:**
- `packages/backend/src/infrastructure/guestAccess.ts`
- `packages/backend/src/presentation/controllers/authController.guest.test.ts`
- `packages/backend/src/guest.integration.test.ts`
- `packages/web/tests/auth-guest.spec.ts`

**Modified — shared:**
- `packages/shared/src/config/index.ts`
- `packages/shared/src/config/index.test.ts`
- `packages/shared/src/schemas/auth.ts`
- `packages/shared/src/schemas/auth.test.ts`

**Modified — backend:**
- `packages/backend/src/infrastructure/sessionStore.ts`
- `packages/backend/src/presentation/controllers/authController.ts`
- `packages/backend/src/routes/authRoutes.ts`
- `packages/backend/src/app.ts`
- `packages/backend/src/main.ts`
- `packages/backend/src/e2e/server.ts`
- `packages/backend/src/e2e/seed.ts`

**Modified — web:**
- `packages/web/src/api/auth.ts`
- `packages/web/src/components/icons.tsx`
- `packages/web/src/components/LoginScreen.tsx`
- `packages/web/src/components/AppLayout.tsx`
- `packages/web/src/components/Header.tsx`
- `packages/web/src/styles/components.css`
- `packages/web/src/App.tsx`
- `packages/web/src/App.test.tsx`
- `packages/web/tests/helpers/session.ts`
- `packages/web/tests/README.md`

**Modified — docs / config:**
- `docs/context/ARCHITECTURE-SPINE.md`
- `docs/context/TECHNICAL-DESIGN.md`
- `docs/data-model.md`
- `docs/api-spec.yml`
- `docs/development_guide.md`
- `Share2Brain.config.yml.example`

## Change Log

| Date | Change |
|---|---|
| 2026-07-11 | Story 2.5 created (bmad-create-story): guest access for demos, config-gated. Ultimate context engine analysis completed — comprehensive developer guide created. |
| 2026-07-11 | Story 2.5 implemented (bmad-dev-story): config-gated guest access end-to-end (docs-first → shared config/contracts → backend seed/session/endpoint/wiring → config example → web login link/guest-mode UI → unit/integration/e2e). Gate green: lint 0 / 914 unit+web (+23) / build 5 pkgs / 135 integration (+7) / 27 e2e (+4). No DDL/migration/dependency/env var. Status → review. |

| 2026-07-11 | Story 2.5 reviewed (bmad-code-review): 3 adversarial layers. 1 decision (cross-guest chat-history leak) FIXED in-story — guest chat made ephemeral (server-side isolation of `/api/conversations` list+detail on `isGuest` + hidden "Historial" button); 2 patches FIXED (guestLogin resolves `getMe` before establishing the session; RBAC integration asserts exact `toEqual`); 3 deferred, 8 dismissed. Gate re-run green: lint 0 / 917 unit+web / build / 136 integration / 28 e2e. Status → done. |
| 2026-07-11 | Story 2.5 re-reviewed (bmad-code-review, 2nd pass): all prior fixes confirmed correct; 1 NEW finding — ephemeral-guest isolation was incomplete on the `POST /api/chat` resume path (shared sentinel userId). FIXED (Borja option A) with a per-session `guestConversationIds` allowlist in the Redis session + `chatService.resolveConversation(guestScope)` gate; same-session multi-turn preserved, no cross-guest/cross-session resume. Gate green: lint 0 / 922 unit+web (+5) / build / 137 integration (+1) / 28 e2e. Status → done. |
| 2026-07-11 | Story 2.5 re-reviewed (3rd pass): allowlist confirmed sound; NEW finding — the shared-guest identity also bled read-status + stats (state/aggregate, not content). FIXED (Borja "ephemeral"): guest read-status writes no-op (→ all-unread), the two per-user stats aggregates report 0; threaded via `req.session.isGuest`. Anti-pattern text amended with the ownership-isolation carve-out. 1 defer (allowlist growth/lost-update), demo-scoped. Gate green: lint 0 / 926 unit+web (+4) / build / 138 integration (+1) / 28 e2e. Status → done. |
| 2026-07-11 | Story 2.5 re-reviewed (4th/confirmation pass): CONVERGED. All 3 adversarial layers agree the shared-sentinel blast radius is exhausted — every `userId`-keyed surface enumerated and verified (conversations/chat/read-status/stats isolated; documents `isRead` + `unreadCount` covered transitively by the empty-sentinel invariant; search/RBAC channel-keyed). Only a docs-consistency patch (scope-boundary bullet vs the anti-pattern carve-out) applied. No code change. Status remains done. |

## Review Findings

_bmad-code-review 2026-07-11 (Blind Hunter + Edge Case Hunter + Acceptance Auditor), 4 passes. Pass 1: 1 decision-needed, 2 patch, 3 defer, 8 dismissed. **Re-review #1**: chat-resume finding (fixed). **Re-review #2**: allowlist sound; read-status/stats blast-radius (fixed) + 1 more defer (4 total). **Re-review #3 (confirmation)**: CONVERGED — all 3 layers agree the shared-sentinel blast radius is EXHAUSTED (every `userId`-keyed surface enumerated: conversations/chat/read-status/stats isolated; documents/unreadCount covered transitively by the empty-sentinel invariant; search/RBAC are channel-keyed). Only a docs-consistency patch remained (scope-boundary reconciliation), applied._

- [x] [Review][Re-review2][Decision→FIXED] Shared-guest identity also bled read-status + stats (same root cause as chat, other per-user surfaces) — read/unread state was shared across guests and a guest's stats summed every guest's query volume (state/aggregate bleed, not content disclosure). **Resolution (Borja, "fix now — ephemeral"):** guest read-status writes are no-ops (`readStatusService.{markRead,unmarkRead,markAll}` take an `isGuest` flag; the sentinel accumulates NO read rows, so `unreadCount` is all-unread for guests with no branch); the two per-user stats aggregates (`getCoverageReadCount`, `countUserAgentQueries`) report 0 for guests (`statsService.getStats(…, isGuest)`). Threaded from `readStatusController`/`statsController` via `req.session.isGuest`. RBAC/channel figures unchanged. Docs: TECHNICAL-DESIGN §10 ("cualquier superficie keyed por `userId` se aísla o neutraliza"). Tests: `readStatusService.test.ts` (+3), `statsService.test.ts` (+1), `guest.integration.test.ts` case (j) (queries KPI 0 despite persisted sentinel messages — discriminates the fix). Gate green: lint 0 / 926 unit+web / build / 138 integration / 28 e2e.
- [x] [Review][Re-review2][Patch→FIXED] Anti-pattern text amended for the ownership-isolation carve-out — the story anti-pattern (line ~149) now distinguishes RBAC/visibility branches (forbidden; `rbac.ts` untouched) from D5-forced ownership/session-isolation branches (allowed: conversation/chat/read-status/stats guest guards). `project-context.md` has no guest anti-pattern to amend.
- [x] [Review][Re-review2][Defer] `guestConversationIds` grows unbounded within a session + concurrent new-conversation lost-update — TTL-bounded (≤120 min) + chat rate limiter; the lost-update fails CLOSED (a guest loses resumability of its OWN conversation, never gains access to another's) and self-heals via express-session's end-of-response save. Deferred: demo-scoped, no security impact.

- [x] [Review][Re-review][Decision→FIXED] Ephemeral-guest isolation was INCOMPLETE on the chat resume path — `POST /api/chat` with `{ conversationId }` resolved via `getOwnedConversation(id, userId)` = `WHERE id=$id AND user_id=$userId`; all guests share the sentinel `userId`, so a guest could resume another guest's (or their own prior-session) conversation by UUID, bypassing the list/detail guards. **Resolution (Borja, option A — session-scoped allowlist):** the Redis session now carries `guestConversationIds` (`sessionStore.ts`); `chatService.resolveConversation` takes an optional `guestScope` and rejects (pre-stream 404) any `conversationId` not in this session's allowlist (`chatService.ts`); `chatController` threads the allowlist and records a freshly-created guest conversation into the session (fresh array, no aliasing) before streaming (`chatController.ts`). Same-session multi-turn preserved; no cross-guest/cross-session resume. Docs: TECHNICAL-DESIGN §10. Tests: `chatService.test.ts` (+3), `chatController.test.ts` (+2, incl. the no-alias/record assertions), `guest.integration.test.ts` case (i) (multi-turn works + cross-session 404). Gate green: lint 0 / 922 unit+web / build / 137 integration / 28 e2e.

- [x] [Review][Decision→FIXED] Shared guest identity → cross-guest chat-history visibility — All guest sessions carry the same sentinel `userId` (D5). `GET /api/conversations` filtered only by `req.session.userId` and `ChatWidget` rendered its history for guests, so a demo shared with multiple concurrent guests would leak each guest's persisted chat history to the others. **Resolution (Borja, option 3 — fix in this story): guest chat is ephemeral.** Server-side isolation is the boundary: in a guest session `GET /api/conversations` → `{ results: [], total: 0 }` and `GET /api/conversations/:id` → `404` (`conversationController.ts`, guarded on `req.session.isGuest`, service never queried). The `ChatWidget` hides the "Historial" button in guest mode (`ChatWidget.tsx` `isGuest` prop, threaded from `App.tsx`). Chat still persists (D9/FK intact) — only cross-session listing/retrieval is blocked. Docs: TECHNICAL-DESIGN §10 guest subsection. Tests: `conversationController.test.ts` (+2 guest cases), `ChatWidget.test.tsx` (+1), `guest.integration.test.ts` case (h), `auth-guest.spec.ts` (+1). Gate re-run green: lint 0 / 917 unit+web / build / 136 integration / 28 e2e.

- [x] [Review][Patch→FIXED] guestLogin persists the session before verifying the guest user exists [packages/backend/src/presentation/controllers/authController.ts] — reordered: `getMe` now resolves BEFORE `regenerate`; a null (missing seed) 500s with no session established (mirrors the OAuth callback resolving `handleCallback` before regenerate). Also removes the nested `.then/.catch` that could double-respond. Guest unit + integration green.
- [x] [Review][Patch→FIXED] RBAC integration assertions weaker than the spec's "exactly"/"[]" wording [packages/backend/src/guest.integration.test.ts] — tightened to `toEqual([CH_MAPPED])` (case c) and `toEqual([])` (case d); the run-unique roles make the exact form deterministic (Task 7c/7d). Integration green.

- [x] [Review][Defer] No boot-time warning when the guest role maps to zero channels [packages/backend/src/main.ts] — deferred: deny-by-default is per-spec (AC4); a startup warning is an ops-ergonomics enhancement, not a defect.
- [x] [Review][Defer] Public POST /api/auth/guest has no CSRF token (forced-guest-downgrade) [packages/backend/src/presentation/controllers/authController.ts:188] — deferred: consistent with the existing unprotected POST /api/auth/logout; downgrade-only, demos-only. CSRF hardening across all auth POSTs is a separate concern.
- [x] [Review][Defer] Disabling guest_access does not revoke live guest sessions [packages/backend/src/presentation/controllers/authController.ts:181] — deferred: sessions are TTL-bounded (≤120 min) and the story marks TTL auto-expiry acceptable demo behavior.
