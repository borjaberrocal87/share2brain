import { describe, expect, it } from 'vitest';

import { parseDeletedEvent, parseUpdatedEvent } from './events.js';

describe('parseUpdatedEvent', () => {
  const valid = {
    type: 'discord.message.updated',
    messageId: 'm1',
    channelId: 'c1',
    guildId: 'g1',
    timestamp: '2026-07-08T10:00:00.000Z',
    newContent: 'edited content',
  };

  it('should accept a valid updated event and carry guildId/timestamp through', () => {
    expect(parseUpdatedEvent(valid)).toEqual({
      type: 'discord.message.updated',
      messageId: 'm1',
      channelId: 'c1',
      guildId: 'g1',
      timestamp: '2026-07-08T10:00:00.000Z',
      newContent: 'edited content',
    });
  });

  it('should reject the wrong type', () => {
    expect(parseUpdatedEvent({ ...valid, type: 'discord.message.deleted' })).toBeNull();
  });

  it('should reject a blank messageId', () => {
    expect(parseUpdatedEvent({ ...valid, messageId: '   ' })).toBeNull();
  });

  it('should reject a blank channelId', () => {
    expect(parseUpdatedEvent({ ...valid, channelId: '' })).toBeNull();
  });

  it('should accept a blank (whitespace-only) newContent — Story 7.3 F3, a zero-URL edit', () => {
    const event = parseUpdatedEvent({ ...valid, newContent: '   ' });
    expect(event?.newContent).toBe('   ');
  });

  it('should default a missing newContent field to an empty string', () => {
    const rest = {
      type: valid.type,
      messageId: valid.messageId,
      channelId: valid.channelId,
      timestamp: valid.timestamp,
    };
    const event = parseUpdatedEvent(rest);
    expect(event?.newContent).toBe('');
  });

  it('should reject a missing timestamp (would poison the updated_at write)', () => {
    const rest = {
      type: valid.type,
      messageId: valid.messageId,
      channelId: valid.channelId,
      newContent: valid.newContent,
    };
    expect(parseUpdatedEvent(rest)).toBeNull();
  });

  it('should reject a blank (whitespace-only) timestamp', () => {
    expect(parseUpdatedEvent({ ...valid, timestamp: '   ' })).toBeNull();
  });

  it('should default a missing guildId to an empty string', () => {
    const rest = {
      type: valid.type,
      messageId: valid.messageId,
      channelId: valid.channelId,
      timestamp: valid.timestamp,
      newContent: valid.newContent,
    };
    const event = parseUpdatedEvent(rest);
    expect(event?.guildId).toBe('');
    expect(event?.timestamp).toBe(valid.timestamp);
  });

  it('should carry a non-empty authorName through', () => {
    const event = parseUpdatedEvent({ ...valid, authorName: 'Alice' });
    expect(event?.authorName).toBe('Alice');
  });

  it('should normalize a missing authorName to undefined', () => {
    const event = parseUpdatedEvent(valid);
    expect(event?.authorName).toBeUndefined();
  });

  it('should normalize a blank (whitespace-only) authorName to undefined — never blank out a stored name', () => {
    const event = parseUpdatedEvent({ ...valid, authorName: '   ' });
    expect(event?.authorName).toBeUndefined();
  });
});

describe('parseDeletedEvent', () => {
  const valid = {
    type: 'discord.message.deleted',
    messageId: 'm1',
    channelId: 'c1',
    guildId: 'g1',
    timestamp: '2026-07-08T10:00:00.000Z',
  };

  it('should accept a valid deleted event and carry guildId/timestamp through', () => {
    expect(parseDeletedEvent(valid)).toEqual({
      type: 'discord.message.deleted',
      messageId: 'm1',
      channelId: 'c1',
      guildId: 'g1',
      timestamp: '2026-07-08T10:00:00.000Z',
    });
  });

  it('should reject the wrong type', () => {
    expect(parseDeletedEvent({ ...valid, type: 'discord.message.updated' })).toBeNull();
  });

  it('should reject a blank messageId', () => {
    expect(parseDeletedEvent({ ...valid, messageId: '  ' })).toBeNull();
  });

  it('should reject a blank channelId', () => {
    expect(parseDeletedEvent({ ...valid, channelId: '' })).toBeNull();
  });

  it('should default missing guildId/timestamp to empty strings', () => {
    const rest = { type: valid.type, messageId: valid.messageId, channelId: valid.channelId };
    const event = parseDeletedEvent(rest);
    expect(event?.guildId).toBe('');
    expect(event?.timestamp).toBe('');
  });
});
