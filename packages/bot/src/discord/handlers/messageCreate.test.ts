// Unit test for handleMessageCreate — the channel + bot-author guards and the
// error-swallowing behavior (AC-2, AC-3). db/redis are mocked; persistence is
// observed through the db.transaction spy.
import type { HivlyConfig } from '@hivly/shared';
import type { Database } from '@hivly/shared/db';
import type { RedisClient } from '@hivly/shared/redis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../logger.js';
import type { IngestibleMessage } from '../../persistence/persistMessage.js';
import { handleMessageCreate, type MessageCreateDeps } from './messageCreate.js';

function makeConfig(ignoreBots: boolean): HivlyConfig {
  return {
    discord: {
      guild_id: 'guild-1',
      channels: [
        { id: 'chan-enabled', name: 'general', enabled: true },
        { id: 'chan-disabled', name: 'archive', enabled: false },
      ],
      backfill: { enabled: false, limit: 0, ignore_bots: ignoreBots },
    },
  } as unknown as HivlyConfig;
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function message(overrides: Partial<IngestibleMessage> = {}): IngestibleMessage {
  return {
    id: '1',
    channelId: 'chan-enabled',
    guildId: 'guild-1',
    content: 'hi',
    createdAt: new Date('2026-07-06T10:00:00.000Z'),
    author: { id: 'u1', bot: false, displayName: 'Alice' },
    ...overrides,
  };
}

describe('handleMessageCreate', () => {
  let transaction: ReturnType<typeof vi.fn>;
  let xAdd: ReturnType<typeof vi.fn>;
  let deps: MessageCreateDeps;
  let logger: Logger;

  beforeEach(() => {
    // A transaction that runs its callback against a fake tx whose idempotent
    // INSERT chain reports one inserted row (the no-conflict case).
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn((v: { id: string }) => ({
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{ id: v.id }])),
          })),
        })),
      })),
    };
    transaction = vi.fn((cb: (t: typeof tx) => Promise<boolean>) => cb(tx));
    xAdd = vi.fn().mockResolvedValue('1-0');
    logger = fakeLogger();
    deps = {
      config: makeConfig(true),
      db: { transaction } as unknown as Database,
      redis: { xAdd } as unknown as RedisClient,
      logger,
    };
  });

  it('should persist and publish when the channel is enabled and the author is human', async () => {
    await handleMessageCreate(message(), deps);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(xAdd).toHaveBeenCalledTimes(1);
  });

  it('should skip silently when the channel is disabled', async () => {
    await handleMessageCreate(message({ channelId: 'chan-disabled' }), deps);

    expect(transaction).not.toHaveBeenCalled();
    expect(xAdd).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('should skip silently when the channel is not configured at all', async () => {
    await handleMessageCreate(message({ channelId: 'chan-unknown' }), deps);

    expect(transaction).not.toHaveBeenCalled();
    expect(xAdd).not.toHaveBeenCalled();
  });

  it('should skip a bot-authored message when ignore_bots is true', async () => {
    await handleMessageCreate(message({ author: { id: 'bot1', bot: true, displayName: 'BotUser' } }), deps);

    expect(transaction).not.toHaveBeenCalled();
    expect(xAdd).not.toHaveBeenCalled();
  });

  it('should persist a bot-authored message when ignore_bots is false', async () => {
    deps.config = makeConfig(false);

    await handleMessageCreate(message({ author: { id: 'bot1', bot: true, displayName: 'BotUser' } }), deps);

    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('should skip an empty-content message and warn (MessageContent intent may be off)', async () => {
    await handleMessageCreate(message({ content: '' }), deps);

    expect(transaction).not.toHaveBeenCalled();
    expect(xAdd).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('empty content'),
      expect.objectContaining({ messageId: '1', channelId: 'chan-enabled' }),
    );
  });

  it('should log at error and not throw when persistence fails on an in-scope message', async () => {
    transaction.mockRejectedValueOnce(new Error('db exploded'));

    await expect(handleMessageCreate(message(), deps)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'failed to handle message',
      expect.objectContaining({ messageId: '1', channelId: 'chan-enabled' }),
    );
  });

  it('should never include the full message content in any log context', async () => {
    await handleMessageCreate(message({ content: 'super secret content' }), deps);

    const allCalls = [
      ...(logger.debug as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ];
    const serialized = JSON.stringify(allCalls);
    expect(serialized).not.toContain('super secret content');
  });
});
