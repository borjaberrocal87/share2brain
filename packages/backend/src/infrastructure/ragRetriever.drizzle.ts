// Infrastructure adapter: the RAG agent's `retrieve` step. Composes the
// EXISTING QueryEmbedder + EmbeddingSearchRepository rather than hand-writing a
// new pgvector query (D4) — this inherits AD-12 (RBAC-in-query) and the
// deleted-message exclusion (D1) for free. Mirrors searchService.ts's fast path.
import { SearchFragmentSchema, type SearchFragment } from '@hivly/shared/schemas';

import type { EmbeddingSearchRepository } from '../domain/repositories/embeddingSearchRepository.js';
import type { QueryEmbedder } from '../domain/repositories/queryEmbedder.js';
import type { RagRetriever } from '../domain/repositories/ragRetriever.js';

export function createDrizzleRagRetriever(deps: {
  embedder: QueryEmbedder;
  searchRepo: EmbeddingSearchRepository;
}): RagRetriever {
  const { embedder, searchRepo } = deps;

  return {
    async retrieve(query, allowedChannelIds, topK): Promise<SearchFragment[]> {
      // Deny-by-default: an empty scope can only yield nothing. Skip the paid
      // embeddings call entirely (the repo also short-circuits defensively).
      if (allowedChannelIds.length === 0) return [];

      const queryVector = await embedder.embedQuery(query);
      const rows = await searchRepo.searchByEmbedding(queryVector, allowedChannelIds, topK);

      return rows.map((r) =>
        SearchFragmentSchema.parse({
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
        }),
      );
    },
  };
}
