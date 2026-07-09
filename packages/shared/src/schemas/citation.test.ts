import { describe, expect, it } from 'vitest';

import { CitationSchema } from './citation.js';

describe('CitationSchema', () => {
  const valid = {
    title: 'Deploying with Docker Compose',
    channel: 'general',
    author: 'ada',
    date: '2026-07-06T00:00:00.000Z',
    link: 'https://example.com/doc',
  };

  it('should parse a fully-populated citation', () => {
    expect(CitationSchema.safeParse(valid).success).toBe(true);
  });

  it('should reject a citation with an empty link', () => {
    expect(CitationSchema.safeParse({ ...valid, link: '' }).success).toBe(false);
  });

  it('should reject a citation with a non-URL non-empty link', () => {
    expect(CitationSchema.safeParse({ ...valid, link: 'not-a-url' }).success).toBe(false);
  });

  it('should reject a link with embedded whitespace', () => {
    expect(
      CitationSchema.safeParse({ ...valid, link: 'https://example.com/a b' }).success,
    ).toBe(false);
  });

  it('should reject a host-less https:// link', () => {
    expect(CitationSchema.safeParse({ ...valid, link: 'https://' }).success).toBe(false);
  });

  it('should reject a non-http(s) scheme link', () => {
    expect(CitationSchema.safeParse({ ...valid, link: 'ftp://x' }).success).toBe(false);
  });

  it('should accept an uppercase-scheme link', () => {
    expect(
      CitationSchema.safeParse({ ...valid, link: 'HTTPS://example.com/doc' }).success,
    ).toBe(true);
  });

  it('should reject a citation missing link', () => {
    const missing: Record<string, unknown> = { ...valid };
    delete missing.link;
    expect(CitationSchema.safeParse(missing).success).toBe(false);
  });

  it('should reject a citation with an empty title', () => {
    expect(CitationSchema.safeParse({ ...valid, title: '' }).success).toBe(false);
  });

  it('should reject a citation missing title', () => {
    const missing: Record<string, unknown> = { ...valid };
    delete missing.title;
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
