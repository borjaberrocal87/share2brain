# Code Audit — Share2Brain

**Date:** 2026-07-12
**Scope:** Full monorepo — 5 packages (`backend`, `bot`, `shared`, `web`, `workers`), ~17.7k LOC source, 116 test files.
**Method:** Direct audit of the security-critical backend spine + SSRF path, plus parallel breadth review of `workers`, `bot`+`shared`, and `web`. Every reported finding was traced to code; the top race and the SSRF bypass were verified empirically.

---

## Executive summary

This is an exceptionally well-engineered, security-conscious codebase. The baseline is clean and the hard architectural invariants hold.

| Check | Result |
|---|---|
| ESLint | ✅ clean |
| `tsc` typecheck (all packages) | ✅ clean |
| Unit tests | ✅ 1051 passed, 1 skipped (pre-audit) |
| `any` types in source | ✅ zero (grep hits are all in comments) |
| `eslint-disable` / `@ts-ignore` / TODO/FIXME in source | ✅ zero |
| RBAC-in-query (AD-12) | ✅ parameterized `inArray`, deny-by-default everywhere |
| SSRF guard | ✅ two-layer, DNS-rebind-proof, redirect-revalidated (verified, incl. IPv4-mapped IPv6) |
| AD-13 idempotency (XACK-after-success) | ✅ holds across indexer/sync/reaper |
| OAuth CSRF `state`, session anti-fixation, IDOR | ✅ all closed |
| Prompt injection | ✅ untrusted data delimited, JSON-encoded, non-system turn |
| Secret/ops hygiene | ✅ `.env` untracked, DB/Redis ports loopback-bound, nginx CSP + hardened headers |

**No Critical or confirmed High code defects.** Findings are one dependency CVE and a handful of correctness/resilience edge cases.

---

## Findings

### 🔴 High

**H1 — Transitive `undici` vulnerability via `discord.js`** · *dependency* · _not fixed in this PR (tracked)_
`npm audit` reports a High advisory (GHSA-p88m-4jfj-68fv, HTTP header injection) plus moderate undici DoS/response-poisoning advisories, pulled in by `discord.js@14.26.4` → `@discordjs/rest`'s bundled older `undici`. The workers' direct `undici@7.28.0` is clean. Real exposure is low — the bot only calls `discord.com` (trusted host, TLS). **Do NOT run `npm audit fix --force`** (it downgrades to `discord.js@13`). Track a `discord.js` release that bumps its bundled `undici`, or test an npm `overrides` pin.

### 🟠 Medium

**M1 — Create-vs-update index race clobbers edited content** · *correctness / data integrity* · `packages/workers/src/indexer/indexBatch.ts` · **✅ FIXED**
`persistMessage`'s `FOR UPDATE` liveness re-check guarded only `deleted_at IS NULL`, while the `indexed_at` dedup read happened outside the transaction (`partitionByIndexState`). During a create event's slow fetch→enrich→embed window, a concurrent Sync `updated` event could index newer content and stamp `indexed_at`; the create's UPSERT-by-`chunk_key` then resurrected/overwrote it with stale content that never self-healed.
**Fix:** read `indexed_at` in the same `FOR UPDATE` statement; a non-null value means an edit already won → abort as a no-op ACK, mirroring the delete-won-the-race branch. Unit test added.

**M2 — DB/Redis credentials can leak into crash logs** · *security* · `packages/{bot,workers,shared}/src/logger.ts`, `packages/shared/src/notifier/index.ts` · **✅ FIXED**
The crash-notifier redacted `scheme://user:pass@host` before alerting, but the always-run `logger.error('uncaughtException', { reason, stack })` paths logged raw — a pg/redis driver error embedding the connection URL would write the password to stdout.
**Fix:** promoted the redaction to a shared `redactSecrets(text)` in `@share2brain/shared/logger`; every logger's `emit` now runs both the message and the context JSON through it, and the notifier reuses it (one implementation). Tests added.

**M4 — No per-call timeout on LLM/embedder calls** · *resilience* · `packages/shared/src/providers/index.ts`, `packages/workers/src/enrichment/resourceRows.ts`, `packages/shared/src/config/index.ts` · **✅ FIXED**
`fetchUrl` bounded each hop, but the enrichment LLM and `embedDocuments` calls were bounded only by the shutdown signal — a provider that opens a connection and stalls could block the strictly-sequential Indexer forever with no error (so no DLQ/reaper path).
**Fix:** added optional `timeout_ms` (default 60s, capped) to `enrichment.llm` and `embeddings` config; the embeddings client now carries the request timeout, and `buildResourceRows` wraps each enrich call in `AbortSignal.any([signal, AbortSignal.timeout(...)])` so a hung provider becomes a normal enrichment failure (entry stays pending → eventually dead-lettered). Tests added.

**M3 — Unbounded memory on first-run backfill / large offline gap** · *resilience* · `packages/bot/src/backfill/pages.ts`, `packages/bot/src/sync/offlineSync.ts` · _not fixed in this PR (tracked)_
`latestPages`/`fetchRecentWindow` accumulate the entire window (up to `backfill.limit`, capped 100,000) before yielding — an intentional abort-safety trade-off that risks OOM on first-run backfill. Fix: stream in bounded chunks or lower the `limit` ceiling.

### 🟡 Low / Quick wins

| ID | File | Issue | Status |
|---|---|---|---|
| L1 | `bot/persistence/persistMessage.ts` | `created` producer payload not typed `Record<keyof MessageCreatedEvent, string>` like the other 3 producers | ✅ FIXED |
| L4 | `shared/providers/index.ts` | Dead export `isValidEmbeddingLength` (no consumers) | ✅ REMOVED |
| L9 | `web/components/DocsView.tsx` | Clickable doc row (`<div onClick>`) not keyboard/SR-accessible | ✅ FIXED (role/tabIndex/onKeyDown + aria-label, i18n keys added) |
| L2 | `bot/sync/reconcile.ts`→`messageUpdate.ts` | Offline-sync content-diff edits dropped when `editedAt === null` | tracked |
| L3 | `shared/config/index.ts` | "Secrets only in `.env`" convention not code-enforced | tracked |
| L5 | `shared/config/index.ts` | A few numeric config fields lack `.max()` bounds | tracked |
| L6 | `workers/enrichment/urlFetcher.ts` | Per-URL latency = `max_redirects × timeout_ms` (no single wall-clock budget) | tracked |
| L7 | `workers/enrichment/rateLimiter.ts` | `INCR` + separate `EXPIRE` not atomic → orphaned TTL-less counter keys | tracked |
| L8 | `workers/streams/poisonReaper.ts` | DLQ `xAdd`+`xAck` not atomic → duplicate DLQ entries (bounded by `MAXLEN`) | tracked |

**Non-issues confirmed during audit:**
- `messageUpdate.ts` `(message.editedAt ?? new Date())` is **not** dead-defensive — `editedAt` is a discord.js getter that TS won't narrow across statements; the fallback is required for typecheck. Left as-is.
- knip's "64 unused files" are all test files + entry points (knip is unconfigured) — false positives, not real dead code. Configuring knip's test/entry patterns would make future dead-code scans meaningful.

---

## Categories verified clean

XSS / link-injection (web), token/CSRF handling, async races & SSE lifecycle (web), all SQL-injection surfaces (fully parameterized via Drizzle `sql`), AD-13 idempotency (except M1), AD-5 schema/indexes/FK-covering-indexes, AD-2 layering, reconnect/backoff, prompt injection, SSRF (no bypass found), dead code (workers/web).

---

## Note on integration tests

The `test:integration` suites (backend/bot/workers integration) fail in the current local environment (21/22 files) on a **clean checkout as well as this branch** — a pre-existing environment/setup issue (the test Postgres/Redis is up but the schema/seed setup for these suites is not applied here), unrelated to the changes in this PR. Unit + web suites (1053 tests) pass.
