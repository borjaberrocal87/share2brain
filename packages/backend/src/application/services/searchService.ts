// Application service: semantic search orchestration. Turns a query + the caller's
// RBAC scope into a validated SearchResponse. Depends ONLY on the two domain ports
// (QueryEmbedder, EmbeddingSearchRepository) — no Drizzle, no LangChain, no Express
// — so it is unit-testable with plain fakes. Mirrors rbacService.ts.
import { SearchResponseSchema, type SearchResponse } from '@hivly/shared/schemas';

import type { EmbeddingSearchRepository } from '../../domain/repositories/embeddingSearchRepository.js';
import type { QueryEmbedder } from '../../domain/repositories/queryEmbedder.js';

export interface SearchService {
  /**
   * Search the indexed knowledge for `q`, restricted to `allowedChannelIds` (AD-12,
   * enforced inside the vector query). An empty scope returns `{ results: [] }`
   * without embedding the query (AC3 fast path — no point paying for a call that
   * can only return nothing).
   */
  search(q: string, limit: number, allowedChannelIds: string[]): Promise<SearchResponse>;
}

export function createSearchService(deps: {
  embedder: QueryEmbedder;
  searchRepo: EmbeddingSearchRepository;
}): SearchService {
  const { embedder, searchRepo } = deps;

  return {
    async search(q, limit, allowedChannelIds): Promise<SearchResponse> {
      // AC3 fast path: deny-by-default scope can only yield nothing. Skip the paid
      // embeddings call entirely (the repo also short-circuits defensively).
      if (allowedChannelIds.length === 0) {
        return { results: [] };
      }

      const queryVector = await embedder.embedQuery(q);
      const rows = await searchRepo.searchByEmbedding(queryVector, allowedChannelIds, limit);

      const results = rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        link: r.link,
        channelId: r.channelId,
        channelName: r.channelName,
        authorId: r.authorId,
        authorName: r.authorName,
        createdAt: r.createdAt,
        similarity: r.similarity,
        messageId: r.messageId,
      }));

      // Validate against the shared contract before it leaves the service (AD-6).
      return SearchResponseSchema.parse({ results });
    },
  };
}
