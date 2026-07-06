// Domain port: the pgvector similarity search over the `embeddings` index.
// Pure — no Drizzle, no SQL. The Drizzle implementation lives in infrastructure/
// and is the ONLY file that knows the SQL, so the application layer depends only
// on this contract (AD-2 spirit). Mirrors channelPermissionRepository.ts.
//
// AD-12 is baked into the contract: `allowedChannelIds` is a REQUIRED argument and
// the implementation MUST filter inside the query (never a post-filter). This is
// the first read-side consumer of the vectors the Indexer wrote in Epic 3.

/**
 * A raw search result row (pre-Zod). Shapes exactly the columns the SQL projects;
 * the application service maps + validates it against `SearchFragmentSchema` (AD-6).
 * `createdAt` is already an ISO 8601 string (the adapter serializes the pg `Date`).
 */
export interface SearchFragmentRow {
  id: string;
  content: string;
  channelId: string;
  channelName: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  similarity: number;
  messageId: string;
}

export interface EmbeddingSearchRepository {
  /**
   * Nearest-neighbour search: the fragments most similar to `queryVector`, ordered
   * by descending cosine similarity, restricted to `allowedChannelIds` INSIDE the
   * SQL (AD-12) and excluding any grouped chunk that contains a soft-deleted message
   * (D1: exclude-if-any). An empty `allowedChannelIds` resolves to `[]` without
   * touching the DB (deny-by-default; `ANY('{}')` is unsafe).
   */
  searchByEmbedding(
    queryVector: number[],
    allowedChannelIds: string[],
    limit: number,
  ): Promise<SearchFragmentRow[]>;
}
