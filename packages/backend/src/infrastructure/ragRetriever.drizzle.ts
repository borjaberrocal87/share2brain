// Infrastructure adapter: the RAG agent's `retrieve` step. Composes the
// EXISTING QueryEmbedder + EmbeddingSearchRepository rather than hand-writing a
// new pgvector query (D4) — this inherits AD-12 (RBAC-in-query) and the
// deleted-message exclusion (D1) for free. Mirrors searchService.ts's fast path.
import { SearchFragmentSchema, type SearchFragment } from '@share2brain/shared/schemas';
import type { Logger } from '@share2brain/shared/logger';

import type { EmbeddingSearchRepository } from '../domain/repositories/embeddingSearchRepository.js';
import type { QueryEmbedder } from '../domain/repositories/queryEmbedder.js';
import type { RagRetriever } from '../domain/repositories/ragRetriever.js';

export function createDrizzleRagRetriever(deps: {
  embedder: QueryEmbedder;
  searchRepo: EmbeddingSearchRepository;
  logger: Logger;
}): RagRetriever {
  const { embedder, searchRepo, logger } = deps;

  return {
    async retrieve(query, allowedChannelIds, topK): Promise<SearchFragment[]> {
      // Deny-by-default: an empty scope can only yield nothing. Skip the paid
      // embeddings call entirely (the repo also short-circuits defensively).
      if (allowedChannelIds.length === 0) return [];

      const queryVector = await embedder.embedQuery(query);
      const rows = await searchRepo.searchByEmbedding(queryVector, allowedChannelIds, topK);

      const fragments: SearchFragment[] = [];
      for (const r of rows) {
        const parsed = SearchFragmentSchema.safeParse({
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
        });

        // F2 (Story 7.4): a corrupt row (e.g. a pre-7.4 empty-link placeholder)
        // is skipped, not fatal — one bad row must not 500 the whole chat.
        // Never log field values (title/description/link are content).
        if (!parsed.success) {
          logger.warn('skipping malformed search fragment row', {
            embeddingId: r.id,
            channelId: r.channelId,
            // Structural, content-free reason: Zod issue paths + codes only —
            // never `error.message` (a full dump that could echo input values).
            reason: parsed.error.issues.map((i) => ({ path: i.path, code: i.code })),
          });
          continue;
        }

        fragments.push(parsed.data);
      }

      return fragments;
    },
  };
}
