# Operational Backlog — post-roadmap (Hivly)

> Created 2026-07-08 at the Epic 6 retrospective (the final epic). The 6-epic roadmap is
> functionally complete (all 23 FRs, all UX-DRs). This file is the explicit home for reliability /
> observability / test-hygiene debt that used to fall into "the next epic" — there is no next epic.
> Items are ranked by real operational impact, **outside** the BMAD epic cycle. Promote an item to a
> BMAD story (`bmad-create-story`) when it is picked up.

## Priority 1 — real operational impact, pick up first

### P1.1 — `MAXLEN` / stream trimming on all Redis Streams
> **Story created 2026-07-08:** `ops-1-maxlen-stream-trimming.md` (status ready-for-dev). Design landed as a PEL-safe `XTRIM … MINID` trimmer (not naive `MAXLEN` on `xAdd`).
- **Why now:** Deferred three times (Epic 3 AI#4 → Epic 5 retro → Epic 6). Story 6.1 added two new
  unbounded streams (`hivly:discord:messages:updated`, `:deleted`) on top of `hivly:discord:messages`.
  No `MAXLEN`, unbounded growth in a long-running self-hosted deployment.
- **Scope:** Add a bounded `MAXLEN ~` (approximate trim) to every `xAdd` producer, or a periodic
  `XTRIM`. **Must confirm** the cap cannot trim entries still PENDING in any consumer group's PEL
  (Indexer `hivly:indexer`, Sync `hivly:sync`) — trimming a pending-but-unacked entry drops an
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
  NOT published to `hivly:discord:messages:deleted` and only sync via offline reconciliation (6.3).
- **Scope:** register `Events.MessageBulkDelete`, iterate the deleted collection, publish one
  `discord.message.deleted` per message through the existing `handleMessageDelete` path.

### P2.4 — Full offline reconciliation (edit-to-anchor + beyond the window)
- **Why:** Epic 6.3 deferral. The startup offline sync seeds `before: lastSeen` (exclusive), so an
  edit to the newest (anchor) message during downtime is never detected on a quiet channel; and the
  window is bounded by `backfill.limit`, so edits/deletes older than the window are missed.
- **Scope:** a periodic or on-demand full-channel reconcile that does not rely on the anchor cursor.

## Future product capability (retained goal, needs a real epic)

### F1 — Execution-trace panel (agentic capabilities)
- **Status:** Retained product goal (**confirmed with Borja, 2026-07-08**), deferred to a future
  "agentic capabilities" epic — NOT operational debt. From the Epic 5 retro (Story 5.4 D1 / UX-DR20).
- **Blocker:** the RAG backend emits only `token` / `citation` / `done` / `error` SSE frames and has
  no `tool_exec` node. Delivering the `tool_call`/`observation` panel requires backend + `@hivly/shared`
  work first (new frame types + a graph node), then the frontend panel.
- **Action:** keep the annotation on Story 5.4's AC and UX-DR20 ("deferred to future
  agentic-capabilities epic"); promote to a proper epic if/when Hivly development resumes.
