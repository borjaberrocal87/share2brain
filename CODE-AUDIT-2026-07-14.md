# Share2Brain — Comprehensive Code Audit

**Date:** 2026-07-14
**Scope:** Fresh full audit of all 5 workspace packages (`shared`, `backend`, `bot`, `web`, `workers`),
infrastructure (docker-compose dev+prod, nginx, Dockerfiles, GitHub Actions), root configuration, and
dependencies. 281 non-test source files across the packages; every non-test source file was read.
**Method:** 6 parallel deep-analysis passes (one per package + one for infra/deps), each finding traced to
and quoted from the actual code before being reported. Baseline tooling run repo-wide. Knip's dead-code
output was verified per-item — false positives are called out explicitly.

---

## Baseline (verified this run)

| Check | Result |
|---|---|
| ESLint (`eslint .`) | ✅ 0 errors |
| Typecheck (`tsc --noEmit`, all 5 packages) | ✅ clean |
| Unit + web tests (`vitest`) | ✅ 1094 passed, 1 skipped |
| `any` in source | ✅ none (casts are all guard-narrowed) |
| `npm audit --omit=dev` | ⚠️ 24 advisories (1 high, 23 moderate) — all `undici`/OTel-undici transitives |
| Committed secrets (`.env`, `Share2Brain.config.yml`) | ✅ neither tracked, neither ever in git history |

---

## Executive summary

**Overall: well above average, security-conscious, and internally consistent.** The hard architectural
invariants hold in code, not just on paper: RBAC lives **inside** the SQL/vector query with deny-by-default
(AD-12), workers `XACK` only after a committed transaction (AD-13), sessions are Redis-only (AD-10), the
Drizzle schema is the sole DDL source (AD-5), and secrets/behavior are cleanly separated (AD-8). The classic
risk surfaces for this kind of app were all affirmatively probed and found **mitigated**: XSS from rendered
LLM/Discord content (no `dangerouslySetInnerHTML`, scheme-validated links), SQL injection (fully
parameterized), prompt injection (delimited non-system context turn), and — notably — SSRF in the URL
enricher, which survived empirical bypass testing (decimal/hex/octal/IPv6-mapped/NAT64 encodings, redirect
re-validation per hop, and a DNS-rebinding-proof custom `dns.lookup` + pinned-address connect).

**Zero Critical findings.** This audit was run independently of the two prior reports (dated 2026-07-12);
it **independently reproduced their top findings**, confirming those issues remain open two days later. What
remains clusters into four themes:

1. **Process/availability resilience** — an unhandled pg `Pool` error can crash any service (H-1); app
   services have no container healthchecks and nginx starts before the backend is ready (M-5).
2. **Delivery-guarantee asymmetry in the bot** — the live create/edit/delete path is single-attempt
   fire-and-forget while backfill retries; a Redis blip can *permanently* lose a message (H-2) or leave
   deleted content searchable (H-3), and the recovery path itself over-reports success (M-3).
3. **Authorization & spend lifecycle gaps (not bypasses)** — Discord role/guild revocation lags up to the
   7-day session TTL (M-2); the enrichment spend cap is entirely bypassable via message *edits* (H-4).
4. **Supply-chain & config hygiene** — vulnerable `undici` via discord.js (H-5, low real-world
   exploitability here), mutable action pins + prod `:latest` + deploy-not-gated-on-CI, and a TLS private-key
   directory that isn't gitignored (M-4).

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 5 |
| Medium | 8 |
| Low | 9 |
| QuickWin | 8 |

---

## High

### H-1 — pg `Pool` has no `error` listener; an idle-connection drop crashes the service
`packages/shared/src/db/index.ts:40`
`createDatabase` does `new Pool({ connectionString })` and returns `drizzle(pool)` with **no**
`pool.on('error', …)`, and no consumer attaches one. node-postgres emits `'error'` on the Pool when a
network/backend error hits an *idle* client (Postgres restart/failover, network blip). With no listener that
becomes an `uncaughtException`; the backend's handler (`main.ts`) then `process.exit(1)` — so a routine DB
blip takes the whole API down and drops every in-flight SSE chat stream. Affects every service that opens a
pool.
**Fix:** attach `pool.on('error', (e) => logger.error('idle pg client error', e))` inside `createDatabase`.

### H-2 — Bot live *create* has no retry; the derived cursor makes the loss permanent
`packages/bot/src/persistence/persistMessage.ts:104`, `discord/handlers/messageCreate.ts:60`, `backfill/cursor.ts:26`
The live path calls `persistMessage` exactly once; on a Redis/DB blip the `XADD` throws, the transaction
rolls back (no row, no event), and the handler just logs and returns. Because the backfill cursor is
"newest persisted row by `created_at`", if message M fails but a later M+1 persists before the next restart,
the cursor advances past M and the gap-fetch (`after: cursor`) skips M **forever**. Backfill already guards
this exact race with `persistWithRetry` (3 attempts) — the live path does not.
**Fix:** route the live create through the same bounded retry as backfill.

### H-3 — Bot live *delete* is fire-and-forget; a lost delete leaves purged content searchable
`packages/bot/src/discord/handlers/messageDelete.ts:55`
`handleMessageDelete` does a bare `xAdd` with no retry and swallows any throw. There is no durable DB marker
for a delete (publish-only by design), so a transient Redis failure drops the event entirely. Recovery
depends solely on offline-sync at next restart, which only reconciles the newest `backfill.limit` messages
back from `lastSeen` — anything older than that window is never reconciled, so deleted content stays indexed
and searchable indefinitely (a privacy/GDPR concern).
**Fix:** retry the delete `XADD` (bounded), and/or write a durable delete-intent marker the Sync worker drains.

### H-4 — Enrichment spend cap bypassed by message edits
`packages/workers/src/sync/processUpdate.ts:108` (+ `sync/consumer.ts:80`)
`processUpdate` runs the full paid pipeline (`buildResourceRows`: fetch + LLM + embed for every new/changed
link), but the budget guard `checkAndConsumeBudget` is wired **only** into `indexer/indexBatch.ts:247` —
the sync path never receives `redis`/`rateLimit` (verified: zero call sites in the sync path). A member can
edit one message repeatedly, each edit swapping in up to `MAX_URLS_PER_MESSAGE=20` fresh URLs, driving
unbounded LLM/embedding cost — the economic-DoS the cap exists to stop, fully sidestepped.
**Fix:** thread `redis` + resolved `rateLimit` through `runSync` → `processUpdate` and call
`checkAndConsumeBudget(authorId)` before enriching edits that introduce non-reused links.

### H-5 — Vulnerable `undici` via discord.js (low real-world exploitability here)
`package-lock.json` — `discord.js@14.26.4 → @discordjs/rest → undici@6.24.1`
`npm audit` flags the transitive `undici@6.24.1` (range `<=6.26.0`): Set-Cookie/header handling, response-queue
poisoning, WS DoS. **Exploitation requires an attacker-controlled HTTP response/redirect**, but this `undici`
instance is used *only* by discord.js to reach Discord's first-party API over TLS — not arbitrary URLs. The
app's own SSRF-guarded outbound fetching (`workers/.../urlFetcher.ts`) uses a **separate patched
`undici@7.28.0`**, outside the vulnerable range. So this is real supply-chain debt but low practical risk.
`@opentelemetry/instrumentation-undici` (via `@sentry/node`) is also flagged.
**Fix:** add an npm `overrides` forcing `@discordjs/rest`'s undici to `>=6.26.1`/7.x. (npm's suggested
`discord.js@13` downgrade is a *breaking* false fix — do not take it.)

---

## Medium

### M-1 — `embeddings.dimensions` has no upper bound → un-indexable vector, stack won't migrate
`packages/shared/src/config/index.ts:89` (+ `db/schema.ts:82`)
`dimensions: z.number().int().positive()` accepts any width, but the column carries an HNSW
`vector_cosine_ops` index and pgvector caps HNSW/IVFFlat at **2000 dimensions**. An operator choosing a
common large model (`text-embedding-3-large` = 3072) passes config validation, then `drizzle-kit migrate`
fails creating `idx_embeddings_vector` and the stack never comes up.
**Fix:** `.max(2000)` on `dimensions` (mirror in `readEmbeddingDimensions`), or switch to `halfvec` for >2000.

### M-2 — Discord role/guild revocation lags up to the 7-day session TTL
`packages/backend/src/application/services/authService.ts:54-57`, `middleware/rbac.ts:17`
The RBAC middleware recomputes *roles → channels* every request (so config edits apply immediately), but
`req.session.discordRoles` is frozen at login and never refreshed, and guild membership is only checked once
at login. Removing a user from a private channel's Discord role (or kicking them from the guild) leaves them
able to read that channel's indexed content via `/api/search`, `/api/documents`, `/api/chat` for up to 7 days.
**Fix:** periodically re-fetch roles/membership (short re-validation TTL or shorter session TTL), or add an
admin session-revocation path.

### M-3 — Bot offline-sync recovery path is itself fire-and-forget and over-reports success
`packages/bot/src/sync/offlineSync.ts:164-177`
`runOfflineSync` — the safety net for lost live edits/deletes — calls handlers that catch their own `XADD`
failures and return void, yet the loop increments `editsPublished`/`deletesPublished` unconditionally. A
Redis blip during reconcile silently loses the reconciled work while the log claims success, and it won't
re-run until the next restart. Compounds H-3.
**Fix:** have the handlers return a boolean so the orchestrator counts real successes and can retry.

### M-4 — TLS private-key directory `certs/` is not gitignored
`.gitignore` / `certs/` (verified: `git check-ignore certs/privkey.pem` → not ignored)
No `certs/` or `*.pem` entry exists in `.gitignore` or `.dockerignore`, yet `nginx.conf:103` and
`docker-compose.yml:252` instruct operators to place `./certs/privkey.pem` + `fullchain.pem` there. A real
private key sits in a tracked-eligible path and can be `git add`-ed by accident.
**Fix:** add `certs/` (or `*.pem`) to `.gitignore` **and** `.dockerignore`.

### M-5 — No healthcheck on backend/bot/workers; nginx starts before the API is ready
`docker-compose.yml:97-260`
Only postgres/redis define `healthcheck`. `backend` exposes `/health` but has no container healthcheck, and
`nginx.depends_on: [backend]` has no `condition: service_healthy`, so nginx starts as soon as the backend
*container* starts — yielding 502s on early requests.
**Fix:** add a `curl`/`wget` healthcheck to backend (and liveness checks to worker/bot) and gate nginx on
`service_healthy`.

### M-6 — Production deploy is not gated on CI
`.github/workflows/deploy.yml:20-34`
`deploy.yml` triggers on `push: main` independently of `ci.yml` and runs no lint/typecheck/test before
building images and deploying to the VPS. A push that fails CI still ships to production.
**Fix:** gate build/deploy on the CI workflow (`workflow_run`) or run verification inside the deploy job first.

### M-7 — Third-party deploy actions pinned to mutable tags
`.github/workflows/deploy.yml:101-114`
`appleboy/scp-action@v0.1.7`, `appleboy/ssh-action@v1`, and `docker/*-action@v3/v5/v6` are pinned to mutable
tags, not commit SHAs. The two `appleboy` actions receive `HOSTINGER_SSH_KEY` (VPS private key) and
`GITHUB_TOKEN`; a hijacked tag would exfiltrate both.
**Fix:** pin all third-party actions to full commit SHAs.

### M-8 — Prod compose defaults images to `:latest`
`docker-compose.prod.yml:58,72,110,143,176`
Every prod image is `...:${IMAGE_TAG:-latest}`. `deploy.yml` pushes both `latest` and `sha-xxx`, but prod
defaults to mutable `latest`, so `docker compose pull` is non-reproducible and rollback-by-tag is impossible
(the dev compose header even warns "never `:latest`").
**Fix:** have the deploy job set `IMAGE_TAG=sha-${{ github.sha }}` for the prod stack.

---

## Low

- **[Low] `packages/shared/src/logger.ts:74`** — stdout path does raw `JSON.stringify(context)` (no cycle/BigInt
  guard, unlike Sentry's `redactValue`); a circular/BigInt context throws inside `emit`, masking the original
  error. Wrap in try/catch with a safe-stringify fallback.
- **[Low] `packages/shared/src/notifier/index.ts:62`** — Telegram `bot_token` lives in the URL *path*, outside
  `redactSecrets` (which only scrubs `user:pass@`); if a transport error ever echoed the URL, the token leaks.
  Pass the token via header/body or extend redaction.
- **[Low] `packages/shared/src/config/index.ts:76,90,181`** — `base_url` regex `/^https?:\/\//` accepts a
  host-less `"http://"`. Reuse `URL.canParse` + hostname check for consistency with `isHttpUrl`.
- **[Low] `packages/backend/src/app.ts:163`** — `trust proxy` is gated on `opts.rateLimit` presence rather than
  the actual secure-cookie/proxy condition; currently harmless (both come from `config.security` together) but
  an implicit coupling. Tie it to the real condition.
- **[Low] `packages/backend/src/middleware/requireAuth.ts:18` + `authController.ts:116-138`** — the guest
  absolute deadline (`guestExpiresAt`) is enforced in `requireAuth` but not in `GET /api/auth/me`; a guest can
  keep re-hydrating their profile past the deadline by polling `/me`. Cosmetic (no knowledge data leaks). Add
  the same check to `/me`.
- **[Low] `packages/web/src/components/SearchView.tsx:131`** — main search `<input>` has no accessible name
  (relies on `placeholder`). Add `aria-label`.
- **[Low] `packages/web/src/components/DocsView.tsx:426`** — `role="button"` row contains a focusable `<a href>`
  descendant (ARIA prohibits it). Restructure so the row isn't an ancestor button.
- **[Low] `packages/workers/src/enrichment/rateLimiter.ts:87`** — budget is consumed *before* success; an
  always-failing poison URL replays (up to `MAX_DELIVERIES=5`) and re-increments the shared **global daily**
  counter each time, degrading enrichment community-wide. Consume on success, or exclude replays.
- **[Low] `.github` / nginx / Dockerfiles (grouped infra hardening)** — client-supplied `X-Forwarded-Proto`
  trusted on the `:80` server (`nginx.conf:20-23`); single-stage images ship devDependencies (no `--omit=dev`);
  no `cpus`/`no-new-privileges`/`cap_drop` on containers; secrets string-interpolated into the SSH `script:`
  body (`deploy.yml:122`). Each low-impact individually; worth a hardening pass.

---

## QuickWins (< 30 min each)

- **`packages/shared/src/db/schema.ts:172`** — `idx_user_read_status_user` is redundant (the composite PK's
  leading `userId` column already serves `WHERE user_id = …`). Drop it. (Keep the sibling `_embedding` index.)
- **`packages/workers/package.json:14`** — `redis` is a declared dependency with **zero imports** in
  `workers/src` (all Redis access goes through `@share2brain/shared/redis`). Remove it.
- **`packages/backend/.../embeddingSearchRepository.drizzle.ts:51,70`** — cosine distance `<=>` is computed
  twice per row (projection + `ORDER BY`) on the hot search path. Compute once via CTE/lateral.
- **`packages/workers/src/indexer/indexBatch.ts:244`** — `extractUrls` runs twice per message (`hasUrls` probe
  then `buildResourceRows`). Compute once and pass down.
- **`packages/web/src/components/Sidebar.tsx:152`** — status panel hardcodes `indexer: running`, `redis: ok`,
  `pgvector: ok` regardless of real health — misleading to a self-hosted operator. Wire to real status or mark
  as illustrative.
- **`packages/web/src/components/StatsView.tsx:52`** — duplicated, divergent avatar color/initials logic vs
  shared `lib/authorColor.ts` + `lib/initials.ts`; the same author renders differently in Stats vs Search/Docs.
  Consolidate onto the shared helpers.
- **`.github/workflows`** — no `npm audit` / Dependabot / CodeQL step; undici-class issues surface only
  manually. Add a non-blocking `npm audit --audit-level=high` and/or enable Dependabot.
- **Dead-export cleanup (verified real)** — only two Knip hits are genuinely internal-only:
  `workers/.../enrich.ts` `EnrichmentOutputSchema` and `ssrfGuard.ts` `defaultAllowedPorts`. Drop the `export`
  or accept as API. **All other Knip "unused" hits are false positives** (test-only exports or public API):
  `computeDelay`, `assertSingleLeadingSystem`, `deriveTitle`, `estimateTokens`, `GUEST_USER_ID`, `computeHealth`,
  `MAX_BODY_TEXT_LENGTH`, `dlqStreamKey`, `compareStreamIds`, `computeSafeFloor`, etc. Also note Knip's entire
  "Unused files (64)" list is a config artifact — it flags every `.test.ts` because the vitest projects aren't
  registered as Knip entry points; **none are actually dead.** Consider fixing `knip.json` entry patterns.

---

## Verified clean (probed, no findings)

- **RBAC-in-query (AD-12):** every channel-scoped query (search, documents, all 6 stats aggregates,
  read-status, RAG retriever) applies `inArray(sql\`e.channel_id\`, allowedChannelIds)` *inside* the SQL with a
  deny-by-default empty-scope short-circuit; role→channel via parameterized `arrayOverlaps`. No post-filter,
  no leak path. Guest isolation handled via per-session conversation allowlist + zeroed per-user aggregates.
- **SQL injection:** all queries use drizzle `sql` tagged templates with bound params (including the pgvector
  `::vector` literal); no user input is concatenated into SQL.
- **XSS:** no `dangerouslySetInnerHTML` anywhere in web; all LLM/Discord/citation text renders as escaped React
  children; every `href` sink is scheme-validated to http(s) at the Zod layer (`linkRefine.isHttpUrl`) and each
  client `.parse()`s the response; external anchors carry `rel="noopener noreferrer"`.
- **Prompt injection:** retrieved content delivered as a delimited, `JSON.stringify`'d, non-system `<context>`
  user turn; the trusted system prompt is the sole system message, guarded by `assertSingleLeadingSystem`.
- **CSRF & auth/session:** OAuth `state` nonce (128-bit, single-use), `session.regenerate` on both OAuth and
  guest login (anti-fixation), `httpOnly`+`sameSite=lax`+`secure` cookies fail-closed from config,
  `X-Requested-With` second layer on all mutating `/api` requests, existence-hiding 404s. Web stores no
  credentials in localStorage.
- **SSRF (enricher):** empirically bypass-tested — decimal/hex/octal/IPv6-mapped/NAT64 loopback + metadata IPs
  all blocked; scheme/port re-validated per redirect hop; custom `dns.lookup` validates every resolved address
  and undici connects only to those (DNS-rebinding/TOCTOU-proof); body streamed under a hard byte cap.
- **XACK / idempotency (AD-13):** indexer stamps `indexed_at` inside a `FOR UPDATE`-locked committed tx and
  XACKs only returned ids; crash-between-commit-and-XACK replays as an idempotent no-op; sync XACKs only after
  a committed `{ack:true}`.
- **Secrets/behavior separation (AD-8):** `.env` / `Share2Brain.config.yml` neither tracked nor ever in git
  history; examples use only placeholders; deep secret-redaction shared across logger/notifier/Sentry.
- **Web async lifecycle:** SSE aborts on unmount, re-entrancy guarded, stale-response races guarded via
  generation tokens / AbortController identity checks throughout; `useIsMobile` cleans up its listener with SSR
  guards.

---

## Prioritized action plan

1. **Now (availability + data-integrity):** H-1 (pg Pool listener — one line, prevents cascading outages),
   H-2 + H-3 (bot live-path retry / durable delete marker — prevents permanent message loss & un-purgeable
   deletes), M-3 (recovery path success signalling).
2. **This week (authz + spend + config safety):** H-4 (wire spend cap into the edit path), M-2 (role/guild
   revalidation), M-1 (`.max(2000)` on dimensions), M-4 (gitignore `certs/`).
3. **Supply chain / deploy hardening:** H-5 (undici `overrides`), M-5/M-6/M-7/M-8 (healthchecks, gate deploy on
   CI, SHA-pin actions, pin prod image tags), add `npm audit`/Dependabot.
4. **Cleanup:** the QuickWins (redundant index, unused `redis` dep, double `extractUrls`/`<=>`, fake status
   panel, avatar-logic consolidation, dead exports, fix `knip.json`).

**Continuity note:** H-1, H-3, H-4/M-2 (spend-via-edits, role lag), and H-5 correspond to findings already
raised in the 2026-07-12 reports (their H-1, M-4/M-6, M-3, H-3). This independent re-audit reproducing them
confirms they are still open and should be treated as the standing backlog, not new discoveries.
