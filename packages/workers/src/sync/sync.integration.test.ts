// Integration test for the Sync worker's processUpdate/processDelete against a
// REAL Postgres (AC-8). A FAKE embedder produces deterministic DIMENSIONS-length
// vectors — a real embeddings API is NEVER called in tests. Covers what unit
// tests can't: the real pgvector purge, the FK-safe read-status cascade
// (note #5), UPSERT/redelivery convergence, and the soft-vs-hard delete branch.
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import type { HivlyConfig } from '@hivly/shared';
import { sql } from '@hivly/shared/db';
import type { MessageDeletedEvent, MessageUpdatedEvent } from '@hivly/shared/types/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Embedder } from '../indexer/types.js';
import type { Logger } from '../logger.js';
import { openTestClients, type TestClients } from '../test-helpers.js';
import { processDelete as processDeleteImpl, type ProcessDeleteDeps } from './processDelete.js';
import { processUpdate as processUpdateImpl, type ProcessUpdateDeps } from './processUpdate.js';

// The consumer always supplies streamId/stream (AC-5); inject fixed values so
// these state-focused integration calls stay unchanged.
function processUpdate(deps: Omit<ProcessUpdateDeps, 'streamId' | 'stream'>) {
  return processUpdateImpl({ ...deps, streamId: 's-itest', stream: 'hivly:discord:messages:updated' });
}
function processDelete(deps: Omit<ProcessDeleteDeps, 'streamId' | 'stream'>) {
  return processDeleteImpl({ ...deps, streamId: 's-itest', stream: 'hivly:discord:messages:deleted' });
}

const DIMENSIONS = 1536;

const softConfig = {
  knowledge: { chunk_size: 500, chunk_overlap: 50, grouping_window: 10 },
  embeddings: { dimensions: DIMENSIONS },
  sync: { enabled: true, sync_on_start: false, delete_policy: 'soft' },
} as unknown as HivlyConfig;

const hardConfig = {
  ...softConfig,
  sync: { enabled: true, sync_on_start: false, delete_policy: 'hard' },
} as unknown as HivlyConfig;

// Silent logger — these tests assert on state, not logs.
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const goodEmbedder: Embedder = {
  embedDocuments: (texts) => Promise.resolve(texts.map(() => new Array(DIMENSIONS).fill(0.02))),
};

function runSuffix(): string {
  return `itest-6-2-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
}

describe('Sync worker (integration)', () => {
  let clients: TestClients;
  const createdMessageIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    clients = await openTestClients();
  });

  afterAll(async () => {
    const { db } = clients;
    for (const userId of createdUserIds) {
      await db.execute(sql`delete from user_read_status where user_id = ${userId}`);
      await db.execute(sql`delete from users where id = ${userId}`);
    }
    for (const id of createdMessageIds) {
      await db.execute(sql`delete from embeddings where ${id} = ANY(message_ids)`);
      await db.execute(sql`delete from discord_messages where id = ${id}`);
    }
    await clients.close();
  });

  async function seedMessage(id: string, channelId: string, content: string): Promise<void> {
    createdMessageIds.push(id);
    await clients.db.execute(sql`
      insert into discord_messages (id, channel_id, guild_id, author_id, content, created_at, updated_at)
      values (${id}, ${channelId}, 'itest-guild', 'itest-author', ${content}, now(), now())
    `);
  }

  async function seedEmbedding(
    chunkKey: string,
    channelId: string,
    messageIds: string[],
    description: string,
  ): Promise<string> {
    const messageIdsLiteral = `{${messageIds.join(',')}}`;
    const vec = new Array(DIMENSIONS).fill(0.01);
    const result = await clients.db.execute(sql`
      insert into embeddings (chunk_key, title, description, link, embedding, channel_id, message_ids, created_at)
      values (${chunkKey}, '', ${description}, '', ${JSON.stringify(vec)}::vector, ${channelId},
              ${messageIdsLiteral}::text[], now())
      returning id
    `);
    return String((result.rows[0] as Record<string, unknown>).id);
  }

  async function seedUser(suffix: string): Promise<string> {
    const result = await clients.db.execute(sql`
      insert into users (discord_id, username) values (${`itest-user-${suffix}`}, 'Itest User')
      returning id
    `);
    const id = String((result.rows[0] as Record<string, unknown>).id);
    createdUserIds.push(id);
    return id;
  }

  async function seedReadStatus(userId: string, embeddingId: string): Promise<void> {
    await clients.db.execute(sql`
      insert into user_read_status (user_id, embedding_id) values (${userId}, ${embeddingId})
    `);
  }

  async function fetchEmbeddingRows(messageId: string): Promise<Record<string, unknown>[]> {
    const result = await clients.db.execute(
      sql`select id, chunk_key, description, message_ids, vector_dims(embedding) as dims
          from embeddings where ${messageId} = ANY(message_ids)`,
    );
    return result.rows as Record<string, unknown>[];
  }

  async function fetchMessage(id: string): Promise<Record<string, unknown>> {
    const result = await clients.db.execute(
      sql`select content, updated_at, indexed_at, deleted_at from discord_messages where id = ${id}`,
    );
    return result.rows[0] as Record<string, unknown>;
  }

  it('should re-index an update: purge old chunks, refresh content, insert new chunk, cascade read-status, converge on redelivery', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-a`;
    const channelId = `chan-${suffix}`;
    await seedMessage(id, channelId, 'ORIGINAL-DB-CONTENT');
    const oldEmbeddingId = await seedEmbedding(`${id}:0`, channelId, [id], 'old chunk content');
    const userId = await seedUser(suffix);
    await seedReadStatus(userId, oldEmbeddingId); // FK-dependent row on the old chunk

    const event: MessageUpdatedEvent = {
      type: 'discord.message.updated',
      messageId: id,
      channelId,
      guildId: 'itest-guild',
      timestamp: new Date().toISOString(),
      newContent: 'brand new edited content',
    };

    const result = await processUpdate({
      event,
      db: clients.db,
      embedder: goodEmbedder,
      config: softConfig,
      logger,
    });
    expect(result).toEqual({ ack: true });

    const rows = await fetchEmbeddingRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].chunk_key).toBe(`${id}:0`);
    expect(rows[0].description).toBe('brand new edited content');
    expect(rows[0].dims).toBe(DIMENSIONS);
    expect(rows[0].message_ids).toEqual([id]);
    expect(rows[0].id).not.toBe(oldEmbeddingId); // old chunk was actually purged, not reused

    const dm = await fetchMessage(id);
    expect(dm.content).toBe('brand new edited content');
    expect(dm.indexed_at).not.toBeNull();

    // The stale read-status row on the purged old chunk is simply gone — no FK
    // violation (note #5: read-status deleted BEFORE embeddings).
    const staleReadStatus = await clients.db.execute(
      sql`select 1 from user_read_status where embedding_id = ${oldEmbeddingId}`,
    );
    expect(staleReadStatus.rows).toHaveLength(0);

    // Redeliver the same event → converges (still exactly one chunk).
    const result2 = await processUpdate({
      event,
      db: clients.db,
      embedder: goodEmbedder,
      config: softConfig,
      logger,
    });
    expect(result2).toEqual({ ack: true });
    expect(await fetchEmbeddingRows(id)).toHaveLength(1);
  });

  it('should skip an update for an unknown message (no discord_messages row) with no writes', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-unknown`; // deliberately never seeded
    const event: MessageUpdatedEvent = {
      type: 'discord.message.updated',
      messageId: id,
      channelId: `chan-${suffix}`,
      guildId: 'itest-guild',
      timestamp: new Date().toISOString(),
      newContent: 'should never be written',
    };

    const result = await processUpdate({
      event,
      db: clients.db,
      embedder: goodEmbedder,
      config: softConfig,
      logger,
    });

    expect(result).toEqual({ ack: true });
    expect(await fetchEmbeddingRows(id)).toHaveLength(0);
  });

  it('should soft-delete: set deleted_at, keep embeddings intact, and exclude the chunk from the D1 anti-join', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-b`;
    const channelId = `chan-${suffix}`;
    await seedMessage(id, channelId, 'content b');
    const embeddingId = await seedEmbedding(`${id}:0`, channelId, [id], 'chunk b content');

    const event: MessageDeletedEvent = {
      type: 'discord.message.deleted',
      messageId: id,
      channelId,
      guildId: 'itest-guild',
      timestamp: new Date().toISOString(),
    };

    const result = await processDelete({ event, db: clients.db, config: softConfig, logger });
    expect(result).toEqual({ ack: true });

    const dm = await fetchMessage(id);
    expect(dm.deleted_at).not.toBeNull();
    expect(await fetchEmbeddingRows(id)).toHaveLength(1); // embeddings row untouched (AC-3)

    // D1 exclude-if-any anti-join (mirrors embeddingSearchRepository.drizzle.ts) —
    // the chunk is invisible to every read path the moment the message is soft-deleted.
    const visible = await clients.db.execute(sql`
      select e.id from embeddings e
      where e.id = ${embeddingId}
        and not exists (
          select 1 from discord_messages d
          where d.id = any(e.message_ids) and d.deleted_at is not null
        )
    `);
    expect(visible.rows).toHaveLength(0);

    // Idempotent: a second soft delete affects 0 rows, no throw, still acked.
    const result2 = await processDelete({ event, db: clients.db, config: softConfig, logger });
    expect(result2).toEqual({ ack: true });
  });

  it('should hard-delete: purge embeddings + read-status (FK-safe) and set deleted_at', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-c`;
    const channelId = `chan-${suffix}`;
    await seedMessage(id, channelId, 'content c');
    const embeddingId = await seedEmbedding(`${id}:0`, channelId, [id], 'chunk c content');
    const userId = await seedUser(suffix);
    await seedReadStatus(userId, embeddingId);

    const event: MessageDeletedEvent = {
      type: 'discord.message.deleted',
      messageId: id,
      channelId,
      guildId: 'itest-guild',
      timestamp: new Date().toISOString(),
    };

    const result = await processDelete({ event, db: clients.db, config: hardConfig, logger });
    expect(result).toEqual({ ack: true });

    expect(await fetchEmbeddingRows(id)).toHaveLength(0); // embeddings purged (AC-4)

    const readStatus = await clients.db.execute(
      sql`select 1 from user_read_status where embedding_id = ${embeddingId}`,
    );
    expect(readStatus.rows).toHaveLength(0); // note #5: FK-safe cascade — no violation

    const dm = await fetchMessage(id);
    expect(dm.deleted_at).not.toBeNull(); // hard delete is a superset of soft (DECISION 3)

    // Idempotent: a second hard delete affects 0 rows, no throw, still acked.
    const result2 = await processDelete({ event, db: clients.db, config: hardConfig, logger });
    expect(result2).toEqual({ ack: true });
  });
});
