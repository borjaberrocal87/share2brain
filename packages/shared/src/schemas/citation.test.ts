import { describe, expect, it } from 'vitest';

import { CitationSchema } from './citation.js';

describe('CitationSchema', () => {
  const valid = {
    channel: 'general',
    author: 'ada',
    date: '2026-07-06T00:00:00.000Z',
    link: '',
  };

  it('should parse a citation with channel, author, date and an empty link', () => {
    expect(CitationSchema.safeParse(valid).success).toBe(true);
  });

  it('should parse a citation with a valid HTTP(S) link', () => {
    expect(
      CitationSchema.safeParse({ ...valid, link: 'https://example.com/doc' }).success,
    ).toBe(true);
  });

  it('should reject a citation with a non-URL non-empty link', () => {
    expect(CitationSchema.safeParse({ ...valid, link: 'not-a-url' }).success).toBe(false);
  });

  it('should reject a citation missing link', () => {
    const missing: Record<string, unknown> = { ...valid };
    delete missing.link;
    expect(CitationSchema.safeParse(missing).success).toBe(false);
  });

  it('should reject a citation missing a required field', () => {
    expect(CitationSchema.safeParse({ channel: 'general', author: 'ada' }).success).toBe(false);
  });

  it('should reject a non-string field', () => {
    expect(
      CitationSchema.safeParse({ ...valid, date: 42 }).success,
    ).toBe(false);
  });
});
