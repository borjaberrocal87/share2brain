// Unit test for persistMessage — verifies the event field mapping (correct keys,
// all-string values) and the guildId fallback, with mocked db + redis. The real
// transaction/rollback path is covered by the integration test.
import type { HivlyConfig } from '@hivly/shared';
import type { Database } from '@hivly/shared/db';
import type { RedisClient } from '@hivly/shared/redis';
import { STREAM_KEYS } from '@hivly/shared/types/events';
import { describe, expect, it, vi } from 'vitest';

import { persistMessage, type IngestibleMessage } from './persistMessage.js';

const config = {
  discord: { guild_id: 'guild-fallback' },
} as unknown as HivlyConfig;

/** Build a db whose transaction runs the callback against a recording fake tx. */
function fakeDb(): { db: Database; inserted: () => Record<string, unknown> | undefined } {
  let insertedValues: Record<string, unknown> | undefined;
  const tx = {
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        insertedValues = v;
        return Promise.resolve();
      }),
    })),
  };
  const db = {
    transaction: vi.fn((cb: (t: typeof tx) => Promise<void>) => cb(tx)),
  } as unknown as Database;
  return { db, inserted: () => insertedValues };
}

function baseMessage(overrides: Partial<IngestibleMessage> = {}): IngestibleMessage {
  return {
    id: '111',
    channelId: '222',
    guildId: '333',
    content: 'hello world',
    createdAt: new Date('2026-07-06T10:00:00.000Z'),
    author: { id: '444', bot: false },
    ...overrides,
  };
}

describe('persistMessage', () => {
  it('should XADD an all-string event with the exact MessageCreatedEvent keys when a message is persisted', async () => {
    const { db } = fakeDb();
    const xAdd = vi.fn().mockResolvedValue('1-0');
    const redis = { xAdd } as unknown as RedisClient;

    await persistMessage(baseMessage(), { config, db, redis });

    expect(xAdd).toHaveBeenCalledTimes(1);
    const [key, id, fields] = xAdd.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(key).toBe(STREAM_KEYS.DISCORD_MESSAGES);
    expect(id).toBe('*');
    expect(fields).toEqual({
      type: 'discord.message.created',
      messageId: '111',
      channelId: '222',
      guildId: '333',
      timestamp: '2026-07-06T10:00:00.000Z',
      content: 'hello world',
      authorId: '444',
    });
    // AD-13: every stream field value MUST be a string.
    for (const value of Object.values(fields)) {
      expect(typeof value).toBe('string');
    }
  });

  it('should INSERT the row with updatedAt equal to createdAt and no indexedAt/deletedAt', async () => {
    const { db, inserted } = fakeDb();
    const redis = { xAdd: vi.fn().mockResolvedValue('1-0') } as unknown as RedisClient;
    const createdAt = new Date('2026-07-06T10:00:00.000Z');

    await persistMessage(baseMessage({ createdAt }), { config, db, redis });

    const row = inserted();
    expect(row).toMatchObject({
      id: '111',
      channelId: '222',
      guildId: '333',
      authorId: '444',
      content: 'hello world',
      createdAt,
      updatedAt: createdAt,
    });
    expect(row).not.toHaveProperty('indexedAt');
    expect(row).not.toHaveProperty('deletedAt');
  });

  it('should fall back to the configured guild_id when message.guildId is null', async () => {
    const { db, inserted } = fakeDb();
    const xAdd = vi.fn().mockResolvedValue('1-0');
    const redis = { xAdd } as unknown as RedisClient;

    await persistMessage(baseMessage({ guildId: null }), { config, db, redis });

    expect(inserted()).toMatchObject({ guildId: 'guild-fallback' });
    const [, , fields] = xAdd.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(fields.guildId).toBe('guild-fallback');
  });

  it('should propagate an XADD failure (the caller relies on this to observe a rollback)', async () => {
    const { db } = fakeDb();
    const redis = {
      xAdd: vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as RedisClient;

    await expect(persistMessage(baseMessage(), { config, db, redis })).rejects.toThrow('redis down');
  });
});
