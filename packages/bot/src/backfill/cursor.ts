// Derived per-channel backfill cursor (AC-1). There is NO last_seen_message_id
// column (AD-5 — decided in Story 3.1): the cursor IS the newest row already
// persisted for the channel, so inserting each backfilled message advances it
// implicitly and a crash-resume starts exactly at the remaining gap.
//
// NEVER MAX(id): snowflakes are variable-length TEXT (18 digits pre-2022, 19
// after), so lexicographic MAX can return an OLD 18-digit id over a NEWER
// 19-digit one and re-fetch years of history. Newest-by-created_at rides the
// existing index idx_discord_messages_channel (channel_id, created_at DESC); a
// same-millisecond tie is harmless — the overlap re-fetch is skipped by the
// idempotent insert.
import { sql, type Database } from '@share2brain/shared/db';

/**
 * Resolve the backfill cursor for one channel: the id of the newest persisted
 * message, or null when the channel has no rows yet (first run → limit path).
 *
 * Throws — does NOT return null — on a driver/schema contract break (id isn't
 * a string). Collapsing that into null would silently downgrade an established
 * channel to the bounded `latestPages` limit path instead of the unbounded gap
 * fetch, permanently skipping the older part of its offline gap. The caller
 * (main.ts) treats a thrown error as "skip this channel's backfill this run,
 * retry cursor resolution next boot" rather than guessing.
 */
export async function getChannelCursor(db: Database, channelId: string): Promise<string | null> {
  const result = await db.execute(
    sql`select id from discord_messages where channel_id = ${channelId} order by created_at desc limit 1`,
  );
  const row = result.rows[0];
  if (!row || typeof row !== 'object') return null;
  const val = (row as Record<string, unknown>).id;
  if (typeof val === 'string') return val;
  throw new Error(
    `backfill cursor: unexpected id type "${typeof val}" from driver for channel ${channelId}`,
  );
}
