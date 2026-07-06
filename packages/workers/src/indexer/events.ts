// Parse a flat Redis Stream field map into a typed MessageCreatedEvent (AC-2).
//
// Stream events are internal contracts (AD-13), not HTTP API bodies, so no Zod —
// we validate the three fields the Indexer actually needs and reject everything
// else. node-redis delivers every XADD field as a string, so `fields` is always
// Record<string, string>; a malformed or foreign-typed entry yields `null` and
// the caller XACKs+skips it (it can never succeed and must not clog the PEL).
import type { MessageCreatedEvent } from '@hivly/shared/types/events';

/**
 * Validate and narrow a raw stream field map to a MessageCreatedEvent.
 *
 * Returns `null` when the entry is not a `discord.message.created` event or when
 * any of `messageId`/`channelId`/`content` is missing or blank (whitespace-only).
 * The other fields (`guildId`, `timestamp`, `authorId`) are carried through
 * verbatim — the producer always sets them and the Indexer does not gate on them.
 */
export function parseCreatedEvent(
  fields: Record<string, string>,
): MessageCreatedEvent | null {
  if (fields.type !== 'discord.message.created') return null;

  const messageId = fields.messageId?.trim();
  const channelId = fields.channelId?.trim();
  // `content` is validated non-blank but carried through UN-trimmed: leading or
  // trailing whitespace is legitimate message text and the chunker owns trimming.
  const content = fields.content;

  if (!messageId || !channelId || content == null || content.trim() === '') {
    return null;
  }

  return {
    type: 'discord.message.created',
    messageId,
    channelId,
    guildId: fields.guildId ?? '',
    timestamp: fields.timestamp ?? '',
    content,
    authorId: fields.authorId ?? '',
  };
}
