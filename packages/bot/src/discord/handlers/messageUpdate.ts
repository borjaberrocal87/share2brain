// messageUpdate handler (AC-1, AC-3, AC-4, AC-6). Publish-only — unlike
// messageCreate this never touches the DB (that is the Sync worker's job,
// Story 6.2), so a bare `xAdd` is correct and there is no transaction.
//
// Guard order: (1) channel not enabled/configured → skip; (2) resolve a partial
// via fetch() FIRST (an uncached edit arrives unhydrated — author/content/
// editedAt may all be null until fetched); (3) ignore_bots && bot author → skip
// (checked on the FETCHED message, so author is never null when we read it);
// (4) editedAt === null → skip (Discord fires messageUpdate for non-content
// changes like embed resolution and pins too — editedAt is the simplest reliable
// "a human really edited this" signal available here); (5) empty content →
// skip+warn (mirrors messageCreate: an empty edit usually means the MessageContent
// intent is off, and re-indexing to empty would destroy indexed knowledge). A
// skip is `debug` (empty-content is `warn`); a handler failure (fetch()/xAdd()
// throwing) is `error` and never re-thrown — a transient Gateway/Redis blip must
// not crash the process (AC-4, mirrors messageCreate). Never log `newContent` or
// original content (AC-6).
import type { Share2BrainConfig } from '@share2brain/shared';
import type { RedisClient } from '@share2brain/shared/redis';
import { STREAM_KEYS, type MessageUpdatedEvent } from '@share2brain/shared/types/events';

import type { Logger } from '../../logger.js';
import { isChannelEnabled } from './channelGuard.js';

/**
 * The narrow slice of a discord.js `Message` this handler reads. Declared
 * structurally (mirrors `IngestibleMessage` in persistMessage.ts) so the real
 * discord.js `Message` is assignable without an import, keeping this module
 * trivially unit-testable.
 */
export interface UpdatableMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  content: string;
  editedAt: Date | null;
  author: { id: string; bot: boolean; displayName: string };
  partial: boolean;
  fetch(): Promise<UpdatableMessage>;
}

export interface MessageUpdateDeps {
  config: Share2BrainConfig;
  redis: RedisClient;
  logger: Logger;
}

/** Handle a single messageUpdate event. Never throws (AC-4). */
export async function handleMessageUpdate(
  newMessage: UpdatableMessage,
  deps: MessageUpdateDeps,
): Promise<void> {
  try {
    if (!isChannelEnabled(deps.config.discord.channels, newMessage.channelId)) {
      deps.logger.debug('skip: channel disabled or not configured', {
        channelId: newMessage.channelId,
      });
      return;
    }

    // Resolve a partial FIRST. An uncached edit can arrive with author, content,
    // and editedAt all unhydrated, so the bot-author and editedAt guards below
    // must run against the fetched message — reading `newMessage.author.bot` on
    // a raw partial would throw (author is null) and silently drop the edit.
    let message = newMessage;
    if (message.partial) {
      try {
        message = await message.fetch();
      } catch (error) {
        // The message was deleted between the edit and this fetch — a
        // messageDelete event will follow. Not an error condition.
        deps.logger.debug('skip: fetch of partial message failed', {
          messageId: message.id,
          channelId: message.channelId,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }

    if (deps.config.discord.backfill.ignore_bots && message.author.bot) {
      deps.logger.debug('skip: bot author', {
        channelId: message.channelId,
        authorId: message.author.id,
      });
      return;
    }

    // Discord fires messageUpdate for embed resolution and pin changes, not
    // just user edits. editedAt is only set by a genuine content edit; a
    // redundant publish is safe (the Sync worker's re-index is idempotent),
    // so bias toward publishing when unsure — this guard only filters the
    // case we can positively identify as a non-edit.
    if (message.editedAt === null) {
      deps.logger.debug('skip: not a content edit (editedAt is null)', {
        messageId: message.id,
        channelId: message.channelId,
      });
      return;
    }

    // Empty content on an edit almost always means the MessageContent privileged
    // intent is off (every message then arrives empty). Skip + warn rather than
    // publish, so the Sync worker (6.2) never re-indexes a real document to empty.
    // Mirrors the messageCreate guard (messageCreate.ts).
    if (!message.content || message.content.trim().length === 0) {
      deps.logger.warn('skip: empty content — MessageContent intent may be disabled', {
        messageId: message.id,
        channelId: message.channelId,
      });
      return;
    }

    const guildId = message.guildId ?? deps.config.discord.guild_id;
    // Record<keyof T, string>, not T itself: xAdd wants Record<string, RedisArgument>,
    // and a plain interface (no index signature) isn't structurally assignable to that.
    const event: Record<keyof MessageUpdatedEvent, string> = {
      type: 'discord.message.updated',
      messageId: message.id,
      channelId: message.channelId,
      guildId,
      timestamp: (message.editedAt ?? new Date()).toISOString(),
      newContent: message.content,
      authorName: message.author.displayName,
    };
    await deps.redis.xAdd(STREAM_KEYS.DISCORD_MESSAGES_UPDATED, '*', event);
  } catch (error) {
    deps.logger.error('failed to handle message update', {
      messageId: newMessage.id,
      channelId: newMessage.channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
