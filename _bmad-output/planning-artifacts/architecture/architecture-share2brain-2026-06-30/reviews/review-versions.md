---
type: version-currency-review
target: ARCHITECTURE-SPINE.md
reviewer: claude-sonnet-4-6
date: 2026-06-30
---

# Version Currency & Technology Fit Review — Share2Brain Architecture Spine

**Verdict:** The stack is current and well-chosen overall, but three entries carry active risk: `pgvector` is pinned to a version with a known CVE (0.8.0), `drizzle-kit` uses a loose `0.x` pin that will land on 0.31.x (not matching the paired `drizzle-orm` 0.45.x minor), and the paradigm name is accurate but incomplete for the ingest half of the system.

---

## Tier 1 — Blocking / Immediate Action Required

### T1-1 — pgvector: pinned version has an unpatched CVE

| Field | Value |
|---|---|
| Pinned | 0.8 (interpreted as 0.8.0) |
| Latest stable | 0.8.3 |
| CVE | CVE-2026-3172 |

CVE-2026-3172 is a buffer-overflow in pgvector's **parallel HNSW index build** path, affecting all 0.6.0–0.8.1 releases. It allows an authenticated DB user to leak data from other relations or crash the server. The fix shipped in **0.8.2**. Any deployment of Share2Brain that builds HNSW indexes in parallel (likely, given the embedding workload) is exposed.

**Required action:** Update the stack entry to `pgvector 0.8.3` (latest as of 2026-06-30) and add a note in AD-5 that `max_parallel_maintenance_workers` must not be set to 0 as a workaround in production — the correct fix is the version bump.

---

### T1-2 — drizzle-kit: `0.x` pin is misaligned with drizzle-orm 0.45.x

| Field | Value |
|---|---|
| Pinned | `drizzle-kit 0.x` |
| drizzle-orm pinned | `0.45.2` (latest 0.x) |
| drizzle-kit latest 0.x | `0.31.10` (released 2026-03-17) |

The spine states `drizzle-kit 0.x (pinned con drizzle-orm)` but the drizzle-kit 0.x series latest release is **0.31.x**, not 0.45.x. The two packages use independent versioning schemes. Pairing drizzle-orm 0.45.2 with an unspecified drizzle-kit 0.x resolves to 0.31.10 — an 14-minor-version gap from the ORM. Drizzle documents that drizzle-kit and drizzle-orm must be kept at matching release branches; a mismatch here can silently generate invalid SQL migrations.

Separately, **drizzle-kit 1.0.0-rc.4** and **drizzle-orm 1.0.0-beta.2** are in late-beta as of June 2026. The v0→v1 upgrade removes RQBv1 (replaced by `defineRelations()`), reworks the casing API, and changes the pgvector query helper import path. AD-5 contains no mention of this upcoming breaking migration path; a future team picking up the 1.x branch will hit silent breakage.

**Required actions:**
1. Replace `drizzle-kit 0.x` with `drizzle-kit 0.31.10` (explicit pin).
2. Add a deferred item noting the drizzle-orm 0.x → 1.x migration path (RQB v2 `defineRelations()`, casing API rework, pgvector helper changes) so it is not a surprise when the team upgrades.

---

## Tier 2 — Non-Blocking Risks / Should Address Before First Story

### T2-1 — express-session pinned to `1.x`; connect-redis 9.0 is one year stale

| Package | Spine pin | Latest stable |
|---|---|---|
| express-session | `1.x` | `1.19.0` |
| connect-redis | `9.0` | `9.0.0` (unchanged) |

`express-session 1.x` is actively maintained (1.19.0, June 2026) but the spine uses a loose `1.x` pin. AD-10 relies on the interaction between express-session and connect-redis; any minor bump in express-session that changes the session store interface contract could break the Redis store silently. The pin should be tightened to `1.19`.

`connect-redis 9.0` was last published ~1 year ago. The project is maintained by the `tj` org which has historically transferred packages with varying continuity. No breaking changes are known, but the lack of updates warrants monitoring. Notably, `connect-redis` 9.x uses the modern `redis` (node-redis v4+) client API and is **not** compatible with `ioredis` directly — the spine lists both `connect-redis` and `ioredis`, which means ioredis is used for the bot/workers Redis Streams path while node-redis underlies the session store. This dual-client pattern should be called out explicitly in AD-10 to prevent a developer assuming they can swap one for the other.

**Required actions:**
1. Tighten `express-session` to `1.19`.
2. Add a note in AD-10 clarifying that `connect-redis 9.x` uses `redis` (node-redis), not `ioredis`, so two Redis client libraries are in the dependency graph.

### T2-2 — nginx pinned to `1.27 (mainline)`; production risk

| Field | Value |
|---|---|
| Pinned | `1.27 (mainline)` |
| Current mainline | `1.27.x` series still active |
| Current stable | `1.28.x` |

nginx mainline is a reasonable choice and the official docs endorse it for production. However, the mainline branch receives feature updates every 1-2 months, which can introduce new behaviour in an automated Docker pull. For a self-hosted product where operators `docker compose pull` on their own schedule, pinning to a **specific patch version** (e.g., `1.27.5`) rather than just `1.27 (mainline)` prevents operators from inadvertently upgrading nginx between deploys. The spine does not pin a patch version anywhere in the Structural Seed's `docker-compose.yml` example.

**Required action:** Add a note in AD-7 (or the docker-compose seed) to pin nginx to a specific image tag (e.g., `nginx:1.27.5-alpine`) rather than `nginx:mainline`.

---

## Tier 3 — Observations / Low Risk

### T3-1 — Paradigm name is accurate but underdescribes the event-driven core

The paradigm label **"Hexagonal (Shared Kernel) + Pipes-and-Filters Ingest"** is correct as far as it goes. The Mermaid diagrams and ADs are consistent: `packages/shared` is the kernel, services depend only on it, and the ingest path is a linear pipeline (Discord → Bot → Redis Streams → Workers → pgvector). No misrepresentation.

However, the architecture is also substantively **event-driven** via Redis Streams (producer/consumer with persistent stream semantics, consumer groups implied by AD-1's retry deferred item). "Pipes-and-Filters" underplays the at-least-once delivery guarantee and backpressure semantics that Redis Streams provide over a simple pipe. A more precise label would be **"Hexagonal (Shared Kernel) + Event-Driven Ingest (Redis Streams)"**. This is not an error but would improve communication precision with future contributors.

### T3-2 — TypeScript 6.0 is the last JS-based compiler; TS 7.0 (Go) on horizon

The spine pins `TypeScript 6.0`, which was released 2026-03-23 and is the correct current major. TypeScript 6.0 carries the **largest breaking-change set since TS 2.0** (default `target` changed to ES2023, default `module` to ESNext, several legacy patterns removed). The spine does not document any tsconfig baseline. Because all five packages share a monorepo, a future `tsc` upgrade from 5.x to 6.0 on an existing repo will require `tsconfig.json` audits across the workspace.

Additionally, TypeScript 7.0 (Go-native compiler, `tsgo`) is in public preview with a stable release expected late 2026/early 2027. AD-2 (monorepo rules) and AD-8 (config loading) should note that TypeScript 7.0 may change `ts-node` and loader behaviour relevant to `loadConfig()`.

**No immediate action required**, but a Deferred entry for "TypeScript 7.0 compiler migration" is recommended.

### T3-3 — @langchain/core pin (1.2) is behind latest 1.4.7; no blocking issue

`@langchain/core` 1.2 is pinned while the latest 1.x release is 1.4.7 (June 12, 2026). The LangChain 1.x series commits to no breaking changes until 2.0. The pin is safe but lagging two minor versions. AD-11 correctly forbids legacy LangChain v0.2 APIs; the 0.x → 1.x migration (removal of `ConversationSummaryBufferMemory`, `LLMChain`) is already documented in the AD.

**No action required**, but bumping the pin to `1.4` reduces exposure to a lingering CVE (CVE-2026-25528) found in `@langchain/core` `<0.3.80` that has been fixed in all 1.x releases.

### T3-4 — Redis 8 pinned correctly; note on Docker Hub tag format

The spine pins `Redis 8`. The current stable release train is Redis 8.8.0 (June 2026). Redis 8.2 reached EOL on 2026-05-25. Pinning to `redis:8` on Docker Hub will pull the latest 8.x image, which as of today is 8.8.0. This is safe. However — consistent with the nginx observation — the docker-compose seed should use an explicit tag like `redis:8.8-alpine` to prevent silent major-patch upgrades during `docker compose pull`.

---

## Summary Table

| Entry | Spine Pin | Latest | Status | Priority |
|---|---|---|---|---|
| Node.js | 24 LTS | 24.18.0 (LTS) | Correct | — |
| TypeScript | 6.0 | 6.0.3 | Correct; TS7 horizon noted | T3-2 |
| React | 19.2 | 19.2.7 | Correct | — |
| Vite | 8.1 | 8.1.x | Correct | — |
| Express | 5.2 | 5.x | Correct; breaking changes from v4 in AD | — |
| @langchain/langgraph | 1.4 | 1.4.7 | Correct | — |
| @langchain/core | 1.2 | 1.4.7 | Lagging minor; CVE note | T3-3 |
| drizzle-orm | 0.45 | 0.45.2 | Correct | — |
| drizzle-kit | 0.x | 0.31.10 (0.x); 1.0-rc4 in beta | Loose pin; version mismatch risk; v1 migration undocumented | T1-2 |
| discord.js | 14.26 | 14.26.4 | Correct | — |
| zod | 4.4 | 4.4.x | Correct; v3→v4 breaking changes already reflected in ADs | — |
| express-session | 1.x | 1.19.0 | Loose pin | T2-1 |
| connect-redis | 9.0 | 9.0.0 | Current; dual-client pattern undocumented | T2-1 |
| ioredis | 5.x | 5.11.1 | Correct; note on preferred node-redis for new work | T2-1 |
| PostgreSQL | 17 | 17.x | Correct | — |
| pgvector | 0.8 | 0.8.3 | **CVE-2026-3172 unpatched in 0.8.0** | **T1-1** |
| Redis | 8 | 8.8.0 | Correct; tag pinning recommended | T3-4 |
| nginx | 1.27 (mainline) | 1.27.x (mainline) / 1.28.x (stable) | No patch pin | T2-2 |
| Docker Compose | 2 | 2.x | Correct | — |
