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
  //    they leave the PEL instead of being redelivered forever (AC-2).
  const parsed: ParsedEntry[] = [];
  for (const entry of entries) {
    const event = parseCreatedEvent(entry.message);
    if (event === null) {
      logger.warn('discarding malformed or foreign stream entry', {
        streamId: entry.id,
        type: entry.message.type,
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

  // 3. Group by channel, then chunk → embed → guard → upsert, one group at a time.
  const groups = groupByChannel(toProcess, config.knowledge.grouping_window);
  const dimensions = config.embeddings.dimensions;
  const chunkOptions = {
    chunkSize: config.knowledge.chunk_size,
    chunkOverlap: config.knowledge.chunk_overlap,
  };

  for (const group of groups) {
    try {
      const chunks = await chunkContents(group.contents, chunkOptions);
      // Non-blank content always yields ≥1 chunk; the empty case is defensive so a
      // valid-but-unchunkable group still gets stamped+acked instead of looping.
      const vectors = chunks.length > 0 ? await embedder.embedDocuments(chunks) : [];

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

      const stamped = await persistGroup(db, group, chunks, vectors);
      // AC-4/AC-5: only ids whose row came back from the stamp RETURNING may be
      // acked; a message whose row is still missing stays pending.
      for (let i = 0; i < group.messageIds.length; i++) {
        if (stamped.has(group.messageIds[i])) ackIds.push(group.streamIds[i]);
      }
    } catch (err) {
      logger.error('failed to index group — entries stay pending', {
        channelId: group.channelId,
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
