// Batch orchestrator (AC-2…AC-5): turns one XREADGROUP batch into embeddings rows
// and the set of stream ids that are safe to XACK. Pure stages (parse, partition,
// group, chunk) are composed here around the two I/O touchpoints — the embeddings
// call and one Drizzle transaction per group.
//
// AD-13 made concrete: an id is returned for XACK only after its row is stamped
// `indexed_at` inside a COMMITted tx (RETURNING-gated). Any failure — bad embed
// call, dimension mismatch, DB error — logs and leaves that group's entries
// PENDING (no ack), and later groups still run. A poison entry never crashes.
import type { HivlyConfig } from '@hivly/shared';
import { discordMessages, embeddings, inArray, sql } from '@hivly/shared/db';
import type { Database } from '@hivly/shared/db';
import { assertEmbeddingDimensions } from '@hivly/shared/providers';

import type { Logger } from '../logger.js';
import { chunkContents } from './chunking.js';
import { parseCreatedEvent } from './events.js';
import { groupByChannel, partitionByIndexState } from './grouping.js';
import type { Embedder, IndexStateRow, MessageGroup, ParsedEntry, RawStreamEntry } from './types.js';

export interface IndexBatchDeps {
  entries: RawStreamEntry[];
  db: Database;
  embedder: Embedder;
  config: HivlyConfig;
  logger: Logger;
}

export interface IndexBatchResult {
  /** Stream ids safe to XACK: malformed entries, already-indexed entries, and
   *  entries whose row was stamped `indexed_at` in a committed tx this pass. */
  ackIds: string[];
}

/**
 * Process one batch of raw stream entries. Never throws for a data/processing
 * failure — a failed group is logged and its entries are simply omitted from
 * `ackIds` so Redis redelivers them.
 */
export async function indexBatch(deps: IndexBatchDeps): Promise<IndexBatchResult> {
  const { entries, db, embedder, config, logger } = deps;
  const ackIds: string[] = [];

  // 1. Parse. Malformed / foreign-typed entries can never succeed — XACK them so
  //    they leave the PEL instead of being redelivered forever (AC-2). A tombstoned
  //    (XDEL'd) PEL entry can be redelivered with `message: null` — treat it the
  //    same as any other unprocessable entry instead of throwing.
  const parsed: ParsedEntry[] = [];
  for (const entry of entries) {
    const event = entry.message == null ? null : parseCreatedEvent(entry.message);
    if (event === null) {
      logger.warn('discarding malformed, foreign, or tombstoned stream entry', {
        streamId: entry.id,
        type: entry.message?.type,
      });
      ackIds.push(entry.id);
      continue;
    }
    parsed.push({ streamId: entry.id, event });
  }

  if (parsed.length === 0) return { ackIds };

  // 2. Dedup state — ONE query over the batch's distinct message ids (AC-2).
  const ids = [...new Set(parsed.map((e) => e.event.messageId))];
  const rows: IndexStateRow[] = await db
    .select({ id: discordMessages.id, indexedAt: discordMessages.indexedAt })
    .from(discordMessages)
    .where(inArray(discordMessages.id, ids));

  const { ackNow, pending, toProcess } = partitionByIndexState(parsed, rows);
  // Already-indexed → XACK + skip; row-missing → leave PENDING (no ack), retried
  // once the bot's COMMIT lands (reconciliation note 5).
  ackIds.push(...ackNow);
  if (pending.length > 0) {
    logger.debug('entries pending — no discord_messages row yet, leaving un-ACKed', {
      count: pending.length,
    });
  }

  // A producer duplicate can put the SAME messageId in `toProcess` twice (up to 3x,
  // per persistMessage's documented COMMIT-race amplification). If two occurrences
  // landed in different grouping windows, both groups would derive the identical
  // `chunk_key` from `messageIds[0]` and the second upsert would silently overwrite
  // the first's content. Dedup by messageId BEFORE grouping — keep the first
  // occurrence for content/grouping, and remember every duplicate's streamId so
  // they all get acked once that messageId's group is confirmed persisted.
  const seenMessageIds = new Set<string>();
  const dedupedToProcess: ParsedEntry[] = [];
  const extraStreamIdsByMessageId = new Map<string, string[]>();
  for (const parsedEntry of toProcess) {
    const { messageId } = parsedEntry.event;
    if (seenMessageIds.has(messageId)) {
      const extras = extraStreamIdsByMessageId.get(messageId) ?? [];
      extras.push(parsedEntry.streamId);
      extraStreamIdsByMessageId.set(messageId, extras);
      continue;
    }
    seenMessageIds.add(messageId);
    dedupedToProcess.push(parsedEntry);
  }

  // 3. Group by channel, then chunk → embed → guard → upsert, one group at a time.
  const groups = groupByChannel(dedupedToProcess, config.knowledge.grouping_window);
  const dimensions = config.embeddings.dimensions;
  const chunkOptions = {
    chunkSize: config.knowledge.chunk_size,
    chunkOverlap: config.knowledge.chunk_overlap,
  };

  for (const group of groups) {
    // Tracks which stage failed so the error log below distinguishes an embedder
    // outage from a chunking exception from a DB/transaction failure, instead of
    // collapsing every cause into one generic message.
    let stage: 'chunk' | 'embed' | 'persist' = 'chunk';
    try {
      const chunks = await chunkContents(group.contents, chunkOptions);
      // Non-blank content always yields ≥1 chunk; the empty case is defensive so a
      // valid-but-unchunkable group still gets stamped+acked instead of looping.
      stage = 'embed';
      const vectors = chunks.length > 0 ? await embedder.embedDocuments(chunks) : [];

      // The embedder is a third-party boundary — it may return fewer (or more)
      // vectors than chunks requested. Treat a count mismatch as an embed failure
      // rather than let `persistGroup` index past the shorter array.
      if (vectors.length !== chunks.length) {
        throw new Error(
          `embedder returned ${vectors.length} vectors for ${chunks.length} chunks`,
        );
      }

      // AC-3: every returned vector must match the configured width or the group
      // is NOT persisted and its entries stay pending (no ack) for redelivery.
      try {
        for (const vector of vectors) assertEmbeddingDimensions(vector, dimensions);
      } catch {
        logger.error('embedding dimension mismatch — group not persisted, entries stay pending', {
          channelId: group.channelId,
          expected: dimensions,
          actual: vectors.map((v) => v?.length ?? null),
        });
        continue; // no ack ids for this group
      }

      stage = 'persist';
      const stamped = await persistGroup(db, group, chunks, vectors);
      // AC-4/AC-5: only ids whose row came back from the stamp RETURNING may be
      // acked; a message whose row is still missing stays pending. Any duplicate
      // stream entries for the same messageId (deduped above) ride along.
      for (let i = 0; i < group.messageIds.length; i++) {
        if (!stamped.has(group.messageIds[i])) continue;
        ackIds.push(group.streamIds[i]);
        const extras = extraStreamIdsByMessageId.get(group.messageIds[i]);
        if (extras) ackIds.push(...extras);
      }
    } catch (err) {
      logger.error(`failed to index group at stage=${stage} — entries stay pending`, {
        channelId: group.channelId,
        stage,
        reason: err instanceof Error ? err.message : String(err),
      });
      // No ack ids for this group; later groups still run (AC-5).
    }
  }

  return { ackIds };
}

/**
 * One tx per group (AC-4): UPSERT every chunk by `chunk_key`, then stamp
 * `indexed_at` on the group's rows. Returns the set of message ids the stamp
 * actually touched — only these may be acked (RETURNING-gated, AD-13).
 */
async function persistGroup(
  db: Database,
  group: MessageGroup,
  chunks: string[],
  vectors: number[][],
): Promise<Set<string>> {
  return db.transaction(async (tx) => {
    for (let i = 0; i < chunks.length; i++) {
      await tx
        .insert(embeddings)
        .values({
          // Message snowflakes are globally unique, so `<firstId>:<chunkIndex>`
          // is a stable, channel-implicit key — redelivery converges here.
          chunkKey: `${group.messageIds[0]}:${i}`,
          content: chunks[i],
          embedding: vectors[i],
          channelId: group.channelId,
          messageIds: group.messageIds,
        })
        .onConflictDoUpdate({
          target: embeddings.chunkKey,
          set: {
            content: sql`excluded.content`,
            embedding: sql`excluded.embedding`,
            channelId: sql`excluded.channel_id`,
            messageIds: sql`excluded.message_ids`,
          },
        });
    }

    const stamped = await tx
      .update(discordMessages)
      .set({ indexedAt: sql`now()` })
      .where(inArray(discordMessages.id, group.messageIds))
      .returning({ id: discordMessages.id });

    return new Set(stamped.map((r) => r.id));
  });
}
