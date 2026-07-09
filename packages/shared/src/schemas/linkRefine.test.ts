import { describe, expect, it } from 'vitest';

import { isHttpUrl, LINK_REFINE_MESSAGE } from './linkRefine.js';

describe('isHttpUrl', () => {
  it('should reject an empty string', () => {
    expect(isHttpUrl('')).toBe(false);
  });

  it('should accept a valid http(s) URL', () => {
    expect(isHttpUrl('https://example.com/doc')).toBe(true);
  });

  it('should accept an uppercase-scheme URL (case-insensitive by construction)', () => {
    expect(isHttpUrl('HTTPS://Example.COM/Doc')).toBe(true);
  });

  it('should reject a non-URL string', () => {
    expect(isHttpUrl('not-a-url')).toBe(false);
  });

  it('should reject a URL with embedded whitespace', () => {
    expect(isHttpUrl('https://example.com/a b')).toBe(false);
  });

  it('should reject https:// with no host', () => {
    expect(isHttpUrl('https://')).toBe(false);
  });

  it('should reject a non-http(s) scheme', () => {
    expect(isHttpUrl('ftp://x')).toBe(false);
  });
});

describe('LINK_REFINE_MESSAGE', () => {
  it('should be a stable, human-readable message', () => {
    expect(LINK_REFINE_MESSAGE).toBe('link must be a valid HTTP(S) URL');
  });
});
