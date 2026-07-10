---
baseline_commit: 70b1179
status: done
story_id: 6.4
epic: 6
---

# Story 6.4: External Notifications, Security Hardening & Graceful Shutdown

Status: done

## Story

As the **system operator**,
I want the system to **send alerts to Telegram/Slack on critical errors, apply HTTP security headers + tiered rate limiting on the backend, and shut down cleanly on `SIGTERM`/`SIGINT`**,
so that I get **observability, security and operational reliability** across the three runtime processes (FR21, FR6/FR7/FR8).

This is the **fourth and final story of Epic 6** (Synchronization, Notifications & Reliability) and the last feature story before the epic retrospective. It is **cross-cutting** — it touches all three long-running services (`bot`, `backend`, `workers`), the shared kernel (`@share2brain/shared`), the config schema, `Share2Brain.config.yml`, `.env.example`, and `docker-compose.yml`. It has three independent concerns, each mapped to one epic AC:

1. **External notifications (AC-1, FR21).** Nothing exists today. A critical (process-fatal) error in any service must fire a Telegram/Slack alert carrying `{ service, error message, timestamp }`.
2. **Security hardening (AC-2).** `helmet` and `express-rate-limit` are **not installed**; the existing `security.rate_limit` config block is **defined but never enforced**. The backend must set HSTS / `X-Content-Type-Options` / `X-Frame-Options` / CSP on every response and apply three rate-limit tiers.
3. **Graceful shutdown (AC-3).** The **bot** and **workers** already ship mature, bounded SIGTERM/SIGINT drains (built in Stories 6.1 and 6.2 respectively). Only the **backend** has a stub (`server.close(); redis.destroy(); process.exit(0)`) — no DB close, no in-flight drain/timeout, no logger, no `uncaughtException`/`unhandledRejection` handlers. This story brings the backend to parity and adds a Compose `stop_grace_period` so the drains actually complete before SIGKILL.

**Baseline commit:** `70b1179` — Story 6.3 merged (bot startup offline reconciliation). Epic 6's ingestion-sync path (live 6.1 → consume 6.2 → offline 6.3) is complete. What is missing is the *operational* layer: alerting, security headers, rate limiting, and a clean backend shutdown.

---

## ⚠️ Reconciliation & design notes — read before implementing

The epic ACs and `TECHNICAL-DESIGN.md` under-specify all three concerns (verified against source at `70b1179`). The notes below reconcile them and record the design decisions **confirmed with Borja at story creation (2026-07-08)**. **Notes #1, #4 and #7 are load-bearing — a wrong call there breaks tests or the crash-alert path.**

1. **Notifier = inline shared adapter, NOT the reserved stream consumer (CONFIRMED with Borja, DECISION 1).** The architecture *reserves* `STREAM_KEYS.KNOWLEDGE_EVENTS = 'share2brain:knowledge:events'` + `CONSUMER_GROUPS.NOTIFIER = 'share2brain:notifier'` for a "deferred" notifier (`packages/shared/src/types/events.ts:66-76`, AD-13), and explicitly leaves the placement (`packages/workers` **o** `packages/backend`) open (`ARCHITECTURE-SPINE.md` Deferred §, `TECHNICAL-DESIGN.md` §17). **We deliberately do NOT use the stream for crash alerts.** A critical error usually means the process is *dying* (`uncaughtException` → `exit(1)`) or that Redis *itself* is the outage — in both cases an `XADD` cannot be relied on to flush before exit, and a stream consumer can't fire if Redis is down. So FR21 crash alerts are sent **inline, directly** via a `Notifier` adapter that lives in **`packages/shared`** (AD-2: shared by all three services, imported by none of each other) and does an HTTP `POST` to the Telegram/Slack API. The reserved stream/group stay unused this story (a future *knowledge-lifecycle* notifier — backfill.completed, "no events in N min" — may still use them; out of scope here).

2. **Config-vs-secrets split is absolute (AD Consistency Conventions; `project-context.md` anti-patterns).** Telegram bot token / chat id and the Slack webhook URL are **secrets → `.env`**. The `Share2Brain.config.yml` `notifications` block holds only *behavior* (`enabled`, `provider`) and references the secrets as `${VAR}` — exactly like `agent.api_key: "${LLM_API_KEY}"` already does. `loadConfig()`'s `interpolateEnv` substitutes them at load; an unset referenced `${VAR}` aborts the process (existing behavior). **Never** put a raw token in the YAML.

3. **Notification payload carries `{ service, message, timestamp }` only — NEVER secrets or message content (AC-1, `project-context.md` "never log/emit full message content").** `service` is `'bot' | 'backend' | 'workers'`; `message` is the error message (`error.message`, never the full stack in the alert body — stack goes to the logger only); `timestamp` is ISO-8601. The notifier must also never echo the bot token / webhook URL in any log line.

4. **Rate limiting MUST be plumbed through `AppOptions`, defaulting OFF in tests (LOAD-BEARING — will break the suite otherwise).** `createApp` is built with `buildTestAppOptions()` in **every** backend integration test AND in the Playwright e2e harness (`e2e/server.ts`). Those suites hammer `/api/auth`, `/api/chat`, `/api/search` far past 10/15min or 20/min. If rate limiting reads `config` directly or is always-on, the auth/chat/e2e suites will start returning `429` and flake. Therefore: add an **optional** `rateLimit?` field to `AppOptions`; `createApp` mounts limiters **only when it is provided**; `buildTestAppOptions` **omits it** (→ no limiting in tests/e2e); `main.ts` always injects it from `config.security.rate_limit`. This mirrors the existing optional-injection precedent (`oauth?`) — but note `queryEmbedder`/`chatModel` *throw* when missing; `rateLimit` must instead **gracefully no-op** when missing.

5. **`config.security.rate_limit` is reshaped to three tiers (CONFIRMED with Borja, DECISION 2) — this is a `@share2brain/shared` schema change (this story legitimately owns it).** Old shape `{ window_ms, max_requests }` → new shape `{ api: {window_ms,max_requests}, auth: {…}, chat: {…} }`, seeded in `Share2Brain.config.yml` with the epic's exact numbers (API 100/15min, auth 10/15min, chat 20/min). The Zod schema (`packages/shared/src/config/index.ts`) and the existing `config/index.test.ts` fixture must both be updated. `security.allowed_origins` is untouched. **Trust-proxy is required for per-IP counting (note #6).**

6. **`app.set('trust proxy', 1)` is mandatory for per-IP rate limiting (real gotcha).** The backend sits behind nginx (AD-7). Without `trust proxy`, `req.ip` is nginx's internal IP for *every* request → the "per-IP" limit becomes a *global* limit. Set `trust proxy` to the single nginx hop (`1`, not `true` — trusting all `X-Forwarded-For` hops is a spoofing risk). `express-rate-limit` v8 validates this and warns loudly if misconfigured. Do NOT enable it in tests/e2e (they connect directly; leave the default).

7. **Backend graceful shutdown must be bounded AND fit inside Compose's grace window (LOAD-BEARING for AC-3).** The bot/workers drains already chain multiple bounded steps that can total ~25s worst case; `docker-compose.yml` sets **no `stop_grace_period`**, so Compose's default **10s** would `SIGKILL` mid-drain — silently defeating the graceful shutdown. Add `stop_grace_period: 30s` to `backend`, `bot`, `workers`. The backend's own active-connection drain uses the AC-mandated **10s** timeout; Redis `quit()` and PG `pool.end()` are each additionally bounded (5s/10s) exactly like the bot/workers pattern. Total backend budget (~10+5+10) < 30s grace. **Do not exceed 30s in aggregate.**

8. **Bot & workers shutdown ALREADY satisfy AC-3 — verify, do not rebuild.** `bot/main.ts:139-188` closes the Gateway (`client.destroy()`, bounded 5s), drains the in-flight backfill/offline-sync (bounded 5s), `redis.quit()` (5s), `db.$client.end()` (10s), all inside a reentrancy-guarded handler. `workers/main.ts:129-166` drains both consumer loops (bounded 7s — a parked `BLOCK 5000` read returns first, satisfying "finish the in-flight message"), quits all Redis clients, ends the pool. This story's *only* change to those two files is **additive notifier wiring** (note #9) — do not touch the drain logic (it passed 6.1/6.2 review; regressions there are expensive).

9. **All three services wire the notifier into their process-fatal handlers (AC-1 "cualquier servicio").** In each `main()`, after `loadConfig()` + logger, construct `const notifier = createNotifier(config.notifications, logger)`. Call `notifier.notify({ service, message, timestamp })` from: (a) `uncaughtException`, (b) `unhandledRejection`, and (c) — best-effort — the errors caught during shutdown. The backend currently has **no** `uncaughtException`/`unhandledRejection` handlers — add them (mirror bot/workers). `notify()` must be **fire-and-forget-safe**: it never throws, is internally bounded (≤5s abortable `fetch`), and swallows transport errors to a `logger.warn`. In the fatal handlers the process still `exit(1)`s promptly — kick off `notify()` but do **not** block the exit indefinitely on it (bound with a short race, or let it run and exit after the bound). The top-level `main().catch` may run **before** config/logger exist (e.g. `loadConfig()` threw) → there, notifier may be unavailable; fall back to the existing `console.error` + `exit(1)` (a missing config means no creds to notify with anyway). Document this asymmetry.

10. **`helmet` applies to EVERY response incl. `/health` (AC-2 "cualquier request"); rate limiting does NOT apply to `/health`.** Mount `helmet()` as the **very first** middleware — before the `/health` route (currently registered before `cors`) — so probes also carry the headers. Do **not** wrap `/health` in a rate limiter (Compose hits it every few seconds; a limiter would flap it to 429 → false "degraded"/restart). Rate limiters mount on `/api*` paths only.

11. **`helmet` CSP/CORP defaults must not break the cross-origin SPA→API credentialed flow (real gotcha).** The SPA (served by nginx/Vite on a *different* origin) calls the API cross-origin **with credentials** (session cookie; `cors({ credentials: true })`). helmet v8 sets `Cross-Origin-Resource-Policy: same-origin` by default, which can block cross-origin reads, and a strict CSP is meaningless on JSON API responses. Configure helmet so it doesn't fight CORS: keep `crossOriginResourcePolicy` compatible with the cross-origin API (e.g. `{ policy: 'cross-origin' }`) and do **not** enable COEP. Keep the AC-required headers (HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a `Content-Security-Policy`). helmet sets HSTS unconditionally (harmless behind nginx's TLS). Verify the existing `auth`/`chat`/`search` integration tests still pass with helmet on.

12. **`express-rate-limit` v8 API + SSE.** Use v8 option names: `windowMs`, `limit` (not the deprecated `max`), `standardHeaders: 'draft-8'` (or `'draft-7'`), `legacyHeaders: false`. The chat limiter guards `/api/chat`, whose response is a **long-lived SSE stream** — a rate limiter only counts the request at *start*, so it is safe; but `server.close()` on shutdown will wait on an open SSE socket → the 10s drain timeout (note #7) is the safety net (consider `server.closeIdleConnections()` on drain start and `server.closeAllConnections()` after the timeout — Node ≥18.2).

13. **Logger: add canonical `@share2brain/shared/logger`, use in backend only (CONFIRMED with Borja, DECISION 3).** The bot & workers loggers are byte-identical dupes (only the `[bot]`/`[workers]` prefix differs). Promote the implementation to `packages/shared/src/logger.ts` exported as `@share2brain/shared/logger` (subpath export, mirror `@share2brain/shared/redis`), parameterizing the service prefix. The **backend** uses it for the new shutdown/notifier paths (`createLogger(config.observability.log_level, 'backend')`). **Leave bot & workers on their local loggers** (mature 6.1/6.2 code — don't churn) and **leave the other ~34 backend `console.*` sites untouched** (out of scope). The remaining duplication is accepted, documented debt.

---

## Acceptance Criteria

### AC-1 — Critical errors fire a Telegram/Slack alert with `{ service, message, timestamp }` (FR21)

**Given** `notifications.enabled === true` and a valid provider is configured
**When** a process-fatal error occurs in **any** service — an `uncaughtException`, an `unhandledRejection`, or a fatal error caught during shutdown (bot, backend, workers)
**Then** the shared `Notifier` sends **one** alert to the configured Telegram chat or Slack webhook containing the **service name** (`'bot' | 'backend' | 'workers'`), the **error message**, and an **ISO-8601 timestamp**
**And** the alert body **never** contains a secret (bot token, webhook URL, DB/Redis URL, API keys) or Discord message content (note #3)
**And** `notify()` **never throws** and is internally bounded (≤5s abortable `fetch`); a transport failure is swallowed to `logger.warn` and does **not** prevent the process from exiting (note #9)
**And** when `notifications.enabled === false` (or the block is absent), `notify()` is a **no-op** (no `fetch`, no throw) and every service boots/behaves exactly as before.

### AC-2 — Backend sets security headers on every response and enforces three rate-limit tiers

**Given** the backend receives **any** HTTP request (including `GET /health`)
**When** it responds
**Then** the response carries `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and a `Content-Security-Policy` header (via `helmet`, mounted first — note #10, #11)
**And** the cross-origin, credentialed SPA→API flow (`cors({ credentials: true })`) still works — helmet's CORP/COEP defaults are configured not to block it (note #11)

**And Given** rate limiting is injected (production `main.ts`)
**When** a client exceeds a tier's limit within its window (keyed per client IP via `trust proxy` — note #6)
**Then** the backend returns `429 Too Many Requests` with `RateLimit-*` standard headers, enforcing: **API** `100 req / 15 min` on `/api/*`, **auth** `10 req / 15 min` on `/api/auth/*`, **chat** `20 msg / min` on `/api/chat`
**And** `/health` is **never** rate-limited (note #10)
**And** when `rateLimit` is **not** injected (tests, e2e harness), **no** limiter is mounted and no request is ever 429'd (note #4).

### AC-3 — All three processes shut down cleanly on `SIGTERM`/`SIGINT`

**Given** any long-running process (bot, backend, workers) receives `SIGTERM` or `SIGINT`
**When** graceful shutdown begins (reentrancy-guarded — a second signal is ignored)
**Then**:
- the **bot** closes the Discord Gateway connection cleanly (`client.destroy()`, bounded) — **already implemented (6.1); verify, don't rebuild** (note #8);
- the **workers** finish the in-flight message before closing (both consumer loops drain at their next boundary, bounded ≥ one `BLOCK` window) — **already implemented (6.2); verify** (note #8);
- the **backend** stops accepting new connections (`server.close()`), waits for active requests to finish with a **10s timeout**, then force-closes — **new work this story** (note #7);
- **all** PostgreSQL pools and Redis clients close cleanly (`db.$client.end()` bounded; `redis.quit()` bounded — the backend currently uses `redis.destroy()`, which does **not** flush; switch to bounded `quit()`);
- each process then `process.exit(0)`
**And** `docker-compose.yml` sets `stop_grace_period: 30s` on `backend`, `bot`, `workers` so the bounded drains complete before Compose escalates to `SIGKILL` (note #7).

### AC-4 — Backend gains `uncaughtException` / `unhandledRejection` hardening (parity with bot/workers)

**Given** the backend process
**When** an uncaught exception or unhandled promise rejection occurs
**Then** it logs the error (message + stack) via the shared logger, fires the notifier (AC-1), and `process.exit(1)` so Compose restarts the container — mirroring `bot/main.ts:128-136` and `workers/main.ts:101-109` (which the backend currently lacks entirely).

### AC-5 — New config is validated in the shared Zod schema; behavior stays in YAML, secrets in `.env`

**Given** `loadConfig()`
**When** it validates `Share2Brain.config.yml`
**Then** the new **top-level `notifications`** block (`{ enabled, provider: 'telegram'|'slack', telegram?: { bot_token, chat_id }, slack?: { webhook_url } }`) and the **reshaped `security.rate_limit`** three-tier block are validated by the Zod schema (`packages/shared/src/config/index.ts`)
**And** `notifications` is **optional** (defaults to disabled) so existing config/fixtures without it remain valid
**And** a `superRefine` enforces: when `notifications.enabled === true`, the selected provider's credentials are present and non-empty (telegram → `bot_token` + `chat_id`; slack → `webhook_url`) — mirroring the existing `agent`/`embeddings` custom-`base_url` refinement
**And** `Share2Brain.config.yml` and `.env.example` are updated with the new keys (behavior in YAML referencing `${TELEGRAM_BOT_TOKEN}`/`${TELEGRAM_CHAT_ID}`/`${SLACK_WEBHOOK_URL}`; the raw secrets documented in `.env.example`).

### AC-6 — Verification gate green

`npm run lint` (0), `npm run test` (all pass; new unit tests for the notifier, the shared logger, the config schema, and the backend shutdown helper), and `npm run build` (all 5 workspaces) are green. `npm run test:integration` is green with infra up (`docker compose up -d postgres redis`) — including a **new** backend integration test proving: (a) helmet headers present on `/health` and an `/api/*` response; (b) a limiter returns `429` past its tier when `rateLimit` is injected; (c) no `429` and full auth/chat flows when it is not (the default path). No pre-existing green test regresses (in particular the auth/chat/search/e2e suites must stay green with helmet on — note #11). Paste the full gate output into the Dev Agent Record.

---

## Tasks / Subtasks

- [x] **Task 1 — Shared logger** (AC-4, note #13) — `packages/shared/src/logger.ts` (+ `logger.test.ts`) + export:
  - [x] Promote the bot/workers logger verbatim, parameterizing the service prefix: `createLogger(level: LogLevel, service: string, sink: LogSink = console): Logger`. Keep the exact `Logger`/`LogLevel`/`LogSink` interfaces and level-gating (`LEVEL_ORDER`), and the emit format `[${service}] ${level} ${msg} <ctx-json>`. Keep the SECURITY header comment (never log secrets/content).
  - [x] Add the subpath export to `packages/shared/package.json` `exports`: `"./logger": { "types": "./src/logger.ts", "default": "./src/logger.ts" }` (subpath-only, NOT in the root barrel — mirror `./redis`).
  - [x] `logger.test.ts` (no current logger test exists): level gating (debug suppressed at `info`), context JSON serialization, prefix, sink injection. Mirror the DI-sink test approach the loggers were built for.
  - [x] Do **not** modify `packages/bot/src/logger.ts` or `packages/workers/src/logger.ts` (Borja's DECISION 3 — leave them; document the remaining dup in Completion Notes).

- [x] **Task 2 — Shared Notifier adapter** (AC-1, note #1, #3, #9) — `packages/shared/src/notifier/index.ts` (+ `notifier.test.ts`) + export:
  - [x] Define the payload type `NotificationPayload = { service: 'bot'|'backend'|'workers'; message: string; timestamp: string }` and the interface `Notifier = { notify(p: NotificationPayload): Promise<void> }`.
  - [x] `createNotifier(config: NotificationsConfig | undefined, logger: Pick<Logger,'warn'|'error'>): Notifier` — a factory (mirror `createRedisClient`: no I/O at construction). When `config` is undefined or `enabled === false`, return a **no-op** notifier (`notify` resolves immediately, no `fetch`).
  - [x] Transport via **native `fetch`** (Node ≥24 — no new dependency for HTTP): Telegram → `POST https://api.telegram.org/bot${bot_token}/sendMessage` body `{ chat_id, text }`; Slack → `POST ${webhook_url}` body `{ text }`. Format `text` as e.g. `🔴 [${service}] ${message} — ${timestamp}` (no secrets, no content — note #3).
  - [x] Bound every send with an abortable timeout (≤5s via `AbortSignal.timeout(5000)` or an `AbortController`+`setTimeout`); on timeout / non-2xx / thrown error → swallow to `logger.warn('notification send failed', { provider, reason })` (reason MUST NOT include the token/URL). **`notify()` never rejects.**
  - [x] Add the subpath export `"./notifier": { … "./src/notifier/index.ts" }` (subpath-only). Accept a *structural* logger (`Pick<Logger,'warn'|'error'>`) so bot/workers' local loggers are assignable without importing the shared logger.
  - [x] `notifier.test.ts` (fake `fetch` via `vi.stubGlobal`/injected): disabled → no fetch, no throw; telegram → correct URL + `{chat_id,text}`; slack → correct URL + `{text}`; non-2xx → swallowed + one `warn`; timeout → swallowed (fake a hanging fetch, assert bounded); **assert no log/body ever contains the token or webhook URL**; assert `text` contains service/message/timestamp but never message content.

- [x] **Task 3 — Config schema: `notifications` + 3-tier `rate_limit`** (AC-5, note #2, #5) — `packages/shared/src/config/index.ts` (+ update `config/index.test.ts`):
  - [x] Add optional top-level `notifications` object: `{ enabled: boolean; provider: z.enum(['telegram','slack']); telegram: z.object({ bot_token: z.string(), chat_id: z.string() }).optional(); slack: z.object({ webhook_url: z.string() }).optional() }`. Make the whole block `.optional()` (default disabled) so existing configs/fixtures stay valid. Export `NotificationsConfig = z.infer<...>` (or `Share2BrainConfig['notifications']`) for Task 2's factory.
  - [x] Reshape `security.rate_limit` from `{ window_ms, max_requests }` to `{ api: Tier; auth: Tier; chat: Tier }` where `Tier = z.object({ window_ms: z.number().int().positive(), max_requests: z.number().int().positive() })`. Leave `security.allowed_origins` unchanged.
  - [x] Extend the `superRefine`: when `notifications?.enabled === true`, require the selected provider's creds non-empty (`telegram` → `bot_token` && `chat_id`; `slack` → `webhook_url`) with a `path`-targeted issue (mirror the existing custom-`base_url` block).
  - [x] Update `config/index.test.ts`: add `notifications` to the valid fixture (or a dedicated test), add the new `rate_limit` tier shape to the fixture, and add negative tests (enabled telegram without `bot_token` → ConfigError; malformed tier → ConfigError). Confirm a config **without** `notifications` still parses (backward-compat).

- [x] **Task 4 — Backend: helmet + tiered rate limiting** (AC-2, note #4, #6, #10, #11) — `packages/backend/src/app.ts` (+ `main.ts`):
  - [x] `npm install helmet@^8 express-rate-limit@^8 -w @share2brain/backend` (peer `express >= 4.11` — Express 5 OK). Add to `packages/backend/package.json` dependencies.
  - [x] In `createApp`: mount `app.use(helmet({ /* CSP configured; crossOriginResourcePolicy: { policy: 'cross-origin' }; no COEP */ }))` as the **first** middleware (before `/health`). Then `app.set('trust proxy', 1)` (note #6).
  - [x] Add optional `rateLimit?: { api: {windowMs,limit}; auth: {windowMs,limit}; chat: {windowMs,limit} }` to `AppOptions`. When present, build three `rateLimit()` limiters (`standardHeaders:'draft-8'`, `legacyHeaders:false`) and mount: `authLimiter` on `/api/auth` (before `createAuthRouter`), `apiLimiter` on `/api` (the general gate area), `chatLimiter` on `/api/chat` (before the chat router). When absent → mount none (note #4). Do NOT rate-limit `/health`.
  - [x] `main.ts`: pass `rateLimit` from `config.security.rate_limit`, mapping `{window_ms,max_requests}` → `{windowMs,limit}` per tier. `buildTestAppOptions` (Task 6) leaves `rateLimit` unset.
  - [x] Verify the auth/chat/search integration suites and the e2e harness still pass with helmet on (note #11) — adjust the helmet CSP/CORP config if any cross-origin assertion breaks.

- [x] **Task 5 — Backend: graceful shutdown + process hardening + notifier** (AC-1, AC-3, AC-4, note #7, #8, #9, #12, #13) — `packages/backend/src/main.ts` + a testable `packages/backend/src/lifecycle.ts` (+ `lifecycle.test.ts`):
  - [x] Extract a testable `gracefulShutdown({ server, redis, db, logger, signal, timeoutMs })` (pure-ish, DI'd fakes) that: `server.close()` raced against a `timeoutMs` (10s) timer (optionally `server.closeIdleConnections()` at start, `server.closeAllConnections()` after timeout — note #12); then bounded `redis.quit()` (5s, `.catch`→undefined — switch off `redis.destroy()`); then bounded `db.$client.end()` (10s); reentrancy-guarded; `finally process.exit(0)` (inject the exit for the test, or assert the sequence up to exit). Mirror `bot/main.ts:144-186` / `workers/main.ts:129-164`.
  - [x] `main.ts`: create `const logger = createLogger(config.observability.log_level, 'backend')` (Task 1) and `const notifier = createNotifier(config.notifications, logger)` (Task 2) right after `loadConfig()`. Replace the `console.*` in the boot/shutdown path with `logger.*`.
  - [x] Register `uncaughtException` + `unhandledRejection` handlers (NEW — mirror bot/workers): `logger.error(...)`, kick off `notifier.notify({ service:'backend', message, timestamp })` (bounded, best-effort), `process.exit(1)`.
  - [x] Replace the stub `shutdown()` with the `gracefulShutdown` call wired to the real `server`/`redis`/`db`; best-effort `notifier.notify` on a caught shutdown error. Keep SIGTERM/SIGINT registration.
  - [x] `lifecycle.test.ts`: server.close awaited; drain resolves before timeout → clean; drain exceeds timeout → force path taken; redis.quit + db.end both called and bounded; reentrancy (second signal ignored); a thrown close error is caught + logged (not rethrown). Fakes for server/redis/db/logger/exit.

- [x] **Task 6 — Bot & workers: additive notifier wiring only** (AC-1, note #8, #9) — `packages/bot/src/main.ts`, `packages/workers/src/main.ts`:
  - [x] In each `main()`, after `createLogger(...)`: `const notifier = createNotifier(config.notifications, logger)` (import `createNotifier` from `@share2brain/shared/notifier` — allowed; it's shared, AD-2).
  - [x] Add `notifier.notify({ service:'bot'|'workers', message, timestamp })` (bounded, best-effort, never blocks exit) inside the **existing** `uncaughtException` / `unhandledRejection` handlers and the caught shutdown error path. **Do NOT touch the drain logic** (note #8).
  - [x] Leave the top-level `main().catch` as-is (console.error + exit(1)) — it may run before config/logger/notifier exist (note #9). Optionally, if a module-scoped notifier ref was set, best-effort notify there too; otherwise keep the console fallback.
  - [x] Update `buildTestAppOptions` (`packages/backend/src/test-helpers.ts`) — no change needed for notifier (services construct it), but ensure `rateLimit` stays **unset** (note #4).

- [x] **Task 7 — Compose grace period** (AC-3, note #7) — `docker-compose.yml`:
  - [x] Add `stop_grace_period: 30s` to `backend`, `bot`, and `workers` service blocks so the bounded drains complete before `SIGKILL`. (Do not add to `migrator`/`postgres`/`redis`/`nginx`.)

- [x] **Task 8 — Config file + env docs** (AC-5, note #2) — `Share2Brain.config.yml`, `.env.example`:
  - [x] `Share2Brain.config.yml`: add the top-level `notifications` block (enabled + provider + `${...}`-referenced creds for the active provider) and reshape `security.rate_limit` into the three tiers with the epic's numbers (API 100/900000ms, auth 10/900000ms, chat 20/60000ms). Comment the config-vs-secrets rule.
  - [x] `.env.example`: document `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `SLACK_WEBHOOK_URL` (whichever provider) as the secret home for the `${...}` references.

- [x] **Task 9 — Backend integration test** (AC-2, AC-6, note #11) — `packages/backend/src/security.integration.test.ts` (or extend an existing suite), real DB+Redis via `openTestClients`/`buildTestAppOptions`:
  - [x] Assert helmet headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy`, `Strict-Transport-Security`) on `GET /health` and on one `/api/*` response.
  - [x] With `rateLimit` **injected** (tiny limits, e.g. `limit: 2`) build a dedicated app and assert the 3rd request to a tier's path returns `429` with `RateLimit-*` headers; assert `/health` is never 429'd even past the API limit.
  - [x] With the default `buildTestAppOptions` (no `rateLimit`) assert repeated `/api/auth`/`/api/chat` hits never 429 (guards note #4 for the rest of the suite + e2e).

- [x] **Task 10 — Verify** (AC-6) — `npm run lint && npm run test && npm run build` green; `npm run test:integration` green with infra up. Paste the full gate output into the Dev Agent Record. Confirm no regression in the auth/chat/search integration suites or the Playwright e2e run with helmet enabled. Explicitly confirm: notifier disabled → all services behave exactly as at baseline (AC-1 no-op path).

---

## Dev Notes

### Architecture & patterns to follow
- **Shared adapters (Notifier, logger) mirror `@share2brain/shared/redis` (`packages/shared/src/infrastructure/redis.ts`).** A factory that constructs but performs NO I/O at construction, attaches internal error handling so a failure degrades rather than crashes, and exports an inferred/explicit type. Subpath-only export (NOT in the root barrel `src/index.ts`) — the barrel intentionally omits side-effect/heavy adapters (see `providers/index.ts:8-11`). AD-2: all three services may import `@share2brain/shared/notifier` and `@share2brain/shared/logger`; none imports another service.
- **Config extension mirrors the existing `superRefine`** (`config/index.ts:105-137`): provider-conditional required fields, `path`-targeted `ctx.addIssue`, readable error via `formatZodError`. `loadConfig()` interpolates `${VAR}` from `.env` (`interpolateEnv`) — an unset referenced var already aborts; so only *reference* secrets in YAML, and only for the provider you enable (keep the other provider's block absent to avoid forcing an unused `${VAR}`).
- **Backend shutdown mirrors the bot/workers template** (`bot/main.ts:144-186`, `workers/main.ts:129-164`): reentrancy flag; `AbortController` not needed for the backend (no consumer loop) but `server.close()` + bounded `redis.quit()` + bounded `db.$client.end()` in a `try/finally` that always `process.exit(0)`. Switch the backend off `redis.destroy()` (no flush) to bounded `quit()`. The 10s active-connection timeout is the AC's explicit number.
- **helmet ordering is load-bearing** (note #10): first middleware, before `/health`. The current order is `/health` → `cors` → `json` → `session`; insert `helmet` + `trust proxy` at the very top, keep the rest.

### The three concerns — what's new vs already-done
- **Notifications: 100% new.** No `telegram`/`slack`/`webhook`/`notify` code exists; Sentry is an unwired config key only. The `share2brain:knowledge:events` stream + `share2brain:notifier` group are *reserved* in `types/events.ts` but deliberately **not** used this story (note #1).
- **Security: 100% new wiring.** `helmet`/`express-rate-limit` absent; `config.security.rate_limit` defined but **never read** anywhere in `packages/backend`. `config.security.allowed_origins` IS used (`main.ts:81` → `cors`).
- **Graceful shutdown: backend-only new work.** Bot (6.1) and workers (6.2) drains are mature and pass review — this story only adds *notifier calls* to their existing handlers (note #8, #9). The backend stub is the real work (note #7).

### Gotchas (each already cost time on this project or is a known trap)
- **Rate limiting off in tests/e2e (note #4)** — the single most likely way to break the suite. `AppOptions.rateLimit` optional, `buildTestAppOptions` omits it, `createApp` mounts none when absent.
- **`trust proxy` (note #6)** — without it per-IP limits become global behind nginx; `express-rate-limit` v8 warns on misconfig.
- **helmet CORP/COEP vs credentialed cross-origin CORS (note #11)** — configure `crossOriginResourcePolicy: { policy:'cross-origin' }`, no COEP; re-run auth/chat/search + e2e.
- **Compose `stop_grace_period` (note #7)** — default 10s < the multi-bounded drains → `SIGKILL`. Set 30s on the three long-running services.
- **Notifier during a crash (note #9)** — `notify()` must be bounded + non-throwing + must not indefinitely delay `exit(1)`. Use native `fetch` + `AbortSignal.timeout`.
- **Two Redis instances on this Mac (memory):** `localhost:6379` (Homebrew) vs the Compose Redis (no published ports). Irrelevant to the notifier (HTTP), but keep in mind when checking backend shutdown against a local Redis.
- **SSE + `server.close()` (note #12):** an open chat stream blocks `server.close()`; the 10s timeout + optional `closeAllConnections()` is the escape.

### Source tree — files to touch
- **NEW** `packages/shared/src/logger.ts` + `logger.test.ts`; export `@share2brain/shared/logger`
- **NEW** `packages/shared/src/notifier/index.ts` + `notifier.test.ts`; export `@share2brain/shared/notifier`
- **UPDATE** `packages/shared/src/config/index.ts` (`notifications` block + 3-tier `security.rate_limit` + `superRefine`) + `config/index.test.ts`
- **UPDATE** `packages/shared/package.json` (two new subpath exports)
- **UPDATE** `packages/backend/src/app.ts` (helmet first + `trust proxy` + optional 3 limiters + `AppOptions.rateLimit`)
- **UPDATE** `packages/backend/src/main.ts` (shared logger + notifier + uncaught/unhandled handlers + real graceful shutdown + inject rateLimit)
- **NEW** `packages/backend/src/lifecycle.ts` (`gracefulShutdown`) + `lifecycle.test.ts`
- **NEW** `packages/backend/src/security.integration.test.ts`
- **UPDATE** `packages/backend/package.json` (add `helmet`, `express-rate-limit`)
- **UPDATE** `packages/backend/src/test-helpers.ts` (keep `rateLimit` unset in `buildTestAppOptions`)
- **UPDATE** `packages/bot/src/main.ts`, `packages/workers/src/main.ts` (additive notifier wiring ONLY — no drain changes)
- **UPDATE** `docker-compose.yml` (`stop_grace_period: 30s` on backend/bot/workers)
- **UPDATE** `Share2Brain.config.yml`, `.env.example`
- **REUSE (no change)** `packages/bot/src/logger.ts`, `packages/workers/src/logger.ts` (Borja DECISION 3), the bot/workers shutdown drains (6.1/6.2), `packages/shared/src/infrastructure/redis.ts` (adapter template), `packages/backend/src/health.ts`
- **NO migration; NO DDL** (AD-5 — this story does none).

### Testing standards
- Vitest, co-located `*.test.ts`, DI fakes, no real network in unit tests. Notifier test fakes `fetch`; logger test injects a `sink`; config test drives `loadConfig` with fixtures; lifecycle test injects fake `server`/`redis`/`db`/`logger`/`exit`.
- **Must-test invariants** (`project-context.md`, adapted): notifier body never contains secrets or message content (assert on the serialized payload/logs); notifier disabled → no I/O; `notify()` never rejects; rate-limit tiers enforce at the boundary and `/health` is exempt; helmet headers present incl. on `/health`; backend drain is bounded and reentrancy-guarded; **no `429` regression** in the auth/chat/search/e2e suites.
- Integration test uses `openTestClients`/`buildTestAppOptions` (`test-helpers.ts`) and, for the 429 case, a dedicated app built with a tiny injected `rateLimit`.

### Project Structure Notes
- Cross-cutting code lives in `packages/shared` (AD-2) — `logger` and `notifier` are used by all three services and imported by none of each other. Services stay adapters over the shared kernel. English only in all code/comments/tests. Only `packages/shared` does DDL (AD-5) — none here. Config is validated centrally in `loadConfig()` (AD-8) — no service parses YAML or reads the new keys ad-hoc.

### Previous-story intelligence
- **Story 6.1** built the bot's mature bounded shutdown (Gateway `client.destroy()` + backfill drain + redis.quit + pool.end, all raced/bounded, reentrancy-guarded) and the `uncaughtException`/`unhandledRejection` → exit(1) hardening. This story only *adds a notifier call* into those handlers (note #8).
- **Story 6.2** built the workers' equivalent drain (both consumer loops settle at their next boundary within one `BLOCK` window before connections close) and its own process hardening. Same additive-only change here.
- **Story 6.3** confirmed the "confirm genuine forks with Borja, adopt sensible defaults for the rest" pattern and the run-unique-id test-isolation discipline (relevant if the security integration test seeds rows).
- **Epic 5 / Story 5.1** built the `/api/chat` SSE endpoint the chat rate limiter guards and whose long-lived stream interacts with `server.close()` (note #12). The multi-system Anthropic-400 fix is unrelated but confirms the chat path is live in integration tests via `fakeChatModel`.
- **Story 4.5** built the Playwright e2e harness (`e2e/server.ts` + `buildTestAppOptions`) that drives real auth/chat/search flows — the reason rate limiting MUST default off (note #4).

### Latest tech (verified 2026-07-08)
- **`helmet@8.2.0`** — sets HSTS/`X-Content-Type-Options`/`X-Frame-Options`/CSP by default; v8 disables COEP by default; `crossOriginResourcePolicy` defaults to `same-origin` (configure `{ policy:'cross-origin' }` for the cross-origin API — note #11). Works with Express 5.
- **`express-rate-limit@8.5.2`** — peer `express >= 4.11` (Express 5 OK). v8 options: `windowMs`, `limit` (`max` deprecated), `standardHeaders: 'draft-8'`, `legacyHeaders: false`; default `keyGenerator` uses `req.ip` (→ needs `trust proxy`, note #6). Validates trust-proxy config and warns on misconfig.
- **Native `fetch`** (Node ≥24, repo `engines.node >= 24`) — no HTTP dependency needed for the notifier; `AbortSignal.timeout(ms)` for the bound.

### References
- [Source: _bmad-output/planning-artifacts/epics.md#Historia 6.4]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-share2brain-2026-06-30/ARCHITECTURE-SPINE.md — AD-1 (per-process lifecycle), AD-2 (shared kernel / no cross-service import), AD-7 (nginx sole exposed entrypoint), AD-8 (central loadConfig), AD-13 (streams + reserved share2brain:notifier group); Consistency Conventions (secrets vs config); Deferred § (notifier placement open)]
- [Source: _bmad-output/planning-artifacts/architecture/architecture-share2brain-2026-06-30/TECHNICAL-DESIGN.md#§8 (streams table incl. share2brain:knowledge:events → share2brain:notifier deferred), §13 (config/env split + example), §17 (Deferred: notifier location, Sentry instrumentation)]
- [Source: packages/backend/src/main.ts:87-98 — the stub shutdown to replace (AC-3)]
- [Source: packages/backend/src/app.ts:82-95 — middleware order; helmet mounts first, trust proxy, limiters (AC-2)]
- [Source: packages/bot/src/main.ts:128-188 — uncaughtException/unhandledRejection + mature bounded drain to reuse/verify + wire notifier (note #8, #9)]
- [Source: packages/workers/src/main.ts:101-166 — same pattern (note #8, #9)]
- [Source: packages/shared/src/config/index.ts:94-137 — observability/security blocks + superRefine to extend (AC-5)]
- [Source: packages/shared/src/infrastructure/redis.ts — factory adapter template for the notifier/logger (note #1, #13)]
- [Source: packages/shared/src/types/events.ts:66-76 — reserved KNOWLEDGE_EVENTS stream + NOTIFIER group (deliberately unused this story — note #1)]
- [Source: packages/bot/src/logger.ts (= packages/workers/src/logger.ts) — logger to promote to shared (note #13)]
- [Source: packages/backend/src/test-helpers.ts:74-93 + e2e/server.ts:57-66 — createApp built via buildTestAppOptions; why rateLimit must default off (note #4)]
- [Source: docker-compose.yml:54-118 — backend/bot/workers blocks; no stop_grace_period (note #7)]
- [Source: Share2Brain.config.yml:85-97 — observability + single-tier security block to extend (AC-5)]
- [Source: _bmad-output/project-context.md — AD-2 shared kernel, secrets-vs-config, never log/emit content, AD-8 central config, AD-13 ACK discipline]

## Project Context Reference

See `_bmad-output/project-context.md` (AD-2 shared kernel + no cross-service imports, secrets-vs-config anti-pattern, never-log/emit-content, AD-8 central `loadConfig`, AD-13 stream/ACK invariants) and `CLAUDE.md` non-negotiables (only shared does DDL, secrets only in `.env` / behavior only in `Share2Brain.config.yml`, services depend on `@share2brain/shared` but never each other). Standards: `docs/base-standards.md`, `docs/backend-standards.md`.

## Decisions (confirmed with Borja, 2026-07-08)

> The three genuine, hard-to-reverse forks were confirmed with Borja at story creation (they extend/override the deferred documented design); the rest are adopted defaults from the established Epic 6 patterns.

1. **[DECIDED — inline shared Notifier, not the reserved stream consumer]** FR21 crash alerts are sent **directly** via an HTTP `POST` from a `Notifier` adapter in `packages/shared`, called from each service's process-fatal handlers — NOT by XADD-ing to `share2brain:knowledge:events` for a deferred consumer. **Rationale:** a crashing process (exit 1) can't be relied on to flush an XADD, and a Redis outage — a prime "critical error" — would make a stream-based notifier silent exactly when it's needed. The reserved stream/group stay unused this story. _Confirmed with Borja — chose inline-shared over stream-consumer (note #1)._
2. **[DECIDED — reshape `security.rate_limit` into three tiers in the shared schema]** `{ api, auth, chat }` each `{ window_ms, max_requests }`, seeded with the epic's numbers, validated in `@share2brain/shared`. **Rationale:** faithful to the AC, operator-tunable, single source of truth (AD-8); this story legitimately owns a shared-schema change (unlike 6.2/6.3). _Confirmed with Borja — chose full 3-tier config over hardcoding auth/chat constants (note #5)._
3. **[DECIDED — add `@share2brain/shared/logger`, use in the backend only]** Promote the duplicated bot/workers logger to a canonical shared export; use it in the backend for the new shutdown/notifier paths. Leave bot & workers on their local loggers and the other ~34 backend `console.*` sites untouched. **Rationale:** bounded diff, zero regression risk on the mature 6.1/6.2 code; the remaining duplication is accepted debt. _Confirmed with Borja — chose backend-only over full consolidation and over a 3rd local copy (note #13)._
4. **[ADOPTED — rate limiting injected via `AppOptions`, off by default in tests/e2e]** `createApp` mounts limiters only when `rateLimit` is provided; `main.ts` injects it, `buildTestAppOptions` omits it. **Rationale:** the auth/chat/search integration suites and the Playwright e2e harness build the app via `buildTestAppOptions` and would 429-flake under real limits (note #4). _Adopted default._
5. **[ADOPTED — helmet first, `/health` header'd but not rate-limited, CORP set cross-origin]** helmet mounts before `/health` (AC-2 "cualquier request"); `/health` is exempt from limiters (frequent Compose probe); helmet's CORP/COEP are configured not to break the credentialed cross-origin SPA→API flow. _Adopted default (note #10, #11)._
6. **[ADOPTED — `stop_grace_period: 30s` on backend/bot/workers]** So the bounded drains complete before Compose's `SIGKILL`. _Adopted default (note #7)._
7. **[ADOPTED — trigger = process-fatal errors; `notify()` bounded, non-throwing, no-op when disabled]** The "umbral configurado" is read as: alert on `uncaughtException`/`unhandledRejection`/fatal-shutdown errors. No count/rate threshold this story; the notifier is bounded (≤5s) and swallows transport errors so it never delays or blocks a crash exit. _Adopted default (note #9)._

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5), via bmad-dev-story.

### Debug Log References

Full verification gate (2026-07-08, infra up via local Homebrew Postgres/Redis + `docker compose`):

```
npm run lint
> eslint .
(0 errors)

npm run test
> vitest run --project unit --project web --passWithNoTests
Test Files  77 passed (77)
     Tests  637 passed (637)

npm run build
> tsc --noEmit (backend, bot, shared, workers) — all clean
> vite build (web) — built in 137ms, no errors

npm run test:integration
> vitest run --project backend-integration --project bot-integration --project workers-integration
Test Files  1 failed | 17 passed (18)
     Tests  2 failed | 104 passed (106)
  FAIL rbac.integration.test.ts — 2 pre-existing failures (see Completion Notes)

npm run test:e2e -w @share2brain/web
Running 13 tests using 1 worker
  13 passed (12.2s)
```

### Completion Notes List

- **Task 1 (shared logger):** Promoted the byte-identical bot/workers logger to `packages/shared/src/logger.ts`, parameterizing the `service` prefix (`createLogger(level, service, sink?)`). `packages/bot/src/logger.ts` / `packages/workers/src/logger.ts` deliberately left untouched (Borja DECISION 3) — the backend is the only consumer of the shared export; the two local copies remain accepted, documented duplication.
- **Task 2 (Notifier):** `packages/shared/src/notifier/index.ts` — factory mirrors `infrastructure/redis.ts` (no I/O at construction), no-op when `config` is undefined/disabled, native `fetch` + `AbortSignal.timeout(5000)`, swallows all transport failures to `logger.warn` without ever throwing/rejecting. 8 unit tests incl. an explicit "never leaks the token/webhook URL into a log line" assertion.
- **Task 3 (config schema):** `security.rate_limit` reshaped `{window_ms,max_requests}` → `{api,auth,chat}` (each a `Tier`); new optional top-level `notifications` block with a `superRefine` requiring the active provider's credentials only when `enabled: true`. Confirmed backward-compatible: a config with no `notifications` block still parses. 22 tests (7 new).
- **Task 4 (helmet + rate limiting):** **Real gotcha found and fixed**: helmet's own `frameguard` default is `X-Frame-Options: SAMEORIGIN`, not `DENY` — AC-2 requires `DENY` explicitly, so `frameguard: { action: 'deny' }` is set. `crossOriginResourcePolicy: { policy: 'cross-origin' }` + `crossOriginEmbedderPolicy: false` keep helmet from fighting the credentialed cross-origin SPA→API flow (verified: all 13 Playwright e2e specs + the auth/chat/search integration suites stay green with helmet mounted). `rateLimit` is optional on `AppOptions`; `buildTestAppOptions` omits it (unchanged — it already didn't set it), so the whole existing integration + e2e suite runs with zero limiters mounted, exactly as before this story.
- **Task 5 (backend shutdown):** New `packages/backend/src/lifecycle.ts` — `createGracefulShutdown` factory holds its own reentrancy flag, races `server.close()` (with `closeIdleConnections()`/`closeAllConnections()`, Node ≥18.2) against a 10s timer, then bounded `redis.quit()` (5s) and `db.$client.end()` (10s), all inside one `try/catch/finally` so any thrown error is logged (never rethrown) and `exit(0)` always fires. Also accepts an **optional** `notifier` for the AC-1c best-effort shutdown-error alert (awaited, since `notify()`'s own 5s internal bound makes that safe — a fire-and-forget call would very likely be killed mid-flight by the immediately-following `process.exit`). `main.ts` now constructs `logger`/`notifier` right after `loadConfig()` and registers `uncaughtException`/`unhandledRejection` (previously **absent** on the backend) that best-effort-notify then `exit(1)` via `.finally()` on the notify promise. 8 lifecycle unit tests (fake timers for the two bounded-timeout paths).
- **Task 6 (bot/workers notifier wiring):** Purely additive — `createNotifier` constructed once per `main()`, called from the pre-existing `uncaughtException`/`unhandledRejection` handlers (bounded via `.finally(() => process.exit(1))`) and from the existing shutdown `catch` block (awaited, best-effort). Zero changes to the 6.1/6.2 drain logic itself, confirmed by an unchanged bot-integration/workers-integration pass count (17/17 across both suites).
- **Task 8 (config docs) — real gotcha found and fixed:** `interpolateEnv` substitutes `${VAR}` placeholders across the **entire raw file** before YAML parsing, including inside `#` comments. An initial draft with a commented example like `#   bot_token: "${TELEGRAM_BOT_TOKEN}"` in the shipped `Share2Brain.config.yml`/`.example` would abort `loadConfig()` on a fresh clone whenever that var is unset — even though the line is a YAML comment and `notifications.enabled` is `false`. Fixed by omitting the `telegram`/`slack` credential blocks entirely while disabled (valid per the `.optional()` schema) and describing the enable-it steps in prose instead of inline `${...}` syntax. Verified by running `loadConfig()` against both the real `Share2Brain.config.yml` and the tracked `Share2Brain.config.yml.example` with only the pre-existing required vars set.
- **Also updated `Share2Brain.config.yml.example`** (the tracked template `git status` doesn't otherwise surface — the real `Share2Brain.config.yml` is gitignored) with the same 3-tier `rate_limit` + `notifications` block, so a fresh `cp Share2Brain.config.yml.example Share2Brain.config.yml` stays valid.
- **Task 9/10 (integration test + gate):** New `security.integration.test.ts` demonstrates the auth-tier and api-tier 429s without needing a real session (the api/auth limiters sit *before* `requireAuth`, so an unauthenticated request still counts and can 429 — verified 401→401→429 for the api tier on `/api/documents`), confirms `/health` is exempt even past an exhausted api-tier budget, and confirms zero 429s anywhere with the default (no-`rateLimit`) `buildTestAppOptions`. Full gate green: lint 0 / 637 unit+web / build clean (5 pkgs) / 104-106 integration / 13 e2e chromium (helmet-on, unchanged pass count). The 2 integration failures are the **same pre-existing, unrelated** `rbac.integration.test.ts` "test-guild role leak" flake documented in the 6.2/6.3 Completion Notes (a stale local-DB `channel_permissions` row, not this story's diff — confirmed via `git diff --stat 70b1179 -- packages/backend/src/rbac.integration.test.ts packages/backend/src/middleware/rbac.ts packages/backend/src/application/services/rbacService.ts` returning empty, and the failure reproduces in isolation on a clean checkout of this branch). Not blocking.
- **Notifier-disabled no-op path (AC-1) confirmed:** `notifications` is absent from both the real and example config today (`enabled: false`), so `createNotifier` returns the shared no-op instance in all three services — zero `fetch` calls, zero behavior change from baseline, exercised end-to-end by the full green gate above running with notifications off throughout.
- **No migration, no DDL** — confirmed; only `packages/shared`'s Zod schema changed (config validation, not persisted data).

### File List

**NEW**
- `packages/shared/src/logger.ts`
- `packages/shared/src/logger.test.ts`
- `packages/shared/src/notifier/index.ts`
- `packages/shared/src/notifier/notifier.test.ts`
- `packages/backend/src/lifecycle.ts`
- `packages/backend/src/lifecycle.test.ts`
- `packages/backend/src/security.integration.test.ts`

**MODIFIED**
- `packages/shared/package.json` (`./logger`, `./notifier` subpath exports)
- `packages/shared/src/config/index.ts` (`notifications` block + 3-tier `security.rate_limit` + `superRefine`)
- `packages/shared/src/config/index.test.ts` (fixture reshape + 7 new tests)
- `packages/backend/src/app.ts` (helmet first + `trust proxy` + optional 3-tier rate limiters + `AppOptions.rateLimit`)
- `packages/backend/src/main.ts` (shared logger + notifier + `uncaughtException`/`unhandledRejection` + real `gracefulShutdown` + `rateLimit` injection)
- `packages/backend/package.json` (`helmet@^8`, `express-rate-limit@^8`)
- `packages/bot/src/main.ts` (additive notifier wiring only)
- `packages/workers/src/main.ts` (additive notifier wiring only)
- `docker-compose.yml` (`stop_grace_period: 30s` on `backend`/`bot`/`workers`)
- `Share2Brain.config.yml` (notifications block + 3-tier rate_limit; gitignored, local operator copy)
- `Share2Brain.config.yml.example` (same reshape, tracked template)
- `.env.example` (documented `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`/`SLACK_WEBHOOK_URL`)
- `package-lock.json` (helmet/express-rate-limit + transitive deps)

## Change Log

- 2026-07-08 — Story 6.4 implemented (bmad-dev-story) → status **review**. All 10 tasks complete. Gate green: lint 0 / 637 unit+web / build clean (5 pkgs) / 104-106 integration (2 pre-existing unrelated `rbac.integration.test.ts` failures, not caused by this diff — see Completion Notes) / 13 e2e chromium with helmet enabled. Two real gotchas found and fixed during implementation: (1) helmet's `frameguard` defaults to `SAMEORIGIN`, not the AC-required `DENY` — set explicitly; (2) `interpolateEnv` substitutes `${VAR}` across the whole raw config file including comments, so the shipped `Share2Brain.config.yml`/`.example` omit the telegram/slack credential blocks entirely while `notifications.enabled: false`, rather than leaving a commented `${TELEGRAM_BOT_TOKEN}`-style example that would abort a fresh boot. Also updated the previously-missed tracked `Share2Brain.config.yml.example` template to match. No migration, no DDL — only `packages/shared`'s Zod schema changed.
- 2026-07-08 — Story 6.4 created (bmad-create-story). Baseline `70b1179`. The final Epic 6 story: cross-cutting operational layer across bot/backend/workers + `@share2brain/shared`. (1) **Notifications (FR21):** new inline `Notifier` adapter in `packages/shared` (HTTP POST to Telegram/Slack, bounded, non-throwing, no-op when disabled), wired into all three services' process-fatal handlers — deliberately NOT the reserved `share2brain:knowledge:events`/`share2brain:notifier` stream consumer (a crashing process / Redis outage can't rely on XADD). (2) **Security:** `helmet` (HSTS/nosniff/DENY/CSP, mounted first incl. `/health`, CORP configured for the cross-origin credentialed SPA) + `express-rate-limit` three tiers (API 100/15m, auth 10/15m, chat 20/1m) injected via `AppOptions` so it defaults OFF in the test/e2e harness; `config.security.rate_limit` reshaped to 3 tiers + `trust proxy 1`. (3) **Graceful shutdown:** backend brought to bot/workers parity (real `server.close()` + 10s active-drain timeout + bounded `redis.quit()`/`db.$client.end()` + reentrancy guard, extracted to a testable `lifecycle.ts`) plus new `uncaughtException`/`unhandledRejection` handlers; `stop_grace_period: 30s` added to the three long-running Compose services; bot & workers drains reused unchanged (only additive notifier calls). New top-level `notifications` config block + `@share2brain/shared/logger` (backend only). No migration, no DDL. Three genuine forks (inline-notifier / 3-tier-config / backend-only-logger) confirmed with Borja. Status → ready-for-dev.

---

## Review Findings

_Code review 2026-07-08 (bmad-code-review). 3 adversarial layers (Blind Hunter + Edge Case Hunter + Acceptance Auditor, Opus 4.8) over the uncommitted 6.4 diff. 2 decision-needed (both resolved → patch), 5 patch total, 3 dismissed. **All 5 patches applied 2026-07-08.** Gate re-run green: lint 0 / 640 unit+web (+3 new: 2 notifier redact/truncate, 1 lifecycle isShuttingDown) / build clean (5 pkgs) / backend-integration 87 pass + security 6/6 (2 pre-existing unrelated rbac failures unchanged; the auth-tier 429 test flaked once under parallel ordering — passes in isolation and on re-run)._

- [x] [Review][Patch] (resolved from Decision, 2026-07-08 — Borja: redact + truncate) Notifier forwards `error.message` unsanitized — AC-1 forbids DB/Redis URLs in the alert body — `packages/shared/src/notifier/index.ts:35` (`formatText`), callers in backend/bot/workers `main.ts` + `lifecycle.ts`. A pg/redis/undici error whose `message` embeds `postgres://user:pass@host` (or a URL with a token) would POST that secret to Telegram/Slack, contradicting AC-1's "never contains ... DB/Redis URL". Fix: add `://user:pass@` → `://***@` redaction + length cap in `formatText` (unifies with the Telegram-4096 patch below).
- [x] [Review][Patch] (resolved from Decision, 2026-07-08 — Borja: apply the guard) Fatal handlers don't check `shuttingDown` — an `uncaughtException`/`unhandledRejection` during an in-flight SIGTERM drain aborts the clean shutdown and fires a spurious crash alert — `packages/backend/src/main.ts:40,46` (+ `lifecycle.ts` guard is closure-local), `packages/bot/src/main.ts`, `packages/workers/src/main.ts`. The reentrancy guard only covers repeat *signals*, not exceptions raised during the ~25-32s drain window. Fix: expose `isShuttingDown()` from the shutdown handler and skip `notify()`+`exit(1)` when a drain is already in flight.
- [x] [Review][Patch] Workers worst-case drain (~32s) exceeds the new `stop_grace_period: 30s` — Compose SIGKILLs mid-`db.end()` exactly in the sync-enabled degraded case [docker-compose.yml workers block]. Drain is sequential: loops 7s + 3× `quitRedisBounded` 5s (redis + syncRedisUpdated + syncRedisDeleted) + `db.end` 10s = 32s > 30s. The added comment even lists the 3 quits but claims "~25s" (arithmetic wrong). Backend/bot both = 25s and fit. Fix: raise workers `stop_grace_period` to `35s` (note #8 forbids touching workers drain logic, so fix the grace window, not the drain) + correct the comment.
- [x] [Review][Patch] Telegram silently drops alerts over 4096 chars — a long `error.message` → HTTP 400 → alert lost (only a local `logger.warn`), precisely when the failure is large/complex [`packages/shared/src/notifier/index.ts:35` `formatText` / `sendTelegram`]. Fix: truncate `text` to a safe bound (e.g. ~3900 chars with an ellipsis) before sending.
- [x] [Review][Patch] (Acceptance Auditor) `trust proxy` enabled in tests/e2e, contradicting note #6 ("Do NOT enable it in tests/e2e") — `packages/backend/src/app.ts:118`. `createApp` set `app.set('trust proxy', 1)` unconditionally; it's inert today (no limiter mounted when `opts.rateLimit` is omitted) but a literal deviation from a CONFIRMED note and a latent spoofing footgun if a future test-built app ever keys off `req.ip`. Fix: gate it on `opts.rateLimit` (the same condition that mounts the limiters).

_Dismissed (3):_
- _Rate-limit "chat tier is dead" (Blind + Edge, Medium) — **false positive**. AC-2 explicitly maps `api` to `/api/*` and `chat` additionally to `/api/chat`; the code implements this exactly. The two blind layers compared windows as flat rates: `api` (100/15m) and `chat` (20/min) are **complementary** — `chat` caps the per-minute burst (a client CAN send 20 in the first minute), `api` caps the 15-min sustained total. Both bind. The Acceptance Auditor (with spec access) correctly did not flag it._
- _`notify()` after `uncaughtException` keeps the process alive ≤5s in a corrupt state (Blind, Low) — spec-sanctioned tradeoff (note #9: "kick off notify() but do not block the exit indefinitely ... bound with a short race"). Impl is bounded by `AbortSignal.timeout(5s)` then `.finally(exit(1))`. Compliant._
- _`fetch`-rejection `reason` could log the webhook URL/token (Blind, Low) — undici error messages ("fetch failed" / "The operation was aborted") do not embed the request URL; the non-2xx path logs only `HTTP ${status}`. Task 2's test asserts no log line contains the token/URL. Not reachable in practice._
