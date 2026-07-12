---
baseline_commit: fe1f56f70ed5e5131db4ca631ce0081492abddca
---

# Story 10.1: shared+backend — `ui.language` config block + `GET /api/ui-config`

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an Operator,
I want to set the web UI language (`es`/`en`) in `Share2Brain.config.yml` and have the SPA read it at runtime from an unauthenticated `GET /api/ui-config` endpoint,
so that a deployment can render the whole UI in the configured language without rebuilding images (FR26 — this story delivers the config + contract + endpoint; story 10.2 consumes it).

## Acceptance Criteria

1. **AC1 — Absent block ⇒ default `es`.** Given a `Share2Brain.config.yml` with NO `ui:` block, when `loadConfig()` runs, then the config is valid and `config.ui` is `undefined`; and when `GET /api/ui-config` is called (no session cookie, no headers), then it responds `200` with exactly `{ "language": "es" }`.
2. **AC2 — Configured language honored at runtime.** Given `ui.language: "en"` in the config, when the backend boots, then `GET /api/ui-config` responds `200` with `{ "language": "en" }` — no image rebuild (the config file is a runtime mount; AD-3/AD-8 intact).
3. **AC3 — Invalid config fails loud at boot (AD-8).** Given `ui.language: "fr"` (or a present `ui:` block missing `language`), when `loadConfig()` runs, then it throws `ConfigError` naming the offending path — `ui.language` when the block is an object missing/mistyping `language`; `ui` when the block is empty (a bare `ui:` parses as YAML null, so the Zod issue path is `['ui']`). The service never starts half-configured. No `.default()` anywhere in the schema (D1).
4. **AC4 — Unauthenticated + general rate-limit tier.** The endpoint responds `200` WITHOUT any session (never 401, never touches `req.session`); it is gate-exempt by mount ORDER (before `app.ts`'s generic `/api` gate) and sits on the **general `api` tier** (`rl:api:` shared budget) — NOT the auth tier. Integration proof: with an injected tiny `rateLimit`, exhausting the `api` tier 429s the endpoint, while exhausting the `auth` tier does NOT affect it (mirror `security.integration.test.ts:69–103` — auth-tier template L69–84, api-tier template L86–103).
5. **AC5 — Shared Zod contract (AD-6).** `UiConfigResponseSchema = z.object({ language: z.enum(['es', 'en']) })` + `UiConfigResponse` type live in `packages/shared/src/schemas/uiConfig.ts`, exported via the schemas barrel — matching `docs/api-spec.yml:418–426` exactly (`language` required, enum es|en). The handler validates the body with `UiConfigResponseSchema.parse(...)` before sending (guest-probe/health precedent).
6. **AC6 — Config example + docs drift closed.** `Share2Brain.config.yml.example` gains the `ui:` block byte-mirroring TECHNICAL-DESIGN §13 (placed between `read_tracking` and `observability`). The no-auth exception lists that the SCP missed now mention `/api/ui-config`: `docs/api-spec.yml:16–17` (`info.description`) and `docs/backend-standards.md:742` + endpoint list `:744`. Already-landed docs (api-spec path+schema, TECHNICAL-DESIGN §11 row + §13 example) are VERIFIED, not redone.
7. **AC7 — Zero regression.** The full gate runs green with NO existing assertion modified: `npm run lint` (0), `npm run test` (unit+web), `npm run build` (5 pkgs), `npm run test:integration` (infra up), and the 28 Playwright e2e stay byte-identical — `buildTestAppOptions` and `e2e/server.ts` remain `uiLanguage`-free, so both resolve to `es` by default (the Epic 10 critical guard).

## Tasks / Subtasks

- [x] Task 1 — Docs sync remainder, docs-first (AC: 6)
  - [x] 1.1 Verify (do NOT redo) what commit `fe1f56f` already landed: `docs/api-spec.yml:135–152` (`/api/ui-config` path, `security: []`) + `:418–426` (`UiConfigResponse`); `docs/context/TECHNICAL-DESIGN.md:844` (no-auth exception), `:856` (§11 row), `:1019–1024` (§13 `ui:` example).
  - [x] 1.2 `Share2Brain.config.yml.example`: add the `ui:` block between `read_tracking` (L118–120) and `observability` (L123–125), byte-mirroring TECHNICAL-DESIGN §13 L1019–1024 (copy the 4-line comment + `ui:` block from the doc itself — do not retype; whitespace must match). ⚠️ The epics.md story text says "Share2Brain.config.example.yml" — the REAL filename is `Share2Brain.config.yml.example`.
  - [x] 1.3 Drift fixes the SCP missed: `docs/api-spec.yml:16–17` info.description — add `/api/ui-config` to the "every /api/* route requires a session except…" list; `docs/backend-standards.md:742` (auth exception list) and `:744` (endpoint list) — same addition.
  - [x] 1.4 Do NOT touch `docs/data-model.md` (no DB surface), `docs/frontend-standards.md` (i18n section already landed; 10.2's context), or Borja's untracked local `Share2Brain.config.yml`.
- [x] Task 2 — Shared: optional `ui:` config block (AC: 1, 2, 3)
  - [x] 2.1 `packages/shared/src/config/index.ts`: add a top-level OPTIONAL `ui` key to `Share2BrainConfigSchema` (third whole-block optional alongside `notifications` L149–163 and `streams` L213–217): `ui: z.object({ language: z.enum(['es', 'en'], { message: '…' }) }).optional()`. NO `.default()` (D1). Block comment above it modeled on the `guest_access` comment (L105–111): optionality rationale, consumer resolves the default (`createApp`, D2), governs ONLY the SPA — AI content language remains `enrichment.language` (L170–171).
  - [x] 2.2 `packages/shared/src/config/index.test.ts`: extend using the `streams` append-pattern (L128–163, closest template for a top-level block): (a) absent block ⇒ `config.ui` undefined (join the existing absent-asserts at L118–119); (b) `ui:\n  language: "en"` parses; (c) `ui:\n  language: "es"` parses; (d) `ui:\n  language: "fr"` throws `/ui|language/`; (e) empty `ui:` block (present, no `language`) throws — assert with `/ui/`, NOT `/ui\.language/`: a bare `ui:` parses as null, so the Zod path is `ui`. `VALID_YAML` (L9–79) stays WITHOUT a `ui:` block — it is the "absent" fixture.
- [x] Task 3 — Shared: `UiConfigResponse` contract (AC: 5)
  - [x] 3.1 NEW `packages/shared/src/schemas/uiConfig.ts`: `//` file header citing AD-6 + the endpoint (model: `schemas/auth.ts:1–4`); `/** GET /api/ui-config — … */` JSDoc; `export const UiConfigResponseSchema = z.object({ language: z.enum(['es', 'en']) });` + `export type UiConfigResponse = z.infer<typeof UiConfigResponseSchema>;`. No error-code map needed (the endpoint has no error responses of its own).
  - [x] 3.2 NEW `packages/shared/src/schemas/uiConfig.test.ts`: accept `{ language: 'es' }` and `{ language: 'en' }`; reject `{ language: 'fr' }`, `{}`, extra-typed values (safeParse pattern, `schemas/auth.test.ts:92–100`).
  - [x] 3.3 Barrel: add `export * from './uiConfig.js';` to `packages/shared/src/schemas/index.ts` (alphabetical — between `./stats.js` and nothing, i.e. last; keep `.js` ESM extension). Zero `package.json` changes (subpath `./schemas` already maps the barrel).
- [x] Task 4 — Backend: option, controller, router, mount, wiring (AC: 1, 2, 4, 5)
  - [x] 4.1 `packages/backend/src/app.ts`: add `uiLanguage?: 'es' | 'en'` to `AppOptions` with a JSDoc stating the default (`'es'` when absent — which is exactly what `buildTestAppOptions` and `e2e/server.ts` rely on; precedent `agentMemoryWindow?` L290). Resolve ONCE inside `createApp`: `const uiLanguage = opts.uiLanguage ?? 'es';` (D2 — single defaulting point; no separate infrastructure resolver, D3).
  - [x] 4.2 NEW `packages/backend/src/presentation/controllers/uiConfigController.ts`: factory `createUiConfigController({ language })` returning a sync handler that sends `res.status(200).json(UiConfigResponseSchema.parse({ language }));` — never reads `req.session` (D6). Model: `authController.ts:178–186` (guestAvailability).
  - [x] 4.3 NEW `packages/backend/src/routes/uiConfigRoutes.ts`: `createUiConfigRouter(controller)` with `router.get('/', (req, res) => controller.get(req, res));` — sync handler, NO `asyncHandler` (authRoutes precedent); header comment stating it is mounted at `/api/ui-config` BEFORE the generic gate and must terminate the request. Known edge (accept, don't "fix"): an unmatched method (e.g. POST with `X-Requested-With`) falls through the router to the generic gate and is counted TWICE by the same `api` limiter — express-rate-limit v8 logs an `ERR_ERL_DOUBLE_COUNT` validation warning. Acceptable for this read-only endpoint (the request still ends 401 at `requireAuth`); do NOT add a second `rateLimit()` instance for it. Optionally terminate the router with a catch-all 404 to avoid the fall-through entirely.
  - [x] 4.4 `app.ts` mount (D4 — ordering is load-bearing): between the `/api/auth` mount (L220) and the generic gate (L226): `app.use('/api/ui-config', ...apiLimiters, createUiConfigRouter(...));` — reuse the SAME `apiLimiters` array instance (L186–188, `rl:api:` prefix = shared general-tier budget; a new `rateLimit()` instance would create an independent budget and violate "general tier"). Add a short comment mirroring the L218–225 ordering comments. GET passes `requireCustomHeader` (L215) freely — safe method, no exemption work.
  - [x] 4.5 `packages/backend/src/main.ts`: spread the key only when the block is present (exactOptionalPropertyTypes-safe, guestAccess precedent L138–140): `...(config.ui ? { uiLanguage: config.ui.language } : {})`. No seed, no logger line required (log if you wish, e.g. `logger.info('ui language', …)` — optional).
  - [x] 4.6 Unit tests: NEW `packages/backend/src/presentation/controllers/uiConfigController.test.ts` — `fakeRes()` doubles pattern (`authController.guest.test.ts:15–26`): returns 200 + `{ language }` for both values; body passes `UiConfigResponseSchema`.
- [x] Task 5 — Backend integration test (AC: 1, 2, 4)
  - [x] 5.1 NEW `packages/backend/src/uiConfig.integration.test.ts` (supertest + real app via `openTestClients()` + `buildTestAppOptions()`, pattern `guest.integration.test.ts`): (a) `GET /api/ui-config` with NO cookie/headers → 200 `{ language: 'es' }` (proves auth exemption + default); (b) `buildTestAppOptions({ uiLanguage: 'en' })` → `{ language: 'en' }`; (c) rate-limit tiering per AC4 with an injected tiny `rateLimit` (api tier exhaust → 429 on ui-config; auth tier exhaust → ui-config still 200) — mirror `security.integration.test.ts:69–103` (auth tier L69–84, api tier L86–103), mind the Redis `rl:*` counter prefixes across tests.
  - [x] 5.2 Confirm by inspection (and say so in Completion Notes) that `buildTestAppOptions` (`test-helpers.ts:146–165`) and `e2e/server.ts:72–82` need ZERO changes — they omit `uiLanguage`, resolving to `es`.
- [x] Task 6 — Verification gate + endpoint verification (AC: 7 + mandatory §3.3)
  - [x] 6.1 Full gate, paste outputs: `npm run lint` && `npm run test` && `npm run build`; `npm run test:integration` with `docker compose up -d postgres redis` + `DATABASE_URL`/`REDIS_URL` exported (no fallback — audit L-6) and app containers STOPPED (`docker compose stop bot backend workers`, 2.5 Debug Log lesson; restart after).
  - [x] 6.2 §3.3 endpoint verification (MANDATORY, `docs/bmad-story-mandatory-steps.md:85–89`): run the dev backend and `curl -i http://localhost:3000/api/ui-config` (no cookie) → 200 + body matching the shared Zod schema; repeat with `ui.language: "en"` in a LOCAL config copy (do not commit; restore afterwards).
  - [x] 6.3 Run the 28 Playwright e2e and confirm green with zero spec changes (`app.ts` changed → the mount-order claim must be proven, not assumed).

## Dev Notes

### Scope boundary — what this story does and does NOT do
- **IN scope:** the optional `ui:` config block (shared) + `UiConfigResponse` contract (shared) + `GET /api/ui-config` endpoint on the general tier (backend) + `Share2Brain.config.yml.example` + the three doc drift fixes + tests listed above.
- **OUT of scope:** EVERYTHING web — react-i18next, `es.json`/`en.json`, literal extraction, `toLocaleString`, error-code mapping are ALL story 10.2 (which depends on this contract). No per-user language selector; no backend response localization (`{ error, code }` bodies unchanged); no languages beyond es/en; no re-tiering of `/api/auth/me` (see the factual correction below); no touching `docs/frontend-standards.md` (already landed, 10.2's context).
- **No DDL, no migration, no new dependency, no new env var, no new session field.** Purely config → contract → read-only endpoint.

### Ratified defaults (flag ANY of these in review if you disagree)
- **D1 — Schema has NO `.default()`; the consumer resolves `es`.** Exact D4-of-2.5 convention (`config/index.ts:105–111` guest_access comment; `guestAccess.ts:1–5` header names it). An absent `ui:` block parses to `undefined`; a PRESENT block requires `language` (fail loud per AD-8 — same as "an explicit block without `enabled` is a config error").
- **D2 — Single defaulting point = `createApp` (`opts.uiLanguage ?? 'es'`).** NOT the presence=enabled pattern (that shape is for features that can be OFF; this endpoint must ALWAYS answer). Precedent: `agentMemoryWindow?` (`app.ts:290`). This is what keeps `buildTestAppOptions`/`e2e/server.ts` untouched (they omit the key ⇒ `es`) — the Epic 10 critical guard falls out of the design for free.
- **D3 — No separate backend resolver module.** `resolveGuestAccessConfig` earns its file with 4 fields + a seed; here it is ONE field with ONE default already owned by `createApp` (D2). `main.ts` just spreads `config.ui` through. A `resolveUiConfig()` infrastructure module would be ceremony — skip it.
- **D4 — Mount slot: after `/api/auth` (L220), before the generic gate (L226), with `...apiLimiters` spread on its own mount.** Gate-exempt by ORDER (the router terminates the request, so the later `app.use('/api', …, requireAuth, …)` never runs for it — same mechanism as the auth router). Reusing the SAME `apiLimiters` instance keeps it on the shared `rl:api:` budget — that is what "general tier" means here.
- **D5 — Contract is enum-strict and matches the already-committed OpenAPI byte-for-byte.** `z.enum(['es','en'])`, `language` required (`api-spec.yml:418–426` is the target, committed in `fe1f56f` — code conforms to the doc, not the other way around). Zod 4 idiom (`z.enum([...])` top-level; repo uses `z.uuid()`-style Zod 4 APIs).
- **D6 — Handler never touches `req.session`.** Session middleware runs before it (harmless), but the endpoint must not create/read sessions — it serves the login screen BEFORE any session exists (that is its raison d'être).
- **D7 — Always 200.** Unlike the guest probe (existence-hiding 404), ui-config has nothing to hide — no error branch, no error code, no `X_ERROR` map in the schema file.

### Factual corrections vs the epic/SCP text (do not propagate these errors)
- **`/api/auth/me` was NEVER moved off the auth tier.** Verified against code + git history: `/me` still sits under the `/api/auth` mount behind `authLimiters` (`app.ts:220`, `authRoutes.ts:13`). The "429 lesson" (auth tier = 10 req/15 min; the SPA hits `/me` every load) is a PLACEMENT lesson for THIS endpoint — do not claim or attempt a `/me` re-tier in this story.
- **The example config filename is `Share2Brain.config.yml.example`** (repo root), not "Share2Brain.config.example.yml" as the epics.md bullet says.
- **Most of the story's "docs sync" already landed** in `fe1f56f` (the SCP docs-first commit): api-spec path+schema, TECHNICAL-DESIGN §11 row + exception line + §13 example. What remains: the example config block + the two no-auth exception lists (`api-spec.yml:16–17`, `backend-standards.md:742/744`). Verify the landed parts; change nothing there.

### Current state — extend, don't reinvent (verified 2026-07-12 @ fe1f56f)
- **Config schema** `packages/shared/src/config/index.ts` — `Share2BrainConfigSchema` at L53–280; optional whole blocks today: `notifications` (L149–163), `streams` (L213–217); `guest_access` optional sub-block (L100–118, the D4 comment to model). `enrichment.language` (L170–171) is a free-form non-empty string = AI OUTPUT language — a DIFFERENT concern; `ui.language` is a strict enum. Loader: `loadConfig` L341–369 (path arg → `SHARE2BRAIN_CONFIG_PATH` → cwd `Share2Brain.config.yml`), `${VAR}` interpolation over the PARSED tree (L311–318), failures throw `ConfigError` with `path: message` lines. Keys are snake_case (YAML mirror); contract fields are camelCase.
- **Schemas dir** `packages/shared/src/schemas/` — barrel `index.ts` is the ONLY registration point (`export * from './x.js';`, `.js` ESM extensions); `linkRefine.ts` deliberately NOT in the barrel (internal). Naming: `XxxResponseSchema` + `export type XxxResponse = z.infer<…>` immediately below. `packages/shared` ships TS source directly (no build); subpath `./schemas` already exists in `package.json`.
- **App composition** `packages/backend/src/app.ts` — `createApp(db, redis, opts)` L128; order: helmet (L136) → `/health` (L157, top-level, no /api) → cors (L159) → json (L160) → session (L161–167) → limiter arrays built (L180–191: `authLimiters`/`apiLimiters`/`chatLimiters`, empty when `opts.rateLimit` absent — tests/e2e never 429) → CSRF `requireCustomHeader` on `/api` (L215, GET-exempt) → `/api/auth` + authLimiters (L220) → **[new mount slot]** → generic gate `app.use('/api', ...apiLimiters, requireAuth, createRbacMiddleware(...))` (L226) → feature routers (L242–303) → error handler (L310).
- **Boot** `main.ts` — `loadConfig()` L31; `createApp` options assembly L117–157; conditional-spread precedent for optional keys L138–140 (`...(guestAccess ? { guestAccess } : {})` — "spread so the key is genuinely absent"); snake→camel rate-limit mapping L143–156.
- **Controller precedent** `authController.ts:178–186` (`guestAvailability`): sync handler, injected option, `Schema.parse` on the response body. **Router precedent** `routes/statsRoutes.ts` (minimal factory) and `authRoutes.ts` (sync handlers without `asyncHandler`).
- **Test helpers** `test-helpers.ts:146–165` `buildTestAppOptions(overrides)` — no `rateLimit`, no `guestAccess`, and (after this story) no `uiLanguage` ⇒ defaults stay production-safe. Integration files at `packages/backend/src/<feature>.integration.test.ts` with `openTestClients()`; `security.integration.test.ts:86–103` is the rate-limit-tier proof template. E2E server `e2e/server.ts:72–82` builds via `buildTestAppOptions({ … })` — passes no language option; refuses `NODE_ENV=production`.
- **ESLint guards**: `eslint.config.js` bans sibling-service imports (AD-2) and bans `packages/web` from everything in shared except `/schemas` + `/types/events` — this is WHY the contract must live in `schemas/` (10.2's SPA will import it) and NEVER in `shared/config`.

### Anti-patterns to avoid
❌ `.default()` anywhere in the config schema (D1 — resolver-side defaults, repo-wide convention). ❌ Presence=enabled shape for `uiLanguage` (the endpoint always exists; D2). ❌ Mounting inside the auth router (auth tier — the exact 429 trap) or after the generic gate (401). ❌ A NEW `rateLimit()` instance for the mount (independent budget ≠ general tier; reuse `apiLimiters`). ❌ Defining `UiConfigResponse` outside `packages/shared/src/schemas/` (AD-6; web import ban makes anything else unusable in 10.2). ❌ Reading `config.ui` anywhere but the `main.ts` assembly (services take options, never `loadConfig` — config faking rule). ❌ Touching `req.session` in the handler (D6). ❌ Adding `uiLanguage` to `buildTestAppOptions` defaults or `e2e/server.ts` (breaks the byte-identical guard; overrides belong per-test). ❌ Editing any existing test assertion (AC7 — if one fails, the implementation is wrong, not the test). ❌ Localizing backend `{ error, code }` bodies (10.2 maps codes client-side). ❌ An `errors.<CODE>` map or 4xx branch on this endpoint (D7). ❌ Spanish in code/comments/tests/commits (English-only; `"es"`/`"en"` VALUES are data). ❌ Marking an AC done without pasting verification output.

### Regression checklist
- `Share2BrainConfigSchema` gains an optional key — every existing YAML fixture (config tests `VALID_YAML`, `workers` enrich smoke fixture, live + example configs) stays valid BECAUSE the block is optional; do not "helpfully" add `ui:` to `VALID_YAML` (it is the absent-case fixture; add per-test appends instead).
- `AppOptions` gains an optional field — constructors are `main.ts`, `buildTestAppOptions`, `e2e/server.ts`; only `main.ts` changes. Grep `createApp(` before finishing to confirm no other call sites.
- The new mount sits in `app.ts` BETWEEN two order-load-bearing mounts — re-read the L218–226 comments after editing; the integration no-cookie test (5.1a) is the executable proof.
- Barrel export addition — `npm run build` catches a broken `.js` extension; nothing else imports `uiConfig` yet (10.2 will).
- The 28 e2e specs assert Spanish literals — they must pass UNCHANGED (6.3); any e2e diff means the default leaked away from `es`.

### Testing standards
- Vitest 4; colocated `*.test.ts` (unit project, no infra) / `*.integration.test.ts` (real Postgres+Redis; `docker compose up -d postgres redis`; `DATABASE_URL`/`REDIS_URL` must be exported — no fallback; `SHARE2BRAIN_TEST_ALLOW_SHARED_DB=1` guard exists; stop app containers first). AAA; names `should <behavior> when <condition>`; English.
- Config tests: real temp-file YAML via the `writeFixture` pattern (`config/index.test.ts:84–96`); never mock `loadConfig`.
- Backend controller unit tests: minimal req/res doubles (`fakeRes()` with `vi.fn`, `authController.guest.test.ts:15–26`) — no supertest at unit level.
- Integration: supertest against the real `createApp`; assert exact bodies (`toEqual({ language: 'es' })` — the "exactly" lesson from the 2.5 review patches).
- Tests-first where it pays: the config-schema validity matrix (Task 2.2) and the tier/auth-exemption semantics (5.1) are the contract boundary; controller/router glue may test after.

### Manual verification (Task 6.2)
Local: `docker compose up -d postgres redis`; `npm run dev -w @share2brain/backend`; `curl -i http://localhost:3000/api/ui-config` (no cookie) → `200 {"language":"es"}` with the `ui:` block absent. Add `ui:\n  language: "en"` to your LOCAL `Share2Brain.config.yml`, restart, re-curl → `{"language":"en"}`. Optionally `curl -i` a fourth+ time under a tiny local rate-limit config to see the 429 come from `rl:api:`. Restore your local config afterwards (do not commit it).

### Project Structure Notes

```
packages/shared/src/
├── config/index.ts                      # EXTEND — optional top-level `ui` block (D1)
├── config/index.test.ts                 # EXTEND — absent/es/en/invalid/empty cases
├── schemas/uiConfig.ts                  # NEW — UiConfigResponseSchema + type (AD-6)
├── schemas/uiConfig.test.ts             # NEW
└── schemas/index.ts                     # EXTEND — barrel export './uiConfig.js'

packages/backend/src/
├── presentation/controllers/uiConfigController.ts       # NEW — sync, Schema.parse, no session
├── presentation/controllers/uiConfigController.test.ts  # NEW
├── routes/uiConfigRoutes.ts             # NEW — minimal router factory
├── app.ts                               # EXTEND — AppOptions.uiLanguage? + mount before gate (D2/D4)
├── main.ts                              # EXTEND — conditional spread of config.ui.language
└── uiConfig.integration.test.ts         # NEW — no-cookie 200 / en override / tier proof

Share2Brain.config.yml.example           # EXTEND — ui block (Task 1.2; real filename!)
docs/api-spec.yml                        # EXTEND — info.description exception list ONLY (path/schema landed)
docs/backend-standards.md                # EXTEND — :742/:744 exception + endpoint lists
```
- Branch: `feat/10-1-ui-config` off `main` (`fe1f56f`). Conventional Commits, scopes `shared|backend|repo`, docs → shared → backend slice order (docs-first per base-standards §7).
- English only in all code/comments/tests/commits. `'es'`/`'en'` literals are data values, fine anywhere.
- FR26 already exists in the epics FR inventory — no FR work, no renumbering.

### References
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-12-i18n.md §1–§5] — ratified decisions (config-not-env, es/en, react-i18next), P3/P4 doc text (landed), success criteria, out-of-scope list.
- [Source: _bmad-output/planning-artifacts/epics.md:1148–1183 (Épico 10) + :45 (FR26)] — story scope bullets (with the two factual corrections noted above).
- [Source: docs/api-spec.yml:135–152, :418–426 (landed contract — the target); :16–17 (drift to fix)]
- [Source: docs/context/TECHNICAL-DESIGN.md:844, :856 (§11, landed), :1019–1024 (§13 example — the byte-source for Task 1.2), :362 (§5.5 SPA paragraph, 10.2 context)]
- [Source: docs/context/ARCHITECTURE-SPINE.md AD-3 (SPA static, runtime config), AD-6 (contracts in shared/schemas), AD-8 (config validated at boot, fail loud)]
- [Source: docs/backend-standards.md:742–744 (drift to fix), :819–821 (verification gate)]
- [Source: docs/bmad-story-mandatory-steps.md §3.1 (gate), §3.3 (endpoint verification — MANDATORY)]
- [Source: _bmad-output/implementation-artifacts/2-5-acceso-de-invitado-para-demos.md] — D4 resolver convention origin, gate-exemption-by-order, conditional-spread, `toEqual` exactness lesson, stop-app-containers lesson (Debug Log).
- Current code (verified 2026-07-12 @ fe1f56f): `packages/shared/src/{config/index.ts:48–51,53–280,286–369, config/index.test.ts:9–96,118–163,165–219, schemas/{index.ts, auth.ts:1–31, auth.test.ts:92–100, errors.ts:5–8}}`; `packages/backend/src/{app.ts:62–311 (AppOptions L62–117, limiters L180–191, mounts L215–226, agentMemoryWindow L290), main.ts:31,94–106,117–157, presentation/controllers/{authController.ts:178–186, authController.guest.test.ts:15–26,148–181}, routes/{statsRoutes.ts, authRoutes.ts:8–18, asyncHandler.ts, errorHandler.ts}, middleware/requireCustomHeader.ts, test-helpers.ts:146–165, security.integration.test.ts:86–103, guest.integration.test.ts, e2e/server.ts:13–16,72–82}`; `eslint.config.js:5–19,48–68`; `Share2Brain.config.yml.example:118–125`; `vitest.config.ts`; zod ^4.4.0, express ^5.2.0, express-rate-limit ^8.5.2, rate-limit-redis ^4.3.1 (no NEW dependency in this story).

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5)

### Debug Log References

- **TD §13 `ui:` comment is Spanish; ported to English.** Task 1.2 said to byte-mirror TECHNICAL-DESIGN.md §13's 4-line `ui:` comment verbatim, but that comment is written in Spanish while `Share2Brain.config.yml.example` is English-only everywhere else (repo-wide non-negotiable, confirmed against every other block in that file, e.g. `guest_access`). Translated the comment to English, kept the same 4-line structure/whitespace/inline `# es | en` comment. TD itself was left untouched (already verified-landed, Task 1.1 scope).
- **Stale local `.env` (`DATABASE_URL`/`REDIS_URL` still `hivly`).** `npm run test:integration` initially failed with `password authentication failed for user "hivly"` across bot/workers-integration (unrelated files this story never touches). Confirmed via `git stash` against baseline `fe1f56f` that the SAME failure occurs without any of this story's changes — a pre-existing drift from the earlier hivly→share2brain rename that never reached the local `.env`. Root Postgres role is `share2brain` with the SAME password already in `.env`'s `POSTGRES_PASSWORD`; only the DB user/name segment of `DATABASE_URL` needed changing (Redis password already matched — no username in that URL scheme). Fixed with Borja's explicit go-ahead. `app.ts`/`main.ts` code is unaffected; this was purely a local secrets file.
- **3/28 Playwright e2e pre-existing failures (`auth-guest.spec.ts`).** `loginAsGuest` in `packages/web/tests/helpers/session.ts` called `POST /api/auth/guest` with no `X-Requested-With` header, tripping `requireCustomHeader` (CSRF, 403) — confirmed pre-existing via the same `git stash` A/B test against `fe1f56f`, unrelated to this story (Story 2.5 territory). Fixed with Borja's explicit go-ahead: added the header, matching the SPA's `CSRF_HEADER` value (`src/api/csrf.ts`). Re-ran full e2e afterward: 28/28 green.
- **Rate-limit test files race under Vitest's default file-parallelism.** `npm run test:integration` intermittently failed (`security.integration.test.ts` vs. this story's new `uiConfig.integration.test.ts`, both exercising the shared `rl:auth:`/`rl:api:` Redis keys via `tinyRateLimit`). `--no-file-parallelism` makes the full suite pass deterministically every time (142/142). This is the previously-flagged Epic 9 retro item AI-5 ("load-sensitive integration intermittency") — pre-existing test-isolation gap in how Redis-backed rate-limit counters are shared across concurrently-run integration files; my new file follows the exact existing `security.integration.test.ts` pattern (per Dev Notes' explicit mirror instruction) and just adds a second consumer of the same keys, making the pre-existing race easier to reproduce locally. Out of scope to redesign here; documented per Borja's direction rather than restructuring the test-isolation strategy.

### Completion Notes List

- Shared: added the optional top-level `ui` block to `Share2BrainConfigSchema` (no `.default()`, D1) plus 4 new + 1 extended config test (absent/en/es/invalid-language/empty-block, empty-block path asserted as `ui` not `ui.language`, matching Zod's null-vs-missing-key path resolution).
- Shared: new `UiConfigResponseSchema`/`UiConfigResponse` in `schemas/uiConfig.ts` (+ 5 tests), barrel-exported.
- Backend: `AppOptions.uiLanguage?`, `createUiConfigController`, `createUiConfigRouter`, mounted in `app.ts` between `/api/auth` and the generic gate reusing the SAME `apiLimiters` array (general tier, not auth tier); `main.ts` conditional-spreads `config.ui.language` only when the block is present. 2 controller unit tests.
- Backend: new `uiConfig.integration.test.ts` (4 tests) proving the no-cookie 200 default, the `en` override, and both halves of the rate-limit-tiering claim (api-tier exhaustion 429s it; auth-tier exhaustion does not).
- Docs: verified the already-landed `fe1f56f` pieces (api-spec path/schema, TD §11 row + §13 example) untouched; closed the 3 remaining drift points — `Share2Brain.config.yml.example` `ui:` block, `docs/api-spec.yml:16-17` info.description exception list, `docs/backend-standards.md:742/744` exception + endpoint lists.
- Confirmed by inspection: `buildTestAppOptions` and `e2e/server.ts` need zero changes (both omit `uiLanguage` ⇒ resolve to `es`) — the Epic 10 critical guard.
- Manual §3.3 verification: local dev backend, `curl -i http://localhost:3000/api/ui-config` → `200 {"language":"es"}` (no `ui:` block, `RateLimit: "100-in-15min"` proving the `api` tier); repeated with a local `ui.language: "en"` override → `200 {"language":"en"}`; local config restored afterward (untracked, unmodified per `git status`).
- Full gate green: `lint` 0 issues; `npm run test` 1003 passed/1 skipped (+10 new); `npm run build` clean (5 packages); `npm run test:integration` 142/142 passed (deterministic with `--no-file-parallelism`, see Debug Log AI-5 note); 28/28 Playwright e2e green (after the pre-existing CSRF-header fix, Borja-approved).
- Two out-of-scope fixes applied with Borja's explicit approval after confirming both were pre-existing (via `git stash` against baseline `fe1f56f`, not caused by this story): the local `.env`'s stale `hivly` DB credentials, and the missing CSRF header in `loginAsGuest` (Story 2.5's e2e helper).

### File List

- `Share2Brain.config.yml.example` (EXTEND — `ui:` block)
- `docs/api-spec.yml` (EXTEND — no-auth exception list)
- `docs/backend-standards.md` (EXTEND — no-auth exception + endpoint lists)
- `packages/shared/src/config/index.ts` (EXTEND — optional `ui` block)
- `packages/shared/src/config/index.test.ts` (EXTEND — 4 new tests + 1 extended assertion)
- `packages/shared/src/schemas/uiConfig.ts` (NEW)
- `packages/shared/src/schemas/uiConfig.test.ts` (NEW)
- `packages/shared/src/schemas/index.ts` (EXTEND — barrel export)
- `packages/backend/src/app.ts` (EXTEND — `AppOptions.uiLanguage?` + mount)
- `packages/backend/src/main.ts` (EXTEND — conditional spread)
- `packages/backend/src/presentation/controllers/uiConfigController.ts` (NEW)
- `packages/backend/src/presentation/controllers/uiConfigController.test.ts` (NEW)
- `packages/backend/src/routes/uiConfigRoutes.ts` (NEW)
- `packages/backend/src/uiConfig.integration.test.ts` (NEW)
- `packages/web/tests/helpers/session.ts` (EXTEND — pre-existing CSRF-header fix, out of story scope, Borja-approved)
- `.env` (EXTEND — pre-existing stale `hivly` credential fix, untracked/gitignored, Borja-approved, not part of this diff)

## Change Log

| Date | Change |
|---|---|
| 2026-07-12 | Story 10.1 created (bmad-create-story): shared `ui.language` optional config block + `UiConfigResponse` contract + unauthenticated `GET /api/ui-config` on the general rate-limit tier. Ultimate context engine analysis completed — comprehensive developer guide created. |
| 2026-07-12 | Story 10.1 implemented (bmad-dev-story) on branch `feat/10-1-ui-config` off `fe1f56f`: shared optional `ui` config block + `UiConfigResponse` contract; backend `GET /api/ui-config` mounted before the generic gate on the `api` rate-limit tier; docs drift closed. 2 out-of-scope, Borja-approved fixes for pre-existing issues (confirmed via `git stash` A/B against `fe1f56f`): stale `hivly` DB credentials in local `.env`, missing CSRF header in the guest-login e2e helper. Gate green: lint 0 / 1003+1skip unit+web (+10) / build clean (5 pkgs) / 142 integration (deterministic with `--no-file-parallelism`, see AI-5 note) / 28 e2e. Status → review. |

## Review Findings

_bmad-code-review 2026-07-12 — 3 adversarial layers (Blind Hunter, Edge Case Hunter, Acceptance Auditor). All 7 ACs + D1–D7 confirmed SATISFIED by the Acceptance Auditor; no AC violations. Findings below are quality/hardening only._

- [x] [Review][Patch] `/api/ui-config` router now terminates on unmatched paths/methods — no more double-count of the shared `api` limiter — The router defined only `router.get('/')` with no catch-all, so `GET /api/ui-config/<anything>` or a non-GET carrying the CSRF header fell through to the generic `/api` gate and incremented the **same** `apiLimiters` (`rl:api:`) Redis counter twice, logging `ERR_ERL_DOUBLE_COUNT` (express-rate-limit v8). **APPLIED** the optional hardening from Task 4.3: added a path-less `router.use((_req, res) => res.sendStatus(404))` after the GET route so the request never falls through. NB used `router.use(...)` (not `router.all('*', …)`) because Express 5 / path-to-regexp v8 rejects a bare `*` wildcard. Verified: lint 0, build clean, 1003 unit/web pass, uiConfig integration 4/4 pass (no-cookie 200 default, en override, both tier halves). [packages/backend/src/routes/uiConfigRoutes.ts] (source: edge, corroborated by blind)
- [x] [Review][Defer] No `Cache-Control`/`ETag` on the deployment-static ui-config response [packages/backend/src/presentation/controllers/uiConfigController.ts] — deferred, optional enhancement (language is fixed per process; every SPA load re-hits the rate-limited endpoint uncached). (source: blind)
- [x] [Review][Defer] `es`/`en` enum duplicated across config schema and response contract [packages/shared/src/config/index.ts vs packages/shared/src/schemas/uiConfig.ts] — deferred, low-priority coupling (adding a language to one and not the other turns a valid config value into a runtime parse-500; consider a shared enum when languages expand beyond es/en). (source: blind)

**Re-run (2026-07-12, after the DN-1 patch) — double-count fix CONFIRMED EFFECTIVE** by the Edge Case Hunter against the real `app.ts` mount order (limiter runs once on the mount; catch-all terminates before the generic gate). Blind Hunter confirmed no GET happy-path regression. Acceptance Auditor re-confirmed all 7 ACs + D1–D7 SATISFIED and that no test asserted the old POST→401 fall-through. One NEW finding introduced by the patch itself:

- [x] [Review][Patch] Catch-all 404 body now uses the unified `{ error, code }` JSON error envelope — **APPLIED.** `res.sendStatus(404)` (plain-text) → `res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' })`, matching the repo-wide ErrorSchema convention (authController's guest-probe 404 precedent, English `'Not found'` string). No per-endpoint error-code map introduced (routing terminator, not an endpoint error branch — D7 intact). Added an integration test (`uiConfig.integration.test.ts`): `POST /api/ui-config` + `X-Requested-With` → 404 with `{ error: 'Not found', code: 'NOT_FOUND' }`, covering the previously-untested catch-all. Re-verified: lint 0, build clean, 1003 unit/web pass, uiConfig integration **5/5** pass. [packages/backend/src/routes/uiConfigRoutes.ts] (source: blind+edge)

**Third pass (2026-07-12, after the JSON-404 patch) — CLEAN, verdict CLEAN TO MERGE (Acceptance Auditor).** Both fixes verified correct by the two context-having layers: Edge Case Hunter confirmed the catch-all terminates with no double-count and the new POST→404 test is non-flaky (empty `apiLimiters`, outside the tiering `describe`); Acceptance Auditor confirmed the inline `{ error: 'Not found', code: 'NOT_FOUND' }` matches the repo's framework-terminator precedent exactly (`errorHandler.ts` `'INTERNAL'`, `requireCustomHeader.ts` `'FORBIDDEN'`, authController's `'Not found'`/`'NOT_FOUND'`) and does NOT violate D7 (routing terminator, not the GET success contract; schema file has no error map). All 7 ACs + D1–D7 re-confirmed SATISFIED. The 5 Blind-Hunter Lows were all dismissed with context: hardcoded-404-bypasses-error-handler (delegating via `next(err)` would re-trigger the fall-through; inline literal is the correct terminator pattern), 405-vs-404 (Task 4.3 sanctions a 404), OPTIONS→404 (Edge-verified: `cors()` terminates preflight app-wide before the router; SPA is same-origin per AD-3), test-CSRF-rationale-unverifiable (Edge-verified `requireCustomHeader` IS mounted before the router), empty-`ui:`-null-vs-undefined (AC3-intended fail-loud, js-yaml yields null). One non-blocking coverage note recorded as a defer below.

- [x] [Review][Defer] No test drives the non-GET catch-all with rate-limiting ACTIVE [packages/backend/src/uiConfig.integration.test.ts] — deferred, low value. The POST→404 test runs with empty `apiLimiters`, so it proves routing termination + the 404 shape but not the double-count guard under active limiters. Edge Case Hunter: "the code path is correct regardless; this is a test-coverage gap, not an unhandled path" — router termination is method/path-based and limiter-independent, so an active-limiter variant would mostly exercise express-rate-limit internals. Revisit only if the limiter-interaction is refactored. (source: edge)

_Dismissed re-run (8): method-not-allowed masked as 404 / no 405+Allow (spec Task 4.3 explicitly sanctions a catch-all **404**); OPTIONS preflight 404 (Edge VERIFIED cors() terminates preflight app-wide before the router — non-issue); OpenAPI has no path/operation (blind lacked context — path+schema landed in fe1f56f, api-spec.yml:135–152/:418–426, Auditor-verified); es/en enum duplicated (already deferred, see below); unauthenticated shares rl:api: budget (ratified D4); no Cache-Control (already deferred); empty `ui:` hard-fails startup (AC3-intended fail-loud per AD-8); enum-dup + Cache-Control re-raised = the two existing defers._

_Dismissed as noise (7, round 1): anonymous-DoS via limiter keying (blind — verified `rl:api:` is per-IP, tier ratified by D4); dedicated public tier (blind — design smell, D4 ratified); `.parse()` "dead code"/no `next(err)` (blind — parse is the AC5-mandated contract guard, input is compile-time `'es'|'en'`); test brittle to a future `.nullable()`/`.default({})` (blind — speculative, current behavior correct); hard-coded CSRF literal `'share2brain'` in the e2e helper (blind — matches the existing SPA constant, test-only, part of the separately-approved 2.5 fix); English config comment vs TD §13 Spanish "byte-mirror" (auditor — deliberate, English-only rule wins, documented in Debug Log); `session.ts` edit out of story scope (auditor — pre-existing, Borja-approved, documented)._
