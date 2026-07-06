// messageCreate handler (AC-2, AC-3). Pure, dependency-injected guard logic:
//   1. Skip messages in channels that are not listed or not `enabled` (silent, debug).
//   2. Skip bot-authored messages when `discord.backfill.ignore_bots` is true (silent, debug).
//   3. Otherwise persist + publish atomically (delegated to persistMessage).
//
// A skip (expected) is a debug line; a persistence FAILURE on an in-scope message
// (unexpected) is an error line with { messageId, channelId } — and must NOT crash
// the process (AC-3). Never log the full message content (project-context §anti-patterns).
import type { Logger } from '../../logger.js';
import {
  persistMessage,
  type IngestDeps,
  type IngestibleMessage,
} from '../../persistence/persistMessage.js';

export interface MessageCreateDeps extends IngestDeps {
  logger: Logger;
}

/** True when the message's channel is configured AND enabled. */
function isChannelEnabled(deps: MessageCreateDeps, channelId: string): boolean {
  const channel = deps.config.discord.channels.find((c) => c.id === channelId);
  return channel?.enabled === true;
}

/**
 * Handle a single messageCreate event. Applies the channel + bot-author guards,
 * then persists the message. Swallows and logs persistence errors at `error` so a
 * transient DB/Redis failure never brings the bot down (AC-3).
 */
export async function handleMessageCreate(
  message: IngestibleMessage,
  deps: MessageCreateDeps,
): Promise<void> {
  // The whole body is guarded: the caller `void`s this promise, so a throw from the
  // guards themselves (e.g. a malformed/partial message with a missing field) — not
  // just from persistMessage — must never surface as an unhandledRejection (AC-3).
  try {
    if (!isChannelEnabled(deps, message.channelId)) {
      deps.logger.debug('skip: channel disabled or not configured', {
        channelId: message.channelId,
      });
      return;
    }

    if (deps.config.discord.backfill.ignore_bots && message.author.bot) {
      deps.logger.debug('skip: bot author', {
        channelId: message.channelId,
        authorId: message.author.id,
      });
      return;
    }

    // If MessageContent intent is disabled in the Discord Developer Portal, every
    // message comes through with empty content. Warn the operator and skip rather
    // than silently persisting thousands of empty rows and stream events.
    if (!message.content || message.content.trim().length === 0) {
      deps.logger.warn('skip: empty content — MessageContent intent may be disabled', {
        messageId: message.id,
        channelId: message.channelId,
      });
      return;
    }

    const { inserted } = await persistMessage(message, deps);
    deps.logger.debug(inserted ? 'persisted message' : 'skip: already persisted', {
      messageId: message.id,
      channelId: message.channelId,
      contentLength: message.content.length,
    });
  } catch (error) {
    deps.logger.error('failed to handle message', {
      messageId: message.id,
      channelId: message.channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
