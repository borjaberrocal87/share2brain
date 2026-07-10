import { describe, expect, it } from 'vitest';

import {
  CONSUMER_GROUPS,
  STREAM_KEYS,
  type MessageCreatedEvent,
  type MessageDeletedEvent,
  type MessageUpdatedEvent,
} from './events.js';

const MANDATORY_FIELDS = ['messageId', 'channelId', 'guildId', 'timestamp'] as const;

describe('Discord stream events', () => {
  it('should carry the four mandatory fields on a created event', () => {
    const event = {
      type: 'discord.message.created',
      messageId: '1',
      channelId: '2',
      guildId: '3',
      timestamp: '2026-07-03T00:00:00Z',
      content: 'hi',
      authorId: '4',
    } satisfies MessageCreatedEvent;

    for (const field of MANDATORY_FIELDS) {
      expect(event[field]).toBeTypeOf('string');
    }
  });

  it('should carry the mandatory fields plus newContent on an updated event', () => {
    const event = {
      type: 'discord.message.updated',
      messageId: '1',
      channelId: '2',
      guildId: '3',
      timestamp: '2026-07-03T00:00:00Z',
      newContent: 'edited',
    } satisfies MessageUpdatedEvent;

    expect(event.newContent).toBe('edited');
    for (const field of MANDATORY_FIELDS) {
      expect(event[field]).toBeTypeOf('string');
    }
  });

  it('should carry only the mandatory fields on a deleted event', () => {
    const event = {
      type: 'discord.message.deleted',
      messageId: '1',
      channelId: '2',
      guildId: '3',
      timestamp: '2026-07-03T00:00:00Z',
    } satisfies MessageDeletedEvent;

    for (const field of MANDATORY_FIELDS) {
      expect(event[field]).toBeTypeOf('string');
    }
  });
});

describe('stream invariants (AD-13)', () => {
  it('should expose the fixed stream keys', () => {
    expect(STREAM_KEYS.DISCORD_MESSAGES).toBe('share2brain:discord:messages');
    expect(STREAM_KEYS.DISCORD_MESSAGES_UPDATED).toBe('share2brain:discord:messages:updated');
    expect(STREAM_KEYS.DISCORD_MESSAGES_DELETED).toBe('share2brain:discord:messages:deleted');
  });

  it('should expose the fixed consumer groups', () => {
    expect(CONSUMER_GROUPS.INDEXER).toBe('share2brain:indexer');
    expect(CONSUMER_GROUPS.SYNC).toBe('share2brain:sync');
  });
});
