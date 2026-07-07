import { describe, expect, it } from 'vitest';

import { CHAT_ERROR, CHAT_MESSAGE_MAX_LENGTH, ChatRequestSchema } from './chat.js';

describe('ChatRequestSchema', () => {
  it('should parse a valid body with no conversationId', () => {
    const result = ChatRequestSchema.safeParse({ message: 'hello there' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.conversationId).toBeUndefined();
  });

  it('should parse a valid body with a conversationId', () => {
    const result = ChatRequestSchema.safeParse({
      message: 'hello there',
      conversationId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });

  it('should accept a null conversationId', () => {
    const result = ChatRequestSchema.safeParse({ message: 'hello there', conversationId: null });
    expect(result.success).toBe(true);
  });

  it('should trim message and reject a blank message', () => {
    expect(ChatRequestSchema.safeParse({ message: '   ' }).success).toBe(false);
  });

  it('should reject a missing message', () => {
    expect(ChatRequestSchema.safeParse({}).success).toBe(false);
  });

  it('should accept a message at the max length', () => {
    const message = 'a'.repeat(CHAT_MESSAGE_MAX_LENGTH);
    expect(ChatRequestSchema.safeParse({ message }).success).toBe(true);
  });

  it('should reject a message longer than the max length', () => {
    const message = 'a'.repeat(CHAT_MESSAGE_MAX_LENGTH + 1);
    expect(ChatRequestSchema.safeParse({ message }).success).toBe(false);
  });

  it('should reject a bad-UUID conversationId', () => {
    expect(
      ChatRequestSchema.safeParse({ message: 'hi', conversationId: 'not-a-uuid' }).success,
    ).toBe(false);
  });
});

describe('CHAT_ERROR', () => {
  it('should expose the stable chat error codes', () => {
    expect(CHAT_ERROR.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(CHAT_ERROR.NOT_FOUND).toBe('NOT_FOUND');
    expect(CHAT_ERROR.INTERNAL).toBe('INTERNAL');
  });
});
