# Operational Backlog — post-roadmap (Share2Brain)

> Created 2026-07-08 at the Epic 6 retrospective (the final epic). The 6-epic roadmap is
> functionally complete (all 23 FRs, all UX-DRs). This file is the explicit home for reliability /
> observability / test-hygiene debt that used to fall into "the next epic" — there is no next epic.
> Items are ranked by real operational impact, **outside** the BMAD epic cycle. Promote an item to a
> BMAD story (`bmad-create-story`) when it is picked up.

## Priority 1 — real operational impact, pick up first

### P1.1 — `MAXLEN` / stream trimming on all Redis Streams
> **DONE 2026-07-08:** `ops-1-maxlen-stream-trimming.md` (status done, code review passed; merged PR #39). Shipped as a PEL-safe `XTRIM … MINID` trimmer in a dedicated loop with its own Redis client — the naive `MAXLEN` on `xAdd` was explicitly rejected (it trims by count with no PEL awareness, which would drop unacked entries and violate AD-13). The four `xAdd` producers were deliberately left untouched.
- **Why now:** Deferred three times (Epic 3 AI#4 → Epic 5 retro → Epic 6). Story 6.1 added two new
  unbounded streams (`share2brain:discord:messages:updated`, `:deleted`) on top of `share2brain:discord:messages`.
  No `MAXLEN`, unbounded growth in a long-running self-hosted deployment.
- **Scope:** Add a bounded `MAXLEN ~` (approximate trim) to every `xAdd` producer, or a periodic
  `XTRIM`. **Must confirm** the cap cannot trim entries still PENDING in any consumer group's PEL
  (Indexer `share2brain:indexer`, Sync `share2brain:sync`) — trimming a pending-but-unacked entry drops an
  un-processed edit/delete.
- **Producers to touch:** `packages/bot/src/persistence/persistMessage.ts`,
  `packages/bot/src/backfill/backfiller.ts`, `packages/bot/src/discord/handlers/messageUpdate.ts`,
  `messageDelete.ts` (+ the 6.3 offline-sync republish path reuses these handlers).

### P1.2 — Backend integration-test isolation (the recurring RBAC flake)
> **DONE 2026-07-08:** `ops-2-integration-test-isolation.md` (status done, code review passed). Spike pinned the "test-guild leak" as a STALE assertion (PR #32 @everyone/guild-id injection), not a flake — fixed + run-unique ids + fail-fast guard + development_guide precondition. A separate load-sensitive intermittency (auth/documents/search under heavy load) is deferred in `deferred-work.md`.
- **Why now:** `rbac.integration.test.ts` / `channels.integration.test.ts` fail non-deterministically
  ("test-guild role leak" — a stale/shared `channel_permissions` row). Reported as pre-existing and
  unrelated in the 6.2, 6.3 **and** 6.4 Completion Notes; first flagged in the Epic 4 retro.
- **Root cause (on record):** RBAC expansion resolves against the WHOLE `channel_permissions` table,
  so a shared literal role leaks into scope; compounded by integration tests running against a
  Postgres/Redis that live `docker compose` `backend`/`bot` containers are also attached to.
- **Scope (pick one):** run-unique roles/channels per run with own-id cleanup (generalize the Epic 4
  AI#3 pattern to the backend package), **or** document + enforce "don't run integration tests against
  a stack with live dev containers attached." Green when the full `npm run test:integration` is
  deterministic.

### P1.3 — Sentry observability for the three Node services
> **Approved 2026-07-13** via `sprint-change-proposal-2026-07-13-sentry.md` (Correct Course). To be
> promoted to story `ops-4-sentry-observability.md` (`bmad-create-story`). Scope decided with Borja:
> **full logs** (errors + all log lines to Sentry Logs) and **consolidate on the shared logger**.
- **Why now:** The operator needs centralized runtime observability for `backend`/`bot`/`workers`
  without `docker logs`/`docker exec` on the Hostinger VPS. Not a new requirement — Sentry was
  designed and the scaffolding shipped (config `observability.sentry_dsn` at S-5, `SENTRY_DSN` in
  `.env`, compose wiring on all 3 services, PRD NFR13), but the instrumentation was **explicitly
  deferred** (`ARCHITECTURE-SPINE.md:325`). `@sentry/node` is not installed anywhere.
- **Scope:** (a) add `@sentry/node` to `packages/shared`; (b) new
  `packages/shared/src/observability/sentry.ts` `initSentry(dsn, service)` — empty DSN = no-op (S-5),
  `_experiments.enableLogs`, `beforeSend`/`beforeSendLog` scrub via existing `redactSecrets`, never
  attach message `content`/PII; (c) dual sink (stdout + Sentry) in the shared `logger.ts` — `error`
  → `captureException`, all levels → `Sentry.logger[level]`; (d) consolidate `bot`/`workers` onto
  `@share2brain/shared/logger` and **delete** their local `logger.ts` + tests (Story 6.4 duplication
  debt); (e) call `initSentry` in the 3 `main.ts` right after `loadConfig()`, before network I/O
  (AD-8); backend 5xx handler → `captureException` with Discord id/roles (NFR13); (f) tests mocking
  `@sentry/node`; (g) docs — PRD "Sentry + Pino" drift, NFR13 note, `ARCHITECTURE-SPINE.md:325`
  deferred→implemented, `development_guide.md`, `project-context.md`.
- **Green when:** with `SENTRY_DSN` set, errors + all logs from the 3 services reach Sentry (backend
  5xx carries user context, no `content`); with empty DSN, services start and log to stdout as today;
  no secret/PII/`content` in any Sentry event; single logger in `shared`; verification gate green.
- **Caveat:** Sentry Logs is a relatively recent feature and full-log volume is high — watch quota.

### P1.4 — Refactor observability to a vendor-neutral port + adapter
> **Promoted to story 2026-07-16** (`ops-5-observability-port-adapter.md`, `bmad-create-story`) from an
> architecture review (Amelia). Behavior-preserving follow-on to P1.3/ops-4.
- **Why now:** ops-4 correctly isolated the `@sentry/node` **dependency** to `packages/shared` (AD-2), but it
  did **not invert** it. The public surface is vendor-named (`initSentry`, `captureException`, `flushSentry`,
  `setSentryUser`, `setupSentryErrorHandler`) and leaks "Sentry" to ~10 call sites across all three services;
  `packages/shared/src/logger.ts` hard-imports `@sentry/node` and calls `Sentry.logger[level]` directly
  (the console sink is injectable, the Sentry sink is not). Adding a second provider (OpenTelemetry, Datadog,
  Grafana) today would force edits across `backend`/`bot`/`workers` + the logger — violating the stated goal of
  swapping providers without touching the application (DIP / Open–Closed). The sibling `notifier` module already
  ships the correct pattern (`interface Notifier` + `createNotifier` + `NOOP_NOTIFIER`); ops-4 copied its barrel
  but not its port.
- **Scope:** introduce an `Observability` port; make Sentry one adapter behind `createObservability(dsn,
  service)`; add a `NoopObservability` for the empty-DSN case (S-5); inject a vendor-neutral `StructuredLogSink`
  into `createLogger` so `logger.ts` no longer imports `@sentry/node`; thread the port through the services via
  DI (main.ts / app.ts / lifecycle.ts); migrate the ops-4 tests to drive the port (no coverage loss); optional
  `observability.provider` config selector (default `sentry`, fail-safe). **Behavior-preserving** — same
  errors/logs, same redaction, same tags. `@sentry/node` ends up imported in exactly one file.
- **Green when:** `grep @sentry/node` over `packages/**` hits only `observability/sentry.ts` (+ its test); no
  vendor name in any service or the logger; empty-DSN boot byte-identical to today; gate green with no net test
  loss; adding a future provider is a new adapter + one factory branch + one config value, zero service/web edits.

## Priority 2 — correctness hardening (low live-path risk today)

### P2.1 — Transactional outbox for the XADD-before-COMMIT producer race
- **Why:** Epic 3 AI#5. `persistMessage.ts` writes the DB row and XADDs in one Drizzle transaction,
  but the XADD is not transactional with Postgres — a crash between COMMIT and XADD (or vice versa)
  can drop or duplicate an ingest event. The two new 6.1 streams are **publish-only** (no DB write),
  so the race does **not** apply to them — this is scoped to the `messageCreate`/backfill ingest path.
- **Scope:** outbox table + relay, or accept-and-document the at-least-once window (current stance).

### P2.2 — DLQ / retry-cap / alert on permanently-failing Sync entries
- **Why:** Epic 6.2 review deferral. A deterministically-failing Sync entry (e.g. an embeddings
  `dimensions` mismatch) sits in the PEL and re-fails on every boot replay, with only per-attempt
  logs — no cap, no alert. PEL-as-DLQ is the AD-13 design; this adds a retry cap + a Notifier alert
  (the 6.4 Notifier now exists and can carry it).

### P2.3 — `messageDeleteBulk` handling
- **Why:** Epic 6.1 deferral (confirmed with Borja). A Discord moderator bulk-purge fires
  `Events.MessageBulkDelete`, a **separate** event from `messageDelete`, so bulk-deleted messages are
  NOT published to `share2brain:discord:messages:deleted` and only sync via offline reconciliation (6.3).
- **Scope:** register `Events.MessageBulkDelete`, iterate the deleted collection, publish one
  `discord.message.deleted` per message through the existing `handleMessageDelete` path.

### P2.4 — Full offline reconciliation (edit-to-anchor + beyond the window)
- **Why:** Epic 6.3 deferral. The startup offline sync seeds `before: lastSeen` (exclusive), so an
  edit to the newest (anchor) message during downtime is never detected on a quiet channel; and the
  window is bounded by `backfill.limit`, so edits/deletes older than the window are missed.
- **Scope:** a periodic or on-demand full-channel reconcile that does not rely on the anchor cursor.

### P2.5 — FR21 knowledge-lifecycle notification ("recurso enriquecido indexado")
- **Why:** Épico 7 (`epics.md`) lists FR21 as covered, but no 7.x story implements a
  knowledge-lifecycle notification. The Story 6.4 Notifier (`@share2brain/shared/notifier`) is
  deliberately **crash-alerts-only** by design (Epic 6) — it is never wired into the Indexer's
  success path. Story 7.2 (workers/indexer resource pipeline) explicitly must NOT emit
  notifications from `indexBatch` (out of scope), so this gap persists post-7.2.
- **Scope:** decide whether/how to notify an operator when a resource is enriched+indexed
  (e.g. a low-noise digest, not per-URL spam) — needs a design decision before implementation,
  not just wiring the existing crash-alert Notifier.

### P2.6 — Workers dies fatally on a Redis restart and compose never revives it
- **Why:** Observed live during PR #72 verification (2026-07-12). Recreating the `redis` container
  killed `workers` with `[workers] fatal: Socket closed unexpectedly` (exit 1) while `bot` and
  `backend` survived and reconnected. `docker-compose.yml` defines no `restart` policy for the app
  services, so the consumer stayed down for ~20 minutes until manually restarted — ingest events
  accumulate in the streams (fine, at-least-once) but nothing consumes them.
- **Scope:** (a) make the workers' node-redis client treat a socket close as reconnectable (mirror
  whatever bot/backend do differently), and/or (b) add `restart: unless-stopped` to the long-running
  app services in compose. Either alone closes the outage window; both is defense in depth.

### P2.7 — Nothing loads `.env` into local `npm run dev` processes
- **Why:** Found while fixing the local-dev Redis gap (PR #72, 2026-07-12). The dev scripts are
  plain `tsx watch src/main.ts` — no dotenv anywhere in app code, no `--env-file`, and neither
  CONTRIBUTING nor the development guide tells the developer to export `.env` into the shell. The
  documented local-dev flow only works if the contributor already exports the vars themselves
  (or, as on the maintainer's machine, unauthenticated local infra happens to answer). First-time
  contributors hit `Required environment variable X is not set` right after cloning.
- **Scope:** decide the mechanism — `tsx watch --env-file=../../.env` in each package's `dev`
  script (Node ≥20 native, no new dependency) vs documenting `set -a && source .env && set +a` —
  then align CONTRIBUTING + development_guide. Small, but it is the first thing every new
  contributor trips on after PR #72 lands.

## Future product capability (retained goal, needs a real epic)

### F1 — Execution-trace panel (agentic capabilities)
- **Status:** Retained product goal (**confirmed with Borja, 2026-07-08**), deferred to a future
  "agentic capabilities" epic — NOT operational debt. From the Epic 5 retro (Story 5.4 D1 / UX-DR20).
- **Blocker:** the RAG backend emits only `token` / `citation` / `done` / `error` SSE frames and has
  no `tool_exec` node. Delivering the `tool_call`/`observation` panel requires backend + `@share2brain/shared`
  work first (new frame types + a graph node), then the frontend panel.
- **Action:** keep the annotation on Story 5.4's AC and UX-DR20 ("deferred to future
  agentic-capabilities epic"); promote to a proper epic if/when Share2Brain development resumes.

## Deploy runbooks

### Epic 7 clean-slate migration (Story 7.1 — resource-index pivot)
> Added 2026-07-09. One-time runbook for the `embeddings.content` → `title/description/link`
> destructive migration (`0003_bent_mandrill.sql`, D1/D2). Re-run this exact sequence on every
> environment (staging/prod) the migration has not yet touched.

1. Stop the app containers so nothing writes through the migration window:
   `docker compose stop backend bot workers` (leave `postgres`/`redis` up — OPS-2 competing-writer guard).
2. Truncate in FK-safe order (D1 extends the wipe to `conversations`/`messages` because
   `Citation.link` is a required field legacy rows lack — a stale row would fail Zod parse):
   `TRUNCATE user_read_status, messages, conversations, embeddings, discord_messages;`
   (`user_read_status` before `embeddings`; `messages` before `conversations` — both have plain
   `no action` FKs, no cascade.)
3. Apply the migration: `npx drizzle-kit migrate` (or let the compose `migrator` one-shot service
   run it on the next `docker compose up`). **Step 2 MUST have run first — even on the `migrator`
   path.** The migration is `ADD COLUMN … NOT NULL` with no default; against a non-empty `embeddings`
   table it aborts, the one-shot `migrator` exits non-zero, and every app service
   (`depends_on: migrator service_completed_successfully`) fails to start. On a fresh environment the
   table is already empty; on any environment with prior data, truncate before letting `migrator` run.
4. Verify: `docker exec -it <postgres-container> psql -U share2brain -d share2brain -c '\d embeddings'` — expect
   `title/description/link text NOT NULL`, no `content` column, indexes unchanged.
5. Restart the app containers and let the Bot re-run its historical backfill — every message is
   reprocessed by the (from Story 7.2 onward) URL-extraction/fetch/AI-enrichment pipeline. Until 7.2
   ships, workers/backend write the Placeholder-policy values (`title:''`, `description:<old content>`,
   `link:''`) — expected and boring, not a bug.

> **Story 7.4 note (2026-07-09):** the strict link contracts (`linkRefine.ts`'s `isHttpUrl`, no more
> `''`-tolerance) and the required `Citation.title` field mean pre-7.4 persisted data — placeholder
> embeddings (`link:''`) from steps 3-4 above, and any legacy citation missing `title` — fail Zod
> `.parse()` at the search/documents/chat edges. **Run this exact runbook again (steps 1-2) before
> deploying Story 7.4 over any DB the 7.4 migration path has touched**, even one already carrying
> Story 7.2/7.3 real-resource data, if it also carries any pre-7.4 placeholder or legacy-citation row.

## Standing Definition-of-Done (adopted practices, not tasks)

> Consolidated 2026-07-08 (bmad-help housekeeping). These are process norms surfaced across the Epic
> 3–6 retros. They have no "completion" — they re-arm on every future story — so they were closing
> `sprint-status` as perpetually-open `action_items`. Homed here as the standing DoD checklist and
> marked `done` in `sprint-status` (= adopted). Apply them to every new story; they are not backlog work.

- **Treat every code-review patch as new, un-reviewed code** — an independent pass verifies prior
  patches with the same rigor as the original code (Epic 3 AI). Applied in round-2 reviews across
  Epics 3–6.
- **A visual AC is not done until the E2E harness asserts it** via `getComputedStyle`/screenshot
  (Epic 4 AI, established by Story 4.5). No frontend story closes with deferred visual ACs.
- **Verify tooling/environment assumptions at story creation**, not mid-implementation ("is X actually
  installed/available?"). On the create-story checklist for any new tooling (Epic 4 AI).
- **Run-unique test isolation as DoD** — suffix-unique roles/channels per run + own-id cleanup; no
  broad `LIKE` cleanups that race sibling suites (Epic 4 AI; enforced for the backend via ops-2).
- **Env-gated smoke against the real LLM provider** as DoD for any story touching the StateGraph/LLM —
  fake-model green is necessary, not sufficient. Re-arms when agentic work resumes (Epic 5 AI).
- **"A test that lies" rule** — every new test must FAIL when the behavior it covers is reverted;
  verify empirically by reverting (Epic 5 AI).
- **Cross-story contract consistency** — when one story injects data into a structure another story
  consumes, review the COMBINED contract, not each in isolation (Epic 5 AI; source of the multi-system
  Anthropic-400 bug).
