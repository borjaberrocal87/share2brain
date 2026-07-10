// Integration tests for the backfill primitives against a REAL Postgres + Redis:
// the cursor query's newest-by-created_at guarantee (including the 18- vs
// 19-digit snowflake trap a lexicographic MAX would fail), and the completed
// event landing in hivly:knowledge:events with the exact string fields.
// Discord itself is NEVER hit — the API is faked at the client boundary.
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import type { HivlyConfig } from '@hivly/shared';
import { sql } from '@hivly/shared/db';
import { STREAM_KEYS } from '@hivly/shared/types/events';
import type { Client } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runBackfill } from './backfiller.js';
import { getChannelCursor } from './cursor.js';
import { openTestClients, type TestClients } from '../test-helpers.js';

/** Unique-per-run marker so parallel/repeat runs never collide. */
const RUN = `itest-3-2-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
const CHANNEL = `${RUN}-chan`;

const config = {
  discord: {
    guild_id: `${RUN}-guild`,
    channels: [{ id: CHANNEL, name: 'itest', enabled: true }],
    backfill: { enabled: true, limit: 1000, ignore_bots: true },
  },
} as unknown as HivlyConfig;

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('backfill (integration)', () => {
  let clients: TestClients;
  const createdIds: string[] = [];
  const createdStreamEntries: Array<{ key: string; id: string }> = [];

  beforeAll(async () => {
    clients = await openTestClients();
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await clients.db.execute(sql`delete from discord_messages where id = ${id}`);
    }
    for (const entry of createdStreamEntries) {
      await clients.redis.xDel(entry.key, [entry.id]);
    }
    await clients.close();
  });

  async function insertRow(id: string, createdAt: string): Promise<void> {
    createdIds.push(id);
    await clients.db.execute(
      sql`insert into discord_messages (id, channel_id, guild_id, author_id, content, created_at, updated_at)
          values (${id}, ${CHANNEL}, ${`${RUN}-guild`}, ${`${RUN}-author`}, 'itest content', ${createdAt}, ${createdAt})`,
    );
  }

  it('should pick the newest row by created_at, not the lexicographically largest id', async () => {
    // The OLDER message has an 18-digit id starting with 9; the NEWER one a
    // 19-digit id starting with 1. String MAX(id) would return the older one.
    const older18 = '999999999999999999';
    const newer19 = '1000000000000000000';
    await insertRow(older18, '2021-12-01T00:00:00.000Z');
    await insertRow(newer19, '2026-07-01T00:00:00.000Z');

    await expect(getChannelCursor(clients.db, CHANNEL)).resolves.toBe(newer19);
  });

  it('should return null for a channel with no rows', async () => {
    await expect(getChannelCursor(clients.db, `${RUN}-empty-chan`)).resolves.toBeNull();
  });

  it('should land the completed event in hivly:knowledge:events with exact string fields', async () => {
    // Fake Discord at the client boundary: one gap page with a single message.
    const fetchedMessage = {
      id: '1000000000000000001',
      channelId: CHANNEL,
      guildId: `${RUN}-guild`,
      content: 'backfilled message',
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
      editedAt: null,
      author: { id: `${RUN}-author`, bot: false, displayName: 'Backfilled Author' },
    };
    createdIds.push(fetchedMessage.id);
    const channel = {
      isTextBased: () => true,
      messages: {
        fetch: (): Promise<Map<string, typeof fetchedMessage>> =>
          Promise.resolve(new Map([[fetchedMessage.id, fetchedMessage]])),
      },
    };
    const client = {
      channels: { fetch: () => Promise.resolve(channel) },
    } as unknown as Client;

    await runBackfill({
      client,
      config,
      db: clients.db,
      redis: clients.redis,
      logger: silentLogger,
      cursors: new Map([[CHANNEL, '1000000000000000000']]),
      signal: new AbortController().signal,
      sleep: () => Promise.resolve(),
    });

    // The backfilled row landed, carrying the captured author display name…
    const rows = await clients.db.execute(
      sql`select author_name from discord_messages where id = ${fetchedMessage.id}`,
    );
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as { author_name: string }).author_name).toBe('Backfilled Author');

    // …its MessageCreatedEvent went to the messages stream…
    const messageEntries = await clients.redis.xRange(STREAM_KEYS.DISCORD_MESSAGES, '-', '+');
    const mine = messageEntries.filter((e) => e.message.messageId === fetchedMessage.id);
    expect(mine).toHaveLength(1);
    createdStreamEntries.push({ key: STREAM_KEYS.DISCORD_MESSAGES, id: mine[0].id });

    // …and exactly one completed event for this run landed in knowledge:events.
    const knowledgeEntries = await clients.redis.xRange(STREAM_KEYS.KNOWLEDGE_EVENTS, '-', '+');
    const completed = knowledgeEntries.filter((e) => e.message.guildId === `${RUN}-guild`);
    expect(completed).toHaveLength(1);
    createdStreamEntries.push({ key: STREAM_KEYS.KNOWLEDGE_EVENTS, id: completed[0].id });
    expect(completed[0].message).toEqual({
      type: 'discord.backfill.completed',
      guildId: `${RUN}-guild`,
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as unknown,
      channelsProcessed: '1',
      channelsFailed: '0',
      messagesPublished: '1',
      messagesFailed: '0',
    });
  });
});
