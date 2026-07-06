import { describe, expect, it } from 'vitest';

import { chunkContents } from './chunking.js';

const OPTIONS = { chunkSize: 500, chunkOverlap: 50 };

describe('chunkContents', () => {
  it('should produce a single chunk for a short group', async () => {
    const chunks = await chunkContents(['hello world'], OPTIONS);
    expect(chunks).toEqual(['hello world']);
  });

  it('should join multiple contents with a newline', async () => {
    const chunks = await chunkContents(['first', 'second'], OPTIONS);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe('first\nsecond');
  });

  it('should return no chunks for empty input', async () => {
    expect(await chunkContents([], OPTIONS)).toEqual([]);
    expect(await chunkContents([''], OPTIONS)).toEqual([]);
    expect(await chunkContents(['   ', '\n'], OPTIONS)).toEqual([]);
  });

  it('should split long text into multiple chunks using the approx-token length', async () => {
    // chunkSize 10 tokens ≈ 40 chars; build text well past that so it must split.
    // Use paragraph/sentence separators the recursive splitter can break on.
    const paragraph = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} here.`).join(' ');

    const chunks = await chunkContents([paragraph], { chunkSize: 10, chunkOverlap: 2 });

    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk must respect the approx-token budget (chars/4 ≤ chunkSize),
    // allowing the splitter's tolerance for an unbreakable long token.
    for (const chunk of chunks) {
      expect(Math.ceil(chunk.length / 4)).toBeLessThanOrEqual(30);
    }
  });

  it('should clamp chunkOverlap below chunkSize instead of throwing', async () => {
    // The splitter throws synchronously if chunkOverlap >= chunkSize; a
    // misconfigured pair must not take down every group forever.
    await expect(chunkContents(['hello world'], { chunkSize: 5, chunkOverlap: 5 })).resolves.toEqual([
      'hello world',
    ]);
    await expect(chunkContents(['hello world'], { chunkSize: 5, chunkOverlap: 100 })).resolves.toEqual([
      'hello world',
    ]);
  });

  it('should clamp a non-positive chunkSize to 1 instead of throwing', async () => {
    // A chunkSize <= 0 would throw synchronously; clamped to 1, the call must not
    // throw and must not lose any of the original content.
    const zero = await chunkContents(['hi'], { chunkSize: 0, chunkOverlap: 0 });
    expect(zero.join('')).toBe('hi');

    const negative = await chunkContents(['hi'], { chunkSize: -10, chunkOverlap: -5 });
    expect(negative.join('')).toBe('hi');
  });

  it('should cap an oversized chunkSize instead of building one unbounded chunk', async () => {
    // ~13 500 approx-tokens of content — well past MAX_CHUNK_SIZE (8000). Without
    // the cap, requesting chunkSize 10_000_000 would keep this as a single chunk.
    const paragraph = Array.from({ length: 2000 }, (_, i) => `Sentence number ${i} here.`).join(' ');
    const chunks = await chunkContents([paragraph], { chunkSize: 10_000_000, chunkOverlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Math.ceil(chunk.length / 4)).toBeLessThanOrEqual(8000);
    }
  });

  it('should reassemble to cover all the original words when split', async () => {
    const paragraph = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    const chunks = await chunkContents([paragraph], { chunkSize: 8, chunkOverlap: 2 });

    const joined = chunks.join(' ');
    for (let i = 0; i < 20; i++) {
      expect(joined).toContain(`word${i}`);
    }
  });
});
