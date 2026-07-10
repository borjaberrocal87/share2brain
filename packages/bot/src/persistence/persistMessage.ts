// Atomic, idempotent persist + publish for a single Discord message (AD-13).
//
// The INSERT into discord_messages and the XADD onto the DISCORD_MESSAGES stream
// run inside ONE Drizzle transaction: if the XADD throws, the transaction rolls
// the INSERT back, so there is never an orphan row without its stream event.
//
// Idempotency (Story 3.2): the INSERT is `onConflictDoNothing`. When the row
// already exists (backfill overlap at the cursor boundary, a live message the
// backfill re-fetches, Gateway re-delivery, crash-resume) the XADD is SKIPPED —
// no duplicate row AND no duplicate stream event. The caller learns which case
// happened via the returned `{ inserted }`.
//
// The only residual inconsistency is a COMMIT that fails *after* a successful
// XADD → an event with no row. That is tolerated: delivery is at-least-once and
// the Indexer is idempotent (AD-13). Redis cannot be a true XA participant, so we
// do not pretend otherwise.
//
// Backfill's persistWithRetry (Story 3.2, packages/bot/src/backfill/backfiller.ts)
// retries this whole function on any thrown error, INCLUDING this exact race — the
// rolled-back INSERT means a retry's onConflictDoNothing finds no row and inserts
// (and XADDs) again. Up to MAX_MESSAGE_ATTEMPTS attempts means up to that many
// duplicate events for one message, not just one. Accepted trade-off (Review,
// fourth pass, 2026-07-06, Borja): same failure class, same AD-13 idempotent-
// consumer safety net as the original single-attempt design, just amplified —
// revisit if Story 3.3's Indexer turns out not to dedupe by messageId in practice.
import type { Share2BrainConfig } from '@share2brain/shared';
import { discordMessages, type Database } from '@share2brain/shared/db';
import type { RedisClient } from '@share2brain/shared/redis';
import { STREAM_KEYS } from '@share2brain/shared/types/events';

/**
 * The narrow slice of a discord.js `Message` this pipeline reads. Declaring it
 * structurally (rather than importing the full `Message` class) keeps the guard
 * and mapping logic pure and trivially unit-testable — the real discord.js
 * `Message` is assignable to it.
 */
export interface IngestibleMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  content: string;
  createdAt: Date;
  /** Discord's edit timestamp; null/absent for never-edited messages. */
  editedAt?: Date | null;
  author: { id: string; bot: boolean; displayName: string };
}

/** Dependencies shared by the handler and the persistence step (dependency-injected). */
export interface IngestDeps {
  config: Share2BrainConfig;
  db: Database;
  redis: RedisClient;
}

/**
 * Persist one message and publish its MessageCreatedEvent atomically. Returns
 * `{ inserted: false }` (and publishes nothing) when the row already existed.
 * Throws if either operation fails (the INSERT is rolled back on an XADD
 * failure). The caller is responsible for catching and logging so the process
 * does not crash.
 */
export async function persistMessage(
  message: IngestibleMessage,
  { config, db, redis }: IngestDeps,
): Promise<{ inserted: boolean }> {
  // message.guildId is null in DMs / uncached partials; fall back to the configured guild.
  const guildId = message.guildId ?? config.discord.guild_id;

  const inserted = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(discordMessages)
      .values({
        id: message.id,
        channelId: message.channelId,
        guildId,
        authorId: message.author.id,
        authorName: message.author.displayName,
        content: message.content,
        createdAt: message.createdAt,
        // Column is NOT NULL with no default; backfilled history can carry an edit.
        updatedAt: message.editedAt ?? message.createdAt,
        // indexedAt / deletedAt left undefined → NULL (the Indexer sets indexedAt in 3.3).
      })
      .onConflictDoNothing()
      .returning({ id: discordMessages.id });

    // Row already existed → nothing inserted, so no event either (idempotent producer).
    if (rows.length === 0) return false;

    // node-redis v6: xAdd(key, id, message). Every field value MUST be a string.
    // Stream ID '*' → server-generated. Never hardcode the key — import STREAM_KEYS (AD-13).
    await redis.xAdd(STREAM_KEYS.DISCORD_MESSAGES, '*', {
      type: 'discord.message.created',
      messageId: message.id,
      channelId: message.channelId,
      guildId,
      timestamp: message.createdAt.toISOString(),
      content: message.content,
      authorId: message.author.id,
    });
    return true;
  });

  return { inserted };
}
