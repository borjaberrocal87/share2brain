# Data Model Documentation

This document describes the data model for **Share2Brain Self-Hosted**, including entity descriptions, field definitions, relationships, and an entity-relationship diagram.

**Source of truth:** all tables are defined with Drizzle in `packages/shared/src/db/schema.ts`. No service defines tables or performs DDL outside `packages/shared` (AD-5). Migrations are generated as explicit SQL with `drizzle-kit`.

**Conventions:**
- IDs: Discord snowflake (`string`) for Discord entities; UUID v4 for own entities (conversations, embeddings, users).
- Dates: `timestamp with time zone` in PostgreSQL; ISO 8601 UTC when serialized.
- Vector search uses the `pgvector` extension. Embedding provider/model are configurable (`embeddings.*`); the vector dimension is declared in `embeddings.dimensions` (deploy-time) — default `text-embedding-3-small` / 1536.
- **Sessions are NOT a table** — they live in Redis via `connect-redis` (AD-10).

## Write Ownership

Only the service that owns a table writes to it (AD, State Ownership):

| Table | Owner (writes) | Readers |
|---|---|---|
| `discord_messages` | bot (create); workers — Sync (edit refresh of `content`/`updated_at`/`author_name`) | workers, backend |
| `embeddings` | workers — Indexer (insert), Sync (update/delete) | backend |
| `channel_permissions` | backend (upsert from config at startup) | backend |
| `user_roles_cache` | backend (login + OAuth2 refresh) | backend |
| `conversations`, `messages` | backend | web (via API) |
| `user_read_status` | backend | web (via API) |
| `users` | backend (Discord OAuth2 login + guest seed at startup) | backend |

## Model Descriptions

### 1. discord_messages
Raw Discord messages captured by the Bot. The Bot is the only writer on create; the Sync worker
also refreshes `content`, `updated_at`, and (Story 9.4) `author_name` on the edit path.

**Fields:**
- `id`: Discord snowflake (Primary Key, string)
- `channel_id`: Discord channel snowflake
- `guild_id`: Discord guild snowflake
- `author_id`: Discord author snowflake
- `author_name`: author's visible display name (`globalName ?? username`) captured at ingestion
  (Story 9.4); nullable, no default — rows written before this column existed stay `NULL` forever
  (no backfill). Refreshed on edit (a newer display name is newer truth); never written by the
  create path when it already holds a value (`onConflictDoNothing`).
- `content`: message text
- `created_at`: message creation timestamp
- `updated_at`: last edit timestamp
- `indexed_at`: stamped by the Indexer on first index, and re-stamped by the Sync worker on every
  edit (link-diff reconciliation, Story 7.3) — even a discard/zero-URL outcome stamps it, so the
  column means "evaluated", not "has resource rows" (nullable)
- `deleted_at`: soft-delete marker (nullable; NULL if not deleted)

**Notes:** the Bot tracks `last_seen_message_id` per channel (the highest snowflake seen) to reconcile backfill after downtime.

### 2. embeddings
One row per curated resource link extracted from a Discord message (Epic 7 — AI-curated resource
index; supersedes the pre-Epic-7 grouped/chunked-content model). Written by the Workers; read by
the Backend for search, documents, and RAG.

**Fields:**
- `id`: UUID (Primary Key)
- `chunk_key`: deterministic dedup key, `"<messageId>:<urlIndex>"` — one key per URL of one
  message (message snowflakes are globally unique, so the channel is implicit and never part of
  the key). Unique-indexed (`idx_embeddings_chunk_key`); this is the UPSERT target, not `id`.
- `title`: AI-generated title for the linked resource, produced by `enrichment.llm` in
  `enrichment.language` (Story 7.2)
- `description`: AI-generated description for the linked resource, produced by `enrichment.llm`
  (Story 7.2)
- `link`: the extracted, normalized URL (`URL.href` — lowercased scheme/host, percent-normalized;
  Story 7.2). The `link` contract is strict since Story 7.4 (`isHttpUrl`, no empty-string
  placeholder) — an empty-link row is legacy pre-7.4 data and fails the API/RAG Zod parse, so it
  must be purged by the Epic 7 clean-slate runbook before deploying 7.4. There is intentionally
  **no** unique index on `link` (`chunk_key` is the dedup key)
- `embedding`: `vector(N)` where `N = embeddings.dimensions` (pgvector; parametrized at deploy-time, default 1536)
- `channel_id`: Discord channel snowflake (used for the RBAC filter)
- `message_ids`: `string[]`, length 1 — `message_ids[0]` is the anchor message the Search/Docs
  projection joins against (the array shape is kept for compatibility with the pre-Epic-7 model,
  which allowed multiple grouped messages per row)
- `created_at`: timestamp

**Notes:** Workers are idempotent — re-processing must UPSERT on `chunk_key` (the unique index),
never on `id`, and never error (at-least-once delivery, AD-13).

### 3. users
Application users, created on Discord OAuth2 login. Backend-owned.

**Fields:**
- `id`: UUID (Primary Key)
- `discord_id`: Discord user snowflake (Unique)
- `username`: Discord username
- `avatar`: avatar hash/URL
- `created_at`: timestamp

**Notes:** when `access_control.guest_access.enabled`, the Backend seeds one guest row at startup with the sentinel `discord_id = "guest"` (an explicit exception to the "snowflake for Discord entities" convention above) and a fixed UUID (`GUEST_USER_ID`). The upsert is idempotent on `discord_id`; a pre-existing guest row keeps its id (Historia 2.5).

### 4. user_roles_cache
Cached Discord roles per user, to answer RBAC without hitting the Discord API on every request. TTL-based.

**Fields:**
- `user_id`: FK → users.id
- `discord_roles`: `string[]` of Discord role IDs in the guild
- `cached_at`: timestamp
- `expires_at`: TTL expiry (configurable via `access_control.role_cache_ttl`)

### 5. channel_permissions
RBAC policy materialized from `Share2Brain.config.yml` at Backend startup (upsert). Maps channels to the roles allowed to read them.

**Fields:**
- `channel_id`: Discord channel snowflake (Primary Key)
- `name`: human-readable channel name
- `allowed_roles`: `string[]` of Discord role IDs allowed to access the channel
- `category_id`: Discord category snowflake (nullable; NULL for direct channels)

**Notes:** `allowedChannelIds` are computed per request by joining `session.discordRoles` against this table (not cached in the session), so a permissions change takes effect on the next request (AD-12).

### 6. conversations
A user's chat conversation with the RAG agent. Backend-owned.

**Fields:**
- `id`: UUID (Primary Key)
- `user_id`: FK → users.id (guest conversations attach to the seeded guest `users` row — Historia 2.5)
- `created_at`: timestamp
- `updated_at`: timestamp

### 7. messages
Individual messages within a conversation (user / assistant / system), with citations.

**Fields:**
- `id`: UUID (Primary Key)
- `conversation_id`: FK → conversations.id
- `role`: `"user" | "assistant" | "system"`
- `content`: message text
- `citations`: `jsonb` array of sources (`title`, `channel`, `author`, `date`, `link` — Epic 7;
  `title` added in Story 7.4)
- `created_at`: timestamp

### 8. user_read_status
Per-user read tracking over indexed fragments.

**Fields:**
- `user_id`: FK → users.id
- `embedding_id`: FK → embeddings.id
- `read_at`: timestamp

## Entity Relationship Diagram

```mermaid
erDiagram
    discord_messages {
        string id PK "Discord snowflake"
        string channel_id
        string guild_id
        string author_id
        string author_name "nullable, no backfill (9.4)"
        text content
        timestamp created_at
        timestamp updated_at
        timestamp indexed_at
        timestamp deleted_at "NULL if not deleted"
    }
    embeddings {
        uuid id PK
        string chunk_key UK "messageId:urlIndex"
        text title "AI-generated"
        text description "AI-generated"
        text link "extracted URL"
        vector embedding "N dims (embeddings.dimensions)"
        string channel_id
        string[] message_ids "length 1 — [0] is the anchor"
        timestamp created_at
    }
    users {
        uuid id PK
        string discord_id UK
        string username
        string avatar
        timestamp created_at
    }
    user_roles_cache {
        uuid user_id FK
        string[] discord_roles
        timestamp cached_at
        timestamp expires_at
    }
    channel_permissions {
        string channel_id PK
        string name
        string[] allowed_roles
        string category_id "NULL if direct channel"
    }
    conversations {
        uuid id PK
        uuid user_id FK
        timestamp created_at
        timestamp updated_at
    }
    messages {
        uuid id PK
        uuid conversation_id FK
        string role "user | assistant | system"
        text content
        jsonb citations "Array of sources"
        timestamp created_at
    }
    user_read_status {
        uuid user_id FK
        uuid embedding_id FK
        timestamp read_at
    }

    users ||--o{ conversations : "has"
    conversations ||--o{ messages : "contains"
    users ||--o{ user_read_status : "has"
    embeddings ||--o{ user_read_status : "referenced by"
    users ||--o| user_roles_cache : "has"
```

## Critical Indexes

```sql
-- Idempotency / UPSERT target (AD-13) — stale/omitted since Story 3.3, documented here
CREATE UNIQUE INDEX idx_embeddings_chunk_key ON embeddings(chunk_key);

-- Vector search (HNSW, cosine)
CREATE INDEX idx_embeddings_vector ON embeddings USING hnsw (embedding vector_cosine_ops);

-- RBAC filter on vector search + the stats endpoint's 14-day activity aggregation
-- (Story 9.1, D2 — composite replaces the old single-column idx_embeddings_channel;
-- (channel_id) is a prefix of (channel_id, created_at DESC), so every prior query
-- served by the old index is served by the new one).
CREATE INDEX idx_embeddings_channel_created ON embeddings(channel_id, created_at DESC);

-- Channel/date lookups over Discord messages
CREATE INDEX idx_discord_messages_channel ON discord_messages(channel_id, created_at DESC);

-- Read tracking
CREATE INDEX idx_user_read_status_user ON user_read_status(user_id);
CREATE INDEX idx_user_read_status_embedding ON user_read_status(embedding_id);
```

## Key Design Principles

1. **RBAC at the query layer**: every vector query includes `WHERE channel_id = ANY(:allowedChannelIds)` — the filter is part of the SQL, never a post-filter (AD-12).
2. **Single DDL source**: all tables and migrations originate in `packages/shared` (AD-5); no service diverges.
3. **Idempotent ingestion**: at-least-once Redis Streams delivery means Workers UPSERT embeddings rather than assume single delivery (AD-13).
4. **Config-materialized permissions**: `channel_permissions` is derived from `Share2Brain.config.yml` on Backend startup — there is no admin panel; everything is code/config.
5. **Sessions out of PostgreSQL**: sessions live in Redis with TTL for fast reads and immediate revocation (AD-10).

## Notes

- Own entities (`users`, `conversations`, `messages`, `embeddings`) use UUID v4 primary keys; Discord entities use snowflake string IDs.
- The `sessions` table referenced in early drafts of the PRD **does not exist** — Redis is the single source of truth for sessions.
- Optional/nullable fields (`indexed_at`, `deleted_at`, `category_id`) allow flexible state while keeping required core information.
