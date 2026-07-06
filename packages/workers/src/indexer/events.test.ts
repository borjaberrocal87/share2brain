import { describe, expect, it } from 'vitest';

import { parseCreatedEvent } from './events.js';

/** A well-formed flat field map as the producer XADDs it (all strings). */
function fields(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    type: 'discord.message.created',
    messageId: '1498305410942369908',
    channelId: '1498779601030086707',
    guildId: '1498305407159107735',
    timestamp: '2026-07-06T10:00:00.000Z',
    content: 'hello world',
    authorId: 'author-1',
    ...overrides,
  };
}

describe('parseCreatedEvent', () => {
  it('should return the typed event when all required fields are present', () => {
    const event = parseCreatedEvent(fields());

    expect(event).toEqual({
      type: 'discord.message.created',
      messageId: '1498305410942369908',
      channelId: '1498779601030086707',
      guildId: '1498305407159107735',
      timestamp: '2026-07-06T10:00:00.000Z',
      content: 'hello world',
      authorId: 'author-1',
    });
  });

  it('should preserve leading/trailing whitespace in content (chunker owns trimming)', () => {
    const event = parseCreatedEvent(fields({ content: '  spaced text  ' }));
    expect(event?.content).toBe('  spaced text  ');
  });

  it('should return null for a foreign event type', () => {
    expect(parseCreatedEvent(fields({ type: 'discord.message.deleted' }))).toBeNull();
  });

  it('should return null when type is missing', () => {
    const noType = fields();
    delete noType.type;
    expect(parseCreatedEvent(noType)).toBeNull();
  });

  it('should return null when messageId is empty', () => {
    expect(parseCreatedEvent(fields({ messageId: '' }))).toBeNull();
  });

  it('should return null when messageId is whitespace-only', () => {
    expect(parseCreatedEvent(fields({ messageId: '   ' }))).toBeNull();
  });

  it('should return null when channelId is missing', () => {
    const noChannel = fields();
    delete noChannel.channelId;
    expect(parseCreatedEvent(noChannel)).toBeNull();
  });

  it('should return null when content is empty', () => {
    expect(parseCreatedEvent(fields({ content: '' }))).toBeNull();
  });

  it('should return null when content is whitespace-only', () => {
    expect(parseCreatedEvent(fields({ content: '   \n  ' }))).toBeNull();
  });

  it('should default optional fields to empty strings when absent', () => {
    const event = parseCreatedEvent({
      type: 'discord.message.created',
      messageId: 'm1',
      channelId: 'c1',
      content: 'x',
    });
    expect(event).toEqual({
      type: 'discord.message.created',
      messageId: 'm1',
      channelId: 'c1',
      guildId: '',
      timestamp: '',
      content: 'x',
      authorId: '',
    });
  });
});
