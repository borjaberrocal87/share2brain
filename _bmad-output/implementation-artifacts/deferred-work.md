# Deferred Work

## Deferred from: code review of 5-3-widget-flotante-fab-panel-base, round 2 (2026-07-07)

- `aria-modal="true"` on the chat panel (`packages/web/src/components/ChatWidget.tsx`) doesn't make `AppLayout` behind it `inert`/`aria-hidden` — assistive tech that doesn't fully honor `aria-modal` (e.g. touch/virtual-cursor browsing) can still reach it. The keyboard-Tab escape this was meant to prevent is closed by the round-2 focus-trap fixes; adding `inert` to `AppLayout` is additional hardening that touches a file outside `ChatWidget.tsx`.

## Deferred from: code review of 5-3-widget-flotante-fab-panel-base (2026-07-07)

- `resetAndSeed`'s new deletes/inserts (`packages/backend/src/e2e/seed.ts`) run as separate unguarded `db.execute` calls, no transaction — a mid-sequence failure leaves partial e2e state; self-heals on the next boot since delete-then-insert always re-runs first. Test-infra only, not production code.
- `fetchConversations`'s `if (params.page)` / `if (params.limit)` truthiness checks (`packages/web/src/api/conversations.ts`) silently drop an explicit `page: 0`/`limit: 0` — copied verbatim from the story's own Dev Notes §Conversations API template; currently unreachable since `ChatWidget` never passes these params in 5.3.
- The chat history overlay (`packages/web/src/components/ChatWidget.tsx`) fetches `total` but never surfaces it — no pagination affordance if a user ever has more conversations than the default page size. Out of the 5.3 shell's stated scope.
- `conversations.ts` throws a generic `Error` with just the HTTP status on a non-ok response (discards any error body) and doesn't guard a malformed-JSON parse failure — matches the existing `api/documents.ts` convention verbatim, not a new regression.

## Deferred from: code review of 5-2-gestion-de-conversaciones-e-historial, round 2 (2026-07-07)

- `Array.from`-based title truncation (`deriveTitle`) is Unicode-code-point-safe but not grapheme-cluster-safe — a ZWJ emoji sequence, flag pair, or base+combining-diacritic sequence spanning multiple code points can still be split at the 80-code-point boundary. A fully correct fix needs `Intl.Segmenter({granularity:'grapheme'})`; no AC requires grapheme-perfect truncation.
- The `id ASC`/`id DESC` SQL tiebreakers (`conversationRepository.drizzle.ts`) make ordering deterministic but not necessarily chronologically correct on an exact `created_at` tie — ids are random UUIDv4s unrelated to insertion order. A true fix needs a monotonic secondary column (serial or UUIDv7), a schema change out of scope for a review patch.

## Deferred from: code review of 5-2-gestion-de-conversaciones-e-historial (2026-07-07)

- Concurrent requests on the same conversationId can race `getMessages`↔`appendMessage(user)` (`chatService.ts:666-678`) — low-probability (a user firing two simultaneous turns on the same conversation, e.g. double-tab); D4 only guards single-request ordering, not cross-request concurrency; no AC requires handling it. Matches how similar low-probability races (TOCTOU) were deferred in Epic 4.
- Full, unbounded conversation history fetched on every `/api/chat` turn (`conversationRepository.drizzle.ts` `getMessages` has no `LIMIT`) — pre-existing design per D3/D7 (the `reason` node's `memory_window` cap + `compressIfNeeded` truncate downstream in JS); real cost only materializes for very long conversations.
- `page` cap still allows an expensive ~1e8 `OFFSET`; the "guards against a bigint OFFSET overflow" comment overstates the actual risk (a JS number/int4 offset doesn't overflow, it just forces Postgres to skip a lot of rows) — copied verbatim from the established `documents.ts` convention (Story 4.2), not introduced by 5.2.

## Deferred from: code review of 1-1-inicializar-el-repositorio-y-la-estructura-del-monorepo (2026-07-03)

- Dev scripts (`node --watch src/main.ts`) won't run .ts files without a TS loader — placeholder scaffold, real tooling (tsx/Vite) lands in later stories
- `noEmit: true` conflicts with `outDir: "dist"` — intentional at scaffold stage; real build artifacts come with domain code
- `SIBLING_SERVICES` array duplicated across ESLint config objects — code style, not a bug
- `"build": "tsc --noEmit"` is misleading — intentional at scaffold; documented in story completion notes
- No `vitest.config.ts` in any package — Vitest defaults work for scaffold; workspace config needed before cross-package tests
- `@hivly/shared` exports raw `.ts` source — intentional decision documented in completion notes (avoids `composite: true` conflict)
- `exports` field blocks future subpath entrypoints — add wildcard when sub-exporters land
- New `@hivly/*` package would not be auto-covered by ESLint cross-service ban — manual registration needed
- No `uncaughtException`/`SIGTERM`/`SIGINT` handlers in any service — scaffold stage, error handling framework lands later
- `--if-present` on root typecheck/build scripts could silently skip packages missing those scripts — all 5 packages currently have them
- `.env.example.*` variants not tracked by `.gitignore` negation — edge case, team can add rules if needed
- No root `tsconfig.json` (only `tsconfig.base.json`) — by design; each package extends base directly
- Multiple scaffold-appropriate omissions: no `.d.ts` generation, no type-aware ESLint rules, no structured logging format, no vitest workspace config

## Deferred from: code review of 1-3-docker-compose-servicios-base-y-endpoint-health (2026-07-04)

- DB/Redis connections created before HTTP listens — lazy redis + pool pattern mitigate this; not a real issue in practice
- Missing Hivly.config.yml crashes containers — standard Docker behavior for missing bind mounts; documented in Dev Notes
- No integration test for health handler — unit tests cover logic; HTTP-level tests can be added in a later story
- redis maxRetriesPerRequest: 1 is aggressive — tuning parameter; 503 on transient Redis outage is acceptable
- Timeout test not explicitly covered — promise that never resolves not tested; both paths fall into the same catch of probe()

## Deferred from: code review of 2-2-layout-principal-sidebar-y-pantalla-de-login (2026-07-04)

- Side effects inside setState updater in useTheme — `toggleTheme` performs DOM mutations and localStorage writes inside a `setState` updater (useTheme.ts:22-33). React state updaters should be pure; a `useEffect` keyed on `theme` is the conventional pattern. Not a real issue in current usage (no StrictMode effects in production).
- login() has no internal guard against concurrent calls — `login` unconditionally starts a new `setTimeout` (App.tsx:35-42). LoginScreen button is `disabled={loggingIn}`, but if a future caller invokes `login()` while a timer is pending, a second timer starts and the first is orphaned. A `if (loginTimer.current) return;` guard would prevent this.

## Deferred from: code review of 2-1-sistema-de-diseno-en-packages-web (2026-07-04)

- Respetar `prefers-color-scheme` — el tema oscuro se fuerza sin consultar la preferencia del SO. La lógica de detección y toggle persistente con `localStorage` está planificada para Story 2.2, donde tiene sentido añadirlo.
- `@media (prefers-reduced-motion: reduce)` — las 6 animaciones no tienen variante reduced-motion. Válido para accesibilidad pero aplica a todo el sistema de diseño, no solo a esta story.

## Deferred from: code review of 2-3-backend-discord-oauth2-y-sesiones-en-redis (2026-07-04)

- No 429 retry logic for Discord rate limits — unlikely at current scale; add retry with `Retry-After` header parsing if rate limits become frequent
- Error message leakage in logs — `console.error('[auth] callback failed:', ...)` may log Discord API error details; adopt structured logging with redaction in a future observability story

## Deferred from: code review of 2-4-rbac-proteccion-de-rutas-y-conexion-ui (2026-07-05)

- `access_control.enabled` not checked during materialization — explicitly out of scope per story Dev Notes ("Do not build an allow-all branch or a disable switch")

## Deferred from: code review of 3-0-config-proveedores-llm-y-embeddings (2026-07-06)

- `readEmbeddingDimensions()` duplica lógica de path resolution de `loadConfig()` — si el mecanismo de path cambia en el futuro, divergen silenciosamente. Pre-existente en `loadConfig()`.
- `superRefine` solo se ejecuta en `z.parse()` — si config se carga de una fuente cacheada que esquiva Zod, el invariante `custom`+`base_url` no se enforce. Pre-existente (toda validación Zod es parse-time).
- `EMBEDDING_DIMENSIONS` evaluado en module-load time — si la config es inválida o el file no existe, `schema.ts` crashea al importarse. Pre-existente en schema.ts (era módulo-top-level antes del cambio).
- `embeddingDimensions.ts` bypass del schema Zod deliberadamente — necesario para AD-5 (drizzle-kit generate no puede correr `loadConfig()`). Si las reglas de validación de dimensiones se extienden, este file debe actualizarse en sincronía.
- `discordRoles` typed as non-optional in `SessionData` — pre-existing pattern (mirrors `userId` which is also non-optional)
- Short-circuit in `findAllowedChannelIds([])` not integration-tested against real Postgres — intentional optimization; covered by unit tests in `rbacService.test.ts`

## Deferred from: code review of 3-1-discord-bot-conexion-al-gateway-y-listener-messagecreate (2026-07-06)

- Redis offline queue retiene transacción DB — con `enableOfflineQueue: true` (default de node-redis), un `xAdd` durante una caída de Redis no rechaza inmediatamente, manteniendo abierta la transacción de Postgres y consumiendo una conexión del pool. Comportamiento preexistente de node-redis, no introducido por esta story.

## Deferred from: code review of 3-1-discord-bot-conexion-al-gateway-y-listener-messagecreate (2026-07-06, 2nd pass)

- ~~XADD publica antes del COMMIT de Postgres — el `xAdd` corre dentro del callback de la transacción pero contra el cliente Redis (no transaccional), así que el evento es durable en Redis antes de que aterrice el COMMIT. Para Story 3.3: el Indexer debe leer `content` del propio evento (lo lleva) o tolerar un row-not-found transitorio sin hacer ACK.~~ **RESUELTO en Story 3.3** (2026-07-06): el Indexer parsea `content` del propio evento de stream (nunca re-lee la fila) y, si la fila de `discord_messages` aún no existe al procesar (COMMIT no aterrizado), deja la entrada **pendiente sin XACK** (`partitionByIndexState` → bucket `pending`); Redis la re-entrega y el ACK solo ocurre sobre ids devueltos por el `RETURNING` del stamp de `indexed_at`.
- ~~INSERT sin `onConflict` — una re-entrega de `messageCreate` en un RESUME de Discord dispara un duplicado de PK que aborta la transacción y loguea un `error: failed to persist message` falso (la fila+evento ya existen). `onConflictDoNothing` haría el productor idempotente. Camino poco frecuente.~~ **RESUELTO en Story 3.2** (2026-07-06): `persistMessage` ahora hace `onConflictDoNothing().returning()` y omite el XADD cuando la fila ya existía — productor idempotente en el camino compartido live + backfill.
- Recuperación del Gateway post-arranque delegada a discord.js — `connectWithRetry` corre una sola vez al boot; el reset/escalado de AC-4 solo se ejercita en el login inicial. Si discord.js agota sus propios reintentos tras el arranque, nada escala a `error` ni sale, y el bot queda idle. Coincide con el diseño documentado; revisar como mejora de observabilidad.

## Deferred from: code review of 3-2-discord-bot-backfill-historico-con-reconciliacion-por-snowflake (2026-07-06)

- No timeout on messages.fetch() — Discord API call has no AbortSignal. Pre-existing concern (same in live path); discord.js internal timebounds handle the common case.
- Gap pages have no max-page safety valve — A year-long offline gap runs unboundedly. By design per AC-6 ("the whole gap is covered").
- rateLimited listener without queue depth visibility — Discord.js internal queue depth is not observable via events.
- onConflictDoNothing silences edits from backfill — `onConflictDoNothing` salta inserciones de mensajes que ya existen, incluso si el backfill trae contenido editado. Caso estrecho: solo cuando el mensaje fue recibido live Y editado durante la ventana offline. Tradeoff aceptado (Borja, 2026-07-06): un `ON CONFLICT DO UPDATE` añadiría escrituras innecesarias para el caso común.

## Deferred from: code review of 3-2-discord-bot-backfill-historico-con-reconciliacion-por-snowflake (2026-07-06, 3rd pass)

- SIGTERM/SIGINT handlers registered after the per-channel cursor-resolution loop and Discord client setup in `main.ts` — a signal arriving during that window bypasses the bounded-shutdown logic entirely (Node's default SIGTERM handling has no cleanup). Pre-existing ordering from the original implementation. Fixing it means moving `shutdownSignal`/`shutdown()`'s definition and the `process.on(...)` registration earlier in `main()`, ahead of the cursor loop — a bigger structural reorder than a single review patch.

## Decisions & deferrals from: Story 3.3 (Workers — Indexer, 2026-07-06)

- **Retry-max / DLQ policy — DECIDED (SPINE §Deferred assigned this decision to this story):** the consumer group's PEL *is* the dead-letter queue. No retry-max and no per-entry poison quarantine: a failed entry stays pending (un-ACKed) and is re-processed by the PEL replay on the next worker boot. Malformed/foreign entries (which can never succeed) are the one exception — they are XACKed so they don't clog the PEL. No `MAXLEN`/`XTRIM` on `hivly:discord:messages` yet.
- **Stream trimming (`MAXLEN`/retention) — STILL DEFERRED:** with no `MAXLEN`, `hivly:discord:messages` grows unbounded. Accepted at self-hosted scale; a future retention/trimming story must decide the cap (and confirm it can't trim entries still pending in any group's PEL).
- **A stale extra chunk in one narrow crash window is accepted, not compensated:** if a crash lands between the upsert tx and the XACKs and a *later, differently-composed* batch regroups an unstamped message under a different first-id, a superseded chunk could linger. Only reachable through that window; overwritten/ignored at query time by similarity. Documented in `indexBatch.ts` / the story's Dev Notes — do not build compensation for it.

## Deferred from: code review of story-4.2 (2026-07-06)

- **TOCTOU in `markRead` → FK violation 500 instead of 404** [`packages/backend/src/application/services/readStatusService.ts:47`]: `findVisibleEmbeddingChannel` and the `INSERT INTO user_read_status` run as two separate statements; if the embedding is deleted in between, the FK violation surfaces as an opaque 500 rather than the uniform 404 that D5 intends. Unreachable today — nothing hard-deletes `embeddings` until Epic 6. Same family as the anchor-missing count/list asymmetry; revisit both when Epic 6 hard-delete lands (wrap the check+insert atomically or map FK violations → 404).

- **`total`/unread counts vs list anchor-JOIN asymmetry** [`packages/backend/src/infrastructure/documentRepository.drizzle.ts:72`, `readStatusRepository.drizzle.ts:102`]: `listDocuments` INNER-joins the anchor message (`message_ids[1]`) but `countDocuments`/`unreadCountByChannel`/`markAllInChannels`/`findVisibleEmbeddingChannel` do not, so an in-scope, non-D1-deleted fragment with a missing anchor is counted/marked but never listed. Divergencia solo materializable con hard-delete de embeddings (Epic 6); hoy los anchors siempre existen y el spec prescribe count sin JOINs. Revisar junto al TOCTOU de la misma familia — alinear las 4 consultas con el INNER JOIN del list, o adoptar LEFT-JOIN+degrade a la vez.

## Deferred from: code review of story-4.5 (2026-07-07)

- **`reuseExistingServer: !process.env.CI` + boot-only seeding** [`packages/web/playwright.config.ts:521,527`]: a stale, manually-left-running local `e2e:server` process (e.g. kept open in a separate terminal to watch logs) would answer the health check without re-seeding, so a fresh test run would see already-mutated data (the docs spec's mark-all-read test). Not a problem in the normal fresh-run flow (each `npm run test:e2e` invocation starts and tears down its own server, matching the story's "3 consecutive green runs" claim) — only a footgun for the "reusable harness" goal (AC8, Stories 5.3/5.4). Worth a README caution, not a behavior change.
- **`seed.ts` delete+insert sequence not transactional** [`packages/backend/src/e2e/seed.ts:322-375`]: a mid-sequence failure (e.g. a future migration changing `vector(1536)`) could leave partial `e2e-`-prefixed rows. Self-healing — the next boot's reset-then-seed cleans it up before the next run.
- **`tsconfig.json` drops `rootDir` and merges Node ambient types into the app tsconfig** [`packages/web/tsconfig.json`]: rather than giving the Playwright specs their own tsconfig, `tests/` was folded into the same config that type-checks `src/`. Verified empirically safe (`npm run typecheck -w @hivly/web` passes clean, no DOM/Node type-declaration conflicts) — but still weakens the type-check boundary between Node-context tests and browser-context app code going forward; a dedicated `tests/tsconfig.json` would be cleaner.
- **`E2E_BACKEND_PORT` not validated as numeric** [`packages/backend/src/e2e/server.ts:413`]: a non-numeric override (e.g. `"abc"`) still throws inside `app.listen()`, caught by `main().catch` — fails loudly but without a clear custom message. (The empty-string case was fixed in the 2nd review pass by switching `??` to `||`; general numeric validation remains deferred.) Low-likelihood misconfiguration.
- **`session.ts` assumes the login redirect always has a `Location` header** [`packages/web/tests/helpers/session.ts:768`]: a missing header would throw a generic `new URL(undefined)` TypeError instead of a clear assertion failure. Only reachable via a backend bug elsewhere in the auth flow, not from this harness's own logic.

## Deferred from: code review of story-4.5 (2026-07-07, 2nd pass)

- **`reuseExistingServer: !process.env.CI` footgun also applies to the web `vite preview` server, not just the backend** [`packages/web/playwright.config.ts` webServer[1]]: a stale, manually-left-running `vite preview` process from an older build would be reused as-is, silently skipping `vite build` and testing outdated frontend code. Same class of issue as the already-deferred backend-reuse footgun, just on the other server; same mitigation (README caution, not a behavior change).
- **Mutating-test isolation depends on an unenforced accident** [`packages/web/playwright.config.ts`]: the docs spec's mark-all-read test running after every non-mutating assertion relies on Playwright's default alphabetical file discovery (`docs.spec.ts` < `search.spec.ts`) plus `workers: 1` — nothing pins this ordering explicitly. A new spec added for 5.3/5.4 could silently change file discovery order. Worth documenting as an explicit invariant in `tests/README.md` when the next spec is added, not a code change now.
- **`shutdown()`'s force-exit fallback exits `1` even for a merely-slow-but-otherwise-clean shutdown** [`packages/backend/src/e2e/server.ts`]: conflates "timed out" with "failed." Accepted as-is — Playwright doesn't inspect the webServer process's exit code during teardown, so this only affects log readability.

## Deferred from: code review of story-4.4 (2026-07-07)

- **Offset pagination skips/duplicates rows under `unreadOnly` after optimistic mark-read + "Cargar más"** [`packages/web/src/components/DocsView.tsx:81`]: with the "Sin leer" filter on, marking rows read optimistically shrinks the server-side `unreadOnly` result set, but the next `loadMore` still requests `offset = (page-1)*20` against the now-smaller set — an unread fragment that shifted below the offset is silently skipped (or duplicated in the reverse direction). Inherent to the offset pagination chosen in D1; low frequency (needs mark-read while filtered, then Cargar más). Correct fix is a cursor or a refetch-from-page-1 after read-state mutations under `unreadOnly` — a design change beyond this story's scope.

## Deferred from: Story 5.4 (Chat messages + streaming UI, 2026-07-08)

- **Execution-trace "loop de ejecución" panel (UX-DR20) — DEFERRED (D1):** the epic AC 5.4 and UX-DR20 describe an agent execution-trace panel with `tool_call` (`#F5A623`) and `observation` (`#3BA55D`) steps. The backend does **not** produce these: `SSEFrameSchema` (`packages/shared/src/schemas/sse.ts`) is a 4-variant union (`token`/`citation`/`done`/`error`), the StateGraph (`packages/backend/src/agent/graph.ts`) is `START → retrieve → reason → respond → END` with **no `tool_exec` node** (only a future-extension comment), and the prototype's trace steps are hardcoded `setTimeout` fakes. Building it for real is a future **backend + shared** story: LLM tool-use, tools defined in `Hivly.config.yml`, a conditional `tool_exec` loop in the StateGraph, and widening `SSEFrameSchema` with `tool_call`/`observation` frames (+ the frontend trace panel). Story 5.4 is frontend-only and deliberately did not touch that surface.
