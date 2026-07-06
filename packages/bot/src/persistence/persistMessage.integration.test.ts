// Integration test for persistMessage against a REAL Postgres + Redis (AC-2, AD-13).
// Covers the layer unit tests can't: the actual atomic INSERT + XADD, the exact
// persisted columns, the exact stream fields, and the rollback guarantee — a
// forced XADD failure leaves ZERO rows behind.
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import type { HivlyConfig } from '@hivly/shared';
import { sql } from '@hivly/shared/db';
import type { RedisClient } from '@hivly/shared/redis';
import { STREAM_KEYS } from '@hivly/shared/types/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { persistMessage, type IngestibleMessage } from './persistMessage.js';
import { openTestClients, type TestClients } from '../test-helpers.js';

const config = {
  discord: { guild_id: 'itest-guild-fallback' },
} as unknown as HivlyConfig;

/** A unique-per-run message id so parallel/repeat runs never collide on the PK. */
function uniqueId(): string {
  return `itest-3-1-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
}

function message(id: string, overrides: Partial<IngestibleMessage> = {}): IngestibleMessage {
  return {
    id,
    channelId: 'itest-channel',
    guildId: 'itest-guild',
    content: 'integration message',
    createdAt: new Date('2026-07-06T10:00:00.000Z'),
    author: { id: 'itest-author', bot: false },
    ...overrides,
  };
}

describe('persistMessage (integration)', () => {
  let clients: TestClients;
  const createdIds: string[] = [];
  const createdStreamIds: string[] = [];

  beforeAll(async () => {
    clients = await openTestClients();
  });

  afterAll(async () => {
    // Clean up rows + stream entries this test created, then close the clients.
    for (const id of createdIds) {
      await clients.db.execute(sql`delete from discord_messages where id = ${id}`);
    }
    if (createdStreamIds.length > 0) {
      await clients.redis.xDel(STREAM_KEYS.DISCORD_MESSAGES, createdStreamIds);
    }
    await clients.close();
  });

  it('should INSERT the row and XADD the stream event with the exact fields', async () => {
    const id = uniqueId();
    createdIds.push(id);

    await persistMessage(message(id), { config, db: clients.db, redis: clients.redis });

    // Row landed with the right columns (raw SQL → snake_case).
    const rows = await clients.db.execute(
      sql`select id, channel_id, guild_id, author_id, content, created_at, updated_at, indexed_at, deleted_at
          from discord_messages where id = ${id}`,
    );
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0] as Record<string, unknown>;
    expect(row.channel_id).toBe('itest-channel');
    expect(row.guild_id).toBe('itest-guild');
    expect(row.author_id).toBe('itest-author');
    expect(row.content).toBe('integration message');
    // updatedAt mirrors createdAt; the Indexer sets indexed_at later (still NULL here).
    expect(new Date(row.updated_at as string).toISOString()).toBe(
      new Date(row.created_at as string).toISOString(),
    );
    expect(row.indexed_at).toBeNull();
    expect(row.deleted_at).toBeNull();

    // Exactly one stream entry carries this messageId, with all the mapped fields.
    const entries = await clients.redis.xRange(STREAM_KEYS.DISCORD_MESSAGES, '-', '+');
    const mine = entries.filter((e) => e.message.messageId === id);
    expect(mine).toHaveLength(1);
    createdStreamIds.push(mine[0].id);
    expect(mine[0].message).toMatchObject({
      type: 'discord.message.created',
      messageId: id,
      channelId: 'itest-channel',
      guildId: 'itest-guild',
      timestamp: '2026-07-06T10:00:00.000Z',
      content: 'integration message',
      authorId: 'itest-author',
    });
  });

  it('should roll back the INSERT (0 rows) when the XADD fails', async () => {
    const id = uniqueId();
    createdIds.push(id); // registered for cleanup even though we expect 0 rows

    const brokenRedis = {
      xAdd: () => Promise.reject(new Error('forced xadd failure')),
    } as unknown as RedisClient;

    await expect(
      persistMessage(message(id), { config, db: clients.db, redis: brokenRedis }),
    ).rejects.toThrow('forced xadd failure');

    const rows = await clients.db.execute(
      sql`select count(*)::int as n from discord_messages where id = ${id}`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });
});
