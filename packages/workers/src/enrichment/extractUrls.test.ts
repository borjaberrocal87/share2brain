import { describe, expect, it } from 'vitest';

import { extractUrls } from './extractUrls.js';

const HTTPS_ONLY: ('http' | 'https')[] = ['https'];
const HTTP_AND_HTTPS: ('http' | 'https')[] = ['http', 'https'];

describe('extractUrls', () => {
  it('should return [] for content with no URL', () => {
    expect(extractUrls('just some plain chat text', HTTPS_ONLY)).toEqual([]);
  });

  it('should extract a bare URL', () => {
    expect(extractUrls('check https://example.com/doc out', HTTPS_ONLY)).toEqual([
      'https://example.com/doc',
    ]);
  });

  it('should unwrap a Discord suppressed-embed angle-bracket URL', () => {
    expect(extractUrls('see <https://example.com/doc> for details', HTTPS_ONLY)).toEqual([
      'https://example.com/doc',
    ]);
  });

  it('should extract the URL from a markdown link', () => {
    expect(extractUrls('read [the docs](https://example.com/doc) now', HTTPS_ONLY)).toEqual([
      'https://example.com/doc',
    ]);
  });

  it('should strip trailing sentence punctuation', () => {
    expect(extractUrls('Look at https://x.com/a.', HTTPS_ONLY)).toEqual(['https://x.com/a']);
    expect(extractUrls('Look at https://x.com/a,', HTTPS_ONLY)).toEqual(['https://x.com/a']);
    expect(extractUrls('Look at https://x.com/a!', HTTPS_ONLY)).toEqual(['https://x.com/a']);
    expect(extractUrls('Is this https://x.com/a?', HTTPS_ONLY)).toEqual(['https://x.com/a']);
  });

  it('should strip a trailing unbalanced paren from parenthetical prose', () => {
    expect(extractUrls('(see https://x.com/b)', HTTPS_ONLY)).toEqual(['https://x.com/b']);
  });

  it('should keep a trailing paren when the URL contains an unmatched opening paren', () => {
    expect(
      extractUrls('wiki entry https://en.wikipedia.org/wiki/Foo_(bar)', HTTPS_ONLY),
    ).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
  });

  it('should normalize an uppercase scheme via the URL object', () => {
    expect(extractUrls('HTTPS://Example.COM/Doc', HTTPS_ONLY)).toEqual([
      'https://example.com/Doc',
    ]);
  });

  it('should reject a URL with embedded credentials', () => {
    expect(extractUrls('https://user:pass@example.com/doc', HTTPS_ONLY)).toEqual([]);
  });

  it('should drop a URL whose scheme is not in allowedSchemes', () => {
    expect(extractUrls('http://example.com/doc', HTTPS_ONLY)).toEqual([]);
  });

  it('should keep an http URL when http is in allowedSchemes', () => {
    expect(extractUrls('http://example.com/doc', HTTP_AND_HTTPS)).toEqual([
      'http://example.com/doc',
    ]);
  });

  it('should dedup the same URL appearing twice, preserving first-occurrence order', () => {
    expect(
      extractUrls(
        'https://b.com then https://a.com then https://b.com again',
        HTTPS_ONLY,
      ),
    ).toEqual(['https://b.com/', 'https://a.com/']);
  });

  it('should preserve order across multiple distinct URLs', () => {
    expect(
      extractUrls('first https://one.com then https://two.com', HTTPS_ONLY),
    ).toEqual(['https://one.com/', 'https://two.com/']);
  });

  it('should be deterministic — identical input yields identical output', () => {
    const content = 'see <https://a.com> and [link](https://b.com/x) and https://a.com again';
    expect(extractUrls(content, HTTPS_ONLY)).toEqual(extractUrls(content, HTTPS_ONLY));
  });
});
