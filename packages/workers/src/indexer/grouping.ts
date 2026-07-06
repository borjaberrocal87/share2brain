// Pure batch-shaping stages of the Indexer pipeline (AC-2). Both are deterministic
// functions of their inputs, so re-processing the SAME PEL entries on a
// crash-restart yields the SAME groups — which is what makes the chunk_key UPSERT
// converge instead of duplicating (AD-13).
import type { IndexStateRow, MessageGroup, ParsedEntry, PartitionResult } from './types.js';

/**
 * Classify a batch's parsed entries against their `discord_messages` dedup rows.
 *
 * - row present with `indexed_at` set  → `ackNow`  (already indexed; XACK + skip)
 * - no row for the message id          → `pending` (XADD raced ahead of COMMIT;
 *                                          leave un-ACKed, reconciliation note 5)
 * - row present, `indexed_at` NULL     → `toProcess`
 *
 * A message id may appear more than once in a batch (producer duplicate); each
 * entry is classified independently so duplicates land in the same bucket.
 */
export function partitionByIndexState(
  entries: ParsedEntry[],
  rows: IndexStateRow[],
): PartitionResult {
  const indexState = new Map<string, IndexStateRow['indexedAt']>();
  for (const row of rows) indexState.set(row.id, row.indexedAt);

  const ackNow: string[] = [];
  const pending: string[] = [];
  const toProcess: ParsedEntry[] = [];

  for (const entry of entries) {
    const id = entry.event.messageId;
    if (!indexState.has(id)) {
      pending.push(entry.streamId);
    } else if (indexState.get(id) != null) {
      ackNow.push(entry.streamId);
    } else {
      toProcess.push(entry);
    }
  }

  return { ackNow, pending, toProcess };
}

/**
 * Partition entries by `channelId` (stream order preserved) into groups of at most
 * `groupingWindow` messages — the resolved `grouping_window` semantics (OQ#3): a
 * message COUNT per group, per channel, within one batch. Channels appear in the
 * order they first occur in the batch; each channel's messages are sliced into
 * consecutive windows.
 *
 * `groupingWindow` is coerced to a positive integer (≥1) so a misconfigured 0 or
 * negative value can never produce empty groups or an infinite slice, and capped
 * at `MAX_GROUPING_WINDOW` so a fat-fingered huge value can't concatenate an
 * unbounded number of messages into one chunking/embedding call.
 */
export const MAX_GROUPING_WINDOW = 50;

export function groupByChannel(
  entries: ParsedEntry[],
  groupingWindow: number,
): MessageGroup[] {
  const window = Math.min(MAX_GROUPING_WINDOW, Math.max(1, Math.floor(groupingWindow)));

  // Preserve channel insertion order (first appearance in the batch) for
  // deterministic output; Map keeps insertion order.
  const byChannel = new Map<string, ParsedEntry[]>();
  for (const entry of entries) {
    const bucket = byChannel.get(entry.event.channelId);
    if (bucket) bucket.push(entry);
    else byChannel.set(entry.event.channelId, [entry]);
  }

  const groups: MessageGroup[] = [];
  for (const [channelId, bucket] of byChannel) {
    for (let i = 0; i < bucket.length; i += window) {
      const slice = bucket.slice(i, i + window);
      groups.push({
        channelId,
        messageIds: slice.map((e) => e.event.messageId),
        streamIds: slice.map((e) => e.streamId),
        contents: slice.map((e) => e.event.content),
      });
    }
  }

  return groups;
}
