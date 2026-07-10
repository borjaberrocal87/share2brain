// Parse flat Redis Stream field maps into typed Sync events (AC-1, AC-2, AC-3,
// AC-4). Mirrors indexer/events.ts: stream events are internal contracts
// (AD-13), not HTTP API bodies, so no Zod — we validate exactly what the Sync
// worker needs and reject everything else. node-redis delivers every XADD field
// as a string, so `fields` is always Record<string, string>; a malformed or
// foreign-typed entry yields `null` and the caller XACKs+skips it (AC-2) so it
// never clogs the PEL.
import type { MessageDeletedEvent, MessageUpdatedEvent } from '@hivly/shared/types/events';

/**
 * Validate and narrow a raw stream field map to a MessageUpdatedEvent.
 *
 * Returns `null` unless `type === 'discord.message.updated'` and
 * `messageId`/`channelId` are non-blank. `newContent` MAY be blank or absent
 * (Story 7.3 F3) — an edit to zero indexable URLs, or to blank content, is a
 * valid update that purges the message's resource rows; it defaults to `''`.
 * `timestamp` is ALSO validated non-blank: `processUpdate` writes it into the
 * `NOT NULL timestamptz` column `discord_messages.updated_at`, so a blank
 * value would poison the update transaction (invalid-timestamp → rollback →
 * PENDING forever). A blank timestamp is therefore treated as malformed
 * (warn + ack + skip, AC-2) rather than let through into a doomed SQL write.
 * `guildId` is carried through verbatim.
 */
export function parseUpdatedEvent(
  fields: Record<string, string>,
): MessageUpdatedEvent | null {
  if (fields.type !== 'discord.message.updated') return null;

  const messageId = fields.messageId?.trim();
  const channelId = fields.channelId?.trim();
  const timestamp = fields.timestamp?.trim();
  const newContent = fields.newContent ?? '';
  // Absent/blank normalizes to undefined — never '' — so processUpdate can
  // tell "no name arrived" apart from "blank the stored name" (D3): a missing
  // or empty authorName must leave the column untouched, never null/blank it.
  const authorName = fields.authorName?.trim() || undefined;

  if (!messageId || !channelId || !timestamp) {
    return null;
  }

  return {
    type: 'discord.message.updated',
    messageId,
    channelId,
    guildId: fields.guildId ?? '',
    timestamp,
    newContent,
    authorName,
  };
}

/**
 * Validate and narrow a raw stream field map to a MessageDeletedEvent.
 *
 * Returns `null` unless `type === 'discord.message.deleted'` and
 * `messageId`/`channelId` are non-blank. There is no content field on delete.
 */
export function parseDeletedEvent(
  fields: Record<string, string>,
): MessageDeletedEvent | null {
  if (fields.type !== 'discord.message.deleted') return null;

  const messageId = fields.messageId?.trim();
  const channelId = fields.channelId?.trim();

  if (!messageId || !channelId) return null;

  return {
    type: 'discord.message.deleted',
    messageId,
    channelId,
    guildId: fields.guildId ?? '',
    timestamp: fields.timestamp ?? '',
  };
}
