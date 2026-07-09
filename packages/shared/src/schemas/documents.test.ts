import { describe, expect, it } from 'vitest';

import {
  DOCUMENTS_ERROR,
  DocumentFragmentSchema,
  DocumentsQuerySchema,
  DocumentsResponseSchema,
} from './documents.js';

describe('DocumentsQuerySchema', () => {
  it('should default page to 1 and limit to 20 when absent', () => {
    const result = DocumentsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
    }
  });

  it('should coerce string page/limit query params to numbers', () => {
    const result = DocumentsQuerySchema.safeParse({ page: '3', limit: '10' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
      expect(result.data.limit).toBe(10);
    }
  });

  it('should reject a page below 1', () => {
    expect(DocumentsQuerySchema.safeParse({ page: '0' }).success).toBe(false);
  });

  it('should reject a limit below 1', () => {
    expect(DocumentsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('should accept the boundary limit of 100', () => {
    const result = DocumentsQuerySchema.safeParse({ limit: '100' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(100);
  });

  it('should reject a limit above the hard cap of 100', () => {
    expect(DocumentsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('should reject a non-integer page', () => {
    expect(DocumentsQuerySchema.safeParse({ page: '1.5' }).success).toBe(false);
  });

  it('should reject a page above the hard cap (guards against a bigint OFFSET overflow → 500)', () => {
    expect(DocumentsQuerySchema.safeParse({ page: '1000001' }).success).toBe(false);
    expect(DocumentsQuerySchema.safeParse({ page: '1000000000000000000' }).success).toBe(false);
  });

  it('should accept the boundary page of 1_000_000', () => {
    const result = DocumentsQuerySchema.safeParse({ page: '1000000' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.page).toBe(1_000_000);
  });

  it('should leave channelId undefined when absent', () => {
    const result = DocumentsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.channelId).toBeUndefined();
  });

  it('should pass through a channelId string', () => {
    const result = DocumentsQuerySchema.safeParse({ channelId: '1234567890' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.channelId).toBe('1234567890');
  });

  it('should reject an empty channelId', () => {
    expect(DocumentsQuerySchema.safeParse({ channelId: '' }).success).toBe(false);
  });

  it('should default unreadOnly to false when absent', () => {
    const result = DocumentsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.unreadOnly).toBe(false);
  });

  it('should parse unreadOnly=true as true', () => {
    const result = DocumentsQuerySchema.safeParse({ unreadOnly: 'true' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.unreadOnly).toBe(true);
  });

  it('should parse unreadOnly=false as false (not the truthy-string trap)', () => {
    const result = DocumentsQuerySchema.safeParse({ unreadOnly: 'false' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.unreadOnly).toBe(false);
  });

  it('should parse unreadOnly=1 as true', () => {
    const result = DocumentsQuerySchema.safeParse({ unreadOnly: '1' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.unreadOnly).toBe(true);
  });
});

describe('DocumentFragmentSchema', () => {
  const valid = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    title: 'The Answer to Everything',
    description: 'the answer is 42',
    link: 'https://example.com/doc',
    channelId: '1234567890',
    channelName: 'general',
    authorId: '9876543210',
    authorName: '9876543210',
    createdAt: '2026-07-06T00:00:00.000Z',
    indexedAt: '2026-07-06T01:00:00.000Z',
    messageId: '1111111111',
    isRead: false,
  };

  it('should parse a fully-populated fragment', () => {
    expect(DocumentFragmentSchema.safeParse(valid).success).toBe(true);
  });

  it('should reject a fragment with an empty link', () => {
    expect(DocumentFragmentSchema.safeParse({ ...valid, link: '' }).success).toBe(false);
  });

  it('should reject a fragment with an empty title', () => {
    expect(DocumentFragmentSchema.safeParse({ ...valid, title: '' }).success).toBe(false);
  });

  it('should reject a fragment with a non-URL non-empty link', () => {
    expect(DocumentFragmentSchema.safeParse({ ...valid, link: 'not-a-url' }).success).toBe(false);
  });

  it('should reject a link with embedded whitespace', () => {
    expect(
      DocumentFragmentSchema.safeParse({ ...valid, link: 'https://example.com/a b' }).success,
    ).toBe(false);
  });

  it('should reject a host-less https:// link', () => {
    expect(DocumentFragmentSchema.safeParse({ ...valid, link: 'https://' }).success).toBe(false);
  });

  it('should reject a non-http(s) scheme link', () => {
    expect(DocumentFragmentSchema.safeParse({ ...valid, link: 'ftp://x' }).success).toBe(false);
  });

  it('should accept an uppercase-scheme link', () => {
    expect(
      DocumentFragmentSchema.safeParse({ ...valid, link: 'HTTPS://example.com/doc' }).success,
    ).toBe(true);
  });

  it('should reject a fragment whose id is not a uuid', () => {
    expect(DocumentFragmentSchema.safeParse({ ...valid, id: 'nope' }).success).toBe(false);
  });

  it('should reject a fragment missing a required field', () => {
    const missing: Record<string, unknown> = { ...valid };
    delete missing.isRead;
    expect(DocumentFragmentSchema.safeParse(missing).success).toBe(false);
  });

  it('should reject a non-boolean isRead', () => {
    expect(DocumentFragmentSchema.safeParse({ ...valid, isRead: 'true' }).success).toBe(false);
  });
});

describe('DocumentsResponseSchema', () => {
  it('should parse an empty results page', () => {
    expect(
      DocumentsResponseSchema.safeParse({ results: [], page: 1, limit: 20, total: 0 }).success,
    ).toBe(true);
  });
});

describe('DOCUMENTS_ERROR', () => {
  it('should expose the stable documents error codes', () => {
    expect(DOCUMENTS_ERROR.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(DOCUMENTS_ERROR.INTERNAL).toBe('INTERNAL');
  });
});
