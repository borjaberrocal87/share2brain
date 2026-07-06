// Unit tests for the search application service — the orchestration + AC3 fast
// path. Uses plain fakes (no Drizzle, no LangChain, no Express): the service
// depends only on the two domain ports. Mirrors rbacService.test.ts.
import { describe, expect, it, vi } from 'vitest';

import type { EmbeddingSearchRepository, SearchFragmentRow } from '../../domain/repositories/embeddingSearchRepository.js';
import type { QueryEmbedder } from '../../domain/repositories/queryEmbedder.js';
import { createSearchService } from './searchService.js';

const QUERY_VEC = [0.1, 0.2, 0.3];

function fakeEmbedder(vec: number[] = QUERY_VEC): QueryEmbedder {
  return { embedQuery: vi.fn(async () => vec) };
}

function fakeRepo(rows: SearchFragmentRow[]): EmbeddingSearchRepository {
  return { searchByEmbedding: vi.fn(async () => rows) };
}

const ROW: SearchFragmentRow = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  content: 'the answer is 42',
  channelId: 'chan-1',
  channelName: 'general',
  authorId: 'author-anchor',
  authorName: 'author-anchor',
  createdAt: '2026-07-06T00:00:00.000Z',
  similarity: 0.91,
  messageId: 'anchor-msg',
};

describe('searchService.search', () => {
  it('should return an empty result WITHOUT embedding the query when the scope is empty (AC3)', async () => {
    const embedder = fakeEmbedder();
    const searchRepo = fakeRepo([]);
    const service = createSearchService({ embedder, searchRepo });

    const result = await service.search('anything', 5, []);

    expect(result).toEqual({ results: [] });
    // The paid embeddings call must be skipped — nothing could ever match.
    expect(embedder.embedQuery).not.toHaveBeenCalled();
    expect(searchRepo.searchByEmbedding).not.toHaveBeenCalled();
  });

  it('should embed the query then search the repo with the vector, scope and limit (happy path)', async () => {
    const embedder = fakeEmbedder();
    const searchRepo = fakeRepo([ROW]);
    const service = createSearchService({ embedder, searchRepo });

    const result = await service.search('how do I deploy', 7, ['chan-1', 'chan-2']);

    expect(embedder.embedQuery).toHaveBeenCalledWith('how do I deploy');
    expect(searchRepo.searchByEmbedding).toHaveBeenCalledWith(QUERY_VEC, ['chan-1', 'chan-2'], 7);
    expect(result.results).toHaveLength(1);
  });

  it('should preserve the D2 anchor fields when mapping rows to fragments', async () => {
    const service = createSearchService({ embedder: fakeEmbedder(), searchRepo: fakeRepo([ROW]) });

    const { results } = await service.search('q', 5, ['chan-1']);

    expect(results[0]).toEqual({
      id: ROW.id,
      content: ROW.content,
      channelId: ROW.channelId,
      channelName: ROW.channelName,
      authorId: ROW.authorId,
      authorName: ROW.authorName, // D2: equals authorId
      createdAt: ROW.createdAt,
      similarity: ROW.similarity,
      messageId: ROW.messageId,
    });
  });

  it('should validate the response against the shared contract (rejects a bad row)', async () => {
    const badRow = { ...ROW, similarity: 9 }; // outside [0,1]
    const service = createSearchService({
      embedder: fakeEmbedder(),
      searchRepo: fakeRepo([badRow]),
    });

    await expect(service.search('q', 5, ['chan-1'])).rejects.toThrow();
  });
});
