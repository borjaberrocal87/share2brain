// Redis Streams event contracts (AD-13). These are internal stream shapes (not
// HTTP API bodies), so they live in `types/` as TS interfaces rather than as Zod
// schemas in `schemas/`. Every event carries the four mandatory fields below.
// Stream keys and consumer groups are FIXED invariants — never hardcode the
// strings; import the constants.

/** Fields every Discord stream event must carry. */
export interface StreamEvent {
  messageId: string; // Discord snowflake
  channelId: string; // Discord snowflake
  guildId: string; // Discord snowflake
  timestamp: string; // ISO 8601 UTC
}

export interface MessageCreatedEvent extends StreamEvent {
  type: 'discord.message.created';
  content: string;
  authorId: string;
}

export interface MessageUpdatedEvent extends StreamEvent {
  type: 'discord.message.updated';
  newContent: string;
  // Wire-optional for legacy in-flight events parked in the stream before this
  // field existed. Producers build this via Record<keyof T, string>, which
  // forces every new producer to send it despite the optional marker here.
  authorName?: string;
}

export interface MessageDeletedEvent extends StreamEvent {
  type: 'discord.message.deleted';
}

export type DiscordStreamEvent =
  | MessageCreatedEvent
  | MessageUpdatedEvent
  | MessageDeletedEvent;

/**
 * Emitted once per bot boot after the historical backfill has attempted every
 * enabled channel (even when some failed). NOT message-scoped, so it does not
 * extend StreamEvent. All fields are strings — AD-13 requires every stream
 * value to be a string.
 */
export interface BackfillCompletedEvent {
  type: 'discord.backfill.completed';
  guildId: string; // Discord snowflake
  timestamp: string; // ISO 8601 UTC
  channelsProcessed: string;
  channelsFailed: string;
  messagesPublished: string;
  /** Messages that exhausted every persist retry and were permanently skipped. */
  messagesFailed: string;
}

/** Events on KNOWLEDGE_EVENTS — a union so Epic 6 can grow it without churn. */
export type KnowledgeStreamEvent = BackfillCompletedEvent;

/**
 * Fixed Redis Stream keys and their consumer groups (AD-13 invariants).
 * Producers and consumers MUST reference these constants, never string literals.
 */
export const STREAM_KEYS = {
  /** New messages → Indexer (embeds + inserts). */
  DISCORD_MESSAGES: 'share2brain:discord:messages',
  /** Edited messages → Sync (re-index). */
  DISCORD_MESSAGES_UPDATED: 'share2brain:discord:messages:updated',
  /** Deleted messages → Sync (soft/hard delete). */
  DISCORD_MESSAGES_DELETED: 'share2brain:discord:messages:deleted',
  /** Knowledge events → Notifier (deferred, Epic 6). */
  KNOWLEDGE_EVENTS: 'share2brain:knowledge:events',
} as const;

export const CONSUMER_GROUPS = {
  /** Consumes DISCORD_MESSAGES. */
  INDEXER: 'share2brain:indexer',
  /** Consumes DISCORD_MESSAGES_UPDATED and DISCORD_MESSAGES_DELETED. */
  SYNC: 'share2brain:sync',
  /** Consumes KNOWLEDGE_EVENTS (deferred, Epic 6). */
  NOTIFIER: 'share2brain:notifier',
} as const;

export type StreamKey = (typeof STREAM_KEYS)[keyof typeof STREAM_KEYS];
export type ConsumerGroup = (typeof CONSUMER_GROUPS)[keyof typeof CONSUMER_GROUPS];
