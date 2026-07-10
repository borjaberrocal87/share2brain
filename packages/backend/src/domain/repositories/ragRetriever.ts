// Domain port: the RAG agent's `retrieve` step. Pure — no Drizzle, no LangChain.
// The adapter in infrastructure/ composes the existing QueryEmbedder +
// EmbeddingSearchRepository so it inherits AD-12 (RBAC-in-query) and the
// deleted-message exclusion (D1) for free. Mirrors embeddingSearchRepository.ts.
import type { SearchFragment } from '@share2brain/shared/schemas';

export interface RagRetriever {
  /**
   * Retrieve the `topK` fragments most relevant to `query`, restricted to
   * `allowedChannelIds` (AD-12, enforced inside the vector query). An empty
   * scope yields `[]` without a paid embeddings call (deny-by-default).
   */
  retrieve(query: string, allowedChannelIds: string[], topK: number): Promise<SearchFragment[]>;
}
