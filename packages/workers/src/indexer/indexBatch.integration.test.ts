// Integration test for the Indexer against a REAL Postgres + Redis (AC-7, AD-13).
// A FAKE embedder produces deterministic DIMENSIONS-length vectors — a real
// embeddings API is NEVER called in tests. Covers what unit tests can't: the real
// pgvector UPSERT, the RETURNING-gated stamp, and the real consumer-group PEL /
// XACK semantics (idempotent redelivery, failure-leaves-entry-pending).
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import type { HivlyConfig } from '@hivly/shared';
import { sql } from '@hivly/shared/db';
import { STREAM_KEYS } from '@hivly/shared/types/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Logger } from '../logger.js';
import { indexBatch } from './indexBatch.js';
import type { Embedder, RawStreamEntry } from './types.js';
import { openTestClients, type TestClients } from '../test-helpers.js';

const STREAM = STREAM_KEYS.DISCORD_MESSAGES;
const DIMENSIONS = 1536;

const config = {
  knowledge: { chunk_size: 500, chunk_overlap: 50, grouping_window: 10 },
  embeddings: { dimensions: DIMENSIONS },
} as unknown as HivlyConfig;

// Silent logger — these tests assert on state, not logs.
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const goodEmbedder: Embedder = {
  embedDocuments: (texts) => Promise.resolve(texts.map(() => new Array(DIMENSIONS).fill(0.01))),
};
const failingEmbedder: Embedder = {
  embedDocuments: () => Promise.reject(new Error('embedder down')),
};

function runSuffix(): string {
  return `itest-3-3-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
}

describe('Indexer (integration)', () => {
  let clients: TestClients;
  const createdIds: string[] = [];
  const createdStreamIds: string[] = [];
  const createdGroups: string[] = [];

  beforeAll(async () => {
    clients = await openTestClients();
  });

  afterAll(async () => {
    const { db, redis } = clients;
    for (const group of createdGroups) {
      await redis.xGroupDestroy(STREAM, group).catch(() => undefined);
    }
    if (createdStreamIds.length > 0) {
      await redis.xDel(STREAM, createdStreamIds).catch(() => undefined);
    }
    for (const id of createdIds) {
      await db.execute(sql`delete from embeddings where chunk_key like ${`${id}:%`}`);
      await db.execute(sql`delete from discord_messages where id = ${id}`);
    }
    await clients.close();
  });

  /** Seed a discord_messages row (indexed_at NULL). Its content is a marker that
   *  must NOT surface in embeddings — the Indexer embeds the EVENT's content. */
  async function seedMessage(id: string, channelId: string): Promise<void> {
    createdIds.push(id);
    await clients.db.execute(
      sql`insert into discord_messages (id, channel_id, guild_id, author_id, content, created_at, updated_at)
          values (${id}, ${channelId}, 'itest-guild', 'itest-author', 'DB-CONTENT-MUST-NOT-BE-EMBEDDED', now(), now())`,
    );
  }

  async function xaddEvent(id: string, channelId: string, content: string): Promise<string> {
    const streamId = await clients.redis.xAdd(STREAM, '*', {
      type: 'discord.message.created',
      messageId: id,
      channelId,
      guildId: 'itest-guild',
      timestamp: new Date().toISOString(),
      content,
      authorId: 'itest-author',
    });
    createdStreamIds.push(streamId);
    return streamId;
  }

  /** Create a fresh test consumer group at the CURRENT tail so a following read of
   *  '>' delivers only the entries this test XADDs — isolating from other entries. */
  async function freshGroup(suffix: string): Promise<string> {
    const group = `hivly:indexer:${suffix}`;
    createdGroups.push(group);
    await clients.redis.xGroupCreate(STREAM, group, '$', { MKSTREAM: true });
    return group;
  }

  async function readAsGroup(group: string): Promise<RawStreamEntry[]> {
    const res = await clients.redis.xReadGroup(
      group,
      'consumer-itest',
      { key: STREAM, id: '>' },
      { COUNT: 100 },
    );
    return (res?.[0]?.messages ?? []) as RawStreamEntry[];
  }

  it('should embed the event content, stamp indexed_at, and drain the PEL', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-a`;
    const channelId = `chan-${suffix}`;
    const group = await freshGroup(suffix);
    await seedMessage(id, channelId);
    await xaddEvent(id, channelId, 'real event content to index');

    const entries = await readAsGroup(group);
    expect(entries.map((e) => e.message?.messageId)).toContain(id);

    const { ackIds } = await indexBatch({ entries, db: clients.db, embedder: goodEmbedder, config, logger });
    for (const aid of ackIds) await clients.redis.xAck(STREAM, group, aid);

    // Embeddings row: correct dims, channel, message_ids, and the EVENT content
    // (reconciliation note 5 — never the DB row's content).
    const rows = await clients.db.execute(
      sql`select chunk_key, description, channel_id, message_ids, vector_dims(embedding) as dims
          from embeddings where chunk_key = ${`${id}:0`}`,
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0] as Record<string, unknown>;
    expect(row.channel_id).toBe(channelId);
    expect(row.dims).toBe(DIMENSIONS);
    expect(row.message_ids).toEqual([id]);
    expect(row.description).toBe('real event content to index');

    // indexed_at stamped; PEL drained.
    const dm = await clients.db.execute(sql`select indexed_at from discord_messages where id = ${id}`);
    expect((dm.rows[0] as Record<string, unknown>).indexed_at).not.toBeNull();

    const pending = await clients.redis.xPending(STREAM, group);
    expect(pending.pending).toBe(0);
  });

  it('should not create duplicate rows on redelivery (dedup + chunk_key UPSERT)', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-b`;
    const channelId = `chan-${suffix}`;
    await seedMessage(id, channelId);

    // First pass → one row, indexed_at stamped.
    const group1 = await freshGroup(`${suffix}-1`);
    await xaddEvent(id, channelId, 'content b');
    const first = await readAsGroup(group1);
    const r1 = await indexBatch({ entries: first, db: clients.db, embedder: goodEmbedder, config, logger });
    for (const aid of r1.ackIds) await clients.redis.xAck(STREAM, group1, aid);

    // Second pass, same message — now indexed_at is set, so dedup ackNow skips it.
    const group2 = await freshGroup(`${suffix}-2`);
    await xaddEvent(id, channelId, 'content b');
    const second = await readAsGroup(group2);
    const r2 = await indexBatch({ entries: second, db: clients.db, embedder: goodEmbedder, config, logger });
    expect(r2.ackIds).toHaveLength(second.length); // acked via dedup, not re-inserted

    // Force the chunk_key UPSERT path too: clear indexed_at and reprocess.
    await clients.db.execute(sql`update discord_messages set indexed_at = null where id = ${id}`);
    const group3 = await freshGroup(`${suffix}-3`);
    await xaddEvent(id, channelId, 'content b');
    const third = await readAsGroup(group3);
    const r3 = await indexBatch({ entries: third, db: clients.db, embedder: goodEmbedder, config, logger });
    for (const aid of r3.ackIds) await clients.redis.xAck(STREAM, group3, aid);

    const count = await clients.db.execute(
      sql`select count(*)::int as n from embeddings where message_ids @> array[${id}]::text[]`,
    );
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it('should leave the entry pending (un-acked) when the embedder fails', async () => {
    const suffix = runSuffix();
    const id = `${suffix}-c`;
    const channelId = `chan-${suffix}`;
    const group = await freshGroup(suffix);
    await seedMessage(id, channelId);
    await xaddEvent(id, channelId, 'content that will fail to embed');

    const entries = await readAsGroup(group);
    const { ackIds } = await indexBatch({ entries, db: clients.db, embedder: failingEmbedder, config, logger });
    for (const aid of ackIds) await clients.redis.xAck(STREAM, group, aid);

    // No ack → the entry is still pending; indexed_at untouched; no embeddings row.
    const pending = await clients.redis.xPending(STREAM, group);
    expect(pending.pending).toBe(1);

    const dm = await clients.db.execute(sql`select indexed_at from discord_messages where id = ${id}`);
    expect((dm.rows[0] as Record<string, unknown>).indexed_at).toBeNull();

    const count = await clients.db.execute(
      sql`select count(*)::int as n from embeddings where chunk_key = ${`${id}:0`}`,
    );
    expect((count.rows[0] as { n: number }).n).toBe(0);
  });

  it('should reject a duplicate consumer-group creation with BUSYGROUP (AC-1 tolerance basis)', async () => {
    const suffix = runSuffix();
    const group = `hivly:indexer:${suffix}-busy`;
    createdGroups.push(group);

    await clients.redis.xGroupCreate(STREAM, group, '$', { MKSTREAM: true });

    await expect(
      clients.redis.xGroupCreate(STREAM, group, '$', { MKSTREAM: true }),
    ).rejects.toThrow(/^BUSYGROUP/);
  });
});
