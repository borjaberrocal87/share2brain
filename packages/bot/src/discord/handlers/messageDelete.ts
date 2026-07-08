// messageDelete handler (AC-2, AC-3, AC-4). Publish-only, no transaction (the
// Sync worker owns the DB mutation, Story 6.2). The delete `message` is very
// often a discord.js *partial* guaranteeing only `id` + `channelId` — content
// and author are unavailable, so unlike messageCreate this handler cannot and
// does not filter bot authors (AC-2 requires publishing regardless; the
// worker's delete is idempotent for a never-indexed message). A handler
// failure (xAdd throwing) is logged at `error` and never re-thrown (AC-4).
import type { HivlyConfig } from '@hivly/shared';
import type { RedisClient } from '@hivly/shared/redis';
import { STREAM_KEYS, type MessageDeletedEvent } from '@hivly/shared/types/events';

import type { Logger } from '../../logger.js';
import { isChannelEnabled } from './channelGuard.js';

/**
 * The narrow slice of a discord.js `Message` this handler reads. Deliberately
 * omits `content`/`author` — unavailable on a partial delete message.
 */
export interface DeletableMessage {
  id: string;
  channelId: string;
  guildId: string | null;
}

export interface MessageDeleteDeps {
  config: HivlyConfig;
  redis: RedisClient;
  logger: Logger;
}

/** Handle a single messageDelete event. Never throws (AC-4). */
export async function handleMessageDelete(
  message: DeletableMessage,
  deps: MessageDeleteDeps,
): Promise<void> {
  try {
    if (!isChannelEnabled(deps.config.discord.channels, message.channelId)) {
      deps.logger.debug('skip: channel disabled or not configured', {
        channelId: message.channelId,
      });
      return;
    }

    const guildId = message.guildId ?? deps.config.discord.guild_id;
    // Record<keyof T, string>, not T itself: xAdd wants Record<string, RedisArgument>,
    // and a plain interface (no index signature) isn't structurally assignable to that.
    const event: Record<keyof MessageDeletedEvent, string> = {
      type: 'discord.message.deleted',
      messageId: message.id,
      channelId: message.channelId,
      guildId,
      // Discord provides no delete timestamp on the event itself — use receipt time.
      timestamp: new Date().toISOString(),
    };
    await deps.redis.xAdd(STREAM_KEYS.DISCORD_MESSAGES_DELETED, '*', event);
  } catch (error) {
    deps.logger.error('failed to handle message delete', {
      messageId: message.id,
      channelId: message.channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
