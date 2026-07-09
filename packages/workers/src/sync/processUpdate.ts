// Re-index a `discord.message.updated` event (AC-1, AC-2, AC-5, AC-7). Pure of
// Redis — the consumer (runSync) owns XACK based on the returned `{ ack }`.
//
// Reconciliation note #2: embeddings are grouped + chunked, and the event only
// carries the edited message's own `newContent` (not its original neighbors'),
// so there is no way to faithfully rebuild the message's original group. Per
// DECISION 1, the message is re-embedded STANDALONE (`messageIds=[id]`,
// `chunkKey="<id>:<i>"`) — co-grouped neighbors lose coverage from the deleted
// chunks and self-heal on their own next edit/re-index.
import type { HivlyConfig } from '@hivly/shared';
import { discordMessages, embeddings, inArray, sql, type Database } from '@hivly/shared/db';
import { assertEmbeddingDimensions } from '@hivly/shared/providers';
import type { MessageUpdatedEvent } from '@hivly/shared/types/events';

import { chunkContents } from '../indexer/chunking.js';
import type { Embedder } from '../indexer/types.js';
import type { Logger } from '../logger.js';
import type { ProcessResult } from './types.js';

export interface ProcessUpdateDeps {
  event: MessageUpdatedEvent;
  /** Redis stream id of the entry being processed — logged on failure (AC-5). */
  streamId: string;
  /** Stream key the entry came from — logged on failure (AC-5). */
  stream: string;
  db: Database;
  embedder: Embedder;
  config: HivlyConfig;
  logger: Logger;
}

/**
 * Process one message-updated event: purge the message's old chunks, refresh
 * the raw row, re-chunk + embed the new content standalone, UPSERT, and stamp
 * `indexed_at`. The chunk + embed + dimension-assert run BEFORE the transaction
 * (mirroring the Indexer's `indexBatch`) so no row locks or pooled connection
 * are held across the external embeddings HTTP call; the transaction itself
 * holds only the purge + refresh + UPSERT + stamp (AC-1). An embed failure
 * before the tx opens writes nothing and leaves the entry PENDING.
 */
export async function processUpdate(deps: ProcessUpdateDeps): Promise<ProcessResult> {
  const { event, streamId, stream, db, embedder, config, logger } = deps;
  const { messageId, channelId, newContent, timestamp } = event;

  try {
    // AC-2: an update for a message the create path never persisted would
    // create an anchor-less chunk (note #7) — skip and let create own it.
    const existing = await db
      .select({ id: discordMessages.id })
      .from(discordMessages)
      .where(inArray(discordMessages.id, [messageId]));

    if (existing.length === 0) {
      logger.debug('update for unknown message — skipping, create path owns insertion', {
        messageId,
        channelId,
      });
      return { ack: true };
    }

    const dimensions = config.embeddings.dimensions;
    const chunkOptions = {
      chunkSize: config.knowledge.chunk_size,
      chunkOverlap: config.knowledge.chunk_overlap,
    };

    // Chunk + embed + assert OUTSIDE the transaction (mirror the Indexer): a
    // slow/hanging embedder must not hold row locks or a pooled connection
    // shared with the concurrently-running Indexer. A failure here throws
    // before the tx opens → nothing written → entry stays pending.
    const chunks = await chunkContents([newContent], chunkOptions);
    const vectors = chunks.length > 0 ? await embedder.embedDocuments(chunks) : [];
    if (vectors.length !== chunks.length) {
      throw new Error(`embedder returned ${vectors.length} vectors for ${chunks.length} chunks`);
    }
    for (const vector of vectors) assertEmbeddingDimensions(vector, dimensions);

    await db.transaction(async (tx) => {
      // Note #5: FK RESTRICT on user_read_status.embedding_id — read-status
      // rows must be deleted BEFORE the embeddings rows they reference.
      await tx.execute(sql`
        DELETE FROM user_read_status
        WHERE embedding_id IN (SELECT id FROM embeddings WHERE ${messageId} = ANY(message_ids))
      `);
      await tx.execute(sql`DELETE FROM embeddings WHERE ${messageId} = ANY(message_ids)`);

      // Note #6: the bot is publish-only — bring the raw row current so it
      // doesn't stay permanently stale (DECISION 2).
      await tx.execute(sql`
        UPDATE discord_messages
        SET content = ${newContent}, updated_at = ${timestamp}
        WHERE id = ${messageId}
      `);

      // Same UPSERT-by-chunk_key shape as the Indexer's persistGroup — a
      // redelivery of this same event converges to the same rows (AD-13).
      for (let i = 0; i < chunks.length; i++) {
        await tx
          .insert(embeddings)
          .values({
            chunkKey: `${messageId}:${i}`,
            // Placeholder policy (Epic 7, Story 7.1): title/link are AI-generated /
            // extracted in Story 7.2 — `description` carries the old `content` text
            // as its semantic successor until then.
            title: '',
            description: chunks[i],
            link: '',
            embedding: vectors[i],
            channelId,
            messageIds: [messageId],
          })
          .onConflictDoUpdate({
            target: embeddings.chunkKey,
            set: {
              title: sql`excluded.title`,
              description: sql`excluded.description`,
              link: sql`excluded.link`,
              embedding: sql`excluded.embedding`,
              channelId: sql`excluded.channel_id`,
              messageIds: sql`excluded.message_ids`,
            },
          });
      }

      await tx.execute(sql`UPDATE discord_messages SET indexed_at = now() WHERE id = ${messageId}`);
    });

    return { ack: true };
  } catch (err) {
    // AC-5: log the PEL locator ({ streamId, stream, messageId, channelId });
    // AC-7: never log newContent or any message content — only ids/reason.
    logger.error('failed to process message update — entry stays pending', {
      streamId,
      stream,
      messageId,
      channelId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return { ack: false };
  }
}
