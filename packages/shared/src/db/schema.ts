// Drizzle schema — the single source of truth for the Share2Brain data model (AD-5).
// No DDL exists anywhere else; migrations are generated from this file with
// drizzle-kit as explicit SQL. DB column names are snake_case; TS property
// names are camelCase (Drizzle maps between them).
//
// NOTE: There is intentionally NO `sessions` table. Sessions live in Redis via
// express-session + connect-redis (AD-10). Do not add one here.
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

import { readEmbeddingDimensions } from '../config/embeddingDimensions.js';

// The embeddings vector width is parametrized from `embeddings.dimensions` in
// Share2Brain.config.yml, read at generate-time by a minimal YAML reader (NOT the full
// loadConfig, which would abort generate on unset ${VAR}). schema.ts stays the
// single DDL source of truth (AD-5); only the width is deploy-time configurable.
// Default 1536 → identical DDL to before, so no migration diff for existing setups.
const EMBEDDING_DIMENSIONS = readEmbeddingDimensions();

/** A single cited source rendered alongside an assistant answer. */
export interface Citation {
  title: string;
  channel: string;
  author: string;
  date: string;
  link: string;
}

// 1. discord_messages — raw Discord messages captured by the Bot (owner: bot).
export const discordMessages = pgTable(
  'discord_messages',
  {
    id: text('id').primaryKey(), // Discord snowflake
    channelId: text('channel_id').notNull(),
    guildId: text('guild_id').notNull(),
    authorId: text('author_id').notNull(),
    authorName: text('author_name'), // nullable — visible display name captured at ingestion (9.4); old rows stay NULL
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }), // nullable — set by the Indexer
    deletedAt: timestamp('deleted_at', { withTimezone: true }), // nullable — soft-delete marker
  },
  (table) => [
    index('idx_discord_messages_channel').on(table.channelId, table.createdAt.desc()),
  ],
);

// 2. embeddings — one row per resource link extracted from a message (owner: workers).
export const embeddings = pgTable(
  'embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Deterministic dedup key `"<messageId>:<urlIndex>"` (Epic 7 — one row per URL
    // of one message; Story 3.3's `"<firstMessageId>:<chunkIndex>"` grouping/chunking
    // semantics are superseded). The Indexer UPSERTs on this so a re-delivered stream
    // event (redelivery or a producer duplicate) converges to the same row instead of
    // inserting a duplicate (AD-13 at-least-once idempotency). Message snowflakes are
    // globally unique, so the channel is implicit and never part of the key.
    chunkKey: text('chunk_key').notNull(),
    title: text('title').notNull(), // AI-generated (Story 7.2)
    description: text('description').notNull(), // AI-generated (Story 7.2)
    link: text('link').notNull(), // the extracted URL (Story 7.2)
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    channelId: text('channel_id').notNull(), // the RBAC filter column (AD-12)
    // Length-1 array: `messageIds[0]` is the anchor message for the Search/Docs
    // projection (kept as an array for compatibility with the pre-Epic-7 shape).
    messageIds: text('message_ids').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('idx_embeddings_chunk_key').on(table.chunkKey),
    index('idx_embeddings_vector').using('hnsw', table.embedding.op('vector_cosine_ops')),
    // Composite replaces the old single-column channel index (D2 — (channel_id) is a
    // prefix of (channel_id, created_at DESC), so every prior query stays served).
    // Backs the stats endpoint's 14-day activity aggregation (AC4).
    index('idx_embeddings_channel_created').on(table.channelId, table.createdAt.desc()),
  ],
);

// 3. users — application users, created on Discord OAuth2 login (owner: backend).
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    discordId: text('discord_id').notNull(),
    username: text('username').notNull(),
    avatar: text('avatar'), // nullable
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('idx_users_discord_id').on(table.discordId)],
);

// 4. user_roles_cache — TTL-cached Discord roles per user for RBAC (owner: backend).
export const userRolesCache = pgTable('user_roles_cache', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  discordRoles: text('discord_roles').array().notNull(),
  cachedAt: timestamp('cached_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

// 5. channel_permissions — RBAC policy materialized from config at startup (owner: backend).
export const channelPermissions = pgTable('channel_permissions', {
  channelId: text('channel_id').primaryKey(), // Discord snowflake
  name: text('name').notNull(),
  allowedRoles: text('allowed_roles').array().notNull(),
  categoryId: text('category_id'), // nullable — NULL for direct channels
});

// 6. conversations — a user's chat conversation with the RAG agent (owner: backend).
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      // Deleting a user (e.g. GDPR erasure) cascades to their conversations —
      // FKs in Postgres do NOT create indexes, hence the explicit index below.
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Backs GET /api/conversations (filter by user_id, newest-first) — without it
  // that authenticated endpoint is a seq-scan, a cheap degradation vector.
  (table) => [index('idx_conversations_user').on(table.userId, table.updatedAt.desc())],
);

// 7. messages — individual messages within a conversation, with citations (owner: backend).
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),
    citations: jsonb('citations').$type<Citation[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Backs loading a conversation's messages in order.
  (table) => [index('idx_messages_conversation').on(table.conversationId, table.createdAt)],
);

// 8. user_read_status — per-user read tracking over indexed fragments (owner: backend).
export const userReadStatus = pgTable(
  'user_read_status',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    embeddingId: uuid('embedding_id')
      .notNull()
      // A hard-deleted embedding (sync delete_policy: 'hard') cascades away its
      // read-status rows instead of failing the delete on an FK violation.
      .references(() => embeddings.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.embeddingId] }),
    index('idx_user_read_status_user').on(table.userId),
    index('idx_user_read_status_embedding').on(table.embeddingId),
  ],
);
