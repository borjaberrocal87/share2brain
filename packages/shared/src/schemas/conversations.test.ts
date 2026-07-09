import { describe, expect, it } from 'vitest';

import {
  CONVERSATION_TITLE_MAX_LENGTH,
  CONVERSATIONS_ERROR,
  ConversationDetailSchema,
  ConversationSummarySchema,
  ConversationsQuerySchema,
  ConversationsResponseSchema,
} from './conversations.js';

describe('ConversationsQuerySchema', () => {
  it('should default page to 1 and limit to 20 when absent', () => {
    const result = ConversationsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
    }
  });

  it('should coerce string page/limit query params to numbers', () => {
    const result = ConversationsQuerySchema.safeParse({ page: '3', limit: '10' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
      expect(result.data.limit).toBe(10);
    }
  });

  it('should reject a page below 1', () => {
    expect(ConversationsQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });

  it('should reject a limit above the hard cap of 100', () => {
    expect(ConversationsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('should reject a page above the hard cap (guards against a bigint OFFSET overflow → 500)', () => {
    expect(ConversationsQuerySchema.safeParse({ page: '1000001' }).success).toBe(false);
  });
});

describe('ConversationSummarySchema', () => {
  const valid = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    title: 'How do I deploy?',
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T01:00:00.000Z',
  };

  it('should parse a fully-populated summary', () => {
    expect(ConversationSummarySchema.safeParse(valid).success).toBe(true);
  });

  it('should reject a summary whose id is not a uuid', () => {
    expect(ConversationSummarySchema.safeParse({ ...valid, id: 'nope' }).success).toBe(false);
  });
});

describe('ConversationDetailSchema', () => {
  it('should round-trip a detail with a message carrying citations', () => {
    const detail = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T01:00:00.000Z',
      messages: [
        {
          id: '660e8400-e29b-41d4-a716-446655440111',
          role: 'assistant',
          content: 'According to #general, Ada mentioned...',
          citations: [
            { channel: 'general', author: 'ada', date: '2026-07-06T00:00:00.000Z', link: '' },
          ],
          createdAt: '2026-07-06T00:30:00.000Z',
        },
      ],
    };
    const result = ConversationDetailSchema.safeParse(detail);
    expect(result.success).toBe(true);
  });

  it('should reject a message with an unknown role', () => {
    const bad = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      createdAt: '2026-07-06T00:00:00.000Z',
      updatedAt: '2026-07-06T01:00:00.000Z',
      messages: [
        {
          id: '660e8400-e29b-41d4-a716-446655440111',
          role: 'moderator',
          content: 'x',
          citations: [],
          createdAt: '2026-07-06T00:30:00.000Z',
        },
      ],
    };
    expect(ConversationDetailSchema.safeParse(bad).success).toBe(false);
  });
});

describe('ConversationsResponseSchema', () => {
  it('should parse an empty results page', () => {
    expect(
      ConversationsResponseSchema.safeParse({ results: [], page: 1, limit: 20, total: 0 }).success,
    ).toBe(true);
  });
});

describe('conversations constants', () => {
  it('should expose the title max length', () => {
    expect(CONVERSATION_TITLE_MAX_LENGTH).toBe(80);
  });

  it('should expose the stable error codes', () => {
    expect(CONVERSATIONS_ERROR.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(CONVERSATIONS_ERROR.NOT_FOUND).toBe('NOT_FOUND');
    expect(CONVERSATIONS_ERROR.INTERNAL).toBe('INTERNAL');
  });
});
