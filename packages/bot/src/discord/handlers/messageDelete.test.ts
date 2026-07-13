// Unit test for handleMessageDelete — channel guard, uncached-partial support,
// and the error-swallowing behavior (AC-2, AC-3, AC-4).
import type { Share2BrainConfig } from '@share2brain/shared';
import type { RedisClient } from '@share2brain/shared/redis';
import { STREAM_KEYS } from '@share2brain/shared/types/events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@share2brain/shared/logger';
import { handleMessageDelete, type DeletableMessage, type MessageDeleteDeps } from './messageDelete.js';

function makeConfig(): Share2BrainConfig {
  return {
    discord: {
      guild_id: 'guild-1',
      channels: [
        { id: 'chan-enabled', name: 'general', enabled: true },
        { id: 'chan-disabled', name: 'archive', enabled: false },
      ],
      backfill: { enabled: false, limit: 0, ignore_bots: true },
    },
  } as unknown as Share2BrainConfig;
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function message(overrides: Partial<DeletableMessage> = {}): DeletableMessage {
  return {
    id: '1',
    channelId: 'chan-enabled',
    guildId: 'guild-1',
    ...overrides,
  };
}

describe('handleMessageDelete', () => {
  let xAdd: ReturnType<typeof vi.fn>;
  let deps: MessageDeleteDeps;
  let logger: Logger;

  beforeEach(() => {
    xAdd = vi.fn().mockResolvedValue('1-0');
    logger = fakeLogger();
    deps = {
      config: makeConfig(),
      redis: { xAdd } as unknown as RedisClient,
      logger,
    };
  });

  it('publishes a MessageDeletedEvent on an enabled channel', async () => {
    await handleMessageDelete(message(), deps);

    expect(xAdd).toHaveBeenCalledTimes(1);
    const [key, id, event] = xAdd.mock.calls[0] as [string, string, Record<string, string>];
    expect(key).toBe(STREAM_KEYS.DISCORD_MESSAGES_DELETED);
    expect(id).toBe('*');
    expect(event.type).toBe('discord.message.deleted');
    expect(event.messageId).toBe('1');
    expect(event.channelId).toBe('chan-enabled');
    expect(event.guildId).toBe('guild-1');
    for (const value of Object.values(event)) {
      expect(typeof value).toBe('string');
    }
  });

  it('publishes for a partial message with only id + channelId (guildId falls back)', async () => {
    await handleMessageDelete({ id: '2', channelId: 'chan-enabled', guildId: null }, deps);

    expect(xAdd).toHaveBeenCalledTimes(1);
    const [, , event] = xAdd.mock.calls[0] as [string, string, Record<string, string>];
    expect(event.guildId).toBe('guild-1');
  });

  it('skips silently when the channel is disabled', async () => {
    await handleMessageDelete(message({ channelId: 'chan-disabled' }), deps);

    expect(xAdd).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('skips silently when the channel is not configured at all', async () => {
    await handleMessageDelete(message({ channelId: 'chan-unknown' }), deps);

    expect(xAdd).not.toHaveBeenCalled();
  });

  it('does not filter bot-authored deletes (author is unknown on a partial)', async () => {
    // DeletableMessage has no author field at all — this test documents that
    // there is no bot-author guard here, unlike messageCreate/messageUpdate.
    await handleMessageDelete(message(), deps);

    expect(xAdd).toHaveBeenCalledTimes(1);
  });

  it('logs at error and does not throw when xAdd rejects', async () => {
    xAdd.mockRejectedValueOnce(new Error('redis exploded'));

    await expect(handleMessageDelete(message(), deps)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'failed to handle message delete',
      expect.objectContaining({ messageId: '1', channelId: 'chan-enabled' }),
    );
  });
});
