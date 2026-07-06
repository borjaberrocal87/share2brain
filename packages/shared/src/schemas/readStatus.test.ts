import { describe, expect, it } from 'vitest';

import {
  EmbeddingIdParamSchema,
  MarkAllRequestSchema,
  MarkAllResponseSchema,
  READ_STATUS_ERROR,
  UnreadCountResponseSchema,
} from './readStatus.js';

describe('EmbeddingIdParamSchema', () => {
  it('should accept a valid uuid', () => {
    expect(
      EmbeddingIdParamSchema.safeParse({ embeddingId: '550e8400-e29b-41d4-a716-446655440000' })
        .success,
    ).toBe(true);
  });

  it('should reject a non-uuid embeddingId', () => {
    expect(EmbeddingIdParamSchema.safeParse({ embeddingId: 'not-a-uuid' }).success).toBe(false);
  });

  it('should reject a missing embeddingId', () => {
    expect(EmbeddingIdParamSchema.safeParse({}).success).toBe(false);
  });
});

describe('MarkAllRequestSchema', () => {
  it('should accept an absent channelId (all-scope, D6)', () => {
    const result = MarkAllRequestSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.channelId).toBeUndefined();
  });

  it('should accept a provided channelId', () => {
    const result = MarkAllRequestSchema.safeParse({ channelId: '1234567890' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.channelId).toBe('1234567890');
  });

  it('should reject an empty-string channelId', () => {
    expect(MarkAllRequestSchema.safeParse({ channelId: '' }).success).toBe(false);
  });
});

describe('MarkAllResponseSchema', () => {
  it('should accept a nonnegative markedCount', () => {
    expect(MarkAllResponseSchema.safeParse({ markedCount: 0 }).success).toBe(true);
  });

  it('should reject a negative markedCount', () => {
    expect(MarkAllResponseSchema.safeParse({ markedCount: -1 }).success).toBe(false);
  });
});

describe('UnreadCountResponseSchema', () => {
  it('should accept an empty map', () => {
    expect(UnreadCountResponseSchema.safeParse({}).success).toBe(true);
  });

  it('should accept a per-channel nonnegative count map (D7)', () => {
    expect(UnreadCountResponseSchema.safeParse({ '1234567890': 3 }).success).toBe(true);
  });

  it('should reject a negative count', () => {
    expect(UnreadCountResponseSchema.safeParse({ '1234567890': -1 }).success).toBe(false);
  });
});

describe('READ_STATUS_ERROR', () => {
  it('should expose the stable read-status error codes', () => {
    expect(READ_STATUS_ERROR.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(READ_STATUS_ERROR.NOT_FOUND).toBe('NOT_FOUND');
    expect(READ_STATUS_ERROR.FORBIDDEN).toBe('FORBIDDEN');
    expect(READ_STATUS_ERROR.INTERNAL).toBe('INTERNAL');
  });
});
