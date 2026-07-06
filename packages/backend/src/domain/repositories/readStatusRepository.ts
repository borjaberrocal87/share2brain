// Domain port: per-user read tracking over `user_read_status`. Pure — no
// Drizzle, no SQL. The Drizzle implementation lives in infrastructure/ and is
// the ONLY file that knows the SQL, so the application layer depends only on
// this contract (AD-2 spirit). Mirrors documentRepository.ts.
//
// AD-12 is baked into the contract: every method that resolves a target set
// takes `allowedChannelIds`/`channelIds` and the implementation MUST filter
// inside the query (never a post-filter).

export interface ReadStatusRepository {
  /**
   * The channel id of `embeddingId` iff it exists, is in `allowedChannelIds`,
   * and is not D1-excluded (a group member soft-deleted); else `null`. Drives
   * AC3's undifferentiated 404 (D5). An empty `allowedChannelIds` resolves to
   * `null` without touching the DB.
   */
  findVisibleEmbeddingChannel(
    embeddingId: string,
    allowedChannelIds: string[],
  ): Promise<string | null>;

  /** Mark `embeddingId` as read for `userId` (`ON CONFLICT DO NOTHING` — idempotent). */
  markRead(userId: string, embeddingId: string): Promise<void>;

  /** Unmark `embeddingId` as read for `userId` — idempotent, always succeeds (AC4). */
  unmarkRead(userId: string, embeddingId: string): Promise<void>;

  /**
   * Mark every visible (RBAC + D1), not-already-read fragment in `channelIds` as
   * read for `userId`, batched (AC5). Returns the count of NEWLY inserted rows.
   * An empty `channelIds` resolves to `0` without touching the DB.
   */
  markAllInChannels(userId: string, channelIds: string[]): Promise<number>;

  /**
   * Per-channel unread fragment count for `userId`, restricted to
   * `allowedChannelIds` INSIDE the SQL (AD-12) and excluding D1-excluded
   * fragments (D7). Channels with 0 unread are absent from the map. An empty
   * `allowedChannelIds` resolves to `{}` without touching the DB.
   */
  unreadCountByChannel(
    userId: string,
    allowedChannelIds: string[],
  ): Promise<Record<string, number>>;
}
