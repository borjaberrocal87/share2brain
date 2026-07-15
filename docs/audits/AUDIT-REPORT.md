# Share2Brain — Comprehensive Code Audit

**Date:** 2026-07-12
**Scope:** all 5 workspace packages (`backend`, `bot`, `shared`, `web`, `workers`), infrastructure (docker-compose, nginx, Dockerfiles, CI), configuration, and dependencies. 289 source files; every non-test source file was read.
**Method:** 6 parallel deep-analysis passes (one per package + infra/deps), each finding verified against the actual code before being reported. Knip dead-code output was individually verified — false positives are called out explicitly.

---

## Executive summary

**Overall: well above average.** Baseline is fully green (ESLint 0 errors, typecheck clean, 1051/1051 unit tests passing). The headline architectural invariants (AD-2, AD-5, AD-6, AD-10, AD-12, AD-13) were **verified compliant** in code, not just on paper. The top theoretical risks for this kind of app — XSS from rendered LLM/Discord content, SQL injection, SSRF in the URL enricher, secrets leakage, RBAC post-filtering — were all affirmatively probed and found mitigated, several of them with layered defenses (the SSRF guard survived empirical bypass testing including DNS-rebinding, IP-encoding, and IPv6-mapped tricks).

**Zero Critical findings.** What remains clusters into four themes:

1. **Process resilience** — an unhandled pg `Pool` error handler can crash every service; no `restart:` policies in docker-compose means any crash is an outage (H-1, H-2).
2. **One vulnerable transitive dependency** — undici ≤6.26.0 via discord.js (1 high, 3 moderate advisories) (H-3).
3. **Authorization lifecycle gaps, not bypasses** — role revocation lags up to 7 days (the designed `user_roles_cache` refresh is unimplemented); channels removed from config keep their old permission rows; the enrichment spend limiter can be bypassed via message *edits* (M-1..M-3).
4. **Delivery-guarantee asymmetry in the bot** — the live event path (create/edit/delete) is single-attempt fire-and-forget while backfill retries; a Redis blip can lose events, and a lost *delete* means content stays searchable (M-4..M-6).

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 3 |
| Medium | 13 |
| Low | ~26 |
| Quick wins | ~15 |

---

## Baseline

| Check | Result |
|---|---|
| `npm run lint` | 0 errors |
| `npm run typecheck` | clean, all workspaces (tsconfig is maximally strict) |
| `npm run test` (unit + web) | 102 files / 1051 tests passed, 1 skipped |
| `npm audit --omit=dev` | 4 vulnerabilities (1 high, 3 moderate) — all transitive via discord.js → undici |
| `npx knip` | 64 "unused files" (nearly all false positives — test files + spike/), 2 real unlisted/unused deps, ~14 genuinely-actionable exports |

---

## High-priority findings

### H-1 · pg Pool has no `'error'` handler — process crash
`packages/shared/src/db/index.ts:39-42` — `createDatabase()` creates a `Pool` with no `'error'` listener and no service attaches one (verified repo-wide). A Postgres restart or network blip makes an idle pooled client emit `'error'` on an EventEmitter with no listener, which **crashes the whole Node process** — backend, bot, and workers alike. The Redis factory (`infrastructure/redis.ts:21`) guards against exactly this; the pg factory doesn't.
**Fix:** attach `pool.on('error', …)` inside `createDatabase`, mirroring redis.ts. Effort: S.

### H-2 · No `restart:` policy on any long-running service
`docker-compose.yml` (postgres:33, redis:54, backend:97, bot:144, workers:183, nginx:227) — a crash, OOM-kill (mem_limits are set, so OOM-kill is a real path — including via H-1), or host reboot leaves the stack down until an operator intervenes, contradicting the crash-alerting design (FR21) which assumes services come back.
**Fix:** `restart: unless-stopped` on the six long-running services. Effort: S.

### H-3 · Vulnerable transitive undici via discord.js
`packages/bot` — discord.js 14.26.4 pins undici ≤6.26.0 carrying 1 high + 3 moderate advisories (HTTP header injection GHSA-p88m-4jfj-68fv, response-queue poisoning GHSA-35p6-xmwp-9g52, WS DoS, SameSite downgrade). The bot makes authenticated Discord REST/WS calls through this client. `npm audit fix --force` proposes a broken downgrade to discord.js@13 — don't.
**Fix:** root `package.json` `overrides` entry pinning undici within `@discordjs/rest` to a patched line; re-run `npm audit --omit=dev`. Effort: S.

---

## Medium findings

### Authorization / economic-DoS lifecycle

- **M-1 · Enrichment budget bypass via message edits** — `packages/workers/src/sync/processUpdate.ts:59-116`: the M-5 spend limiter is enforced only on the indexer create path (`indexBatch.ts:230-241`); `processUpdate` calls `buildResourceRows` with no budget check (`ProcessUpdateDeps` has no redis/rateLimit at all). A member can bypass per-author hourly and global daily budgets by repeatedly *editing* a message to add fresh URLs — each edit triggers paid fetch + LLM + embed. **Fix:** thread the budget check into `processUpdate`. Effort: M.
- **M-2 · Role revocation lags up to 7 days** — `packages/backend/src/application/services/authService.ts:54-57` + `sessionStore.ts:40-58`: `discordRoles` are captured once at OAuth callback and live in the sliding-TTL Redis session; revoking a Discord role or kicking a member doesn't reduce access until logout/expiry. The designed refresh mechanism is a **dead table**: `user_roles_cache` (`packages/shared/src/db/schema.ts:104`) is written/read by no code anywhere. **Fix:** implement TTL-based role re-fetch, or document the lag as accepted. Effort: M.
- **M-3 · Channels removed from config keep their permission rows** — `packages/backend/src/infrastructure/materializeChannelPermissions.ts:14`: startup materialization is upsert-only; deleting a channel block from `Share2Brain.config.yml` does not revoke access to that channel's already-indexed content. **Fix:** reconcile on startup (delete or empty `allowed_roles` for rows absent from config); needs an AD-12 wording update since it currently says "upsert". Effort: M.

### Bot delivery guarantees (theme: live path weaker than backfill path)

- **M-4 · Live persist is single-attempt** — `packages/bot/src/discord/handlers/messageCreate.ts:60-72`: a transient DB/Redis failure drops the message with only an error log; recovery only happens via gap backfill on the *next restart*. `persistWithRetry` already exists (`backfiller.ts:54-85`) but only backfill uses it. **Fix:** reuse it in the live handler. Effort: S.
- **M-5 · Edit/delete publish is fire-and-forget** — `messageDelete.ts:55-62`, `messageUpdate.ts:126-133`: on a Redis blip the event is logged and dropped. A lost *delete* means the content **stays indexed and searchable indefinitely** — a privacy/retention concern, worse than a lost create. **Fix:** same bounded retry. Effort: S.
- **M-6 · Offline-sync anchor blind spot** — `sync/offlineSync.ts:69,80` + `sync/reconcile.ts:87`: the recent-window fetch is exclusive of `lastSeen` and gap backfill fetches only *after* the cursor, so an offline edit/delete of the **newest persisted message** is never reconciled — potentially forever in a quiet channel. **Fix:** fetch the anchor message itself and include it in the diff set. Effort: S.

### Data / schema

- **M-7 · Missing GIN index on `embeddings.message_ids`** — `packages/shared/src/db/schema.ts:77`: the sync worker's steady-state query is `WHERE :messageId = ANY(message_ids)` (`processUpdate.ts:99,167,172`, `processDelete.ts:54,56`) — every Discord edit/delete does up to 3 sequential scans of the embeddings table, degrading linearly with index size. Also missing from `docs/data-model.md`. **Fix:** add a GIN index on `message_ids`. Effort: S.
- **M-8 · Silent 1536-dim fallback at migration-generation time** — `packages/shared/src/config/embeddingDimensions.ts:33-47`: any read/parse failure (wrong cwd, mis-set `SHARE2BRAIN_CONFIG_PATH`) silently emits DDL for `vector(1536)` on what may be a 1024-dim deployment; surfaces later as permanent indexer failures. **Fix:** fail loud when `SHARE2BRAIN_CONFIG_PATH` is explicitly set but unreadable. Effort: S.

### Web (streaming UX)

- **M-9 · Stream ending without a terminal frame leaves a permanent "streaming" state** — `packages/web/src/api/chat.ts:59-65` + `ChatWidget.tsx:301-345`: a clean close at a frame boundary with no `done`/`error` frame is treated as success; the assistant bubble's cursor blinks forever. **Fix:** throw/mark errored if the loop ends without a terminal frame. Effort: S.
- **M-10 · Auto-scroll yanks the viewport on every SSE token** — `ChatWidget.tsx:194-197`: no "user has scrolled up" check; re-reading earlier content during a long answer is impossible. **Fix:** only scroll when already near the bottom. Effort: S.
- **M-11 · Full message-list re-render per token** — `ChatWidget.tsx:307-311, 732-738, 862-957`: bubbles aren't memoized; a 50-message conversation re-renders everything dozens of times/second while streaming. **Fix:** `React.memo` the bubble components (props are already identity-stable). Effort: S.
- **M-12 · Keyboard/screen-reader gaps on primary flows** — `DocsView.tsx:411-426` (clickable `<div>` with no role/tabIndex/key handler — mark-as-read is mouse-only) and `SearchView.tsx:124-143` (main search input has only a placeholder, no accessible name). Effort: S each.

### Infra / tooling

- **M-13 · No healthchecks on app services + config drift** — docker-compose has no `healthcheck:` on backend/bot/workers/nginx (nginx.conf:22 even documents `/health` "so container healthchecks work"); nginx `depends_on` is start-order only. Separately, the live `Share2Brain.config.yml` has drifted from the example: header still says "Hivly", `enrichment.user_agent` is `HivlyBot/1.0` (line 69), and the `enrichment.rate_limit` block from the example (lines 74-77) is **missing — the live deployment runs with enrichment throttling disabled**, compounding M-1. Effort: S.

---

## Low-priority findings

### Backend
- `authController.ts:116-121` — `GET /api/auth/me` skips the guest absolute-deadline check that `requireAuth` enforces; expired guests get a 200 until sliding TTL lapses. Fix: mount `requireAuth`. (S)
- `authController.ts:44-62` — every anonymous `/api/auth/login` persists a 7-day-TTL Redis session for a 16-byte OAuth nonce; slow spray accumulates keys. Fix: short `cookie.maxAge` pre-auth (guest-TTL trick already exists at :221). (M)
- `documentRepository.drizzle.ts:88-105` — `countDocuments` omits the anchor/permission joins `listDocuments` applies; will diverge when hard-delete (Epic 6) lands. (S)
- `chatService.ts:117` + `conversationRepository.drizzle.ts:132-160` — `getMessages` has no LIMIT; every turn loads the entire conversation history then truncates to 20 in `graph.ts`. Fix: `ORDER BY created_at DESC LIMIT n`. (S)
- `authService.ts:39-41` — `getCurrentUser`/`getGuildMember` awaited sequentially; `Promise.all` saves an RTT per login. (S)
- `statsRepository.drizzle.ts:24-56` — two independent aggregates run sequentially. (S)
- `chatService.ts:105` — guest conversations/messages rows are never listable and never cleaned up; unbounded orphan growth. Fix: periodic sweep. (M)
- `app.ts:245,314` — `POST /api/chat` draws down both `rl:api:` and `rl:chat:` budgets; additive semantics undocumented. (S)
- Controllers + `middleware/rbac.ts:22` — `console.error` throughout despite an injectable structured `Logger`; `errorHandler.ts:24` drops stacks for unexpected 500s. Fix: thread `opts.logger` through. (M)

### Bot
- `messageCreate.ts:52-58` vs `messageUpdate.ts:106-112` — attachment-only message later edited to add text produces an update event for a message with no DB row; indexing depends on the sync worker's unknown-id handling. Document or fall back to `persistMessage`. (M)
- `backfill/pages.ts:103-119` + `offlineSync.ts:67-107` — whole window buffered in memory; config allows `limit: 100000` (`shared/src/config/index.ts:60`) → tens-to-hundreds of MB per channel walk. Lower the schema max or document. (S)
- `offlineSync.ts:61-107` vs `pages.ts:96-124` — two near-identical backwards-pagination loops with divergent "find oldest id" implementations. Extract a shared `paginateBackward`. (M)

### Shared
- `logger.ts:43` — `JSON.stringify(context)` throws on circular refs/BigInt and serializes `Error` to `{}`. Wrap + special-case Error. (S)
- `infrastructure/redis.ts:14-24` — infinite reconnect with unbounded offline command queue; long outage under load grows memory without limit. Set `commandsQueueMaxLength` or `disableOfflineQueue`. (S)
- `logger.ts` + `config/index.ts:79,93,179` — loaded config carries plaintext secrets; no redaction layer — one careless `logger.info('config', config)` dumps credentials. Add `redactSecrets` defense-in-depth. (M)
- Three near-identical loggers (`shared`, `bot`, `workers` — bot's hardcodes `[bot]`). Consolidate on `@share2brain/shared/logger`. (M)
- `db/index.ts:40` — Pool uses all defaults (max 10, no connect/statement timeouts); hung Postgres stalls callers instead of failing health fast. (S)

### Workers
- `ssrfGuard.ts:59-66` — IPv6 site-local `fec0::/10` missing from block list (verified empirically; every other classic bypass tested was blocked). Add `['fec0::', 10]`. (S)
- `urlFetcher.ts:106` — per-redirect-hop timeout ⇒ total wall time `timeout_ms × (max_redirects+1)` × 20 URLs/message for a hostile chain. One overall deadline signal. (S)
- `urlFetcher.ts:120` — `SsrfBlockedError` detected only one `cause` level deep; deeper nesting degrades to `network_error`, which `resourceRows.ts:103-118` does *not* skip — the internal link would be *published* into the curated index (never fetched, so fail-safe, but a classification hole). Walk the cause chain. (S)
- `indexer/consumer.ts:21`, `sync/consumer.ts:28` — consumer name hardcoded `'consumer-1'`; >1 replica shares PEL identity → duplicate paid LLM/embed spend (converges via idempotent UPSERT). Derive from hostname/PID or document single-replica as a hard constraint. (S)
- `indexBatch.ts:235-241` — budget-denied messages are stamped `indexed_at` with zero rows; their URLs are permanently dropped, never retried when the budget window resets. (M)
- `processUpdate.ts:165-172` — wipe-and-reinsert on edit deletes `user_read_status` for *kept* links too; a typo-fix edit erases users' read markers. (M)
- `rateLimiter.ts:52-104` — fixed epoch windows (docs say "rolling"; up to 2× burst at boundary); budget consumed before success (poison message burns up to MAX_DELIVERIES units); `INCR`+`EXPIRE` non-atomic. Document or consume-after-success. (S)
- `resourceRows.ts:82-120` — fetch+enrich strictly sequential per URL (up to 20/message); bounded concurrency (3-4) would drain backlogs faster. (M)

### Web
- `ChatWidget.tsx:218-249,346-348` — abort + failed conversation load leaves the old bubble's `streaming` flag set forever. (S)
- `api/chat.ts:71` — SSE frames split only on `\n\n`; `\r\n\r\n` (spec-legal, proxy-normalized) never matches → stream errors at close. Split on `/\r?\n\r?\n/`. (S)
- App-wide — no 401/session-expiry handling after mount; expired Redis session ⇒ generic errors everywhere until manual reload. Detect 401 centrally and flip to `anon`. (M)
- `Sidebar.tsx:124-188` — hardcoded untranslated status panel renders permanently-green *fake* health data ("indexer running / ok / ok" even when down). Wire to a real endpoint or mark decorative. (M)
- `DocsView.tsx:158-163,339` — optimistic mark-read with `unreadOnly` desyncs the "showing X of Y" counter until refetch. (S)
- `main.tsx:17-26` — first paint blocked up to 3 s on `fetchUiLanguage()`; render in default language and switch live. (M)

### Infra / CI / tooling
- nginx: no `client_max_body_size` (implicit 1m), no nginx-level `limit_req` (floods reach Node), CSP allows `style-src 'unsafe-inline'`. (S)
- `docker-compose.yml:232-234` — port 443 published but the TLS server block is commented out; live config has `cookie_secure: false` and `guest_access.enabled: true` — fine for local dev, **must** flip for any production deploy. (M)
- Dockerfiles — base images tag-pinned only (digest trade-off is documented in compose header); `npm ci` runs without `--ignore-scripts` as root at build time. (M)
- `.github/workflows/ci.yml:20,22` — actions pinned by major tag not SHA; CI never runs `npm audit`, so H-3-class issues ship silently. (S)
- `eslint.config.js:83` — only `tseslint.configs.recommended`, not `recommendedTypeChecked`; `no-floating-promises` etc. are off in an async-heavy Redis-streams codebase. Upgrade. (M)
- `drizzle.config.ts:12` — `process.env.DATABASE_URL!` gives a confusing deep error when unset; throw explicitly. (S)

---

## Quick wins (< 30 min each)

1. `pool.on('error', …)` in `createDatabase` (**H-1** — the single highest-value line of code in this report).
2. `restart: unless-stopped` × 6 in docker-compose (**H-2**).
3. Root `overrides` for undici under discord.js (**H-3**).
4. Add `"zod": "^4.4.0"` to `packages/workers/package.json` — imported at `enrich.ts:21` but undeclared; works only via hoisting, breaks under pnpm/stricter installers. **Confirmed real.**
5. Remove unused `redis` dep from `packages/bot` and `packages/workers` package.json — **confirmed**: zero direct imports; client comes from `@share2brain/shared/redis` and shared declares it.
6. Add `@types/express-serve-static-core` to backend devDependencies (currently resolves via hoisted transitive only).
7. Add `['fec0::', 10]` to the SSRF block list.
8. `z.uuid()` for the SSE `done` frame's `conversationId` (`shared/src/schemas/sse.ts:12`) — the one field looser than the rest of the contract.
9. Batch XACK: node-redis `xAck` takes an id array; drop the per-id loop (`workers/src/indexer/consumer.ts:75,93,113`).
10. `extractUrls` runs twice per URL-bearing message (`indexBatch.ts:228`); extract once.
11. Drop dead exports: `GUEST_USER_ID`/`GUEST_DISCORD_ID` (guestAccess.ts), `RateLimitTierOptions`, `AuthSession`, `MarkReadResult`/`MarkAllResult`, `isValidEmbeddingLength` (shared/providers), `defaultAllowedPorts` (ssrfGuard.ts:144), `DEFAULT_MIN_IDLE_MS` (poisonReaper.ts:32), `PACKAGE_NAME`/`SHARED_KERNEL_VERSION` (shared/index.ts), dead `?? new Date()` fallback (bot messageUpdate.ts:122).
12. Hoist the duplicated `INTER_PAGE_DELAY_MS` constant (bot backfiller.ts:36 / offlineSync.ts:27) — the comment says they share one budget; the code doesn't enforce it.
13. Extract the duplicated `ChannelChip` (SearchView vs DocsView) and consolidate the 3 initials functions / 2 color hashes in web.
14. Add the missing `maxLength`/`maximum` bounds to `docs/api-spec.yml` (search `q`≤1000, `limit`≤50, chat `message`≤4000) — the Zod contract already enforces them.
15. Dependency bumps: `rate-limit-redis` 4→5, `helmet` 8.2→8.3, `undici` 7.28→8.x (workers' direct dep).

---

## Knip verification summary

| Knip claim | Verdict |
|---|---|
| 60 "unused files" (all `*.test.ts` + spike/ + drizzle.config.ts) | **False positives** — add a `knip.json` with vitest test patterns, spike/, and drizzle entry (knip itself suggests the workspace config) |
| `drizzle-kit` unused in packages/shared | **False positive — do NOT remove**: invoked as `npx drizzle-kit migrate` by the migrator container (Dockerfile.migrator:29); removal breaks production migrations (AD-9) |
| `redis` unused in bot + workers | **Confirmed removable** (client comes from shared) |
| `zod` unlisted in workers | **Confirmed real** — add it |
| ~20 "unused exports" | Majority are **deliberate test seams on live code** (compress.ts, health.ts, reconnect.ts, ssrfGuard.ts, poisonReaper.ts, streamTrimmer.ts, lifecycle.ts…) — keep, and register in knip `ignoreExports`/`@public` tags; the genuinely dead ones are listed in Quick win #11 |

---

## Verified clean (probed, not assumed)

- **XSS:** zero `dangerouslySetInnerHTML`; all AI/Discord content rendered as React text nodes; all server-supplied hrefs schema-validated http(s)-only (`linkRefine.ts`), so a prompt-injected `javascript:` citation dies at parse time.
- **SQL injection:** every raw query uses parameterized drizzle `sql` templates, repo-wide.
- **SSRF guard:** DNS pinning via custom `connect.lookup` defeats rebinding/TOCTOU; per-redirect-hop re-validation; empirically survived decimal/octal/hex IPs, `127.1`, `0.0.0.0`, `::ffff:127.0.0.1`, `169.254.169.254`, NAT64. (One gap: `fec0::/10`, Quick win #7.)
- **Secrets:** committed configs use only `${VAR}` placeholders; `.gitignore`/`.dockerignore` cover `.env*`; git history clean (`--diff-filter=A` shows only `.env.example`); repo-wide secrets grep returned zero hits.
- **AD invariants:** AD-2 (no cross-service imports), AD-5 (DDL only in shared), AD-6 (Zod contracts — every web API client parses responses through shared schemas; no casting of network data), AD-10 (Redis-only sessions), AD-12 (RBAC inside every vector/aggregate query, deny-by-default on empty scope, no post-filter anywhere), AD-13 (XACK strictly after committed success on every traced path, RETURNING-gated, `FOR UPDATE` race closure) — all verified compliant.
- **Contract validation in the SPA** is airtight — every byte off the wire, including each SSE frame, passes a shared Zod schema before touching React state.
- **Prompt-injection defense** is layered: JSON-encoded fragments in delimited blocks demoted to non-system role + `assertSingleLeadingSystem` (backend), and random-UUID sentinels with output caps (workers enrichment).

---

## Prioritized action plan

| # | Action | Findings | Effort |
|---|---|---|---|
| 1 | Resilience trio: pg pool error handler, compose restart policies, undici override | H-1, H-2, H-3 | ~1h |
| 2 | Close the authz lifecycle gaps: budget check on edit path, channel-permission reconciliation, role re-fetch (or documented acceptance) | M-1, M-2, M-3 | 1-2 days |
| 3 | Bot live-path retries (create + edit/delete) and offline-sync anchor fix | M-4, M-5, M-6 | ~½ day |
| 4 | GIN index on `message_ids` + fail-loud embedding-dimensions read | M-7, M-8 | ~1h |
| 5 | Web streaming polish: terminal-frame detection, scroll guard, bubble memoization, a11y pair | M-9..M-12 | ~½ day |
| 6 | Compose healthchecks + resync live config from example (restores enrichment rate limit) | M-13 | ~1h |
| 7 | Quick-wins batch (list above) + `knip.json` so dead-code checks stay signal | QW 1-15 | ~½ day |
| 8 | Lows as ongoing hygiene; consider `recommendedTypeChecked` ESLint upgrade as its own PR | — | ongoing |

---

## Package assessments

- **backend** — hexagonal layering enforced honestly; all AD invariants hold; SSE lifecycle and guest access clearly survived prior adversarial passes. Remaining items are lifecycle/operational, not exploitable.
- **bot** — textbook at-least-once producer (transactional INSERT+XADD), unusually careful snowflake handling; the gap is the live path's weaker delivery guarantees vs backfill.
- **shared** — invariant-driven kernel; config loader genuinely hardened (env interpolation over parsed leaves, fail-closed cookie security, cross-field refinements). H-1 is the one pre-production must-fix.
- **web** — top RAG-frontend risks (XSS, contract casting, token leakage) affirmatively mitigated; exemplary race-condition hygiene; issues are second-order streaming/a11y polish.
- **workers** — SSRF guard and XACK discipline both survive adversarial review; M-1 (edit-path budget bypass) is the one real gap.
- **infra** — unusually well-hardened compose (two-tier networks, loopback-only data stores, least-privilege env, non-root images) with correct SSE proxying; gaps are operational (restart/healthchecks) plus the undici advisory.
