// Domain port: the aggregate reads the stats service needs. Pure — no Drizzle, no
// SQL. The Drizzle implementation lives in infrastructure/ and is the ONLY file
// that knows the SQL, so the application layer depends only on this contract
// (AD-2 spirit). Mirrors documentRepository.ts.
//
// AD-12 is baked into the contract: every channel-scoped method takes
// `allowedChannelIds` and MUST filter inside the query (never a post-filter).
// The only exception is `countUserAgentQueries`, which has no `channel_id`
// (D3 — the per-user agent-usage KPI).

/** Scoped resources/channels KPI counts plus the `authors` KPI (D3). */
export interface ScopedKpiCounts {
  resources: number;
  resourcesThisWeek: number;
  channels: number;
  authors: number;
}

/** One non-zero day of the activity series (D5 — the service zero-fills). */
export interface ActivityDay {
  day: string; // 'YYYY-MM-DD'
  count: number;
}

/** One per-channel volume row (D7 — `channelName` already resolved). */
export interface ChannelCount {
  channelId: string;
  channelName: string;
  count: number;
}

/** One row of the top-5-most-active-users aggregate (D1/D2 — `authorName` already resolved). */
export interface TopUserRow {
  authorId: string;
  authorName: string;
  count: number;
}

export interface StatsRepository {
  /**
   * Scoped `resources`/`channels`/`authors` KPI values plus the weekly delta for
   * `resources` (D3). `weekStart` is an ISO 8601 UTC timestamp: `created_at >=
   * weekStart` counts toward `resourcesThisWeek`. An empty `allowedChannelIds`
   * resolves to all-zero without touching the DB (deny-by-default).
   */
  getScopedKpiCounts(allowedChannelIds: string[], weekStart: string): Promise<ScopedKpiCounts>;

  /**
   * Non-zero indexing-activity days within `[fromDate, now]` UTC, restricted to
   * `allowedChannelIds` (AC4). The service zero-fills missing days (D5). An empty
   * `allowedChannelIds` resolves to `[]` without touching the DB.
   */
  getActivity(allowedChannelIds: string[], fromDate: string): Promise<ActivityDay[]>;

  /**
   * Per-channel resource volume, restricted to `allowedChannelIds`, ordered
   * `count DESC, channelId ASC` (D7). An empty `allowedChannelIds` resolves to
   * `[]` without touching the DB.
   */
  getChannelCounts(allowedChannelIds: string[]): Promise<ChannelCount[]>;

  /**
   * Count of `userId`'s read resources within `allowedChannelIds` (AC5). An empty
   * `allowedChannelIds` resolves to `0` without touching the DB.
   */
  getCoverageReadCount(userId: string, allowedChannelIds: string[]): Promise<number>;

  /**
   * Count of `userId`'s own `role = 'user'` messages across their conversations
   * within `[fromDate, now]` (D3 `queries` KPI — 30-day window, review decision
   * 2026-07-10). `fromDate` is an ISO 8601 UTC timestamp computed by the service
   * (single-clock determinism). No `channel_id` — this is the one exception to
   * AD-12 channel scoping (per-user data has no leak surface) and ALWAYS runs,
   * even when `allowedChannelIds` is empty (D6).
   */
  countUserAgentQueries(userId: string, fromDate: string): Promise<number>;

  /**
   * Top 5 `author_id`s by count of scoped, non-deleted embeddings whose anchor is
   * authored by that `author_id` (same basis as the `authors` KPI — D2), ordered
   * `count DESC, authorId ASC`, at most 5 rows (D4). `authorName` resolves via
   * `COALESCE(<latest scoped non-blank author_name>, username, authorId)` (D1) —
   * the pick considers only the caller's scoped, non-deleted anchor rows, never a
   * name captured in a denied channel. An empty `allowedChannelIds` resolves to
   * `[]` without touching the DB (deny-by-default — this method IS channel-scoped,
   * unlike `countUserAgentQueries`).
   */
  getTopUsers(allowedChannelIds: string[]): Promise<TopUserRow[]>;
}
