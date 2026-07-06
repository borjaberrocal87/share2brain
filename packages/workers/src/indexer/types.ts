// Shared internal shapes for the Indexer pipeline. Kept separate from the pure
// stages (events/grouping/chunking) and the orchestrator (indexBatch) so both
// sides depend on the same definitions without a cycle.
import type { MessageCreatedEvent } from '@hivly/shared/types/events';

/** A raw entry as node-redis delivers it from XREADGROUP: the stream id plus the
 *  flat all-string field map of the XADD. `message` is `null` for a tombstoned
 *  (XDEL'd) entry redelivered from the PEL — `indexBatch` treats it like any
 *  other unprocessable entry (ack + skip). */
export interface RawStreamEntry {
  id: string;
  message: Record<string, string> | null;
}

/** The slice of the embeddings model the Indexer depends on — injected so unit
 *  tests can supply a deterministic fake and never call a real API. The LangChain
 *  `Embeddings` returned by `createEmbeddingsModel` is assignable to this. */
export interface Embedder {
  embedDocuments(texts: string[]): Promise<number[][]>;
}

/** A stream entry that parsed into a valid MessageCreatedEvent, paired with its
 *  Redis stream id (needed to XACK it after successful processing). */
export interface ParsedEntry {
  /** The Redis Stream entry id (e.g. "1712-0") — the XACK target. */
  streamId: string;
  event: MessageCreatedEvent;
}

/** A row of dedup state from `discord_messages`, one per message id in the batch. */
export interface IndexStateRow {
  id: string;
  /** NULL until the Indexer stamps it; a non-null value means already indexed. */
  indexedAt: Date | string | null;
}

/** The result of classifying a batch's parsed entries against their dedup rows. */
export interface PartitionResult {
  /** Stream ids safe to XACK immediately: their row already has `indexed_at`. */
  ackNow: string[];
  /** Stream ids to leave PENDING (no XACK): no `discord_messages` row yet
   *  (XADD-before-COMMIT race) — retried on the next delivery. Informational. */
  pending: string[];
  /** Entries whose row exists but is not yet indexed — proceed to group/embed. */
  toProcess: ParsedEntry[];
}

/** A by-channel group of messages to chunk + embed + upsert as one unit. */
export interface MessageGroup {
  channelId: string;
  /** Message snowflakes in stream order; `messageIds[0]` seeds the chunk_key. */
  messageIds: string[];
  /** Stream entry ids for these messages — XACKed together on success. */
  streamIds: string[];
  /** Each message's content, in the same order as `messageIds`. */
  contents: string[];
}
