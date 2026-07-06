// Atomic persist + publish for a single Discord message (AC-2, AD-13).
//
// The INSERT into discord_messages and the XADD onto the DISCORD_MESSAGES stream
// run inside ONE Drizzle transaction: if the XADD throws, the transaction rolls
// the INSERT back, so there is never an orphan row without its stream event.
//
// The only residual inconsistency is a COMMIT that fails *after* a successful
// XADD → an event with no row. That is tolerated: delivery is at-least-once and
// the Indexer is idempotent (AD-13). Redis cannot be a true XA participant, so we
// do not pretend otherwise.
import type { HivlyConfig } from '@hivly/shared';
import { discordMessages, type Database } from '@hivly/shared/db';
import type { RedisClient } from '@hivly/shared/redis';
import { STREAM_KEYS } from '@hivly/shared/types/events';

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
  author: { id: string; bot: boolean };
}

/** Dependencies shared by the handler and the persistence step (dependency-injected). */
export interface IngestDeps {
  config: HivlyConfig;
  db: Database;
  redis: RedisClient;
}

/**
 * Persist one message and publish its MessageCreatedEvent atomically. Throws if
 * either operation fails (the INSERT is rolled back on an XADD failure). The
 * caller is responsible for catching and logging so the process does not crash.
 */
export async function persistMessage(
  message: IngestibleMessage,
  { config, db, redis }: IngestDeps,
): Promise<void> {
  // message.guildId is null in DMs / uncached partials; fall back to the configured guild.
  const guildId = message.guildId ?? config.discord.guild_id;

  await db.transaction(async (tx) => {
    await tx.insert(discordMessages).values({
      id: message.id,
      channelId: message.channelId,
      guildId,
      authorId: message.author.id,
      content: message.content,
      createdAt: message.createdAt,
      // Column is NOT NULL with no default; a fresh message has not been edited.
      updatedAt: message.createdAt,
      // indexedAt / deletedAt left undefined → NULL (the Indexer sets indexedAt in 3.3).
    });

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
  });
}
