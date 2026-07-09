import { describe, expect, it } from 'vitest';

import { extractPageHints, MAX_BODY_TEXT_LENGTH } from './htmlText.js';

describe('extractPageHints — HTML content', () => {
  it('should extract title, meta description, and Open Graph hints', () => {
    const html = `
      <html><head>
        <title>Example Title</title>
        <meta name="description" content="An example description">
        <meta property="og:title" content="OG Title">
        <meta property="og:description" content="OG Description">
      </head><body><p>Body text here.</p></body></html>
    `;
    const hints = extractPageHints(html, 'text/html; charset=utf-8');
    expect(hints).not.toBeNull();
    expect(hints?.title).toBe('Example Title');
    expect(hints?.metaDescription).toBe('An example description');
    expect(hints?.ogTitle).toBe('OG Title');
    expect(hints?.ogDescription).toBe('OG Description');
    expect(hints?.bodyText).toContain('Body text here.');
  });

  it('should remove script and style block content from bodyText', () => {
    const html = `
      <html><body>
        <script>alert('should not appear');</script>
        <style>.hidden { display: none; }</style>
        <p>Visible text.</p>
      </body></html>
    `;
    const hints = extractPageHints(html, 'text/html');
    expect(hints?.bodyText).not.toContain('should not appear');
    expect(hints?.bodyText).not.toContain('display: none');
    expect(hints?.bodyText).toContain('Visible text.');
  });

  it('should strip remaining tags from bodyText', () => {
    const html = '<html><body><div><p>Hello <b>world</b></p></div></body></html>';
    const hints = extractPageHints(html, 'text/html');
    expect(hints?.bodyText).not.toMatch(/<[^>]+>/);
    expect(hints?.bodyText).toContain('Hello');
    expect(hints?.bodyText).toContain('world');
  });

  it('should decode common HTML entities', () => {
    const html = '<html><body><p>Tom &amp; Jerry &lt;3 &quot;fun&quot; &#39;times&#39;</p></body></html>';
    const hints = extractPageHints(html, 'text/html');
    expect(hints?.bodyText).toContain('Tom & Jerry <3 "fun" \'times\'');
  });

  it('should collapse whitespace in bodyText', () => {
    const html = '<html><body><p>Too   much\n\n  whitespace</p></body></html>';
    const hints = extractPageHints(html, 'text/html');
    expect(hints?.bodyText).toBe('Too much whitespace');
  });

  it('should truncate bodyText to the module-constant cap', () => {
    const html = `<html><body><p>${'a'.repeat(MAX_BODY_TEXT_LENGTH + 500)}</p></body></html>`;
    const hints = extractPageHints(html, 'text/html');
    expect(hints?.bodyText.length).toBe(MAX_BODY_TEXT_LENGTH);
  });

  it('should return empty-string hints when title/meta/OG tags are absent', () => {
    const html = '<html><body><p>No head hints at all.</p></body></html>';
    const hints = extractPageHints(html, 'text/html');
    expect(hints?.title).toBe('');
    expect(hints?.metaDescription).toBe('');
    expect(hints?.ogTitle).toBe('');
    expect(hints?.ogDescription).toBe('');
  });
});

describe('extractPageHints — non-HTML text/* content', () => {
  it('should pass through raw text with empty title/meta/OG hints', () => {
    const hints = extractPageHints('Just plain   text\n\ncontent.', 'text/plain');
    expect(hints).not.toBeNull();
    expect(hints?.title).toBe('');
    expect(hints?.metaDescription).toBe('');
    expect(hints?.bodyText).toBe('Just plain text content.');
  });

  it('should truncate plain text to the module-constant cap', () => {
    const text = 'b'.repeat(MAX_BODY_TEXT_LENGTH + 200);
    const hints = extractPageHints(text, 'text/plain');
    expect(hints?.bodyText.length).toBe(MAX_BODY_TEXT_LENGTH);
  });
});

describe('extractPageHints — unusable content types', () => {
  it('should return null for a PDF content type', () => {
    expect(extractPageHints('%PDF-1.4 binary garbage', 'application/pdf')).toBeNull();
  });

  it('should return null for an image content type', () => {
    expect(extractPageHints('\x89PNG binary', 'image/png')).toBeNull();
  });

  it('should return null for a generic binary content type', () => {
    expect(extractPageHints('binary', 'application/octet-stream')).toBeNull();
  });
});
