// Drizzle schema — the single source of truth for the Hivly data model (AD-5).
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
// Hivly.config.yml, read at generate-time by a minimal YAML reader (NOT the full
// loadConfig, which would abort generate on unset ${VAR}). schema.ts stays the
// single DDL source of truth (AD-5); only the width is deploy-time configurable.
// Default 1536 → identical DDL to before, so no migration diff for existing setups.
const EMBEDDING_DIMENSIONS = readEmbeddingDimensions();

/** A single cited source rendered alongside an assistant answer. */
export interface Citation {
  channel: string;
  author: string;
  date: string;
}

// 1. discord_messages — raw Discord messages captured by the Bot (owner: bot).
export const discordMessages = pgTable(
  'discord_messages',
  {
    id: text('id').primaryKey(), // Discord snowflake
    channelId: text('channel_id').notNull(),
    guildId: text('guild_id').notNull(),
    authorId: text('author_id').notNull(),
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

// 2. embeddings — vector index over grouped/chunked content (owner: workers).
export const embeddings = pgTable(
  'embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }).notNull(),
    channelId: text('channel_id').notNull(), // the RBAC filter column (AD-12)
    messageIds: text('message_ids').array().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('idx_embeddings_vector').using('hnsw', table.embedding.op('vector_cosine_ops')),
    index('idx_embeddings_channel').on(table.channelId),
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
    .references(() => users.id),
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
export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 7. messages — individual messages within a conversation, with citations (owner: backend).
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id')
    .notNull()
    .references(() => conversations.id),
  role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
  content: text('content').notNull(),
  citations: jsonb('citations').$type<Citation[]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// 8. user_read_status — per-user read tracking over indexed fragments (owner: backend).
export const userReadStatus = pgTable(
  'user_read_status',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    embeddingId: uuid('embedding_id')
      .notNull()
      .references(() => embeddings.id),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.embeddingId] }),
    index('idx_user_read_status_user').on(table.userId),
    index('idx_user_read_status_embedding').on(table.embeddingId),
  ],
);
