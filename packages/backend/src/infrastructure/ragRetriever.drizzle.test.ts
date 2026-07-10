// Unit tests for the ragRetriever adapter — F2 (Story 7.4): a malformed row
// must not fail the whole retrieval, only be skipped with a warn. Plain fakes
// (no Drizzle, no LangChain): the adapter depends only on the two domain ports
// + Logger. Mirrors searchService.test.ts.
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@share2brain/shared/logger';

import type { EmbeddingSearchRepository, SearchFragmentRow } from '../domain/repositories/embeddingSearchRepository.js';
import type { QueryEmbedder } from '../domain/repositories/queryEmbedder.js';
import { createDrizzleRagRetriever } from './ragRetriever.drizzle.js';

const QUERY_VEC = [0.1, 0.2, 0.3];

function fakeEmbedder(): QueryEmbedder {
  return { embedQuery: vi.fn(async () => QUERY_VEC) };
}

function fakeRepo(rows: SearchFragmentRow[]): EmbeddingSearchRepository {
  return { searchByEmbedding: vi.fn(async () => rows) };
}

function fakeLogger(): Logger & { warn: ReturnType<typeof vi.fn<Logger['warn']>> } {
  return {
    debug: vi.fn<Logger['debug']>(),
    info: vi.fn<Logger['info']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
  };
}

function validRow(overrides: Partial<SearchFragmentRow> = {}): SearchFragmentRow {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    title: 'The Answer to Everything',
    description: 'the answer is 42',
    link: 'https://example.com/e2e/the-answer',
    channelId: 'chan-1',
    channelName: 'general',
    authorId: 'author-1',
    authorName: 'author-1',
    createdAt: '2026-07-06T00:00:00.000Z',
    similarity: 0.91,
    messageId: 'anchor-msg',
    ...overrides,
  };
}

describe('createDrizzleRagRetriever().retrieve', () => {
  it('should skip one malformed row among K valid rows and warn exactly once, without field values', async () => {
    const rows: SearchFragmentRow[] = [
      validRow({ id: '550e8400-e29b-41d4-a716-446655440001' }),
      validRow({ id: '550e8400-e29b-41d4-a716-446655440002', link: '' }), // malformed: strict link rejects ''
      validRow({ id: '550e8400-e29b-41d4-a716-446655440003' }),
    ];
    const logger = fakeLogger();
    const retriever = createDrizzleRagRetriever({
      embedder: fakeEmbedder(),
      searchRepo: fakeRepo(rows),
      logger,
    });

    const fragments = await retriever.retrieve('q', ['chan-1'], 5);

    expect(fragments).toHaveLength(2);
    expect(fragments.map((f) => f.id)).toEqual([
      '550e8400-e29b-41d4-a716-446655440001',
      '550e8400-e29b-41d4-a716-446655440003',
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, context] = logger.warn.mock.calls[0];
    expect(message).toBe('skipping malformed search fragment row');
    expect(context).toEqual({
      embeddingId: '550e8400-e29b-41d4-a716-446655440002',
      channelId: 'chan-1',
      // Structural, content-free reason: an array of { path, code } Zod issues.
      reason: expect.arrayContaining([
        expect.objectContaining({ code: expect.any(String) }),
      ]),
    });
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain('The Answer to Everything');
    expect(serialized).not.toContain('the answer is 42');
  });

  it('should warn nothing when every row is valid', async () => {
    const rows: SearchFragmentRow[] = [
      validRow({ id: '550e8400-e29b-41d4-a716-446655440001' }),
      validRow({ id: '550e8400-e29b-41d4-a716-446655440002' }),
    ];
    const logger = fakeLogger();
    const retriever = createDrizzleRagRetriever({
      embedder: fakeEmbedder(),
      searchRepo: fakeRepo(rows),
      logger,
    });

    const fragments = await retriever.retrieve('q', ['chan-1'], 5);

    expect(fragments).toHaveLength(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('should short-circuit on an empty scope without calling the embedder', async () => {
    const embedder = fakeEmbedder();
    const logger = fakeLogger();
    const retriever = createDrizzleRagRetriever({
      embedder,
      searchRepo: fakeRepo([validRow()]),
      logger,
    });

    const fragments = await retriever.retrieve('q', [], 5);

    expect(fragments).toEqual([]);
    expect(embedder.embedQuery).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
