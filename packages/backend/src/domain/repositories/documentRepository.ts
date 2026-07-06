// Domain port: the paginated documents listing over the `embeddings` index,
// read-annotated per user. Pure — no Drizzle, no SQL. The Drizzle implementation
// lives in infrastructure/ and is the ONLY file that knows the SQL, so the
// application layer depends only on this contract (AD-2 spirit). Mirrors
// embeddingSearchRepository.ts.
//
// AD-12 is baked into the contract: `allowedChannelIds` is a REQUIRED argument
// and the implementation MUST filter inside the query (never a post-filter).

/**
 * A raw document fragment row (pre-Zod). Shapes exactly the columns the SQL
 * projects; the application service maps + validates it against
 * `DocumentFragmentSchema` (AD-6). `createdAt`/`indexedAt` are already ISO 8601
 * strings (the adapter serializes the pg `Date`).
 */
export interface DocumentFragmentRow {
  id: string;
  content: string;
  channelId: string;
  channelName: string;
  authorId: string;
  authorName: string;
  createdAt: string;
  indexedAt: string;
  messageId: string;
  isRead: boolean;
}

export interface DocumentRepository {
  /**
   * A page of document fragments, newest indexed first (D4), restricted to
   * `allowedChannelIds` INSIDE the SQL (AD-12), excluding any grouped chunk that
   * contains a soft-deleted message (D1: exclude-if-any), and annotated with
   * `isRead` for `userId` via a LEFT JOIN against `user_read_status`. An empty
   * `allowedChannelIds` resolves to `[]` without touching the DB (deny-by-default;
   * `ANY('{}')` is unsafe).
   */
  listDocuments(
    userId: string,
    allowedChannelIds: string[],
    limit: number,
    offset: number,
  ): Promise<DocumentFragmentRow[]>;

  /**
   * Count of all visible fragments in scope (same RBAC + D1 filter as
   * `listDocuments`, no pagination) — used for the response `total` (D4).
   */
  countDocuments(allowedChannelIds: string[]): Promise<number>;
}
