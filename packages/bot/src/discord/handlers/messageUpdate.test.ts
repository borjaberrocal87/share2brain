// Unit test for handleMessageUpdate — channel/bot-author/editedAt guards,
// partial-fetch resolution, and the error-swallowing behavior (AC-1, AC-3,
// AC-4, AC-6). Redis is mocked; no db (publish-only).
import type { Share2BrainConfig } from '@share2brain/shared';
import type { RedisClient } from '@share2brain/shared/redis';
import { STREAM_KEYS } from '@share2brain/shared/types/events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../../logger.js';
import { handleMessageUpdate, type MessageUpdateDeps, type UpdatableMessage } from './messageUpdate.js';

function makeConfig(ignoreBots: boolean): Share2BrainConfig {
  return {
    discord: {
      guild_id: 'guild-1',
      channels: [
        { id: 'chan-enabled', name: 'general', enabled: true },
        { id: 'chan-disabled', name: 'archive', enabled: false },
      ],
      backfill: { enabled: false, limit: 0, ignore_bots: ignoreBots },
    },
  } as unknown as Share2BrainConfig;
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function message(overrides: Partial<UpdatableMessage> = {}): UpdatableMessage {
  return {
    id: '1',
    channelId: 'chan-enabled',
    guildId: 'guild-1',
    content: 'edited content',
    editedAt: new Date('2026-07-08T10:00:00.000Z'),
    author: { id: 'u1', bot: false, displayName: 'Alice' },
    partial: false,
    fetch: vi.fn(),
    ...overrides,
  };
}

describe('handleMessageUpdate', () => {
  let xAdd: ReturnType<typeof vi.fn>;
  let deps: MessageUpdateDeps;
  let logger: Logger;

  beforeEach(() => {
    xAdd = vi.fn().mockResolvedValue('1-0');
    logger = fakeLogger();
    deps = {
      config: makeConfig(true),
      redis: { xAdd } as unknown as RedisClient,
      logger,
    };
  });

  it('publishes a MessageUpdatedEvent on an enabled channel', async () => {
    await handleMessageUpdate(message(), deps);

    expect(xAdd).toHaveBeenCalledTimes(1);
    const [key, id, event] = xAdd.mock.calls[0] as [string, string, Record<string, string>];
    expect(key).toBe(STREAM_KEYS.DISCORD_MESSAGES_UPDATED);
    expect(id).toBe('*');
    expect(event).toEqual({
      type: 'discord.message.updated',
      messageId: '1',
      channelId: 'chan-enabled',
      guildId: 'guild-1',
      timestamp: '2026-07-08T10:00:00.000Z',
      newContent: 'edited content',
      authorName: 'Alice',
    });
    for (const value of Object.values(event)) {
      expect(typeof value).toBe('string');
    }
  });

  it('falls back to config guild_id when message.guildId is null', async () => {
    await handleMessageUpdate(message({ guildId: null }), deps);

    const [, , event] = xAdd.mock.calls[0] as [string, string, Record<string, string>];
    expect(event.guildId).toBe('guild-1');
  });

  it('skips silently when the channel is disabled', async () => {
    await handleMessageUpdate(message({ channelId: 'chan-disabled' }), deps);

    expect(xAdd).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('skips silently when the channel is not configured at all', async () => {
    await handleMessageUpdate(message({ channelId: 'chan-unknown' }), deps);

    expect(xAdd).not.toHaveBeenCalled();
  });

  it('skips a bot-authored message when ignore_bots is true', async () => {
    await handleMessageUpdate(message({ author: { id: 'bot1', bot: true, displayName: 'BotUser' } }), deps);

    expect(xAdd).not.toHaveBeenCalled();
  });

  it('publishes a bot-authored message when ignore_bots is false', async () => {
    deps.config = makeConfig(false);

    await handleMessageUpdate(message({ author: { id: 'bot1', bot: true, displayName: 'BotUser' } }), deps);

    expect(xAdd).toHaveBeenCalledTimes(1);
  });

  it('fetches a partial message and uses the fetched content', async () => {
    const fetched = message({ content: 'fetched content', partial: false });
    const fetch = vi.fn().mockResolvedValue(fetched);

    await handleMessageUpdate(message({ partial: true, fetch }), deps);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, , event] = xAdd.mock.calls[0] as [string, string, Record<string, string>];
    expect(event.newContent).toBe('fetched content');
  });

  it('publishes the authorName of the FETCHED message, not the raw partial', async () => {
    const fetched = message({ author: { id: 'u1', bot: false, displayName: 'Fetched Name' }, partial: false });
    const fetch = vi.fn().mockResolvedValue(fetched);

    await handleMessageUpdate(message({ partial: true, fetch }), deps);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [, , event] = xAdd.mock.calls[0] as [string, string, Record<string, string>];
    expect(event.authorName).toBe('Fetched Name');
  });

  it('applies the bot-author guard to the FETCHED message, not the raw partial', async () => {
    // Raw partial has no usable author; fetch resolves to a bot author. The guard
    // must run on the fetched author → skip. (Locks in the fetch-before-guard order.)
    const fetched = message({ author: { id: 'bot1', bot: true, displayName: 'BotUser' }, partial: false });
    const fetch = vi.fn().mockResolvedValue(fetched);

    await handleMessageUpdate(message({ partial: true, fetch }), deps);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(xAdd).not.toHaveBeenCalled();
  });

  it('does not throw when a partial arrives with a null author (guard runs after fetch)', async () => {
    const fetched = message({ author: { id: 'u1', bot: false, displayName: 'Alice' }, partial: false });
    const fetch = vi.fn().mockResolvedValue(fetched);
    // author is null on the raw partial — reading .bot before fetch would throw.
    const partial = message({ partial: true, fetch, author: null as unknown as UpdatableMessage['author'] });

    await expect(handleMessageUpdate(partial, deps)).resolves.toBeUndefined();
    expect(xAdd).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('skips and warns when the resolved content is empty (MessageContent intent likely off)', async () => {
    await handleMessageUpdate(message({ content: '   ' }), deps);

    expect(xAdd).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('skips and warns on an empty-string content (the !content branch)', async () => {
    await handleMessageUpdate(message({ content: '' }), deps);

    expect(xAdd).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('skips when a partial resolves to empty content (guard runs after fetch)', async () => {
    const fetched = message({ content: '', partial: false });
    const fetch = vi.fn().mockResolvedValue(fetched);

    await handleMessageUpdate(message({ partial: true, fetch }), deps);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(xAdd).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('skips without throwing when fetch() rejects (message deleted meanwhile)', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('Unknown Message'));

    await expect(
      handleMessageUpdate(message({ partial: true, fetch }), deps),
    ).resolves.toBeUndefined();
    expect(xAdd).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('skips when editedAt is null (non-content update, e.g. embed load)', async () => {
    await handleMessageUpdate(message({ editedAt: null }), deps);

    expect(xAdd).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('logs at error and does not throw when xAdd rejects', async () => {
    xAdd.mockRejectedValueOnce(new Error('redis exploded'));

    await expect(handleMessageUpdate(message(), deps)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      'failed to handle message update',
      expect.objectContaining({ messageId: '1', channelId: 'chan-enabled' }),
    );
  });

  it('never includes newContent in any log context', async () => {
    await handleMessageUpdate(message({ content: 'super secret edited content' }), deps);

    const allCalls = [
      ...(logger.debug as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ];
    const serialized = JSON.stringify(allCalls);
    expect(serialized).not.toContain('super secret edited content');
  });
});
