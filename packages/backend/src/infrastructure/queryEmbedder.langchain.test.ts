// Unit tests for the LangChain query embedder adapter. The provider factory is
// mocked so no real embeddings endpoint is hit; the real `assertEmbeddingDimensions`
// is kept. Covers the happy path AND the guard branches (width mismatch, non-finite
// component, all-zero vector) that are the Story 3.0 "corrupt vector" safety net.
import type { HivlyConfig } from '@hivly/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const embedQuery = vi.fn<(text: string) => Promise<number[]>>();

vi.mock('@hivly/shared/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hivly/shared/providers')>();
  return {
    ...actual, // keep the real assertEmbeddingDimensions
    createEmbeddingsModel: vi.fn(() => ({ embedQuery }) as unknown),
  };
});

import { createLangchainQueryEmbedder } from './queryEmbedder.langchain.js';

// Only `.dimensions` is read by the adapter; the mocked factory ignores the rest.
const config = { dimensions: 3 } as unknown as HivlyConfig['embeddings'];

describe('createLangchainQueryEmbedder', () => {
  beforeEach(() => {
    embedQuery.mockReset();
  });

  it('should return the vector on the happy path', async () => {
    embedQuery.mockResolvedValue([1, 0, 0]);
    const embedder = createLangchainQueryEmbedder(config);

    await expect(embedder.embedQuery('hello')).resolves.toEqual([1, 0, 0]);
    expect(embedQuery).toHaveBeenCalledWith('hello');
  });

  it('should throw on a dimension mismatch (width guard)', async () => {
    embedQuery.mockResolvedValue([1, 0]); // length 2 != 3
    const embedder = createLangchainQueryEmbedder(config);

    await expect(embedder.embedQuery('hello')).rejects.toThrow(/dimension mismatch/i);
  });

  it('should throw on a non-finite component (NaN/Infinity)', async () => {
    embedQuery.mockResolvedValue([Number.NaN, 0, 0]);
    const embedder = createLangchainQueryEmbedder(config);

    await expect(embedder.embedQuery('hello')).rejects.toThrow(/non-finite/i);
  });

  it('should throw on an all-zero (degenerate) vector', async () => {
    embedQuery.mockResolvedValue([0, 0, 0]);
    const embedder = createLangchainQueryEmbedder(config);

    await expect(embedder.embedQuery('hello')).rejects.toThrow(/all-zero/i);
  });
});
