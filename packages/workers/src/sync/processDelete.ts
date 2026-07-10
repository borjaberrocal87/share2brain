// Delete a `discord.message.deleted` event, branching on `config.sync.delete_policy`
// (AC-3, AC-4, AC-5). No embedder — delete never embeds.
//
// Soft delete (note #4) touches ONLY discord_messages.deleted_at: the D1
// exclude-if-any anti-join already used by search/docs/read-status makes the
// chunk vanish from every read path the moment any of its constituent messages
// is soft-deleted, so embeddings must not be touched here.
//
// Hard delete (DECISION 3) is a SUPERSET of soft: it purges the message's
// embedding chunks (and their dependent read-status rows, note #5 FK order)
// AND sets deleted_at — keeping the raw row for audit/6.3 while never leaving
// an anchor-less chunk behind (note #7).
import type { Share2BrainConfig } from '@share2brain/shared';
import { sql, type Database } from '@share2brain/shared/db';
import type { MessageDeletedEvent } from '@share2brain/shared/types/events';

import type { Logger } from '../logger.js';
import type { ProcessResult } from './types.js';

export interface ProcessDeleteDeps {
  event: MessageDeletedEvent;
  /** Redis stream id of the entry being processed — logged on failure (AC-5). */
  streamId: string;
  /** Stream key the entry came from — logged on failure (AC-5). */
  stream: string;
  db: Database;
  config: Share2BrainConfig;
  logger: Logger;
}

/**
 * Process one message-deleted event per `config.sync.delete_policy`. Every
 * write is `WHERE id = :id` / `WHERE :id = ANY(message_ids)` — zero rows
 * affected (message already deleted, or never existed) is success, not error.
 */
export async function processDelete(deps: ProcessDeleteDeps): Promise<ProcessResult> {
  const { event, streamId, stream, db, config, logger } = deps;
  const { messageId, channelId } = event;

  try {
    if (config.sync.delete_policy === 'soft') {
      await db.execute(sql`
        UPDATE discord_messages SET deleted_at = now()
        WHERE id = ${messageId} AND deleted_at IS NULL
      `);
      return { ack: true };
    }

    await db.transaction(async (tx) => {
      // Note #5: FK RESTRICT on user_read_status.embedding_id — read-status
      // rows must be deleted BEFORE the embeddings rows they reference.
      await tx.execute(sql`
        DELETE FROM user_read_status
        WHERE embedding_id IN (SELECT id FROM embeddings WHERE ${messageId} = ANY(message_ids))
      `);
      await tx.execute(sql`DELETE FROM embeddings WHERE ${messageId} = ANY(message_ids)`);
      await tx.execute(sql`
        UPDATE discord_messages SET deleted_at = now()
        WHERE id = ${messageId} AND deleted_at IS NULL
      `);
    });

    return { ack: true };
  } catch (err) {
    // AC-5: log the PEL locator ({ streamId, stream, messageId, channelId }).
    logger.error('failed to process message delete — entry stays pending', {
      streamId,
      stream,
      messageId,
      channelId,
      policy: config.sync.delete_policy,
      reason: err instanceof Error ? err.message : String(err),
    });
    return { ack: false };
  }
}
