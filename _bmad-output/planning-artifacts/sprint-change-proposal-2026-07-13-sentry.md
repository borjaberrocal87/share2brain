# Sprint Change Proposal — Sentry Observability for Node services

- **Date:** 2026-07-13
- **Author:** Borja (via `bmad-correct-course`)
- **Change scope classification:** Moderate (new operational-backlog item + story creation → Developer agent)
- **MVP impact:** None — additive observability, no functional requirement changes

---

## 1. Issue Summary

**Problem statement.** The operator needs centralized runtime observability for the three
Node services (`backend`, `bot`, `workers`) without `docker logs` / `docker exec` on the
Hostinger VPS. Today the only log sink is the structured logger writing to `stdout`
(console), visible only from inside each container.

**Context of discovery.** Raised by the operator post-roadmap (the 6-epic roadmap is
functionally complete; `operational-backlog.md` declares "there is no next epic"). This is
**not a new requirement** — Sentry was already designed and its scaffolding shipped, but the
instrumentation was **explicitly deferred**.

**Evidence (verified in code + docs):**

| Finding | State |
|---|---|
| `observability.sentry_dsn` in Zod config (`packages/shared/src/config/index.ts:131`) | ✅ Exists and validates (invariant S-5) |
| `SENTRY_DSN` in `.env` and `docs/development_guide.md:35` | ✅ Documented |
| PRD **NFR13**: "All 5xx errors captured by Sentry with stack trace and user context" | ✅ Requirement already written |
| `docker-compose.yml` propagates `SENTRY_DSN` to all 3 services (`:125`, `:170`, `:211`) | ✅ Already wired |
| PRD stack table: "Observability: **Sentry + Pino**" | ⚠️ Drift — the real logger is custom (`logger.ts`); Pino was never adopted |
| `@sentry/*` dependency in any `package.json` | ❌ Never installed |
| Instrumentation strategy | ⚠️ **Explicitly deferred** (`ARCHITECTURE-SPINE.md:325`) |
| Logger topology | Canonical in `shared` + near-identical local copies in `bot`/`workers` (Story 6.4 DECISION 3) |

**Scope decision (confirmed with operator):**
- **What goes to Sentry:** *Full logs* — errors **plus** all log lines (info/warn/debug) via
  Sentry Logs, so the operator never opens `docker logs`. Noted trade-off: high volume and a
  relatively recent Sentry feature; quota must be monitored.
- **Logger wiring:** *Consolidate on the shared logger* — migrate `bot`/`workers` to
  `@share2brain/shared/logger` and delete their local copies (removes Story 6.4 duplication
  debt); single Sentry integration point.

---

## 2. Impact Analysis

### Epic Impact — N/A
No epic is invalidated, blocked, or resequenced. The roadmap is functionally complete; this
is additive operational work modeled as one operational-backlog item + one story.

### Artifact Conflicts

- **PRD** — No conflict with goals. Two edits: fix the "Sentry + Pino" stack-table drift, and
  annotate NFR13 that full logs (not only 5xx) ship to Sentry Logs.
- **Architecture** — `ARCHITECTURE-SPINE.md:325` marks instrumentation as *deferred*; this
  change **resolves that deferral** and must record the decision. New cross-cutting
  integration point: `initSentry()` in `shared`, invoked **per-process** in each `main.ts`
  (respects AD-2 boundaries and the AD-8 "loadConfig in main.ts before network I/O" ordering).
  **No DB schema or Zod contract changes** — only the already-existing
  `observability.sentry_dsn` is consumed.
- **UI/UX** — N/A (backend/bot/workers; no UI surface).
- **Other artifacts** — `docker-compose.yml` already wired (no change).
  `development_guide.md` + `project-context.md` gain observability guidance.
  Tests gain a Sentry sink suite. `.env` / config already ready.

### Technical Impact

- New runtime dependency `@sentry/node` in `packages/shared` (inherited by the 3 services).
- Per-process `Sentry.init` in each `main.ts` (empty DSN = no-op → local dev stays offline).
- Dual sink (stdout **and** Sentry) preserves current on-container logging.
- **Security:** existing `redactSecrets` reused in `beforeSend`/`beforeSendLog`; message
  `content` and secrets/PII are never forwarded (project-context §anti-patterns; NFR13 user
  context = Discord id/roles only).

---

## 3. Recommended Approach — Option 1: Direct Adjustment

| Option | Verdict | Effort | Risk |
|---|---|---|---|
| **1 — Direct Adjustment** (new backlog item + 1 story) | ✅ **Selected** | Medium | Low |
| 2 — Rollback | N/A — nothing to revert; purely additive | — | — |
| 3 — MVP Review | N/A — MVP untouched | — | — |

**Rationale.** All scaffolding (config, env, DSN validation, compose wiring, NFR) already
exists; the remaining work is SDK + wiring + logger consolidation + docs. It slots cleanly
into `operational-backlog.md` as a single story-sized item (like `ops-1/2/3`), carries low
risk (additive, DSN-gated, no contract/schema change), and keeps momentum by closing a
long-standing deferred architectural item.

---

## 4. Detailed Change Proposals

### Code

**C1 — Add `@sentry/node` to `packages/shared`.** Single integration point (consistent with
logger consolidation); the 3 services inherit it. Shared already hosts infra (logger,
notifier, config).

**C2 — New `packages/shared/src/observability/sentry.ts`.**
```
initSentry(dsn: string, service: string): void
  - dsn === '' → no-op (config already allows empty = disabled, S-5)
  - Sentry.init({ dsn, _experiments: { enableLogs: true }, beforeSend, beforeSendLog })
  - setTag('service', service)
  - beforeSend/beforeSendLog → redactSecrets(message + stack); NEVER attach `content`
```

**C3 — `packages/shared/src/logger.ts`: dual sink (stdout + Sentry).** Uses the existing
injectable `LogSink` seam. `error` → `Sentry.captureException`; all levels →
`Sentry.logger[level]` (enableLogs). Console sink retained. Redaction applied before
forwarding.

**C4 — Consolidate `bot`/`workers` onto the shared logger.**
- `packages/bot/src/main.ts` → import from `@share2brain/shared/logger`, `createLogger(level, 'bot')`
- `packages/workers/src/main.ts` → same with `'workers'`
- **Delete** `packages/bot/src/logger.ts`, `packages/workers/src/logger.ts` and their
  `.test.ts` (Story 6.4 duplication debt). Each logger is instantiated once in `main.ts` and
  dependency-injected downward — only these two import sites change.

**C5 — Call `initSentry(config.observability.sentry_dsn, <service>)` in all 3 `main.ts`,**
immediately after `loadConfig()` and **before any network I/O** (AD-8 ordering). Backend
additionally: Express 5xx error handler → `Sentry.captureException` with user context
(Discord id/roles) → satisfies **NFR13**.

**C6 — Tests.** New `packages/shared/src/observability/sentry.test.ts` + extend
`logger.test.ts` (mock `@sentry/node`): empty DSN = no init · `error` → captureException ·
all levels → `Sentry.logger.*` · redaction applied · `content` never forwarded.

### Docs

- **D1 — PRD** stack table: `Sentry + Pino` → `Sentry + custom logger (@share2brain/shared/logger)`.
- **D2 — PRD** NFR13: note full logs (not only 5xx) ship to Sentry Logs.
- **D3 — `ARCHITECTURE-SPINE.md:325`**: replace the "deferred" note with the **implemented**
  decision (per-process init in `main.ts`; dual sink; `enableLogs`; PII/`content` excluded).
- **D4 — `development_guide.md`**: new "Observability / Sentry" subsection (enable via
  `SENTRY_DSN`; what is captured; how to disable locally).
- **D5 — `project-context.md`**: new observability rule (initSentry in `main.ts` after
  `loadConfig`; never send PII/`content`; dual sink).
- **D6 — `operational-backlog.md`**: new **P1.3 — Sentry observability** item documenting the
  work and its promotion to a story.

### Backlog / Story

- **S1 — Promote to BMAD story `ops-4-sentry-observability.md`** (next after ops-1/2/3), with
  commit slices: `shared` (C1–C3) → wiring/consolidation (C4–C5) → tests (C6) → docs (D1–D6).
  Create via `bmad-create-story` when picked up.

---

## 5. Implementation Handoff

**Scope: Moderate.** Requires a backlog entry + story creation before implementation.

| Recipient | Responsibility |
|---|---|
| **Product Owner / Dev** (backlog) | Land D6 (operational-backlog P1.3); run `bmad-create-story` to produce `ops-4-sentry-observability.md` (S1). |
| **Developer agent** (`bmad-dev-story`) | Implement C1–C6 and D1–D5 following the commit slices; run the mandatory verification gate (`npm run lint && npm run test && npm run build`) and paste output; branch `feat/ops-4-sentry-observability`. |
| **Reviewer** (`bmad-code-review` → `bmad-checkpoint-preview`) | Review on the strongest model; verify redaction (no `content`/secrets/PII reaches Sentry) and DSN-gated no-op behavior. |

**Success criteria.**
1. With `SENTRY_DSN` set, an error in each service surfaces in Sentry with `service` tag and
   stack trace; `backend` 5xx carries Discord user context (id/roles, no content) — NFR13.
2. All log lines (info/warn/debug/error) appear in Sentry Logs for the 3 services.
3. With empty `SENTRY_DSN`, all services start and log to stdout exactly as today (no init).
4. No message `content`, secret, or connection-string credential appears in any Sentry event
   or log (verified by test + manual scrub check).
5. `bot`/`workers` no longer carry local logger copies; single logger in `shared`.
6. Verification gate green; docs (D1–D6) updated **before** merge.

**Dependencies / sequencing.** `shared` first (C1–C3), then service wiring (C4–C5), then tests
(C6), then docs. No external dependency — compose/env/config already in place.
