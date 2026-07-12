---
baseline_commit: 4471cd2
---

# Story 10.2: web — react-i18next, literal extraction and JSON locales

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an Operator,
I want the web SPA to render every user-facing string, date and number in the language configured in `Share2Brain.config.yml` (`ui.language`, es/en), resolved at boot from `GET /api/ui-config`,
so that a deployment renders the whole UI in the configured language without rebuilding images (FR26 — story 10.1 delivered the config + contract + endpoint; this story consumes it and closes Epic 10).

## Acceptance Criteria

1. **AC1 — Full literal extraction.** Given the inventory in Dev Notes (§Literal inventory — the authoritative list, ~80 literals across 8 files, NOT the epic's "~31 in 9 components"), when the story is done, then every listed literal renders through react-i18next (`t('<namespace>.<key>')`) with its `es.json` value **byte-identical** to today's hardcoded string (including `·`, `¡`, `…`, nested `"` quotes and accents), and `grep` over `packages/web/src/**/*.{ts,tsx}` finds no remaining user-facing Spanish literal (the D7 exclusion list is the only sanctioned residue; paste the grep + surviving hits as evidence).
2. **AC2 — `en.json` complete and structurally identical.** `packages/web/src/locales/en.json` has EXACTLY the same key tree as `es.json` (an automated structural-parity unit test enforces it), every value is a faithful English translation, and at least one unit test per view (LoginScreen, Sidebar/Header, ChatWidget, DocsView, SearchView, StatsView) renders under `en` and asserts an English string.
3. **AC3 — Boot language resolution.** When the SPA boots, it fetches `GET /api/ui-config` BEFORE the first React render and sets the i18n language from the response; when the call fails (network error, non-200, invalid body, timeout), it silently degrades to `es` and the app renders normally; `document.documentElement.lang` reflects the active language (and `index.html`'s static `lang` attribute is corrected from `"en"` to `"es"`).
4. **AC4 — Locale-aware formatting.** No hardcoded locale literal remains in `packages/web/src`: the 7 `toLocaleString('es')` in `StatsView.tsx` (L216, 238, 249, 305, 389, 400, 456), the 2 `Intl.DateTimeFormat('es', …)` (SearchView.tsx:282, DocsView.tsx:408) and the `Intl.RelativeTimeFormat('es', …)` in `lib/relativeTime.ts:18` all format with the active i18n language. Under the default `es` the rendered output is byte-identical to today.
5. **AC5 — Error-code mapping.** `errors.<CODE>` keys exist in both locales for the full 11-code vocabulary (`AUTH_REQUIRED, GUILD_MEMBER_REQUIRED, INVALID_OAUTH_STATE, OAUTH_CALLBACK_FAILED, LOGOUT_FAILED, RBAC_EXPANSION_FAILED, GUEST_ACCESS_DISABLED, VALIDATION_ERROR, NOT_FOUND, FORBIDDEN, INTERNAL`); a helper resolves `errors.<CODE>` via `i18n.exists()` and falls back to the caller-supplied string for unknown codes (the SSE `error` frame's `message` where one exists — `sse.ts:13` — otherwise the view's generic translated error, since `ChatStreamError` carries only `code`); it is wired into the ChatWidget error paths (the ONLY place a backend `code` reaches the UI today — the `ChatStreamError` catch at L333–339 AND the SSE `error`-frame branch at L326–331, both of which discard the code today); unit tests cover known-code, unknown-code-fallback and both languages.
6. **AC6 — Zero-regression guard (the Epic 10 critical AC).** With the `ui` block absent (default `es`), the full gate runs green with NO existing assertion's expected value modified: `npm run lint` (0), `npm run test` (unit + the 126 web tests), `npm run build` (5 pkgs), and the 28 Playwright e2e stay green with **zero spec changes**. Sanctioned mechanical edits that do NOT count as assertion changes: adding `setupFiles` to `packages/web/vitest.config.ts`, and updating `relativeTime.test.ts` call sites for the D6 signature change (expected literals untouched). If any existing test fails, the implementation is wrong — never the test.
7. **AC7 — English deployment verified end-to-end.** Per `docs/bmad-story-mandatory-steps.md` §3.4, with a LOCAL config carrying `ui.language: "en"` (not committed; restored afterwards) and the dev stack running, the agent verifies in a real browser (or documents the deferral) that the login screen, all three views, the chat widget, dates and numbers render in English with no rebuild — and that removing the block restores Spanish. Evidence pasted in Completion Notes.

## Tasks / Subtasks

- [x] Task 1 — Dependencies + i18n scaffolding (AC: 1, 2)
  - [x] 1.1 `packages/web/package.json`: add runtime deps `i18next` (^26.3.6) and `react-i18next` (^17.0.9) — the two SCP-sanctioned new dependencies. `npm install` from the repo root (workspaces).
  - [x] 1.2 NEW `packages/web/src/locales/es.json`: nested single-namespace tree (`common`, `login`, `sidebar`, `header`, `chat`, `docs`, `search`, `stats`, `errors`), camelCase keys per `docs/frontend-standards.md:128`. Values copied byte-exact from the inventory. NEW `en.json` with the identical key tree, translated.
  - [x] 1.3 NEW `packages/web/src/i18n.ts`: singleton — `i18n.use(initReactI18next).init({ resources: { es: { translation: es }, en: { translation: en } }, lng: 'es', fallbackLng: 'es', interpolation: { escapeValue: false } })`. Static JSON imports, synchronous init (bundled resources ⇒ ready immediately; NO `useSuspense: false`, NO loading state — see §Latest tech). Register a `languageChanged` listener that stamps `document.documentElement.lang` (guard for non-DOM test envs is unnecessary — jsdom has `document`).
  - [x] 1.4 NEW `packages/web/src/i18next.d.ts`: `declare module 'i18next' { interface CustomTypeOptions { defaultNS: 'translation'; resources: { translation: typeof import('./locales/es.json') }; } }` — the `{ translation: ... }` wrapper is **load-bearing**: `resources` maps namespace → keys, so passing the JSON type directly makes each top-level section a namespace and `defaultNS: 'translation'` fails with `TS2344: '"translation"' does not satisfy 'Namespace'` (verified empirically against i18next 26.3.6 with this repo's exact compiler flags; no `['default']` accessor needed under `resolveJsonModule` + Bundler). `enableSelector` already defaults to `false` in 26.3.6, so classic string keys typecheck as-is — you MAY add `enableSelector: false` for explicitness, but it is not required (D8).
  - [x] 1.5 `packages/web/tsconfig.json`: add `"resolveJsonModule": true` to `compilerOptions` (base tsconfig does not set it; JSON imports won't typecheck without it).
  - [x] 1.6 `packages/web/vitest.config.ts`: add `setupFiles: ['./src/test-setup.ts']`; NEW `src/test-setup.ts` importing `./i18n` — unit tests render with the REAL `es` resources so all 126 existing text assertions keep passing without a Provider (initReactI18next registers the default instance).
- [x] Task 2 — Boot wiring (AC: 3)
  - [x] 2.1 NEW `packages/web/src/api/uiConfig.ts`: `fetchUiLanguage(): Promise<'es' | 'en'>` — `fetch('/api/ui-config', { signal: AbortSignal.timeout(3000) })`, parse with `UiConfigResponseSchema` from `'@share2brain/shared/schemas'` (web may import only `/schemas` or `/types/events` from shared — eslint.config.js:46–68), return `.language`; ANY failure (reject, non-ok, parse error, timeout) → return `'es'`. **Never throws** — the whole degrade path lives here so `main.tsx` stays branch-free and the client is unit-testable. `AbortSignal.timeout` is verified available in jsdom 29 (unit env), Playwright's Chromium and all Vite 8 baseline browsers.
  - [x] 2.2 `packages/web/src/main.tsx`: import `./i18n` first; use an explicit async bootstrap function (not top-level await): `async function bootstrap() { const language = await fetchUiLanguage(); await i18n.changeLanguage(language); createRoot(...).render(...); } void bootstrap();`. With bundled resources `changeLanguage` resolves in a microtask — no FOUC, no loading UI (the pre-render delay is one small GET; the deferred `Cache-Control` enhancement on the endpoint is 10.1's deferred-work item — do NOT add caching here).
  - [x] 2.3 `packages/web/index.html:2`: `lang="en"` → `lang="es"` (today's mismatch; runtime stamp from 1.3 overrides it post-boot).
- [x] Task 3 — Literal extraction, per file (AC: 1)
  - [x] 3.1 `LoginScreen.tsx` (7 literals: L110, 121–122, 148, 163, 187, 213 + brand exclusions per D7).
  - [x] 3.2 `Sidebar.tsx`: `NAV_ITEMS` labels (L67–69) — **module-scope trap (D9)**: replace `label` with i18n keys and translate at render (`t(item.labelKey)`), or build the array inside the component with `useMemo`. Status-panel tokens excluded per D7.
  - [x] 3.3 `Header.tsx` (L99, 117, and the 144–145/155–156 ternary pairs — conditional KEYS, e.g. `t(theme === 'dark' ? 'header.themeToLight' : 'header.themeToDark')`; `title` and `aria-label` may share a key when texts match).
  - [x] 3.4 `App.tsx`: `STATS_LINE` (L32 — module const, D9 trap) + LoadingSplash `aria-label="Cargando"` (L166). `VITE_COMMUNITY_NAME` fallback `'Share2Brain'` (L31) stays (brand, D7). `main.tsx` fatal-mount message stays English (D7).
  - [x] 3.5 `ChatWidget.tsx` (22 literals, L89–91 `SUGGESTIONS` module const — D9 trap — plus L240, 376, 433, 524, 536–537, 547–548, 557–558, 590, 603, 606, 610, 670, 673, 755, 756, 775, 810, 876, 930, 951). Distinct keys where aria-label/title differ (`'Historial de conversaciones'` vs `'Historial'`).
  - [x] 3.6 `DocsView.tsx` (L176, 179–181, 194 `"todos"` → `common.all`, 222, 254 interpolated, 260, 290, 293 — mind the nested `"Sin leer"` quotes in JSON —, 322–327 the 6 column headers, 339 interpolated, 358, 490, 516–517).
  - [x] 3.7 `SearchView.tsx` (L102, 105–106, 127 placeholder — same string as ChatWidget suggestion #1: share ONE key —, 146 `common.all`, 166, 178, 197 plain interpolation NOT plural (D5 — `SearchView.test.tsx:93` pins `'1 resultados'`), 206, 229, 232, 401, 418).
  - [x] 3.8 `StatsView.tsx` (L124, 127–128, 133, 139, 233, 238 plural D5, 249 plural D5, 276–277 axis labels, 288, 292, 333, 334–335, 371, 376–377 LegendRow labels, 389 plural D5, 411, 415). KPI `label`/`sub` (L190/218) stay verbatim from the API — D3, do NOT touch.
- [x] Task 4 — Locale-aware formatting (AC: 4)
  - [x] 4.1 `StatsView.tsx`: plain-value sites (L216 KPI value, 305 channel count, 400 legend value, 456 top-user count) → `toLocaleString(i18n.language)` (get `i18n` from `useTranslation()`). Sites embedded in translated strings (238, 249, 389) → i18next built-in Intl formatter `{{count, number}}` inside the JSON value (formats with `Intl.NumberFormat(lng)` — grouping matches `toLocaleString`; the 131-fixture in `StatsView.test.tsx:92` renders identically).
  - [x] 4.2 `SearchView.tsx:282` + `DocsView.tsx:408`: `new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' })`.
  - [x] 4.3 `lib/relativeTime.ts` (D6): refactor `relativeTimeEs(iso, now?)` → `relativeTime(iso, locale, now?)` with a per-locale `Intl.RelativeTimeFormat` cache (the current module-level `RTF` const pins `'es'` forever); `ChatWidget.tsx:32/641` passes `i18n.language`. `relativeTime.test.ts`: mechanically update import + call sites to pass `'es'` — the 9 expected literals (`'hace 5 días'`, `'ayer'`, …) stay byte-identical — and ADD `en` cases (`'5 days ago'`, `'yesterday'`).
- [x] Task 5 — Error-code mapping (AC: 5)
  - [x] 5.1 NEW `packages/web/src/lib/apiError.ts`: `translateErrorCode(code: string, fallback: string): string` returning `i18n.exists(key) ? i18n.t(key) : fallback` where `const key = \`errors.\${code}\`` (dynamic key needs a cast under typed keys — one sanctioned `as never`/`as any` at the single call site, or type the helper against the plain instance). Add the 11 `errors.*` entries to both locale files.
  - [x] 5.2 Wire into `ChatWidget.tsx`: the `ChatStreamError` catch (L333–339) and the SSE `error`-frame branch (L326–331) — both **discard** `code`/`message` today and render the L930 generic — route through `translateErrorCode(code, fallback)` (fallback = the SSE frame's `message` when present, else the generic chat error via `t()`). Pre-grep already done at story-creation time: **zero** existing unit/e2e assertions pin `'No se pudo completar la respuesta. Intentá de nuevo.'` or `'No se pudo cargar la conversación. Intentá de nuevo.'` — you have full freedom choosing `errors.*` es values for the chat paths (D4). Do NOT refactor the other 8 API clients to parse `{ error, code }` bodies — out of scope (D4).
- [x] Task 6 — New tests (AC: 2, 3, 5 + D5/D6)
  - [x] 6.1 NEW `src/locales/parity.test.ts`: recursive key-tree comparison of `es.json` vs `en.json` (both directions — missing AND extra keys fail).
  - [x] 6.2 `en` render smokes (one per view, 6 total minimum): `beforeEach` `i18n.changeLanguage('en')`, `afterEach` restore `'es'` + `cleanup()` — the singleton is shared within a test file (Vitest isolates per file, not per test).
  - [x] 6.3 NEW `src/api/uiConfig.test.ts` (stub-global-fetch pattern, `api/documents.test.ts:17–18`): 200 `{language:'en'}` → `'en'`; network reject → `'es'`; non-200 → `'es'`; malformed body → `'es'`.
  - [x] 6.4 NEW `src/lib/apiError.test.ts`: known code (both languages), unknown code → raw fallback.
  - [x] 6.5 Plural cases (D5): NEW tests asserting the StatsView singular renderings (`'1 recurso · últimos 14 días'`, `'1 documento en total'`). NO singular test for SearchView — it stays plain interpolation because `SearchView.test.tsx:93` pins the existing `'1 resultados'` rendering (D5).
- [x] Task 7 — Verification gate + manual verification (AC: 6, 7 + mandatory §3.1/§3.4)
  - [x] 7.1 Full gate, paste outputs: `npm run lint` && `npm run test` && `npm run build`. `npm run test:integration` is legitimately SKIPPED (web-only story, no shared/backend change — 8-1 precedent; state it explicitly in Completion Notes).
  - [x] 7.2 Run the 28 Playwright e2e (`npm run test:e2e -w @share2brain/web`) — green with ZERO spec changes (`e2e/server.ts` passes no `uiLanguage` ⇒ backend serves `es`; the SPA's new boot fetch hits the real mounted endpoint through the vite-preview proxy).
  - [x] 7.3 §3.4 manual verification (AC7): dev stack up, add `ui.language: "en"` to your LOCAL `Share2Brain.config.yml`, restart backend, browse `:5173` — login screen, the 3 views, chat, dates/numbers in English; remove the block, restart, confirm Spanish. Restore the local config (do not commit).
  - [x] 7.4 AC1 grep evidence: run the no-literals grep (e.g. `grep -rnP '[áéíóúñ¿¡]' packages/web/src --include='*.tsx' --include='*.ts' | grep -v locales | grep -v '.test.'`) and account for every surviving hit against the D7 exclusion list.
- [x] Task 8 — Docs + tracking (AC: —)
  - [x] 8.1 Verify (do NOT redo) the already-landed docs: `docs/frontend-standards.md:124–133` (i18n standard), `docs/context/TECHNICAL-DESIGN.md:362` (§5.5 paragraph). No api-spec/data-model surface in this story.
  - [x] 8.2 Append the D3 limitation to `_bmad-output/implementation-artifacts/deferred-work.md`: KPI `label`/`sub` are API-owned Spanish and remain untranslated under `en`; follow-up = structured KPI contract (label key + numeric fields) or backend language awareness — a shared+backend story, out of Epic 10's web scope.
  - [x] 8.3 Story file + `sprint-status.yaml` updates per the BMAD flow.

## Dev Notes

### Scope boundary
- **IN:** everything `packages/web` — deps, locales, i18n init, boot fetch of `/api/ui-config`, extraction of the §inventory literals, locale-aware number/date/relative-time formatting, `errors.<CODE>` client mapping, new tests, `index.html` lang fix.
- **OUT:** ANY backend/shared change (the endpoint, contract and config landed in 10.1); localizing backend `{ error, code }` bodies or the API-owned KPI `label`/`sub` strings (D3); per-user language selector; languages beyond es/en; `Cache-Control` on `/api/ui-config` (10.1 deferred-work — leave it); refactoring the 9 API clients' error handling beyond D4; MSW or any new test infra beyond `setupFiles`.
- **No DDL, no migration, no new endpoint, no env var.** Two new runtime deps (`i18next`, `react-i18next`) — explicitly sanctioned by the SCP (§2 Technical impact).

### Factual corrections vs the epic/SCP text (do not propagate)
- **"~31 literals in 9 components" is wrong.** The verified count is **~80 translatable literals in 8 files**: `LoginScreen`, `Sidebar`, `Header`, `ChatWidget` (22 — the largest), `DocsView`, `SearchView`, `StatsView`, `App.tsx` (+1 aria-label in the splash). `icons.tsx` has ZERO (all SVGs `aria-hidden`), `AppLayout.tsx` has zero. §Literal inventory below is authoritative.
- **`toLocaleString('es')` is NOT the only hardcoded locale.** Also: `Intl.DateTimeFormat('es', { dateStyle: 'medium' })` at `SearchView.tsx:282` + `DocsView.tsx:408`, and `Intl.RelativeTimeFormat('es', { numeric: 'auto' })` at `lib/relativeTime.ts:18` (module-level const; exported function literally named `relativeTimeEs`, consumed by `ChatWidget.tsx:32/641`, 9 unit tests assert its `es` output).
- **StatsView KPI `label`/`sub` are produced IN SPANISH BY THE BACKEND** (`packages/backend/src/application/services/statsService.ts:96–121`: `'Recursos indexados'`, `` `+${n} esta semana` ``, `'de ${n} accesibles'`, `'en tus canales'`, `'Tus consultas al agente'`, `'últimos 30 días'`…). StatsView renders them verbatim (L190/218; its own header comment says "KPI label/sub content is API-owned, never hardcoded here" — story 9.1's D1). Web-only i18n cannot translate them and the SCP pins backend bodies unchanged → D3.
- **`errors.<CODE>` mapping has almost no existing surface.** Only `src/api/chat.ts:43–51` reads `code` today (throws `ChatStreamError(code, status)`), and `ChatWidget.tsx:333–339` **discards** it. Every other API client throws a generic English `Error` without reading the body; components render their own hardcoded Spanish error strings. The mapping (AC5) is therefore mostly NEW plumbing, not a translation of existing behavior → D4.

### Ratified defaults (flag ANY of these in review if you disagree)
- **D1 — Boot = pre-render await in `main.tsx`.** `import './i18n'` (sync init, `lng: 'es'`) → `await fetchUiLanguage()` → `await i18n.changeLanguage(lang)` → `createRoot().render()`. Matches TD §5.5 ("al arrancar, la SPA consulta… y fija el idioma") and the react-i18next guidance: with bundled resources `changeLanguage` before first render is safe, effectively synchronous, zero FOUC and zero re-render churn. The one-GET pre-render delay is accepted (3 s `AbortSignal.timeout` bounds the worst case).
- **D2 — The degrade path lives in `fetchUiLanguage()`, which NEVER throws.** Network/HTTP/parse/timeout failures all resolve `'es'`. Rationale: `main.tsx` stays linear, the entire AC3 failure matrix is unit-testable at the API-client layer (fetch-stub pattern), and a broken backend still yields a working Spanish login screen.
- **D3 — KPI `label`/`sub` remain API-owned Spanish under `en` (KNOWN LIMITATION — 🚩 veto point).** The SCP contradicts itself: success criterion 1 says "full UI in English" but §1 and the out-of-scope list pin "backend responses unchanged / no backend body localization". Resolved in favor of the explicit scope clause: an `en` deployment shows English chrome with Spanish KPI card texts. The contract HAS a stable `kpis[].key` enum, so labels alone COULD be client-mapped — but `sub` embeds backend-computed numbers (`+3 esta semana`, `de 6 accesibles`) not present elsewhere in the contract, and a half-translated card is worse than a consistent limitation. Follow-up recorded in deferred-work (Task 8.2). If Borja vetoes: the fix is a shared+backend contract change (new story), NOT client string-matching on Spanish labels.
- **D4 — Error-mapping wiring is ChatWidget-only.** `errors.*` keys cover all 11 codes (vocabulary from the shared `*_ERROR` maps: `auth.ts:46`, `chat.ts:24`, `search.ts:63`, `documents.ts:68`, `readStatus.ts:40`, `conversations.ts:75`, `channels.ts:11`, `stats.ts:103`, plus raw `FORBIDDEN`/`NOT_FOUND`/`INTERNAL` emissions), but the only consumer is ChatWidget (`ChatStreamError` + SSE `error` frame `{ code, message }` — `sse.ts:13`). Refactoring the other 8 clients to parse `{ error, code }` is a behavior change beyond i18n and would risk the byte-identical guard. Per-view generic error literals stay (translated as view keys). Under `es`, any TESTED error path must render today's exact text — pre-grep before choosing `errors.*` es values (Task 5.2).
- **D5 — Plurals: StatsView yes, SearchView NO.** The three StatsView count strings (activity total L238, bar tooltip L249, coverage total L389) adopt i18next `_one`/`_other` plural keys — `es` `_other` values byte-identical to today, `_one` grammatically singular; safe because the only asserted values are `0`/`131` (`analytics.spec.ts:143/307`, `StatsView.test.tsx:92`) and `12`/`0 documentos en total` (`StatsView.test.tsx:125/171`), all `other`-category in both languages. **SearchView L197 must use plain `{{count}}` interpolation and KEEP today's `"1 resultados"` bug**: `SearchView.test.tsx:93` pins `expect(screen.getByText('1 resultados')).toBeTruthy()` on a single-result fixture (:87), and AC6 forbids touching it. Do NOT add a singular test for search (Task 6.5 covers StatsView singulars only). `docs` L254/L339 are NOT plurals (fixed wording) — plain interpolation. Number grouping inside translated strings uses the built-in `{{count, number}}` Intl formatter (i18next v26 kept built-in formatters; only the legacy monolithic `interpolation.format` option was removed); `Intl.NumberFormat('es').format(131) === '131'`, and no grouped-number assertion exists anywhere in unit or e2e tests — byte-safe.
- **D6 — `relativeTimeEs` → `relativeTime(iso, locale, now?)`.** The current name and module-level `RTF` const hardcode `'es'` by construction. Mechanical call-site updates in `relativeTime.test.ts` (pass `'es'`) are sanctioned by AC6 — the guard forbids changing EXPECTED VALUES, not renaming an API; all 9 expected literals stay byte-identical. Alternative (keeping a deprecated `relativeTimeEs` wrapper solely so the test file is untouched) was rejected as dead-code ceremony.
- **D7 — Exclusion list (NOT translated; everything else in the inventory IS):** brand `'Share2Brain'` (all occurrences + the `VITE_COMMUNITY_NAME` fallback, App.tsx:31); `'v4.0'` (LoginScreen:233); the OAuth scope footer `'scope: identify · guilds.members.read'` (LoginScreen:232); Sidebar's technical status panel (`share2brain.config.yml`, `indexer`/`running`, `redis stream`/`ok`, `pgvector`/`ok`, L140–164) and footer `'self-hosted · open source'` (L179) — deliberate techy chrome, already English/identifiers; `main.tsx:20/22` fatal-mount message (pre-React, dev-facing, English); all `console.*` messages and thrown `Error` strings in `src/api/*` (dev-facing, never rendered — English-only logging rule); `data-testid`s, `kh-*` CSS classes, protocol constants (`CSRF_HEADER` value, localStorage keys, `LOGIN_URL`); `` `#${ch.name}` `` channel-chip interpolation (data, `#` prefix); `'?'` initials fallback. Borderlines RESOLVED AS TRANSLATABLE: `'Agente de conocimiento · self-hosted'` (LoginScreen:110), `STATS_LINE` `'indexación de conocimiento · pgvector'` (App:32), `'indexando en vivo'` (Header:99), `'Vos'` (ChatWidget:876 → "You"), `'Cargando'` splash aria-label, the `'hace 14 días'`/`'hoy'` axis labels, `'Fuentes'`, `'todos'` (→ `common.all`).
- **D8 — Typed string keys via `CustomTypeOptions`.** The augmentation in Task 1.4 gives compile-checked string keys (`t('chat.historyTitle')` valid, unknown keys rejected — verified empirically against i18next 26.3.6). `enableSelector` (the type-level selector API) defaults to `false` in 26.3.6, so no opt-out is required; adding `enableSelector: false` explicitly is optional. The dynamic `errors.${code}` key in the helper is the one sanctioned cast.
- **D9 — Module-scope constant trap.** `NAV_ITEMS` (Sidebar:67–69), `SUGGESTIONS` (ChatWidget:89–91) and `STATS_LINE` (App:32) are evaluated AT IMPORT TIME — before `main.tsx` runs `changeLanguage`. A module-scope `t()` call would freeze the init language (`es`) forever under an `en` deployment. All module constants holding user-facing text must become key lists translated at render time (or move inside components). This is the #1 silent-failure risk of the story — an `en` smoke test per affected component (Task 6.2) is the executable proof.
- **D10 — Unit-test i18n via `setupFiles`, real resources, no mocks.** `src/test-setup.ts` imports `src/i18n.ts`; `initReactI18next` registers the default instance so `useTranslation()` works without a Provider and all 126 existing tests see real `es` strings. No `t()` mocking, no `I18nextProvider` wrapping, no `cimode`. `en` tests switch + restore language within their file (singleton shared per file; Vitest isolates across files).

### Current state — extend, don't reinvent (verified 2026-07-12 @ 4471cd2)
- **Backend contract (10.1, done, merged):** `GET /api/ui-config` → `200 { language: 'es' | 'en' }`, no auth, no session read, general `api` rate-limit tier, mounted before the generic gate; unmatched method/path → `404 { error: 'Not found', code: 'NOT_FOUND' }`. Contract: `UiConfigResponseSchema` in `packages/shared/src/schemas/uiConfig.ts`, barrel-exported. The e2e server (`packages/backend/src/e2e/server.ts:72–82`) and `buildTestAppOptions` pass NO `uiLanguage` ⇒ both serve `es` — the guard 10.1 left in place for this story.
- **Web boot:** `main.tsx` (24 lines) renders immediately — nothing async pre-render today; the only pre-React code is the inline theme script in `index.html:12–22`. `App.tsx` owns an `AuthState` machine (`loading → anon | authed`) driven by `fetchMe()`; splash at L124–126, LoginScreen at 128–130, shell (`AppLayout` + `ChatWidget`) at 138–157. **No router** (UX-DR5 — `useState<Screen>` navigation). The app never calls `/api/ui-config` today.
- **API layer:** 9 hand-rolled clients in `src/api/` (raw `fetch` + Zod `.parse()`); ALL import types via `'@share2brain/shared/schemas'` — web may import only `/schemas` or `/types/events` from shared (eslint `banNonBrowserSafeSharedInWeb`, eslint.config.js:46–68; root barrel, `/db`, `/config`, `/providers` are BANNED). Vite proxies `/api` → backend (`vite.config.ts:14–36`, both `server` and `preview`).
- **Test harness:** web vitest project = jsdom, `include: src/**/*.test.{ts,tsx}`, **currently NO `setupFiles`**; `@testing-library/react` render + role/name/text queries, **no jest-dom matchers** (project rule — `toBeTruthy()`/`toBeNull()`). Component tests `vi.mock` the `src/api/*` modules (`DocsView.test.tsx:16–23`, `App.test.tsx:14–40`); API-client tests stub global fetch (`api/documents.test.ts:17–18`). 13 files / 126 tests. Spanish-literal assertion hotspots: `ChatWidget.test.tsx` (~25 lines, `'Historial de conversaciones'` ×13), `DocsView.test.tsx` (~20, `'Cargar más'` ×7, `'mostrando 1 de 2'`), `App.test.tsx` (~13), `StatsView.test.tsx` (~11, incl. locale-formatted `'131 recursos · últimos 14 días'` at :92), `SearchView.test.tsx` (~5), `relativeTime.test.ts` (9 `es` Intl outputs).
- **E2E:** 28 tests / 6 specs in `packages/web/tests/` (chat 7, analytics 7, auth-guest 5, docs 4, search 3, interactions 2), single worker, Spanish literals asserted heavily (`analytics.spec.ts:34` `'Estadísticas'`, `:285` error text; `docs.spec.ts:198/219/221`; `chat.spec.ts:118`; `search.spec.ts:31/106`; `auth-guest.spec.ts:47/60`). No spec touches `/api/ui-config`.
- **Deps:** web has `react ^19.2.7`, `@share2brain/shared *`, NO i18n lib. TS strict + `verbatimModuleSyntax` (base), web overrides `moduleResolution: "Bundler"`; **no `resolveJsonModule`** yet.

### Literal inventory (authoritative — extract ALL of these)
Counts per file; exact lines verified @ 4471cd2. JSX text unless noted (attr = `placeholder`/`aria-label`/`title`).

| File | # | Lines |
|---|---|---|
| `App.tsx` | 2 | 32 (`STATS_LINE`, module const D9), 166 (aria-label `Cargando`) |
| `LoginScreen.tsx` | 6 | 110, 121–122, 148 (`Continuar con Discord`), 163, 187, 213 (`Entrar como invitado`) — D7 excludes 97/232/233 |
| `Sidebar.tsx` | 3 | 67–69 (`NAV_ITEMS` labels `Búsqueda`/`Documentos`/`Estadísticas`, module const D9) — D7 excludes 85/140–164/179 |
| `Header.tsx` | 6 | 99 (`indexando en vivo`), 117 (`Modo invitado`), 144–145 (theme ternary pair, title+aria), 155–156 (`Salir`/`Cerrar sesión` ternary pair) |
| `ChatWidget.tsx` | ~24 | 89–91 (`SUGGESTIONS` ×3, module const D9), 240, 376, 433, 524, 536–537, 547–548, 557–558, 590, 603, 606, 610, 670, 673, 755 (placeholder), 756, 775, 810, 876 (`Vos`), 930, 951 (`Fuentes`) |
| `DocsView.tsx` | 19 | 176, 179–181, 194 (`todos`), 222, 254 (interp `Sin leer · {n}`), 260, 290, 293 (nested quotes), 322–327 (6 column headers), 339 (interp `mostrando {n} de {total}`), 358 (`Cargar más`), 490 (`Nuevo`), 516–517 (`Ver recurso` pair) |
| `SearchView.tsx` | 12 | 102, 105–106, 127 (placeholder = ChatWidget suggestion #1, share the key), 146 (`todos`), 166 (`Buscando…`), 178, 197 (plain interp `{n} resultados` — NO plural, D5), 206, 229, 232, 401 (`ver recurso`), 418 (`ver en Discord`) |
| `StatsView.tsx` | 18 | 124, 127–128, 133, 139, 233, 238 (plural+number), 249 (title attr, plural+number), 276–277 (`hace 14 días`/`hoy`), 288, 292, 333, 334–335, 371 (`leído`), 376–377 (LegendRow `Leídos`/`Sin leer`), 389 (plural+number), 411, 415 (`Sin autores todavía.`) |

Plus `errors.*` (11 keys, both languages) — net-new, no existing literal.

### Anti-patterns to avoid
❌ Touching ANY file outside `packages/web` (+ deferred-work.md). ❌ Modifying an existing assertion's expected value — if a test goes red, your `es.json` value or wiring diverged (AC6). ❌ `t()` at module scope (D9 — frozen language). ❌ Reading the language from `import.meta.env` (frontend-standards:129). ❌ `I18nextProvider` wrapping / `useSuspense: false` / lazy loading / an i18n loading state — bundled + sync init makes all of it dead ceremony. ❌ Importing `@share2brain/shared` root barrel or `/config` from web (eslint ban; use `/schemas`). ❌ Hardcoded locale literals left behind (`'es'` in any `Intl.*`/`toLocaleString` call — AC4 grep). ❌ Translating the D7 exclusions (brand, testids, status-panel tokens, console/log strings — logs stay English). ❌ Client-side string-matching on Spanish KPI labels to "translate" them (D3 — accept the limitation). ❌ Editing e2e specs, `e2e/server.ts` or `buildTestAppOptions`. ❌ Adding `Cache-Control` to the endpoint (10.1 deferred-work, backend anyway). ❌ New i18n keys in Spanish or code comments in Spanish (English-only rule; JSON VALUES are data — Spanish fine there). ❌ Marking an AC done without pasting verification output.

### Previous-story intelligence (10.1 + Epic 9 lessons)
- 10.1 is MERGED (`4471cd2`); the endpoint is live on `main` — no branch dependency, no rebase risk. Baseline your branch off `4471cd2` or later.
- The e2e guest-login CSRF-header fix (`packages/web/tests/helpers/session.ts`) already landed via 10.1 — 28/28 e2e were green at merge. Any e2e failure you see is YOURS.
- Integration tests are load-sensitive under file parallelism (Epic 9 retro AI-5) — irrelevant here: this story legitimately skips `test:integration` (no shared/backend change; 8-1 precedent — SAY SO in Completion Notes rather than silently omitting).
- 10.1's review round-trip lesson: optional hardening subtasks left undone get patched in review — do the small hardening (timeout in D2, parity test) up front.
- `npm run test` = `vitest run --project unit --project web` from the root; web has no per-package unit-test script.

### Latest tech notes (researched 2026-07-12)
- **`i18next` ^26.3.6, `react-i18next` ^17.0.9** — both dual ESM/CJS, TS 5/6/7 peer range, React 19 fully supported (peer `react >= 16.8`, `i18next >= 26.2`). Vite 8 bundles them fine.
- v24+ removed legacy JSON formats and `compatibilityJSON`; **plural keys MUST use Intl suffixes** (`_one`/`_other`); `Intl.PluralRules` is mandatory (present in all evergreen browsers, Node, jsdom).
- v26: `initImmediate` fully removed (its successor `initAsync` is irrelevant with bundled resources — init is effectively synchronous); legacy `interpolation.format` removed but **built-in `{{value, number}}` / `{{value, datetime}}` Intl formatters remain** (use for D5); the type-level selector API exists but `enableSelector` defaults to `false` in 26.3.6 — classic string keys typecheck without opting out (D8).
- `changeLanguage()` with bundled resources resolves immediately (microtask) — awaiting it pre-render is the canonical boot pattern; multiple-call ordering was fixed in v25.
- Outside React (helpers like `apiError.ts`): import the singleton and call `i18n.t()` / `i18n.exists()` at CALL time (never cache translated strings at module load).
- `document.documentElement.lang`: no built-in — manual via the `languageChanged` event (fires on init too if the listener is registered before `init()`).
- Testing: `initReactI18next` + real resources in a setup file is the documented pattern; no Suspense/`waitFor` needed; singleton language state is per-file under Vitest isolation — restore after `changeLanguage` within a file.

### Testing standards
- Vitest 4, jsdom, colocated `*.test.{ts,tsx}` under `src/`; AAA; names `should <behavior> when <condition>`; English. No jest-dom matchers. RTL `render`/`screen` + role/name/text queries; `afterEach` `cleanup()` + `vi.clearAllMocks()`.
- Component tests mock `src/api/*` modules (`vi.mock` + `vi.mocked`); API-client tests stub global fetch. Follow the existing file's pattern when extending it.
- Tests-first where it pays: the parity test (6.1), `fetchUiLanguage` failure matrix (6.3) and `translateErrorCode` (6.4) are contract boundaries — write red first. Extraction itself is guarded by the 126 existing tests (your real red/green harness) + the new `en` smokes.
- E2E: run, never edit (AC6). Playwright e2e is MANDATORY for UI-affecting stories (`docs/bmad-story-mandatory-steps.md` §3.4).

### Project Structure Notes

```
packages/web/
├── package.json                      # EXTEND — + i18next, react-i18next
├── tsconfig.json                     # EXTEND — + resolveJsonModule
├── vitest.config.ts                  # EXTEND — + setupFiles
├── index.html                        # EXTEND — lang="es"
└── src/
    ├── i18n.ts                       # NEW — singleton init (D1), lang stamp listener
    ├── i18next.d.ts                  # NEW — CustomTypeOptions, enableSelector:false (D8)
    ├── test-setup.ts                 # NEW — imports ./i18n (D10)
    ├── main.tsx                      # EXTEND — pre-render fetch + changeLanguage (D1)
    ├── locales/{es,en}.json          # NEW — the resources
    ├── locales/parity.test.ts        # NEW — key-tree parity (AC2)
    ├── api/uiConfig.ts (+ .test.ts)  # NEW — fetchUiLanguage, never throws (D2)
    ├── lib/apiError.ts (+ .test.ts)  # NEW — translateErrorCode (D4)
    ├── lib/relativeTime.ts (+ test)  # EXTEND — locale param (D6)
    ├── App.tsx                       # EXTEND — extraction
    └── components/{LoginScreen,Sidebar,Header,ChatWidget,DocsView,SearchView,StatsView}.tsx  # EXTEND — extraction
_bmad-output/implementation-artifacts/deferred-work.md   # EXTEND — D3 KPI limitation entry
```
- Branch: `feat/10-2-web-i18n` off `main` (`4471cd2`). Conventional Commits, scope `web` (deferred-work edit → `repo`). Suggested slices: deps+scaffolding → boot wiring → extraction (may be 1–2 commits) → formatting → error mapping → tests.
- English only in code/comments/tests/commits; Spanish lives ONLY in `es.json` values (and pre-existing test expected-literals).

### References
- [Source: _bmad-output/planning-artifacts/epics.md:1148–1183 (Épico 10, Historia 10.2 bullets) + :169 (FR26)] — with the four factual corrections above.
- [Source: _bmad-output/planning-artifacts/sprint-change-proposal-2026-07-12-i18n.md] — ratified decisions (config-not-env, es/en, react-i18next, full-web scope), §2 dep sanction + test-coupling risk, §5 success criteria + out-of-scope list (the D3/D4 authority).
- [Source: docs/frontend-standards.md:124–133 (i18n standard — the permanent rule this story inaugurates), :90 (shared imports), :96–104 (naming/English), :197–202 (testing)]
- [Source: docs/context/TECHNICAL-DESIGN.md:362 (§5.5 i18n paragraph), :844/:856 (§11 endpoint row), :1019–1024 (§13 ui: example)]
- [Source: docs/context/ARCHITECTURE-SPINE.md AD-2 (web imports shared only), AD-3 (static SPA — runtime language, no rebuild), AD-6 (contracts in shared/schemas)]
- [Source: docs/bmad-story-mandatory-steps.md §2 (branch-first), §3.1 (gate), §3.4 (e2e mandatory for UI)]
- [Source: _bmad-output/implementation-artifacts/10-1-shared-backend-config-ui-language-endpoint-ui-config.md] — endpoint semantics, D-conventions, the byte-identical guard design, review-patch history (404 catch-all).
- Current code (verified 2026-07-12 @ 4471cd2): `packages/web/src/{main.tsx, App.tsx:26–166, components/{LoginScreen.tsx:97–233, Sidebar.tsx:67–179, Header.tsx:99–156, ChatWidget.tsx:88–951, DocsView.tsx:176–517, SearchView.tsx:102–418, StatsView.tsx:124–456}, api/{chat.ts:16–51, documents.test.ts:17–18}, lib/{relativeTime.ts, initials.ts}}`; `packages/web/{vitest.config.ts, vite.config.ts:14–36, tsconfig.json, index.html:2,12–22, package.json}`; `packages/shared/src/schemas/{uiConfig.ts, errors.ts, auth.ts:46, chat.ts:24, search.ts:63, documents.ts:68, readStatus.ts:40, conversations.ts:75, channels.ts:11, stats.ts:6–103, sse.ts:13}`; `packages/backend/src/{application/services/statsService.ts:96–121, e2e/server.ts:72–82, routes/uiConfigRoutes.ts, presentation/controllers/uiConfigController.ts}`; `eslint.config.js:48–68`; `packages/web/tests/*` (6 specs, 28 tests). i18next ^26.3.6, react-i18next ^17.0.9 (NEW), react ^19.2.7, vite ^8.1.3, zod ^4.4.0.

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5)

### Debug Log References

- The root Vitest "unit" project globs `packages/*/src/**/*.test.ts` (node env, no `document`) in ADDITION to the `web` project (jsdom). `src/lib/apiError.test.ts` calls `i18n.changeLanguage()`, which fires the `languageChanged` listener that stamps `document.documentElement.lang` — crashed under the "unit" project's node env. Fixed with a `typeof document !== 'undefined'` guard in `src/i18n.ts` (not a jsdom-safety guard per se — the "unit" project is a repo-specific double-execution quirk this story's design didn't anticipate).
- `ChatWidget.test.tsx`'s `vi.mock('../api/chat', () => ({ streamChat: vi.fn() }))` broke once `ChatWidget.tsx` started importing the real `ChatStreamError` class (for the `instanceof` check in the error-mapping wiring, D4) — the mock object had no such export. Fixed by switching the mock to `importOriginal` + only stubbing `streamChat`, preserving the real `ChatStreamError` class. Mechanical fix (no assertion value changed) required by production code, not by the test itself.
- AC7 manual verification: the running `docker compose` stack (backend/bot/workers) turned out to be built from an image that predates story 10.1 (`GET /api/ui-config` returned `401 AUTH_REQUIRED` there — a stale image issue, not this story's code). Verified instead against the source-run dev servers (`npm run dev -w @share2brain/backend`, `npm run dev -w @share2brain/web`), matching `docs/development_guide.md`'s documented flow. Needed `SHARE2BRAIN_CONFIG_PATH=<abs path>` since `npm run dev -w` sets cwd inside `packages/backend`, and the full `.env` sourced (the config interpolates many `${VAR}` placeholders beyond DATABASE_URL/REDIS_URL).

### Completion Notes List

- All 8 tasks complete. ~80 literals across 8 components extracted to `t('<ns>.<key>')` calls against a single `translation` namespace (`common`, `login`, `sidebar`, `header`, `chat`, `docs`, `search`, `stats`, `errors` — 103 keys), with `es.json`/`en.json` structurally identical (enforced by `locales/parity.test.ts`, both directions).
- D9 module-scope trap avoided in all 3 places (`Sidebar.NAV_ITEMS`, `ChatWidget.SUGGESTIONS`, `App.STATS_LINE`): each now holds/derives translation keys, resolved via `t()` at render time, never at import time.
- D5 plurals: StatsView's 3 count strings (`activityTotal`, `activityBarTitle`, `coverageTotal`) use i18next `_one`/`_other` suffixes with the built-in `{{count, number}}` Intl formatter (satisfies AC4's locale-aware-number requirement for those 3 sites in the same edit). SearchView's `resultsCount` stays plain `{{count}}` interpolation with NO suffix variants, so `SearchView.test.tsx:93`'s pinned `'1 resultados'` (grammatically singular-count-but-plural-word) renders byte-identical.
- D4 error-code mapping (`lib/apiError.ts: translateErrorCode`) wired into ChatWidget's two error paths (SSE `error` frame using `frame.message` as fallback; the `ChatStreamError` catch using the translated `chat.genericError` as fallback). The other 8 API clients are untouched, per scope.
- D6 `relativeTimeEs(iso, now?)` → `relativeTime(iso, locale, now?)` with a per-locale `Intl.RelativeTimeFormat` cache; `relativeTime.test.ts` call sites mechanically updated to pass `'es'` (all 9 existing expected literals byte-identical) plus 8 new `en` cases.
- **Verification gate (evidence):**
  - `npm run lint` → 0 errors/warnings across all packages.
  - `npm run test` (unit + web projects) → 1051 passed, 1 skipped, 0 failed (1019 pre-existing + 32 new: `locales/parity.test.ts` ×2, `api/uiConfig.test.ts` ×6, `lib/apiError.test.ts` ×4, 6 `en`-locale render smokes across ChatWidget/DocsView/SearchView/StatsView/App(×2), 2 StatsView singular-plural cases, 8 new `relativeTime` `en` cases — some `.ts` files run under both the root "unit" and "web" projects, hence the count exceeds the individual new-test tally). **No existing assertion's expected value was changed** — every one of the pre-10.2 126 web tests (and the rest of the suite) passes unmodified.
  - `npm run build` → clean across all 5 workspaces (backend/bot/shared/workers `tsc --noEmit`; web `vite build`, 388.71 kB / 113.49 kB gzip).
  - `npm run test:integration` — **legitimately SKIPPED**: web-only story, no shared/backend touch (8-1 precedent).
  - Playwright e2e (`npm run test:e2e -w @share2brain/web`, against `docker compose up -d postgres redis` + the local dev-mode `redis-server` already running on :6379) → **28/28 passed**, ZERO spec changes (`e2e/server.ts` stays `uiLanguage`-free ⇒ backend serves `es` ⇒ every pre-existing Spanish-literal e2e assertion holds).
  - AC1 grep evidence: `grep -rnP '[áéíóúñ¿¡]' packages/web/src --include='*.tsx' --include='*.ts' | grep -v locales | grep -v '.test.'` → 8 surviving hits, ALL inside code comments (English prose referencing Spanish story-era literals/component names for reader orientation, e.g. `ChatWidget.tsx:7` `"loop de ejecución"`, `icons.tsx:151` `"estás al día"`) — zero user-facing literals remain outside `es.json`.
  - AC7 manual verification (dev servers, `ui.language: "en"` added to the local, uncommitted `Share2Brain.config.yml`, backend restarted): confirmed via a headless-Chromium screenshot pass — login screen fully in English ("Continue with Discord", "Knowledge Agent · Self-Hosted" tagline, "Only guild members can access", brand/version/scope-footer D7 exclusions untouched); logged in as guest (guest access enabled locally) and confirmed the authenticated shell in English — Sidebar (`Search`/`Documents`/`Stats`), Header (`knowledge indexing · pgvector`, `live indexing`, `Guest mode`), Search view (`Knowledge search` + description + `all`/`#general` chips), Documents view (`Indexed documents`, column headers, `Mark all as read`, `Unread · 40`, `showing 0 of 0`), Stats view (`Indexing activity`, `40 resources · last 14 days`, `14 days ago`/`today`, `Resources by channel`, `Reading coverage` — **with the D3 limitation visually confirmed**: the 4 KPI cards' `label`/`sub` stayed Spanish, e.g. "Recursos indexados"/"+40 esta semana", exactly as ratified), and the chat widget empty state (`Ask whatever you want` + 3 English suggestions). Removed the `ui` block and restarted again to confirm the deployment reverts to Spanish (re-ran the login-screen check — Spanish restored, matching pre-story behavior). Local `Share2Brain.config.yml` restored to its original (no `ui` block) content before finishing; nothing committed from this step.
- D3 KPI Spanish-under-`en` limitation appended to `_bmad-output/implementation-artifacts/deferred-work.md` (Task 8.2).
- `docs/frontend-standards.md:124-133` and `docs/context/TECHNICAL-DESIGN.md:362` were verified already accurate against the shipped implementation — not modified (Task 8.1, as instructed).

### File List

**New:**
- `packages/web/src/locales/es.json`
- `packages/web/src/locales/en.json`
- `packages/web/src/locales/parity.test.ts`
- `packages/web/src/i18n.ts`
- `packages/web/src/i18next.d.ts`
- `packages/web/src/test-setup.ts`
- `packages/web/src/api/uiConfig.ts`
- `packages/web/src/api/uiConfig.test.ts`
- `packages/web/src/lib/apiError.ts`
- `packages/web/src/lib/apiError.test.ts`

**Modified:**
- `packages/web/package.json` (+ `i18next`, `react-i18next`)
- `packages/web/tsconfig.json` (+ `resolveJsonModule`)
- `packages/web/vitest.config.ts` (+ `setupFiles`)
- `packages/web/index.html` (`lang="en"` → `lang="es"`)
- `packages/web/src/main.tsx` (pre-render boot: `fetchUiLanguage` + `changeLanguage`)
- `packages/web/src/App.tsx` (extraction + `app.statsLine`/`app.loadingAriaLabel`)
- `packages/web/src/App.test.tsx` (+ 2 `en`-locale smoke tests)
- `packages/web/src/components/LoginScreen.tsx` (extraction)
- `packages/web/src/components/Sidebar.tsx` (extraction, D9 `labelKey` fix)
- `packages/web/src/components/Header.tsx` (extraction)
- `packages/web/src/components/ChatWidget.tsx` (extraction, D9 `SUGGESTIONS` keys, D4 error-code wiring, D6 `relativeTime` call)
- `packages/web/src/components/ChatWidget.test.tsx` (mock fix for `ChatStreamError` re-export, + 1 `en`-locale smoke test)
- `packages/web/src/components/DocsView.tsx` (extraction, D4 date formatting)
- `packages/web/src/components/DocsView.test.tsx` (+ 1 `en`-locale smoke test)
- `packages/web/src/components/SearchView.tsx` (extraction, D4 date formatting)
- `packages/web/src/components/SearchView.test.tsx` (+ 1 `en`-locale smoke test)
- `packages/web/src/components/StatsView.tsx` (extraction, D4 number formatting, D5 plurals)
- `packages/web/src/components/StatsView.test.tsx` (+ 1 `en`-locale smoke test, + 2 D5 singular-plural tests)
- `packages/web/src/lib/relativeTime.ts` (D6: `relativeTimeEs` → `relativeTime(iso, locale, now?)`)
- `packages/web/src/lib/relativeTime.test.ts` (D6 mechanical call-site update + 8 new `en` cases)
- `package-lock.json` (dependency lockfile update)
- `_bmad-output/implementation-artifacts/deferred-work.md` (D3 limitation entry)
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (status tracking)

## Review Findings

_bmad-code-review 2026-07-12 (3 adversarial layers: Blind Hunter, Edge Case Hunter, Acceptance Auditor). Acceptance Auditor: all 7 ACs + D1–D10 SATISFIED, zero violations. The items below are robustness/edge findings from the blind + edge layers._

**Post-patch gate (re-run after the 3 patches):** `npm run lint` → 0 · `npm run test` → 1051 passed / 1 skipped · `npm run build` → clean (5 pkgs) · Playwright e2e → **28/28 passed, ZERO spec changes** (AC6 fully re-confirmed post-patch).

- [x] [Review][Decision→Dismissed] Pre-render network gate can blank-paint up to 3s — **RESOLVED: keep D1 as-is** (Borja, 2026-07-12). `main.tsx` `bootstrap()` awaits `fetchUiLanguage()` before `createRoot().render()`; on a slow/unreachable backend nothing paints until the fetch resolves or the 3s `AbortSignal.timeout` fires. This is the ratified D1 tradeoff (1-GET pre-render delay; same-origin GET is <50ms, the 3s ceiling only bites on a hung backend). No change. (blind+edge)
- [x] [Review][Patch] English single-result renders "1 results" — **RESOLVED: add plural forms** (Borja, 2026-07-12). APPLIED: es `resultsCount_one`/`_other` both `"{{count}} resultados"`, en `resultsCount_one` `"{{count}} result"` / `_other` `"{{count}} results"`. Gate green, `SearchView.test.tsx:93` still byte-identical. `search.resultsCount` uses plain `{{count}}` interpolation with no `_one`/`_other` (D5). Fix: es `resultsCount_one` = `resultsCount_other` = `"{{count}} resultados"` (preserves the byte-identical `'1 resultados'` pinned by `SearchView.test.tsx:93` and keeps parity), en `resultsCount_one` = `"{{count}} result"`, `resultsCount_other` = `"{{count}} results"`. `SearchView.tsx:197` already passes `{ count }`, so no code change there. [packages/web/src/locales/{es,en}.json] (blind+edge)
- [x] [Review][Patch] Empty SSE `frame.message` on an unmapped code renders a blank error bubble [packages/web/src/components/ChatWidget.tsx:951] — APPLIED: `??` → `||`. — the error-frame path passes `frame.message` (schema allows `""`) as the `translateErrorCode` fallback; for an unknown code it returns `""`, and `{message.errorNote ?? t('chat.genericError')}` does not catch empty string (only null/undefined). Fix: `??` → `||` at L951 (or guard the empty fallback). Low severity; latent regression vs. the pre-change "always generic" behavior. (edge)
- [x] [Review][Patch] `void bootstrap()` has no error handling — a rejected `i18n.changeLanguage()` leaves a silent white screen with no `#root` fallback [packages/web/src/main.tsx:17-35] — APPLIED: wrapped the two awaits in `try/catch` that logs and falls through to mount in the default language. — the pre-change synchronous mount always reached the `#root`-not-found fallback; both awaits now precede the mount and `void` swallows any rejection. Fix: wrap in `try/catch` that still mounts (or `.catch()` that logs + mounts). Low/defensive — `changeLanguage` with bundled resources effectively never rejects. (blind)
- [x] [Review][Defer] Parity test compares only the key tree, not interpolation placeholders or plural-form divergence [packages/web/src/locales/parity.test.ts:18-31] — deferred, test-hardening only; all current keys match so no live break, and AC2 only requires key-tree parity. A future edit diverging placeholders (e.g. `{{shown}}` vs `{{shownn}}`) or adding a `_one` to one locale would pass parity yet break at runtime. (edge)

## Change Log

| Date | Change |
|---|---|
| 2026-07-12 | Story 10.2 created (bmad-create-story): react-i18next + static es/en JSON locales in packages/web, pre-render language resolution from GET /api/ui-config (degrade to es), full literal extraction (~80 literals/8 files — corrected from the epic's ~31/9), locale-aware number/date/relative-time formatting, errors.<CODE> client mapping. Ultimate context engine analysis completed — comprehensive developer guide created. |
| 2026-07-12 | Story 10.2 implemented (bmad-dev-story): all 8 tasks complete on branch feat/10-2-web-i18n off 4471cd2. i18next 26 + react-i18next 17 scaffolding (single `translation` namespace, 103 keys, structural parity enforced); pre-render boot language resolution (fetchUiLanguage never throws, degrades to es); ~80 literals extracted across 8 components incl. the D9 module-scope trap (NAV_ITEMS/SUGGESTIONS/STATS_LINE) resolved via render-time key lookup; locale-aware number/date/relative-time formatting (D6 relativeTimeEs → relativeTime(iso, locale)); errors.<CODE> mapping wired into ChatWidget only (D4); D5 plurals in StatsView, SearchView's "1 resultados" byte-identical per D5. Gate green: lint 0 / 1051 unit+web (+32) / build clean (5 pkgs) / 28 e2e (0 spec changes). test:integration skipped (web-only, no shared/backend touch, 8-1 precedent). AC7 manually verified via dev servers + headless-Chromium screenshots (login screen + guest-authenticated shell across all 3 views + chat widget, all in English; D3 KPI-Spanish limitation visually confirmed as expected; Spanish restored after removing the local `ui.language: "en"` override). D3 limitation appended to deferred-work.md. |
