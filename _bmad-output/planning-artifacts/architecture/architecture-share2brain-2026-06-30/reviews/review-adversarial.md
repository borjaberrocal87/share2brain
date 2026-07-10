---
type: adversarial-architecture-review
target: ARCHITECTURE-SPINE.md
date: 2026-06-30
reviewer: adversarial-agent
---

# Adversarial Architecture Review — Share2Brain Self-Hosted

**Verdict:** The spine's dependency rules are well-formed but leave five integration seams where two fully-compliant builders can independently satisfy every AD yet produce components that cannot be wired together without an undocumented contract extension.

---

## CRITICAL

### C-1 — SSE streaming broken at nginx boundary (AD-4 vs AD-7)

**Unit A — Backend builder (AD-4)**
Builds `POST /api/chat` as a true streaming SSE endpoint: sets `Content-Type: text/event-stream`, disables response buffering (`res.flushHeaders()`), and streams LangGraph token deltas. Fully compliant with AD-4.

**Unit B — nginx builder (AD-7)**
Configures nginx as the single HTTP entry point that reverse-proxies `/api/*` to the backend. Follows AD-7 to the letter. Chooses a standard `proxy_pass` block with default buffering — nginx's default behavior is to buffer upstream responses until the connection closes, which is correct for most API endpoints and is not prohibited by AD-7.

**Incompatibility at integration**
nginx's default `proxy_buffering on` swallows the SSE stream. The client receives no tokens until the entire chat response completes (or the proxy buffer overflows), nullifying streaming entirely. Neither builder violated an AD; neither was told to talk to the other about buffering.

**Missing AD or tightening needed**
AD-7 must add: *"For `/api/chat`, nginx must set `proxy_buffering off`, `proxy_cache off`, `X-Accel-Buffering: no`, and `proxy_read_timeout` >= agent timeout. These directives are mandatory, not optional."* Without this, AD-4 and AD-7 are individually satisfiable but jointly fatal.

---

### C-2 — RBAC filter never populated at query time (AD-12 vs AD-10 + AD-8)

**Unit A — Backend RBAC builder (AD-12)**
Builds vector search queries with `WHERE channel_id = ANY(:allowed_channel_ids)`. Derives `allowed_channel_ids` from the authenticated user's Discord roles stored in the session. Fully compliant with AD-12: filtering is at the query layer, not middleware.

**Unit B — Auth/session builder (AD-10 + AD-8)**
Builds the OAuth2 login flow that writes `{ user_id, discord_roles }` to the Redis session. Reads the guild's role-to-channel mapping from `channel_permissions` (populated by `loadConfig()` at backend startup per AD-8). Stores only the raw Discord role IDs in the session — this is all AD-10 specifies: *"user_id, discord_roles"*.

**Incompatibility at integration**
`discord_roles` (role IDs) ≠ `allowed_channel_ids` (channel IDs). The RBAC builder needs a role→channel expansion at query time, requiring a join against `channel_permissions`. The auth builder never stored expanded channel IDs. Neither builder was told who owns this expansion: is it computed at login (cached in session) or at query time (DB join on every request)? Both are valid interpretations of AD-12 and AD-10. If each builder assumes the other does it, the filter is `NULL` and RBAC is silently bypassed — a security vulnerability.

**Missing AD or tightening needed**
AD-12 must specify exactly who expands roles to channel IDs and when: *"The Backend, at login, computes `allowed_channel_ids` from the user's Discord role IDs via a join on `channel_permissions` and stores the result in the session alongside `discord_roles`. Vector queries use the pre-expanded session value."* This pins ownership unambiguously.

---

## HIGH

### H-1 — Redis Streams consumer group contract undefined (AD-1 vs AD-5 / Naming Convention)

**Unit A — Bot builder (AD-1, AD-2, Naming Convention)**
Publishes to Redis Streams using the event names specified in the Consistency Conventions: `discord.message.created`, `discord.message.updated`, `discord.message.deleted`. Chooses a stream key format, e.g., publishes all events to a single stream key `discord.events` with a `type` field. This is unspecified by the spine; the naming convention only fixes event names, not stream keys or field schemas.

**Unit B — Workers builder (AD-1, AD-2)**
Consumes Redis Streams. Independently decides to use one stream per event type (`discord.message.created` as the stream key, `discord.message.updated` as another key) for cleaner consumer group isolation. Both choices are unprohibited by any AD.

**Incompatibility at integration**
Bot publishes to `discord.events`; Workers reads from `discord.message.created`. The pipeline produces zero indexing. Neither builder violated an AD or the naming convention (the convention names the event type, not the stream key).

**Missing AD or tightening needed**
A new rule (or extension to the Naming Convention) must fix: the exact Redis stream key(s), the field schema per event type (at minimum `{ type, payload }` or equivalent), and whether consumer groups are used. Without this, the ingest pipeline — the spine's core data flow — is unspecified at the wire level.

---

### H-2 — Migration dependency race: bot writes before schema exists (AD-9 vs AD-1 / AD-5)

**Unit A — Bot builder (AD-1, AD-5)**
Builds the Bot service with `depends_on: { migrator: { condition: service_completed_successfully } }` as mandated by AD-9. Interprets "before the rest of services" as applying to backend and workers (the query/processing services). Reasonably omits the migrator dependency from the bot's Compose service definition, since the bot only writes `discord_messages` and a simple schema won't break on insert if columns exist.

**Unit B — Migrator / Compose builder (AD-9)**
Builds the `migrator` service with `service_completed_successfully` conditions wired to `bot`, `backend`, and `workers`. Assumes all three list `migrator` as a dependency — but Compose `depends_on` is opt-in per service, not enforced globally by the migrator.

**Incompatibility at integration**
If the bot builder omits the `depends_on: migrator` line (a reasonable reading of AD-9 which says "el operador nunca corre migraciones manualmente" but does not enumerate which services must declare the dependency), the bot can start before the schema exists and fail with a PostgreSQL relation-not-found error. AD-9 says the migrator runs "before the rest of services" but never enumerates "the rest" exhaustively.

**Missing AD or tightening needed**
AD-9 must state: *"All three service definitions — bot, backend, workers — must declare `depends_on: { migrator: { condition: service_completed_successfully } }`. This is not optional for any service that reads or writes PostgreSQL."*

---

## MEDIUM

### M-1 — loadConfig() schema divergence between shared and per-service use (AD-8 vs AD-2)

**Unit A — Shared kernel builder (AD-2, AD-8)**
Builds `loadConfig()` in `packages/shared`. Defines a Zod schema covering the fields the kernel author knows about: `guild_id`, `observability.log_level`, `channels`, `roles`, `agent.*`, `grouping_window`, `chunk_overlap`. Exports a single typed config object. Compliant with AD-8.

**Unit B — Bot builder (AD-8)**
Calls `loadConfig()` and uses only `guild_id` and `channels`. Finds the returned type sufficient. Decides to also read `Share2Brain.config.yml` directly via `js-yaml` for a new field (`backfill.max_messages_per_channel`) that the shared schema doesn't yet include — because the field was added to the YAML spec after the shared builder froze the schema, and AD-8 only says "ningún servicio parsea el YAML localmente" but does not prevent reading config from a pre-parsed object that is then extended.

**Incompatibility at integration**
The bot now has a local YAML read, violating the spirit but technically surviving the letter of AD-8 (it uses `loadConfig()` for startup validation, then falls back). More dangerously, the `backfill.max_messages_per_channel` field is invisible to the shared schema's validation — an invalid value silently defaults rather than terminates the process.

**Missing AD or tightening needed**
AD-8 must add: *"The Zod schema in `loadConfig()` is the exhaustive contract for `Share2Brain.config.yml`. Any new config field required by a service must be added to the shared Zod schema first. No service may read `Share2Brain.config.yml` directly or supplement `loadConfig()` output with local parsing of any kind."*

---

### M-2 — Web Dockerfile serves statics locally in dev, bypassing AD-7 in non-prod environments

**Unit A — Web builder (AD-3, AD-7)**
Reads the structural seed comment: *"Multi-stage: build → nginx para dev; prod sirve via nginx global."* Builds a Dockerfile with a dev stage that runs `vite preview` (a local HTTP server) on port 4173 to enable hot-reload. In dev Compose, the web container exposes port 4173 directly — fully consistent with how the seed describes it. AD-3 says "en producción, nginx sirve `dist/` directamente"; dev is not production.

**Unit B — Backend builder (AD-4, AD-6)**
Configures CORS on the Express server with `origin: process.env.FRONTEND_URL`. In production, `FRONTEND_URL` is the nginx domain. In dev, the builder assumes the same nginx-fronted origin as prod.

**Incompatibility at integration**
Dev web app runs on `http://localhost:4173`; backend CORS allows only the nginx origin. Every API call from the dev SPA is blocked by CORS. The web builder never set `FRONTEND_URL=http://localhost:4173` because that env var is not mentioned anywhere in the spine. Neither builder violated an AD.

**Missing AD or tightening needed**
Either AD-7 should explicitly state the dev topology (confirming nginx is used in dev too, or documenting the `FRONTEND_URL` env var as a required secret/config), or a Consistency Convention entry should define `FRONTEND_URL` and its expected value per environment. The current deferred note on "TLS/HTTPS" does not cover this CORS gap.

---

## LOW

### L-1 — Error shape AD is unidirectional: covers REST but not SSE error events (AD-6 vs AD-4)

**Unit A — Backend SSE builder (AD-4, AD-6)**
The AD-6 error shape `{ error: string, code: string }` is defined for REST responses. When an error occurs mid-stream in `POST /api/chat`, the builder emits an SSE `event: error` with `data: { message: "LLM timeout" }` — a reasonable SSE idiom, but a different shape than AD-6.

**Unit B — Web chat client builder (AD-6)**
Imports the error Zod schema from `packages/shared` and uses it to parse API errors. For SSE, it listens for `onerror` (connection-level) and `event: error` (application-level). Since no SSE error schema is in shared, it defines a local shape.

**Incompatibility at integration**
The two SSE error shapes diverge silently. The web client may ignore or crash on backend error events because the field name (`message` vs `error`) doesn't match.

**Missing AD or tightening needed**
AD-4 or AD-6 should add: *"SSE error events on `/api/chat` use the same `{ error: string, code: string }` shape defined in `shared/src/schemas/errors.ts`, serialized as the `data` field of an `event: error` SSE frame."*

---

## Summary Table

| ID | Tier | ADs in conflict | Risk |
|---|---|---|---|
| C-1 | Critical | AD-4 vs AD-7 | Streaming completely broken in production |
| C-2 | Critical | AD-12 vs AD-10/AD-8 | RBAC silently bypassed — data leak |
| H-1 | High | AD-1/AD-2 Naming Convention | Ingest pipeline produces zero data |
| H-2 | High | AD-9 vs AD-1/AD-5 | Bot crashes on startup before schema exists |
| M-1 | Medium | AD-8 vs AD-2 | Config validation gap; potential silent misconfiguration |
| M-2 | Medium | AD-3/AD-7 vs AD-4/AD-6 | Dev environment entirely broken (CORS) |
| L-1 | Low | AD-4 vs AD-6 | SSE error handling diverges silently |
