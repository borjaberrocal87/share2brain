---
baseline_commit: a30406e
---

# Story 4.5: Web App — E2E Visual-Verification Harness (Playwright)

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a developer of the project,
I want an E2E harness that boots the authenticated SPA without real Discord and verifies the real visual/CSS acceptance criteria of the views,
so that the verification gap left by Story 4.3 is closed, the Documentos view (4.4) is verified retroactively, and the Epic 5 chat UI (5.3/5.4) is unblocked.

> Cross-cutting test-enablement story, formalized by `sprint-change-proposal-2026-07-07.md`. The mandatory gate (`bmad-story-mandatory-steps.md` §3.4) requires Playwright E2E whenever `@hivly/web` is touched, but no harness existed and the SPA gates everything behind a Discord OAuth session. **Playwright is NOT installed today** (verified: no `@playwright/test` in any package.json, no `node_modules/@playwright/`, no bin — the only lockfile hits are vitest's optional peer metadata). **Blocks Stories 5.3 and 5.4.**

## Acceptance Criteria

**AC1 — Tooling installed and wired.** `packages/web` declares `@playwright/test` (^1.61.1, current stable) as a devDependency; `packages/web/playwright.config.ts` exists; `npm run test:e2e -w @hivly/web` runs the E2E suite; the root `package.json` gains a `test:e2e` script delegating to the workspace. Playwright artifacts (`test-results/`, `playwright-report/`) are gitignored.

**AC2 — Deterministic test backend.** The harness boots `createApp` with an injected fake `DiscordOAuthClient` (the `opts.oauth` pattern from `*.integration.test.ts`) and a deterministic fake `queryEmbedder`, over test Postgres+pgvector/Redis seeded with `channel_permissions` + `discord_messages` + `embeddings` (+ a pre-created user with `user_read_status` rows), so that `GET /api/search` returns fixed results and `GET /api/documents` returns a fixed read/unread mix. Seeding is idempotent (reset-then-seed on boot) and scoped to `e2e-`-prefixed ids so it coexists with the dev DB and the integration suites.

**AC3 — Authenticated browser session without real Discord.** The harness obtains the session cookie by driving the fake-OAuth flow (`GET /api/auth/login` → extract `state` from the Location header → `GET /api/auth/callback?code=…&state=…`) **without real Discord credentials** and **without adding any production auth-bypass route**. The test-backend entrypoint refuses to start when `NODE_ENV === 'production'` (a test-only guarded route is fallback only, not the default path).

**AC4 — Vite preview against the test backend.** Playwright drives the **built** SPA via `vite preview`, whose `/api` (+ `/health`) proxy points at the test backend, so the authenticated SPA renders the real views with the real global CSS.

**AC5 — Retroactive Story 4.3 spec (Búsqueda).** The initial spec verifies via `getComputedStyle`: AC1 title (Space Grotesk, weight 600, 25px) + 54px search bar; AC2 focus `border-color: var(--accent-ink)` + `box-shadow: 0 0 0 3px rgba(245,166,35,0.12)`; AC4 result-card tokens (amber badge `rgba(245,166,35,0.1)`, similarity-bar 54×5px with `linear-gradient(90deg,#F5A623,#FFCB6B)`, 24px avatar); AC5 active vs inactive chip styles; AC6 empty state with `1px dashed var(--border-strong)`.

**AC6 — Retroactive Story 4.4 spec (Documentos).** The initial spec verifies via `getComputedStyle`: table `grid-template-columns: 1fr 130px 130px 96px`; unread dot `#F5A623` with glow `0 0 0 3px rgba(245,166,35,0.16)` vs read dot `var(--dot-read)` with no shadow; row hover `background: var(--hover-row)`; the sidebar "Documentos" badge (amber, 18px, radius 9px, mono 10.5px) present when unread > 0 and absent at 0; the "todo leído" empty state (green check circle `#3BA55D` on `rgba(59,165,93,0.12)`).

**AC7 — Real token names.** Assertions use the **implemented** token names (`--text-primary` / `--text-muted` / `--text-subtle`, renamed in Story 2.1 from the mockup's `--tx`/`--tx4`/`--tx5`) and assert **computed values** (rgb/px), never the mockup names.

**AC8 — Screenshots + reusable harness.** Each run captures full-page screenshots of the Búsqueda and Documentos views as artifacts. The harness (session helper, seed data, config) is documented so Stories 5.3/5.4 add their own specs without re-engineering the bootstrap.

**Dependencies:** blocks 5.3 and 5.4. No new production code paths; no DB migration.

## Tasks / Subtasks

### Backend — deterministic E2E server (AC: 2, 3)

- [x] **Task 1 — E2E test-server entrypoint in `packages/backend`** (AC: 2, 3)
  - [x] Create `packages/backend/src/e2e/server.ts` (dev-only entrypoint, same package as `test-helpers.ts` so it can import it — see Dev Notes → AD-2). At the very top: `if (process.env.NODE_ENV === 'production') { console.error('[e2e] refusing to start in production'); process.exit(1); }`.
  - [x] Boot: `openTestClients()` (from `../test-helpers.js`; honors `DATABASE_URL`/`REDIS_URL`, defaults `postgres://hivly:changeme@127.0.0.1:5432/hivly` / `redis://127.0.0.1:6379`) → reset-then-seed (Task 2) → `createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: e2eOAuth(), queryEmbedder: e2eQueryEmbedder(), frontendUrl: E2E_WEB_ORIGIN, allowedOrigins: [E2E_WEB_ORIGIN] }))` → `app.listen(E2E_BACKEND_PORT, '127.0.0.1')`. `E2E_BACKEND_PORT` default **3100** (avoid the dev backend on 3000); `E2E_WEB_ORIGIN` default `http://localhost:4173` (vite preview).
  - [x] **Fake OAuth with code→identity mapping** (makes the search empty state reachable, see Dev Notes → D3): `exchangeCode: async (code) => ({ accessToken: code })`; `getCurrentUser: async (tok) => tok === 'e2e-empty' ? { id: 'e2e-user-empty', username: 'e2e-empty', avatar: null } : { id: 'e2e-user-member', username: 'e2e-member', avatar: null }`; `getGuildMember: async (tok) => ({ roles: tok === 'e2e-empty' ? ['e2e-role-empty'] : ['e2e-role-member'] })`.
  - [x] **Deterministic queryEmbedder**: reuse the one-hot pattern (`TEST_EMBEDDING_DIMENSIONS = 1536`): always return one-hot at index 0 (`fakeQueryEmbedder()` from test-helpers is exactly this — reuse it).
  - [x] Graceful shutdown: on SIGTERM/SIGINT close the server and `clients.close()` (Playwright's webServer sends SIGTERM). Do **not** delete seed rows on shutdown — the boot-time reset makes runs idempotent and keeps post-run state inspectable.
  - [x] Add script to `packages/backend/package.json`: `"e2e:server": "tsx src/e2e/server.ts"` (tsx already powers `dev`).

- [x] **Task 2 — seed module** (AC: 2)
  - [x] Create `packages/backend/src/e2e/seed.ts` exporting `resetAndSeed(db)`. Delete order (FKs): `user_read_status` (by the e2e user's id / e2e embedding ids) → `embeddings` (`chunk_key LIKE 'e2e-%'`) → `discord_messages` (`id LIKE 'e2e-%'`) → `channel_permissions` (`channel_id LIKE 'e2e-%'`) → `users` (`discord_id LIKE 'e2e-user-%'`). Then insert:
    - `channel_permissions`: `('e2e-ch-general','general',ARRAY['e2e-role-member'])`, `('e2e-ch-random','random',ARRAY['e2e-role-member'])`, `('e2e-ch-void','sin-datos',ARRAY['e2e-role-empty'])` — the void channel gets **no** embeddings (empty-state user scope).
    - `discord_messages`: ≥4 rows per member channel (`id` = `e2e-msg-<n>`, `guild_id 'e2e-guild'`, `author_id` e.g. `e2e-author-ada`/`e2e-author-linus`, distinct `created_at` values for deterministic `ORDER BY created_at DESC, id DESC`).
    - `embeddings`: ≥3 in `e2e-ch-general`, ≥2 in `e2e-ch-random`. `chunk_key = 'e2e-<anchorMsgId>:0'`; **`message_ids[1]` MUST be an existing `discord_messages.id`** (the search SQL INNER JOINs the anchor — a missing anchor silently drops the chunk); vector bound as `JSON.stringify(vec)::vector`. Vary vectors for a nice similarity spread: one-hot(0) → similarity 1.0; normalized mixes like `[0.8, 0.6, 0, …]` → 0.8; `[0.5, 0.866, 0, …]` → 0.5 (cosine vs one-hot(0) = first component, vectors must be unit-norm).
    - `users`: pre-create the member user (`discord_id 'e2e-user-member'`, any username) so its UUID is known at seed time — `authService.handleCallback` upserts by `discord_id` and will reuse this row on login.
    - `user_read_status`: mark 1–2 embeddings read for that user → the Documentos view shows a deterministic read/unread mix and the sidebar badge a fixed total.
  - [x] Log a one-line summary of seeded counts (`[e2e] seeded: 3 channels, N messages, M embeddings, K read`).

### Web — Playwright install + config (AC: 1, 4)

- [x] **Task 3 — install and configure Playwright** (AC: 1)
  - [x] `npm install -D -w @hivly/web @playwright/test@^1.61.1`, then `npx playwright install chromium` (chromium only — see Dev Notes → D4). If the browser download fails in this environment, STOP and apply the §3.4 fallback (flag + defer), do not fake it.
  - [x] Create `packages/web/playwright.config.ts`: `testDir: './tests'`; `fullyParallel: false`, `workers: 1` (specs share one seeded DB and one spec mutates read-status — see Dev Notes → ordering); `use: { baseURL: 'http://localhost:4173', screenshot: 'only-on-failure', trace: 'on-first-retry' }`; `projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }]`; `reporter: [['html', { open: 'never' }], ['list']]`;
    `webServer: [` backend: `{ command: 'npm run e2e:server -w @hivly/backend', url: 'http://127.0.0.1:3100/health', reuseExistingServer: !process.env.CI, timeout: 60_000 }`, web: `{ command: 'npm run build -w @hivly/web && npm run preview -w @hivly/web', url: 'http://localhost:4173', reuseExistingServer: !process.env.CI, timeout: 120_000, env: { HIVLY_API_PROXY_TARGET: 'http://127.0.0.1:3100' } }` `]`. (Multiple `webServer` entries are supported; the config `env` is passed to the spawned command.)
  - [x] `packages/web/package.json`: add `"preview": "vite preview --strictPort"` and `"test:e2e": "playwright test"`. Root `package.json`: add `"test:e2e": "npm run test:e2e -w @hivly/web"`.
  - [x] Root `.gitignore`: add `test-results/` and `playwright-report/`.
  - [x] TypeScript/ESLint: add `"tests"` to `packages/web/tsconfig.json` `include` so `npm run typecheck -w @hivly/web` covers the specs. Run `npm run lint` early: if the Epic-1 browser-safe import guard on `packages/web/**` (no-restricted-imports) or an env assumption flags `packages/web/tests/**`, add a scoped ESLint override for `packages/web/tests/**` (Node context, `@playwright/test` import allowed) — do not weaken the guard for `src/**`.

- [x] **Task 4 — vite preview proxy** (AC: 4)
  - [x] In `packages/web/vite.config.ts`: extract `const apiTarget = process.env.HIVLY_API_PROXY_TARGET ?? 'http://localhost:3000';` and use it in the existing `server.proxy`; add a `preview` block with the **same** proxy (`'/api'` + `'/health'` → `apiTarget`, `changeOrigin: true`). 🔴 `vite preview` does NOT inherit `server.proxy` — without the `preview.proxy` block every `/api` call from the built SPA 404s and the harness dies at login. Keep the explanatory header comment accurate (same-origin `sid` cookie rationale).

### Web — session bootstrap + specs (AC: 3, 5, 6, 7, 8)

- [x] **Task 5 — session helper** (AC: 3)
  - [x] Create `packages/web/tests/helpers/session.ts` with `loginAs(page, code: 'e2e-member' | 'e2e-empty' = 'e2e-member')`:
    1. `const res = await page.request.get('/api/auth/login', { maxRedirects: 0 });` → expect 302; `const state = new URL(res.headers()['location']).searchParams.get('state');` (the redirect points at discord.com — never follow it).
    2. `await page.request.get(`/api/auth/callback?code=${code}&state=${state}`, { maxRedirects: 0 });` → expect 302 to `frontendUrl`. `page.request` shares the browser context's cookie jar, so the regenerated `sid` cookie (httpOnly, SameSite=Lax, `cookieSecure:false`) lands in the browser automatically — requests go through the preview proxy, so the cookie is set on the SPA origin.
    3. `await page.addInitScript(() => localStorage.setItem('hivly-theme', 'dark'));` **before** the first `goto` — force the dark theme so token assertions are deterministic (see Dev Notes → theme).
    4. `await page.goto('/');` → the SPA calls `/api/auth/me`, resolves `authed`, renders `AppLayout`. Wait for the sidebar (`getByRole('button', { name: /Búsqueda/ })`).

- [x] **Task 6 — spec: retroactive 4.3 Búsqueda** (AC: 5, 7, 8) — `packages/web/tests/search.spec.ts`
  - [x] Login as `e2e-member`; the Búsqueda view is the default screen.
  - [x] **4.3-AC1**: `h2` "Búsqueda de conocimiento" → computed `font-family` contains `"Space Grotesk"`, `font-weight: 600`, `font-size: 25px`. `.kh-search-input` → `height: 54px`.
  - [x] **4.3-AC2**: `input.focus()` (or click) → computed `border-color: rgb(245, 166, 35)` and `box-shadow: rgba(245, 166, 35, 0.12) 0px 0px 0px 3px` (Chromium serializes color first — see Dev Notes → computed values).
  - [x] **4.3-AC3/AC4**: type a ≥2-char query (250ms debounce — use `await expect(locator).toBeVisible()` auto-retry, not fixed sleeps); result cards render. First `.kh-result-card`: badge span (`#general`) → `background-color: rgba(245, 166, 35, 0.1)`, mono 12px; similarity track → `width: 54px; height: 5px; border-radius: 3px`, fill → `background-image` contains `linear-gradient` with `rgb(245, 166, 35)` and `rgb(255, 203, 107)`; avatar div → `width: 24px; height: 24px; border-radius: 50%`.
  - [x] **4.3-AC5**: chips have no modifier class — assert by computed style: active chip (`todos` on load) `background-color: rgba(245, 166, 35, 0.14)` + `border: 1px solid rgba(245, 166, 35, 0.45)` + `color: rgb(245, 166, 35)`; an inactive chip `background-color: rgb(18, 22, 29)` (`--surface` dark) + `color: rgb(154, 163, 178)` (`--text-tertiary`).
  - [x] **4.3-AC6 (empty state)**: new browser context, `loginAs(page, 'e2e-empty')` (scope = `e2e-ch-void`, zero embeddings — searches always return everything in scope, there is no similarity threshold, so an empty scope is the only way to get 0 results); search ≥2 chars → empty state div: `border: 1px dashed rgb(42, 49, 61)` (`--border-strong` dark), text "Sin coincidencias en el conocimiento indexado." and "Probá con otros términos o consultá al agente en el chat.".
  - [x] Full-page screenshot of the results state and of the empty state (`testInfo.outputPath('search-results.png')` / `search-empty.png`, or `testInfo.attach`).

- [x] **Task 7 — spec: retroactive 4.4 Documentos** (AC: 6, 7, 8) — `packages/web/tests/docs.spec.ts`
  - [x] Login as `e2e-member`; click the sidebar `getByRole('button', { name: /Documentos/ })`.
  - [x] **4.4 grid**: header row → computed `grid-template-columns` equals the **resolved pixel list** (Chromium computes `1fr` to px, e.g. `"Npx 130px 130px 96px"` — assert it matches `/^\d+(\.\d+)?px 130px 130px 96px$/`, not the literal `1fr` string). Header cells (source lowercase, uppercased by CSS): mono, `font-size: 10.5px`, `text-transform: uppercase`, `color: rgb(100, 108, 124)` (`--text-subtle` dark).
  - [x] **4.4 dots**: rows carry `data-read="true"|"false"` (the one stable data attribute in the codebase). Unread row (`.kh-doc-row[data-read="false"]`) dot span → `background-color: rgb(245, 166, 35)`, `box-shadow: rgba(245, 166, 35, 0.16) 0px 0px 0px 3px`; content span `color: rgb(230, 233, 239)` (`--text-primary`), `font-weight: 500`. Read row (`[data-read="true"]`) dot → `background-color: rgb(39, 46, 57)` (`--dot-read` dark), `box-shadow: none`; content `color: rgb(124, 132, 148)` (`--text-muted`), `font-weight: 400`.
  - [x] **4.4 hover**: `row.hover()` → computed `background-color: rgb(20, 25, 34)` (`--hover-row` dark).
  - [x] **4.4 badge**: sidebar Documentos button contains the badge span (locate within `getByRole('button', { name: /Documentos/ })`; it's the unread total, e.g. seeded unread count) → `background-color: rgb(245, 166, 35)`, `min-width: 18px`, `height: 18px`, `border-radius: 9px`, mono `font-size: 10.5px`.
  - [x] **4.4 empty state + badge disappearance (mutating — run LAST in this file, `workers:1` keeps it isolated from search.spec)**: click "Marcar todas como leídas", then toggle "Sin leer · 0" → empty state: check-circle div `color: rgb(59, 165, 93)`, `background-color: rgba(59, 165, 93, 0.12)`, `border-radius: 50%`, 38px; texts "¡Estás al día! No te quedan fuentes sin leer." + "Quitá el filtro \"Sin leer\" para ver todo el conocimiento indexado."; dashed border container. Assert the sidebar badge is no longer rendered (`toHaveCount(0)`).
  - [x] Full-page screenshots: table state (`docs-table.png`) and empty state (`docs-all-read.png`).

### Docs + reusability (AC: 8)

- [x] **Task 8 — document the harness**
  - [x] Create `packages/web/tests/README.md`: prerequisites (`docker compose up -d postgres redis` + migrated DB + `npx playwright install chromium`; note the local Redis situation — see Dev Notes), how to run (`npm run test:e2e -w @hivly/web`), how the session bootstrap works, the seed identities (`e2e-member` / `e2e-empty`) and dataset, and **how 5.3/5.4 add a spec** (import `loginAs`, add `<view>.spec.ts`, extend `seed.ts` if new data is needed).
  - [x] `docs/development_guide.md` + `docs/frontend-standards.md` already describe the harness (amended by the correct-course — verify the command/prereqs you shipped match the text; fix only real mismatches, e.g. add the `npx playwright install chromium` prerequisite if absent). Do NOT rewrite §3.4 — it is already correct.

### Verification gate (AGENT runs it — mandatory)

- [x] **Task 9** — Run and paste output of `npm run lint && npm run test && npm run build` (must stay green — this story must not break the unit gate; vitest globs `src/**` and the specs live in `tests/**`, so there must be zero collision). Then `npm run test:integration` (unchanged, needs `docker compose up -d postgres redis`). Then the new gate itself: **`npm run test:e2e -w @hivly/web`** — paste the Playwright run output and confirm the screenshots exist in the output dir. This story's whole point is that the visual ACs of 4.3/4.4 flip from "deferred" to **verified with evidence** — if any `getComputedStyle` assertion contradicts the 4.3/4.4 AC values, that is a real regression finding: report it, don't adjust the assertion to match the code.

### Review Findings

- [x] [Review][Decision] Task 9 verification evidence not pasted — **RESOLVED (2026-07-07, re-run during code review):** the gate was re-run in full and matches the reported summary exactly. Raw output:

  ```
  $ npm run lint
  > eslint .
  (no output — 0 problems)

  $ npm run test
  > vitest run --project unit --project web --passWithNoTests
   Test Files  48 passed (48)
        Tests  360 passed (360)
     Duration  5.58s

  $ npm run build
  > npm run build --workspaces --if-present
  @hivly/backend  tsc --noEmit   (clean)
  @hivly/bot      tsc --noEmit   (clean)
  @hivly/shared   tsc --noEmit   (clean)
  @hivly/web      vite build     ✓ built in 102ms
  @hivly/workers  tsc --noEmit   (clean)

  $ npm run test:integration
  > vitest run --project backend-integration --project bot-integration --project workers-integration
   Test Files  13 passed (13)
        Tests  76 passed (76)
     Duration  3.18s

  $ npm run test:e2e -w @hivly/web
  > playwright test
  Running 4 tests using 1 worker
    ✓ tests/docs.spec.ts:24:3 › ... grid, header cells, read/unread dots, row hover, and sidebar badge (4.4) (977ms)
    ✓ tests/docs.spec.ts:79:3 › ... all-read empty state + badge disappearance (4.4) (673ms)
    ✓ tests/search.spec.ts:17:3 › ... title, search bar, focus ring, result card, and chips (4.3 AC1/AC2/AC4/AC5) (695ms)
    ✓ tests/search.spec.ts:78:3 › ... empty state when the scope has no indexed knowledge (4.3 AC6) (640ms)
  4 passed (6.8s)
  ```

  Screenshots confirmed on disk under `packages/web/test-results/`: `search-results.png`, `search-empty.png`, `docs-table.png`, `docs-all-read.png`.

- [x] [Review][Patch] `sprint-status.yaml`: duplicated/garbled comment text pasted mid-line into the new "4-5 → ready-for-dev" entry — a verbatim copy of the unrelated 4-4 "review" comment block is appended without a separator [_bmad-output/implementation-artifacts/sprint-status.yaml:22] — **FIXED**: trimmed the duplicated tail.
- [x] [Review][Patch] `e2e/server.ts` `shutdown()` can stall on lingering keep-alive connections — `server.close()` has no forced-exit fallback, risking a Playwright teardown hang [packages/backend/src/e2e/server.ts:463-473] — **FIXED**: added a 5s unref'd force-exit timeout alongside `server.close()`.
- [x] [Review][Patch] Backend/web ports and origins (3100 / 4173) are hardcoded independently in three places with no single source of truth — changing one without the others silently breaks the harness [packages/web/playwright.config.ts:497-498, packages/backend/src/e2e/server.ts:413-414, packages/web/vite.config.ts:201] — **FIXED**: `playwright.config.ts` now derives both origins from two port constants and injects them explicitly into the backend `webServer`'s `env` (`E2E_BACKEND_PORT`/`E2E_WEB_ORIGIN`) instead of relying on matching hardcoded defaults in `server.ts`.
- [x] [Review][Patch] `docs.spec.ts` uses fragile `.locator('span').first()/.nth(1)` and `.locator('div').first()` chains for the unread-dot/content and empty-state check-icon assertions, contradicting the harness's own README guidance to prefer `data-testid` in exactly this situation [packages/web/tests/docs.spec.ts:676,679,686,689,725] — **FIXED**: added `data-testid="doc-row-dot"`/`"doc-row-content"`/`"docs-empty-state-check"` in `DocsView.tsx`, spec updated to use them.
- [x] [Review][Patch] `session.ts` interpolates `state`/`code` into the callback query string without `encodeURIComponent` — safe today only because `state` always happens to be a 32-char hex string [packages/web/tests/helpers/session.ts:775] — **FIXED**: both params now wrapped in `encodeURIComponent`.
- [x] [Review][Patch] `search.spec.ts` asserts only `border-color` for the active chip, not the full `border` (width/style) that Task 6 specifies [packages/web/tests/search.spec.ts:860] — **FIXED**: added `border-width`/`border-style` assertions.
- [x] [Review][Patch] `vite.config.ts`: `HIVLY_API_PROXY_TARGET` uses `??`, which doesn't catch an explicit empty-string override — the proxy target would silently become `''` [packages/web/vite.config.ts:201] — **FIXED**: switched to `||`.

Gate re-run after patches — still green: lint 0 · 360 unit · build clean (4 pkgs) · 76 integration · test:e2e 4 passed (chromium).

- [x] [Review][Defer] `reuseExistingServer: !process.env.CI` + boot-only seeding — a stale, manually-left-running local `e2e:server` process would serve already-mutated data to a fresh test run; undocumented footgun for the "reusable harness" goal (not a regression in the normal fresh-run flow) [packages/web/playwright.config.ts:521,527] — deferred, pre-existing design footgun
- [x] [Review][Defer] `seed.ts`'s delete+insert sequence isn't wrapped in a transaction — a mid-sequence failure could leave partial `e2e-`-prefixed rows until the next boot's reset cleans them up [packages/backend/src/e2e/seed.ts:322-375] — deferred, self-healing on next boot
- [x] [Review][Defer] `tsconfig.json` drops `rootDir` and merges Node ambient types into the same config that type-checks the browser app source, instead of giving the Playwright specs their own tsconfig — safe today (`noEmit` + Vite build ignore tsconfig) but weakens the type-check boundary going forward [packages/web/tsconfig.json] — deferred, no current impact
- [x] [Review][Defer] `E2E_BACKEND_PORT` isn't validated as numeric — a non-numeric value throws late inside `main().catch` rather than failing with a clear custom message [packages/backend/src/e2e/server.ts:413] — deferred, low-likelihood misconfiguration
- [x] [Review][Defer] `session.ts` assumes the login redirect always has a `Location` header — a missing header throws a generic `new URL(undefined)` TypeError instead of a clear assertion failure [packages/web/tests/helpers/session.ts:768] — deferred, only reachable via a backend bug elsewhere

### Review Findings — 2nd pass (2026-07-07)

Re-reviewed the diff including the 7 first-pass patches. Two independent reviewers (Blind Hunter, Acceptance Auditor) both flagged the same real gap in the port-sync patch; everything else was either fixed, deferred, or verified as a false positive.

- [x] [Review][Patch] "Single source of truth for ports" patch was incomplete — `WEB_PORT` was defined and used to derive `WEB_ORIGIN`, but never actually passed to the `vite preview` process; it matched only by coincidence with Vite's own default preview port [packages/web/playwright.config.ts] — **FIXED**: web `webServer.command` now passes `--port ${WEB_PORT}` explicitly.
- [x] [Review][Patch] `app.listen()` has no `'error'` handler — a port conflict throws an unhandled exception instead of failing fast with a clear message; Playwright would otherwise wait its full 60s timeout [packages/backend/src/e2e/server.ts] — **FIXED**: added `server.on('error', ...)`.
- [x] [Review][Patch] `server.close()`'s optional `Error` callback argument was ignored [packages/backend/src/e2e/server.ts] — **FIXED**: now logged if present.
- [x] [Review][Patch] `SeedSummary.channels` was a hardcoded literal `3` instead of derived from data, unlike `messages`/`embeddings` [packages/backend/src/e2e/seed.ts] — **FIXED**: extracted a `CHANNELS` array (mirroring `MESSAGES`/`EMBEDDINGS`), `channels: CHANNELS.length`.
- [x] [Review][Patch] `E2E_BACKEND_PORT` used `??`, inconsistent with the `HIVLY_API_PROXY_TARGET` fix — same empty-string footgun (`Number('') === 0`, not `NaN`) [packages/backend/src/e2e/server.ts] — **FIXED**: switched to `||`.
- [x] [Review][Patch] `docs-empty-state` border assertion only checked `border-style`, unlike `search-empty-state`'s fuller check (width + style + color) — asymmetric rigor between the two near-identical empty states [packages/web/tests/docs.spec.ts] — **FIXED**: added `border-width`/`border-color` assertions.
- [x] [Review][Patch] `NODE_ENV=production` guard comment overstated its guarantee — ES module imports are hoisted and evaluate before the check, so it doesn't literally gate "the whole entrypoint"; only `main()` (DB/Redis connections, the listener) is actually gated. No dangerous import-time side effects exist today, so this was a documentation-accuracy fix, not a behavior change [packages/backend/src/e2e/server.ts] — **FIXED**: reworded the comment.

Gate re-run after 2nd-pass patches — still green: lint 0 · 360 unit · web typecheck clean · build clean (4 pkgs) · 76 integration · test:e2e 4 passed (chromium).

- [x] [Review][Defer] `reuseExistingServer` footgun also applies to the web `vite preview` webServer, not just the backend — a stale prior build would be silently reused without rebuilding [packages/web/playwright.config.ts] — deferred, same mitigation as the existing backend-side note (README caution)
- [x] [Review][Defer] Mutating-test isolation (docs spec's mark-all-read running last) relies on Playwright's default alphabetical file discovery + `workers: 1`, not an explicit pinned order — a new spec (5.3/5.4) could silently change it [packages/web/playwright.config.ts] — deferred, document as an explicit invariant when the next spec is added
- [x] [Review][Defer] `shutdown()`'s force-exit fallback exits `1` even for a merely-slow-but-clean shutdown, conflating "timed out" with "failed" [packages/backend/src/e2e/server.ts] — deferred, accepted (Playwright doesn't inspect the webServer's exit code)

Dismissed as false positives / out of scope (verified): no CI wiring (repo has zero CI workflows for any suite, not a regression); tsconfig Node+DOM type conflict risk (verified empirically clean via `npm run typecheck -w @hivly/web`); seed.ts "self-healing" claim (duplicate of an already-deferred finding); Homebrew-Redis workaround in docs (explicit, already-made Dev Notes decision, not an oversight); 🔴 emoji in comments (established project convention, seen throughout this same story file and sprint-status); missing `retries`/`expect.timeout` config (speculative CI hardening, no CI exists to harden); stale empty-string `HIVLY_API_PROXY_TARGET` re-flag (Edge Hunter was looking at an already-fixed line).

## Dev Notes

### Decisions locked at creation (autonomous, per correct-course scope)

- **D1 — the E2E backend lives in `packages/backend`, spawned as a process.** `buildTestAppOptions`/`fakeQueryEmbedder`/`openTestClients` live in `packages/backend/src/test-helpers.ts`. `packages/web` may **never** import `@hivly/backend` (AD-2) — so the harness does not import the backend, it **spawns** it: `packages/backend/src/e2e/server.ts` run via Playwright's `webServer[0]`. No cross-package import, AD-2 intact, and the non-prod guard lives in the entrypoint (no production surface at all — stronger than a guarded route).
- **D2 — built SPA via `vite preview`** (AC4 wording from the proposal). Requires the new `preview.proxy` block (Task 4) — `vite preview` ignores `server.proxy`. The webServer command chains `build && preview`; slower per run than the dev server but tests what ships.
- **D3 — fake OAuth maps `code` → identity.** The search endpoint has **no similarity threshold**: any query returns every in-scope chunk (LIMIT 5), so the 4.3-AC6 empty state is reachable only with an empty-embedding scope. `code=e2e-empty` logs in a user whose only channel (`e2e-ch-void`) has no embeddings. Same fake-OAuth interface (`exchangeCode`/`getCurrentUser`/`getGuildMember`, `packages/backend/src/domain/repositories/discordOAuthClient.ts:18-31`) as the integration tests — just parameterized by the code.
- **D4 — chromium-only, `workers: 1`, dark theme forced.** One browser keeps install/CI cheap (add more later if wanted). One worker because all specs share one seeded Postgres and the docs spec mutates read-status (mark-all). Dark theme (`localStorage['hivly-theme'] = 'dark'` via `addInitScript`) because tokens differ per theme (`--accent-ink` is `#F5A623` dark but `#9A5B00` light — an unforced theme would flake on the host's OS preference).
- **D5 — `@playwright/test` pinned `^1.61.1`** (current stable, July 2026). Note: the old sprint-status comment "Playwright 1.61.1 already installed" was **false** (nothing installed) — but 1.61.1 is coincidentally the right version to install now.

### 🔴 Computed-value ground truth (assert THESE, not the CSS-var names)

`getComputedStyle` resolves vars and serializes: hex → `rgb()/rgba()`, numeric inline styles → `px`, box-shadow → **color first** in Chromium. Default theme is **dark** (`:root` in `packages/web/src/styles/global.css:19-24`; light overrides at `[data-kh="light"]`, lines 25-30). Dark values the specs need:

| Token | Dark value | Computed |
|---|---|---|
| `--accent-ink` | `#F5A623` | `rgb(245, 166, 35)` |
| `--dot-read` | `#272E39` | `rgb(39, 46, 57)` |
| `--hover-row` | `#141922` | `rgb(20, 25, 34)` |
| `--track` | `#222934` | `rgb(34, 41, 52)` |
| `--border-strong` | `#2A313D` | `rgb(42, 49, 61)` |
| `--text-primary` | `#E6E9EF` | `rgb(230, 233, 239)` |
| `--text-muted` | `#7C8494` | `rgb(124, 132, 148)` |
| `--text-subtle` | `#646C7C` | `rgb(100, 108, 124)` |
| `--text-tertiary` | `#9AA3B2` | `rgb(154, 163, 178)` |
| `--surface` | `#12161D` | `rgb(18, 22, 29)` |
| `--bg` | `#0E1116` | `rgb(14, 17, 22)` |

Shadows: focus ring → `rgba(245, 166, 35, 0.12) 0px 0px 0px 3px`; unread-dot glow → `rgba(245, 166, 35, 0.16) 0px 0px 0px 3px`. Grid: computed `grid-template-columns` resolves `1fr` to pixels — regex-match `^\d+(\.\d+)?px 130px 130px 96px$`. Fixed brand hexes (theme-independent): amber `#F5A623`, highlight `#FFCB6B`, Discord `#5865F2`, positive `#3BA55D`.

### Selector ground truth (no `data-testid` exists in product code)

Stable hooks, in preference order: **`data-read="true|false"`** on `.kh-doc-row` (`DocsView.tsx:407` — the only data attribute in the codebase); stable hand-written `kh-*` classes (`.kh-search-input`, `.kh-chip`, `.kh-result-card`, `.kh-discord-link`, `.kh-doc-row`, `.kh-unread-toggle`, `.kh-mark-all`, `.kh-load-more`, `.kh-nav-item`); roles + Spanish copy. Chip active/inactive and the unread toggle have **no modifier class** — distinguish by computed `background-color`. The sidebar badge is an unclassed `span` inside the Documentos nav button (`Sidebar.tsx:102`, rendered only when `unreadCount > 0`). `frontend-standards.md:187` prefers `data-testid` for E2E: you MAY add a few (`data-testid="similarity-bar"`, `"sidebar-badge"`, `"docs-empty-state"`, `"search-empty-state"`) where computed-style locators would otherwise chain fragile `nth()` hops — keep additions minimal and semantic.

Exact rendered strings (locator targets): titles "Búsqueda de conocimiento" / "Documentos indexados"; placeholder "¿Cómo configuro los canales a indexar?"; chip "todos"; count "N resultados" + "ordenado por similitud"; link "ver en Discord"; search empty "Sin coincidencias en el conocimiento indexado." + "Probá con otros términos o consultá al agente en el chat."; docs headers `chunk` `canal` `autor` `indexado` (lowercase in source, uppercase via CSS — text locators match source case); "Marcar todas como leídas"; "Sin leer · N" (middle dot U+00B7); "mostrando X de Y"; "Cargar más"; docs empty "¡Estás al día! No te quedan fuentes sin leer." + "Quitá el filtro \"Sin leer\" para ver todo el conocimiento indexado."; nav "Búsqueda"/"Documentos" (buttons, `aria-current="page"` when active).

### Session/auth mechanics (from the real backend source)

- `createApp(db, redis, opts)` returns Express **without listening** (`app.ts:57-58`); `oauth` injectable at `AppOptions.oauth` (`app.ts:47`, fallback `app.ts:75`), `queryEmbedder` **required** (`app.ts:103-109` throws). `/health` is auth-exempt and top-level (`app.ts:62`) — use it as the webServer readiness URL. `/api/auth` mounts before the `/api` gate (`app.ts:91` vs `:97`).
- Cookie: name **`sid`**, httpOnly, `SameSite=Lax`, `secure` off in tests (`sessionStore.ts:32`); Redis keys `sess:<sid>`. The callback **regenerates** the session id (fixation guard, `authController.ts:73`) — the cookie you keep is the one from the **callback** response, which `page.request` handles automatically (shared jar).
- Login flow: `GET /api/auth/login` → 302 to discord.com with `state` (32-hex, stored in session pre-redirect); `GET /api/auth/callback?code&state` → CSRF check (`400 INVALID_OAUTH_STATE` on mismatch — always pass the state from step 1) → fake exchange → user upsert by `discord_id` → 302 to `frontendUrl/`. Non-member (`getGuildMember → null`) → 403 `GUILD_MEMBER_REQUIRED`.
- `buildTestAppOptions` defaults (`test-helpers.ts:59-76`): `cookieSecure: false`, `guildId 'test-guild'`, `frontendUrl http://localhost:5173` — **override `frontendUrl`/`allowedOrigins` to the preview origin** (`http://localhost:4173`) in the e2e server.

### Search/documents data mechanics (what the seed must satisfy)

- Search SQL (`embeddingSearchRepository.drizzle.ts`): RBAC `WHERE e.channel_id IN (…)` **inside** the query (AD-12); **INNER JOIN** `discord_messages dm ON dm.id = e.message_ids[1]` (Postgres arrays are 1-indexed → the FIRST element is the anchor; chunk silently dropped if the anchor row is missing); `NOT EXISTS` anti-join drops chunks with any soft-deleted member message; similarity `1 - cosine_distance` clamped to [0,1]; ordered ascending distance, LIMIT 5 default. `authorName = authorId` today (D2 from 4.1) — expect `e2e-author-…` rendered as the author name.
- Vector literal: `JSON.stringify(number[])` + `::vector` cast, 1536 dims (`TEST_EMBEDDING_DIMENSIONS`), matching migration `vector(1536)`.
- RBAC expansion is per-request array-overlap over the **whole** `channel_permissions` table — run-unique-ish role names (`e2e-role-member`, `e2e-role-empty`) keep the e2e scope from leaking into the integration suites' assertions and vice versa (the 4.2/4.3/4.4 isolation lesson: never reuse a literal like `'member'`).
- Documents list: `ORDER BY created_at DESC, id DESC`, page size 20, `isRead` via LEFT JOIN `user_read_status`. Seed < 20 embeddings ⇒ no pagination in the way (the "Cargar más" button simply won't render — it is NOT part of this story's asserted ACs).

### 🔴 Environment gotchas

- **Two Redis instances on this Mac**: compose Redis publishes **no ports**; `redis://127.0.0.1:6379` (the test-helpers default) is the **Homebrew** Redis. Same recipe as the integration suites (`docker compose up -d postgres redis` + local Redis reachable on 6379) — the harness inherits it; don't "fix" it, document it in the README.
- **Same `hivly` database as dev** — no separate test DB. The `e2e-` prefix + reset-then-seed keeps runs idempotent and coexistent. Never widen a cleanup beyond the `e2e-` prefix (the 4.2 broad-`LIKE` race lesson).
- **Fonts come from Google Fonts (network)** (`index.html:26-31`, `display=swap`): computed `font-family` returns the *specified* stack regardless of load — the AC assertions are network-independent. Screenshots may render fallback faces offline; acceptable, note it in the README.
- **Debounce**: search fires 250ms after typing ≥2 chars — rely on Playwright auto-retrying `expect`s, never `waitForTimeout`.
- **Playwright browser download**: `npx playwright install chromium` needs network. If it fails in the agent environment, apply §3.4's fallback honestly (build everything, flag the un-run suite) — do not claim a green run.
- The unit-test gate must stay green untouched: vitest projects glob `src/**/*.test.*`; e2e specs are `tests/**/*.spec.ts` — keep that separation exactly.

### Previous-story intelligence (4.3 / 4.4)

- Both stories shipped with visual ACs **explicitly deferred to this story** (their completion notes name the exact ACs). 4.4's review added `data-read` and hardened DocsView (error branch, abortable loadMore, mark-all revert) — the view you're asserting against is post-review `main` (`a30406e`).
- The token-rename table (mockup `--tx*` → `--text-*`) is already baked into the computed-value table above — never write `--tx` anywhere.
- 4.4's "Sin leer · N" chip is **always rendered**; "Marcar todas como leídas" renders only when `scopeUnread > 0`. Row click on a read row is a no-op.
- Review discipline (Epic 3 retro AI#1): every patch from this story's future review is new un-reviewed code.

### Project Structure Notes

- **New**: `packages/backend/src/e2e/server.ts`, `packages/backend/src/e2e/seed.ts`; `packages/web/playwright.config.ts`, `packages/web/tests/helpers/session.ts`, `packages/web/tests/search.spec.ts`, `packages/web/tests/docs.spec.ts`, `packages/web/tests/README.md`.
- **Modified**: `packages/web/package.json` (deps + `preview`/`test:e2e` scripts), `packages/backend/package.json` (`e2e:server` script), root `package.json` (`test:e2e`), `packages/web/vite.config.ts` (env-var target + `preview.proxy`), `packages/web/tsconfig.json` (include tests), root `.gitignore` (+2 lines), possibly the web ESLint override, possibly a few `data-testid`s in `SearchView.tsx`/`DocsView.tsx`/`Sidebar.tsx`, `docs/development_guide.md`/`docs/frontend-standards.md` only if the shipped commands mismatch the amended text.
- **NOT touched**: `app.ts` (injection points already exist), any production route, the Drizzle schema (no migration), `@hivly/shared`. Playwright stays a **convention**, not an AD invariant (stakeholder decision in the correct-course).
- Naming: e2e specs `camelCase.spec.ts` under `tests/`; all code/comments English; UI strings asserted verbatim in Spanish.

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Historia 4.5 (lines 747-789)] — the 8 epic AC blocks + dependencies.
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-07.md] — scope, decisions (no renumber, retro 4.3+4.4 coverage, no prod auth-bypass), §4.1 AC set.
- [Source: docs/bmad-story-mandatory-steps.md:94-124 (§3.4) + :137 (§4)] — the gate this story makes real (already amended; includes the explicit fallback).
- [Source: docs/frontend-standards.md:65,187-188,259 + docs/development_guide.md:115-121] — harness design + command contract (already amended).
- [Source: docs/context/ARCHITECTURE-SPINE.md:308 + docs/context/TECHNICAL-DESIGN.md:1077] — Playwright = convention, not invariant; harness pattern noted.
- [Source: packages/backend/src/app.ts:39-58,62,75,91,97,103-109] — `createApp` + `AppOptions` injection points, mounts.
- [Source: packages/backend/src/test-helpers.ts:12,19-27,31-33,43-56,59-76] — `TEST_EMBEDDING_DIMENSIONS`, `fakeQueryEmbedder`, connection defaults, `openTestClients`, `buildTestAppOptions`.
- [Source: packages/backend/src/auth.integration.test.ts:20-26,41-47,71,98-109 + search.integration.test.ts:38-43,48-79,126] — canonical fake OAuth, `state` extraction, login helper, exact seed SQL shapes, one-hot similarity.
- [Source: packages/backend/src/domain/repositories/discordOAuthClient.ts:18-31] — the 3-method fake-OAuth port.
- [Source: packages/backend/src/infrastructure/embeddingSearchRepository.drizzle.ts:25,44,53,57-62] — anchor INNER JOIN (`message_ids[1]`), RBAC-in-query, similarity formula, no threshold.
- [Source: packages/backend/src/infrastructure/sessionStore.ts:13-19,27,32 + presentation/controllers/authController.ts:34-55,63,73,145-164] — `sid` cookie, `sess:` prefix, state CSRF, session regeneration.
- [Source: packages/web/vite.config.ts:17-22] — dev-only proxy (the `preview.proxy` gap); packages/web/package.json (no preview/test scripts today).
- [Source: packages/web/index.html:12-22,26-31] — pre-paint theme script (`data-kh`, `localStorage 'hivly-theme'`), Google Fonts links.
- [Source: packages/web/src/styles/global.css:19-30 + styles/components.css:64-93] — token values (both themes), all `:hover`/`:focus` rules.
- [Source: packages/web/src/components/SearchView.tsx:22-23,92-138,187-231,251-267,284-379 + DocsView.tsx:26,161,166-181,206-350,405-489 + Sidebar.tsx:10,48-62,66-69,95-102 + App.tsx:25,45-64,91-93,109-132] — every inline style + string the specs assert.
- [Source: _bmad-output/implementation-artifacts/4-3-web-app-vista-busqueda.md + 4-4-web-app-vista-documentos-read-tracking-ui-y-sidebar-badge.md] — the deferred visual ACs this story verifies; isolation lessons.
- Invariants: AD-2 (no cross-service imports — D1), AD-3 (static SPA), AD-9/AD-10 (sessions in Redis, no bypass route), AD-12 (RBAC in query — the seed exercises it) — `docs/context/ARCHITECTURE-SPINE.md`.
- Latest tech: `@playwright/test` **1.61.1** stable (npm, 2026-07); multi-entry `webServer`, `page.request` cookie-jar sharing, `testInfo.attach` — all standard current API.

## Dev Agent Record

### Agent Model Used

claude-opus-4-8 (bmad-dev-story)

### Debug Log References

- Backend harness smoke (curl, before Playwright): login → callback → `/api/auth/me`
  (member, guildId `test-guild`) → `/api/search?q=hola` returned the fixed 5-result
  spread (similarity 1.0/0.8/0.6/0.5/0.3, top = `#general` one-hot) → `/api/documents`
  5 rows (2 read/3 unread) → `/api/read-status/unread-count` `{general:2, random:1}`.
  `code=e2e-empty` returned `{results:[]}` and 0 documents (empty state reachable).
- **Finding (real Story 4.3 defect surfaced by the harness):** the search input's
  focus ring border never turned amber. Probe (focused input, `getComputedStyle`):
  `isActive:true`, `border-color: rgb(42,49,61)` (`--border-strong`, the *base*),
  `box-shadow: rgba(245,166,35,0.12) 0px 0px 0px 3px` (the `:focus` glow **did**
  apply). Root cause: the inline `border` shorthand on `.kh-search-input` outranks
  the `.kh-search-input:focus { border-color }` author rule (inline beats stylesheet
  regardless of `:focus`), so only the box-shadow half of the AC2 focus ring worked.
  Per Task 9 ("report it, don't adjust the assertion to match the code") the fix was
  to the **product**: moved the base border into the `.kh-search-input` class so
  `:focus` can override `border-color`. Assertion now passes as true evidence.
- Related, NOT fixed (out of this story's asserted ACs, flagged for review): the same
  inline-border-vs-`:hover` cascade means `.kh-result-card:hover` and `.kh-chip:hover`
  `border-color` overrides also never apply (inline `border` wins). No 4.3 AC in this
  harness asserts hover borders; left for code-review to decide.

### Completion Notes List

Implemented the E2E visual-verification harness end-to-end. All 8 ACs satisfied; the
whole gate is green and the 4.3/4.4 visual ACs are now **verified with browser
evidence** (screenshots as artifacts), no longer deferred.

- **AC1** `@playwright/test@1.61.1` + chromium installed; `playwright.config.ts`;
  `test:e2e` scripts (web + root); `test-results/`/`playwright-report/` gitignored.
- **AC2** `packages/backend/src/e2e/{server,seed}.ts` — spawned test backend
  (`e2e:server`), reuses `openTestClients`/`buildTestAppOptions`/`fakeQueryEmbedder`,
  reset-then-seeds an `e2e-`-scoped dataset (3 channels, 5 messages, 5 embeddings, 2
  pre-read). AD-2 intact — `packages/web` never imports the backend, it spawns it.
- **AC3** session via the fake-OAuth flow (`loginAs`), no real Discord, no auth-bypass
  route; the entrypoint refuses to start under `NODE_ENV=production`.
- **AC4** built SPA via `vite build && vite preview`; new `preview.proxy` block
  (`HIVLY_API_PROXY_TARGET`) — without it every `/api` call 404s.
- **AC5/AC6** `search.spec.ts` + `docs.spec.ts` assert computed values (rgb/px) for the
  4.3 (title/search-bar/focus-ring/badge/similarity-bar/avatar/chips/empty) and 4.4
  (grid/header/read+unread dots/hover/sidebar badge/all-read empty) ACs.
- **AC7** real token names / computed values only (`--text-primary`/`-muted`/`-subtle`).
- **AC8** full-page screenshots (`search-results`/`search-empty`/`docs-table`/
  `docs-all-read`) + `tests/README.md` documenting the harness for 5.3/5.4.

Decisions: added 4 minimal `data-testid`s (`similarity-bar`, `sidebar-badge`,
`search-empty-state`, `docs-empty-state`) where computed-style locators would chain
fragile `nth()` hops (permitted by the story + `frontend-standards.md:187`). Fixed one
real 4.3 defect (focus-ring border — see Debug Log). Idempotency verified: Playwright
tears down its spawned webServers each run, so the mutating docs test (mark-all) is
reset by the next boot's reseed — confirmed across 3 consecutive green runs.

**Gate:** `lint` 0 · `test` 360 unit · `build` clean (4 pkgs) · `test:integration` 76 ·
`test:e2e` **4 passed** (chromium). Integration suite unchanged and coexists with the
`e2e-`-scoped data (distinct roles/channels — no RBAC leak).

### File List

**New:**
- `packages/backend/src/e2e/server.ts`
- `packages/backend/src/e2e/seed.ts`
- `packages/web/playwright.config.ts`
- `packages/web/tests/helpers/session.ts`
- `packages/web/tests/search.spec.ts`
- `packages/web/tests/docs.spec.ts`
- `packages/web/tests/README.md`

**Modified:**
- `packages/backend/package.json` (`e2e:server` script)
- `packages/web/package.json` (`@playwright/test` dep + `preview`/`test:e2e` scripts)
- `package.json` (root `test:e2e` script)
- `package-lock.json` (Playwright dependency tree)
- `packages/web/vite.config.ts` (env-var proxy target + `preview.proxy` block)
- `packages/web/tsconfig.json` (include `tests`/`playwright.config.ts`; `node` types; drop `rootDir`)
- `.gitignore` (`test-results/`, `playwright-report/`)
- `packages/web/src/components/SearchView.tsx` (`data-testid`s; move base border to CSS — 4.3 focus-ring fix)
- `packages/web/src/components/DocsView.tsx` (`data-testid="docs-empty-state"`)
- `packages/web/src/components/Sidebar.tsx` (`data-testid="sidebar-badge"`)
- `packages/web/src/styles/components.css` (`.kh-search-input` base border rule)
- `docs/development_guide.md` (add `npx playwright install chromium` prerequisite)

## Change Log

| Date | Change |
|---|---|
| 2026-07-07 | Story 4.5 implemented: Playwright E2E visual-verification harness (spawned deterministic backend + fake OAuth + vite preview proxy), retroactive 4.3/4.4 computed-style specs + screenshots. Fixed a real 4.3 focus-ring defect surfaced by the harness (inline border outranked `:focus`). Gate green (lint 0 / 360 unit / build clean / 76 integration / 4 e2e). Status → review. |
| 2026-07-07 | Code review pass 1 (bmad-code-review): 1 decision-needed resolved (re-ran the full gate live, pasted real output), 7 patches applied (garbled sprint-status comment, shutdown() force-exit fallback, single-source-of-truth ports in playwright.config.ts, data-testid fixes for fragile docs.spec.ts locators, encodeURIComponent on the OAuth callback query, fuller chip border assertion, `\|\|` instead of `??` for the proxy target), 5 deferred, 10 dismissed as false positives/out of scope (verified against test-helpers.ts, schema.ts, and existing integration tests). Gate re-confirmed green after patches. Status → done. |
| 2026-07-07 | Code review pass 2 (bmad-code-review, re-run at Borja's request): 7 more patches applied — completed the port-sync fix (`WEB_PORT` now actually passed to `vite preview` via `--port`, caught independently by 2 reviewers), `server.listen`/`server.close` error handling, `SeedSummary.channels` derived instead of hardcoded, `??`→`\|\|` consistency on `E2E_BACKEND_PORT`, symmetric border rigor on the docs empty-state, and a doc-accuracy fix on the `NODE_ENV=production` guard comment. 3 new deferrals, 8 dismissed as false positives/out of scope. Gate re-confirmed green (now also verified `npm run typecheck -w @hivly/web` clean). |
