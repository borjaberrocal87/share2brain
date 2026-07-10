---
type: architecture-review
review-type: rubric-walk
target: ARCHITECTURE-SPINE.md
altitude: feature
reviewer: rubric-walker
date: 2026-06-30
---

# Architecture Spine Rubric Review — Share2Brain Self-Hosted

**Overall Verdict:** The spine is structurally sound and covers the happy path well, but carries three critical gaps — a session-storage contradiction vs. the PRD, unverified stack versions for major dependencies, and a deferred retry/DLQ policy that can cause silent divergence between implementations of the Workers package — which must be resolved before epics are written.

---

## Rubric Results Summary

| Criterion | Result |
|---|---|
| 1. Fixes real divergence points for epics altitude | PASS with gaps |
| 2. Every AD Rule is enforceable and prevents stated divergence | PASS (one exception, see HIGH-1) |
| 3. Nothing deferred could let two units diverge at this altitude | FAIL — see CRITICAL-2 |
| 4. Named tech versions are verified-current | FAIL — see CRITICAL-3 |
| 5. Covers PRD SO-1 through SO-8 capabilities | PASS with note |
| 6. Every dimension owned by feature altitude is decided/deferred/open | FAIL — see CRITICAL-1 |
| 7. Consistency Conventions covers all cross-cutting drift concerns | PASS with gaps |

---

## Findings

### CRITICAL

---

#### CRITICAL-1 — Sessions table still exists in PRD schema; AD-10 creates an invisible contract split

**AD reference:** AD-10, State Ownership table  
**Rubric criterion:** Dimension 6 — state ownership decided at this altitude

**Description:** AD-10 declares "No existe tabla `sessions` en el schema Drizzle — Redis es la fuente de verdad de sesiones." However, the PRD (§4.4, §5.2) explicitly defines a `sessions` table in the database schema with columns `id`, `token`, `user_id`, `expires_at` — and lists it in the State Ownership table of the PRD. The spine removes this table without updating or referencing the PRD data model. This creates two simultaneously valid sources of truth: an architect reading the PRD will implement a `sessions` table in Drizzle; an architect reading the spine will not. Because `packages/shared` is the single kernel for the DB schema (AD-2, AD-5), this contradiction will manifest the moment anyone writes `schema.ts`.

**Fix recommendation:** Add an explicit callout in AD-10: "The PRD `sessions` table is superseded by this decision. The Drizzle schema in `packages/shared/src/db/schema.ts` must NOT include a `sessions` table. Connect-redis manages session persistence entirely." Then update the State Ownership table to remove the sessions row from PostgreSQL and add a footnote that the PRD ER diagram (§5) is deprecated in favour of this spine.

---

#### CRITICAL-2 — Redis Streams retry/DLQ policy is deferred but diverges Workers at epic altitude

**AD reference:** Deferred section ("Retry y dead-letter en Redis Streams"); AD-1  
**Rubric criterion:** Criterion 3 — nothing deferred can cause divergence at this altitude

**Description:** The retry and dead-letter queue policy for Redis Streams consumer groups is explicitly deferred to "la historia de Workers." However, the choice between at-least-once vs. at-most-once delivery, consumer group naming, and acknowledgment strategy is a cross-cutting invariant: both the `indexer/` and `sync/` subtrees inside `packages/workers` must agree on it, and it is baked into the Redis Streams wire format from day one (the consumer group name must be fixed before the first message is produced by the Bot). Leaving this deferred means two builders implementing `indexer/` and `sync/` can independently choose different group names or ACK strategies and produce a non-recoverable split in stream consumer state.

**Fix recommendation:** Elevate to a new AD-13: define the consumer group naming convention (e.g., `share2brain:workers:indexer` and `share2brain:workers:sync`), the ACK discipline (XACK only after successful DB write), and the dead-letter behaviour (after N failed deliveries, move to `share2brain:dlq` stream). The exact maxlen and DLQ processing cadence can remain deferred, but the invariants above must be fixed now.

---

#### CRITICAL-3 — Stack versions are not verified-current for three major dependencies

**AD reference:** Stack table  
**Rubric criterion:** Criterion 4 — named tech is verified-current

**Description:** Three entries appear implausible or unverifiable as of June 2026:

- **TypeScript 6.0** — TypeScript 5.x is the current stable line; 6.0 is not released as of the knowledge cutoff. Listing an unreleased version breaks the monorepo's `tsconfig.json` and CI `npm ci` from day one.
- **Vite 8.1** — Vite 6 was the current major as of late 2025; 8.x is ahead of the verified release train.
- **@langchain/langgraph 1.4 / @langchain/core 1.2** — These versions may exceed what has actually been published to npm. LangGraph for JS was at ~0.2.x in mid-2025; a 1.x stable line would require verification.

Additionally, **drizzle-kit 0.x (pinned con drizzle-orm)** is too vague to enforce; a builder can pin any 0.x patch and get a different migration CLI behaviour.

**Fix recommendation:** Verify each version against npm registry before epics are cut. Replace speculative versions with the actual latest stable. For drizzle-kit, pin to the exact version required by drizzle-orm 0.45 (e.g., `drizzle-kit@0.28.x`) — the version must be a concrete semver range, not `0.x`.

---

### HIGH

---

#### HIGH-1 — AD-11 Rule does not prevent legacy LangChain memory use; it only names the banned APIs

**AD reference:** AD-11  
**Rubric criterion:** Criterion 2 — every AD Rule is enforceable and actually prevents stated divergence

**Description:** AD-11 bans `ConversationSummaryBufferMemory` and `LLMChain` (LangChain v0.2 legacy APIs), but the rule is purely aspirational — there is no enforcement mechanism (no eslint plugin, no banned-imports lint rule, no custom module boundary). More importantly, the PRD (§4.2, SD-17) explicitly specifies `ConversationSummaryBufferMemory` as the memory strategy. A builder reading the PRD will implement it; a builder reading the spine will not. The spine's Structural Seed (`agent/` folder) lists no module that enforces the StateGraph contract.

**Fix recommendation:** Add to the Rule: "A lint rule (`eslint-plugin-n` or a custom rule) in `packages/backend/.eslintrc` bans imports from `langchain/memory`, `langchain/chains`, and any module path matching `@langchain/community/memory/*`. CI fails on violation." Also reconcile with the PRD by explicitly stating that SD-17 (`ConversationSummaryBufferMemory`) is superseded by AD-11's StateGraph approach, with the equivalent behaviour (20-turn window, token-budget compression) implemented via explicit LangGraph state fields.

---

#### HIGH-2 — OAuth2 callback endpoint and CORS origin contract are absent from API Conventions

**AD reference:** AD-6, AD-7, Consistency Conventions  
**Rubric criterion:** Criterion 7 — Consistency Conventions covers all cross-cutting drift concerns

**Description:** The spine defines the REST naming convention (`/api/<resource>` kebab-case) but does not fix two high-drift API surfaces: (1) the OAuth2 callback route (`/api/auth/callback` is implied in the PRD .env example but never named in the spine), and (2) the CORS `allowed_origins` policy — the PRD config shows it as a runtime config field but the spine has no AD governing how the Backend initialises CORS middleware from it. Two builders can independently choose `/api/auth/discord/callback` vs `/api/auth/callback`, breaking the Discord application's redirect URI setting, which is an operator-configuration hard constraint (AS-1).

**Fix recommendation:** Add to the Consistency Conventions table: "OAuth2 callback route: always `GET /api/auth/callback` (matches Discord application redirect URI config)." Add to AD-7 or a new AD: "CORS allowed origins are read exclusively from `config.security.allowed_origins` (loaded via `loadConfig()`); the Backend must not hardcode any origin."

---

### MEDIUM

---

#### MEDIUM-1 — Capability map lists SO-8 as governed only by config, missing the single-guild enforcement rule

**AD reference:** Capability → Architecture Map (SO-8 row)  
**Rubric criterion:** Criterion 5 — covers PRD SO-1–SO-8

**Description:** SO-8 ("Un despliegue = un guild") is listed as governed by `AD-8` via `guild_id` in config. However, no AD states that the Bot must hard-fail (not warn) at startup if `DISCORD_GUILD_ID` is absent or if the loaded guild_id does not match the bot's connected guild. Nothing prevents a builder from making this a warning that lets the bot start in a degraded multi-guild mode, which would silently violate SO-8's isolation guarantee.

**Fix recommendation:** Add to AD-8's Rule: "At startup, `loadConfig()` must assert that `config.discord.guild_id` is present and non-empty; if absent the process exits with code 1. The Bot additionally asserts at Discord Gateway ready event that the connected guild matches `config.discord.guild_id`; a mismatch is fatal."

---

#### MEDIUM-2 — Notifier placement in Deferred causes a real divergence in health check contract

**AD reference:** Deferred ("Notificador"), AD-1, Capability map  
**Rubric criterion:** Criterion 3 / Criterion 6 — operations dimension

**Description:** The PRD's `/health` endpoint response (§10.1) includes `"notifier": "connected"` as a required component status field. The spine defers Notifier placement entirely. This means the Backend's health check shape — a Zod schema in `packages/shared` under AD-6 — cannot be finalised. A builder writing the health route will either omit `notifier`, hardcode it, or add a conditional field that breaks the contract invariant. The deferred item straddles the API contract, which is feature-altitude territory.

**Fix recommendation:** Add to the Deferred entry: "Until the Notifier story is assigned, the Backend `/health` response must include `"notifier": "not_configured"` as the status value. The Zod schema for the health response in `packages/shared/src/schemas/health.ts` must be written before the health route story is started, with `notifier` typed as `'connected' | 'not_configured' | 'degraded'`."

---

#### MEDIUM-3 — Streaming contract (AD-4) does not specify the SSE event schema

**AD reference:** AD-4  
**Rubric criterion:** Criterion 6 — API contracts dimension; Criterion 7 — cross-cutting conventions

**Description:** AD-4 fixes SSE as the streaming transport but says nothing about the SSE event format: event names (`data:`, `event: delta`, `event: done`), the JSON shape of each chunk, how citations are delivered (inline vs. final event), or how errors are signalled over the stream (e.g., `event: error` with a payload vs. connection close). The Web client (`packages/web/src/api/`) and the Backend (`packages/backend/src/routes/`) will independently invent these formats, leading to a parsing mismatch that is invisible until runtime.

**Fix recommendation:** Add to AD-4's Rule (or the Consistency Conventions table): "The SSE wire format for `POST /api/chat` is: `event: delta` with `data: {"text": "..."}` for each streamed token; `event: done` with `data: {"citations": [...]}` as the final frame; `event: error` with `data: {"error": "...", "code": "..."}` on failure. This shape is defined as a Zod schema in `packages/shared/src/schemas/chat.ts`."

---

### LOW

---

#### LOW-1 — Test framework is deferred but CI/CD is not addressed at all

**AD reference:** Deferred ("Test framework y estrategia")  
**Rubric criterion:** Criterion 6 — operations dimension

**Description:** The PRD (§6.2) lists GitHub Actions as the CI/CD tool and §11.3 sets coverage targets (>80% unit, integration, E2E). The spine defers the test framework and makes no mention of CI/CD at all — not even as a deferred item. For a self-hosted open-source project the CI pipeline shape (which `npm` scripts are run, which Docker images are built) is a cross-cutting concern that affects every package's `package.json` scripts.

**Fix recommendation:** Add a Deferred entry: "CI/CD: GitHub Actions pipeline running `npm test`, `npm run lint`, and `docker compose build` on every PR — deferred to the infra/ops story. The test command must be `vitest run` in each package; E2E with Playwright deferred to v1."

---

#### LOW-2 — Consistency Conventions does not cover the logging library or log format

**AD reference:** Consistency Conventions (Logging row)  
**Rubric criterion:** Criterion 7

**Description:** The Logging convention specifies log level configuration but does not name the logging library (Pino is named in the PRD §6.2 and §10.2 but not in the spine), the structured log format (JSON vs. pretty-print by env), or the shared logger export path. Two builders can independently install `winston` and `pino` in different packages, or configure different serialisers.

**Fix recommendation:** Expand the Logging row: "All services import the logger from `@share2brain/shared` (`packages/shared/src/logger/index.ts`), which exports a Pino instance. JSON format in production (`NODE_ENV=production`), pretty-print in development. No service instantiates its own logger directly."

---

#### LOW-3 — `drizzle-kit` version is a placeholder that cannot be resolved deterministically

**AD reference:** Stack table  
**Rubric criterion:** Criterion 4

**Description:** The entry `drizzle-kit | 0.x (pinned con drizzle-orm)` is not a version — it is an instruction. `package.json` cannot express "pin to the version compatible with drizzle-orm 0.45" without a concrete specifier. npm will resolve `0.x` to the latest 0.* patch, which changes over time.

**Fix recommendation:** Replace with the concrete peer-required version (e.g., `drizzle-kit@0.28.1`) after verifying the drizzle-orm 0.45 peer dependency matrix. If the version is genuinely unknown at spine time, mark it as an open question, not a stack entry.

---

## Dimension Coverage Assessment

| Dimension (Criterion 6) | Status | Notes |
|---|---|---|
| Deployment & environments | Partial | Docker Compose topology defined; dev vs. prod environment differences deferred (TLS, health checks). Acceptable at feature altitude. |
| Infra/provider strategy | Decided | Self-hosted Docker Compose; no cloud provider dependency — correct for SO-7. |
| Operations | Partial | Migrator service decided (AD-9); backup, monitoring, restart policies in PRD but not referenced in spine invariants. LOW-1 covers CI gap. |
| Data model | Partial | State Ownership table is good; CRITICAL-1 covers the sessions table contradiction. |
| State ownership | Decided | State Ownership table is comprehensive and correctly maps write ownership. |
| Security/auth | Decided | AD-10 (sessions), AD-12 (RBAC), AD-7 (TLS termination). HIGH-2 covers CORS gap. |
| API contracts | Partial | AD-6 (Zod schemas in shared) is strong. MEDIUM-3 covers SSE event schema gap; HIGH-2 covers CORS and callback route gap. |
| Streaming | Partial | Transport decided (AD-4: SSE). Wire format not fixed. See MEDIUM-3. |

---

## Capability Coverage (PRD SO-1 through SO-8)

| Capability | Mapped | Notes |
|---|---|---|
| SO-1 Automatic message indexing | Yes | AD-1, AD-2, AD-5 |
| SO-2 Semantic search | Yes | AD-5, AD-6, AD-12 |
| SO-3 RAG chat with streaming | Yes | AD-4, AD-11, AD-12 |
| SO-4 Read Tracking | Yes | AD-6; no dedicated AD but capability map covers it |
| SO-5 Config as code | Yes | AD-8 |
| SO-6 Trivial deployment (one command) | Yes | AD-1, AD-9 |
| SO-7 Data under control (self-hosted) | Yes | AD-7 |
| SO-8 One deployment = one guild | Partial | See MEDIUM-1 — no fail-fast rule enforces single-guild isolation |

---

*Review generated: 2026-06-30*
