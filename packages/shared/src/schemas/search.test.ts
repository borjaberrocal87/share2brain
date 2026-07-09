import { describe, expect, it } from 'vitest';

import {
  SEARCH_ERROR,
  SEARCH_QUERY_MAX_LENGTH,
  SearchFragmentSchema,
  SearchQuerySchema,
  SearchResponseSchema,
} from './search.js';

describe('SearchQuerySchema', () => {
  it('should parse a valid query and default limit to 5', () => {
    const result = SearchQuerySchema.safeParse({ q: 'how do I deploy' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(5);
  });

  it('should trim q and reject a whitespace-only query', () => {
    expect(SearchQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
  });

  it('should reject a missing q', () => {
    expect(SearchQuerySchema.safeParse({}).success).toBe(false);
  });

  it('should reject an empty q', () => {
    expect(SearchQuerySchema.safeParse({ q: '' }).success).toBe(false);
  });

  it('should coerce a string limit query param to a number', () => {
    const result = SearchQuerySchema.safeParse({ q: 'x', limit: '10' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(10);
  });

  it('should reject a limit above the hard cap of 50', () => {
    expect(SearchQuerySchema.safeParse({ q: 'x', limit: '51' }).success).toBe(false);
  });

  it('should accept the boundary limit of 50', () => {
    const result = SearchQuerySchema.safeParse({ q: 'x', limit: '50' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(50);
  });

  it('should reject a limit below 1', () => {
    expect(SearchQuerySchema.safeParse({ q: 'x', limit: '0' }).success).toBe(false);
  });

  it('should reject a non-integer limit', () => {
    expect(SearchQuerySchema.safeParse({ q: 'x', limit: '3.5' }).success).toBe(false);
  });

  it('should accept a q at the max length', () => {
    const q = 'a'.repeat(SEARCH_QUERY_MAX_LENGTH);
    expect(SearchQuerySchema.safeParse({ q }).success).toBe(true);
  });

  it('should reject a q longer than the max length', () => {
    const q = 'a'.repeat(SEARCH_QUERY_MAX_LENGTH + 1);
    expect(SearchQuerySchema.safeParse({ q }).success).toBe(false);
  });
});

describe('SearchFragmentSchema', () => {
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
    similarity: 0.87,
    messageId: '1111111111',
  };

  it('should parse a fully-populated fragment', () => {
    expect(SearchFragmentSchema.safeParse(valid).success).toBe(true);
  });

  it('should reject a fragment with an empty link', () => {
    expect(SearchFragmentSchema.safeParse({ ...valid, link: '' }).success).toBe(false);
  });

  it('should reject a fragment with an empty title', () => {
    expect(SearchFragmentSchema.safeParse({ ...valid, title: '' }).success).toBe(false);
  });

  it('should reject a fragment with a non-URL non-empty link', () => {
    expect(SearchFragmentSchema.safeParse({ ...valid, link: 'not-a-url' }).success).toBe(false);
  });

  it('should reject a link with embedded whitespace', () => {
    expect(
      SearchFragmentSchema.safeParse({ ...valid, link: 'https://example.com/a b' }).success,
    ).toBe(false);
  });

  it('should reject a host-less https:// link', () => {
    expect(SearchFragmentSchema.safeParse({ ...valid, link: 'https://' }).success).toBe(false);
  });

  it('should reject a non-http(s) scheme link', () => {
    expect(SearchFragmentSchema.safeParse({ ...valid, link: 'ftp://x' }).success).toBe(false);
  });

  it('should accept an uppercase-scheme link', () => {
    expect(
      SearchFragmentSchema.safeParse({ ...valid, link: 'HTTPS://example.com/doc' }).success,
    ).toBe(true);
  });

  it('should reject a fragment whose id is not a uuid', () => {
    expect(SearchFragmentSchema.safeParse({ ...valid, id: 'nope' }).success).toBe(false);
  });

  it('should reject a similarity outside [0,1]', () => {
    expect(SearchFragmentSchema.safeParse({ ...valid, similarity: 1.2 }).success).toBe(false);
    expect(SearchFragmentSchema.safeParse({ ...valid, similarity: -0.1 }).success).toBe(false);
  });

  it('should reject a fragment missing a required field', () => {
    const missing: Record<string, unknown> = { ...valid };
    delete missing.messageId;
    expect(SearchFragmentSchema.safeParse(missing).success).toBe(false);
  });
});

describe('SearchResponseSchema', () => {
  it('should parse an empty results array (AC3)', () => {
    expect(SearchResponseSchema.safeParse({ results: [] }).success).toBe(true);
  });
});

describe('SEARCH_ERROR', () => {
  it('should expose the stable search error codes', () => {
    expect(SEARCH_ERROR.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(SEARCH_ERROR.INTERNAL).toBe('INTERNAL');
  });
});
