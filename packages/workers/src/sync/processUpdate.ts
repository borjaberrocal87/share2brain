// Re-index a `discord.message.updated` event by link-diff (Story 7.3, AC-1,
// AC-2, AC-3, AC-4, AC-7). Pure of Redis — the consumer (runSync) owns XACK
// based on the returned `{ ack }`.
//
// F1 (rebuild-by-diff): the diff against the message's EXISTING resource rows
// is an in-memory cost optimizer, not a row-identity mechanism. A kept link
// (same normalized `link` in the old rows and the freshly extracted set)
// REUSES its existing title/description/embedding — zero fetch, zero LLM,
// zero embed (F2). Persistence is a single-transaction wipe-and-reinsert: this
// sidesteps the positional `chunk_key` unique-index collisions a partial diff
// would hit when URL positions shift between edits. A zero-URL edit (F3 — none
// extracted, all SSRF-blocked, or blank content) converges on the SAME flow
// with an empty new row set: it purges every old row.
import type { HivlyConfig } from '@hivly/shared';
import { discordMessages, embeddings, inArray, sql, type Database } from '@hivly/shared/db';
import { assertEmbeddingDimensions } from '@hivly/shared/providers';
import type { MessageUpdatedEvent } from '@hivly/shared/types/events';

import type { Embedder } from '../indexer/types.js';
import { buildEmbeddingText, type EnrichmentChatModel } from '../enrichment/enrich.js';
import { buildResourceRows, type ResourceRow } from '../enrichment/resourceRows.js';
import type { GuardedDispatcher } from '../enrichment/ssrfGuard.js';
import type { Logger } from '../logger.js';
import type { ProcessResult } from './types.js';

export interface ProcessUpdateDeps {
  event: MessageUpdatedEvent;
  /** Redis stream id of the entry being processed — logged on failure (AC-4). */
  streamId: string;
  /** Stream key the entry came from — logged on failure (AC-4). */
  stream: string;
  db: Database;
  embedder: Embedder;
  config: HivlyConfig;
  logger: Logger;
  /** The enrichment chat model — built once at boot, injected (AC-7, mirrors
   *  the Indexer's injection pattern; never constructed here). */
  enrichModel: EnrichmentChatModel;
  /** The SSRF-guarded dispatcher — built once at boot, injected (AC-7). */
  guard: GuardedDispatcher;
  /** Aborted on SIGTERM/SIGINT — forwarded into `buildResourceRows` so a
   *  shutdown mid-fetch/enrich never lets a partially-processed edit get
   *  falsely stamped complete. */
  signal: AbortSignal;
}

/** A row with a CONFIRMED embedding — either reused from an old row (kept
 *  link) or freshly computed below. `buildResourceRows` may leave `embedding`
 *  undefined for a fresh row; this narrows it after the embed step. */
type EmbeddedRow = ResourceRow & { embedding: number[] };

/**
 * Process one message-updated event: guard on tombstone/unknown, diff the
 * freshly extracted URLs against the message's existing resource rows by
 * `link`, run the 7.2 pipeline for new/changed links only (kept links reuse
 * their title/description/embedding), embed the fresh rows OUTSIDE the
 * transaction, then rebuild the message's resource rows in ONE transaction.
 */
export async function processUpdate(deps: ProcessUpdateDeps): Promise<ProcessResult> {
  const { event, streamId, stream, db, embedder, config, logger, enrichModel, guard, signal } = deps;
  const { messageId, channelId, newContent, timestamp, authorName } = event;

  try {
    // D2 (tombstone guard, closes the 6.2 resurrect hazard): an update for a
    // message the create path never persisted, OR one already hard/soft
    // deleted, is a no-op — create path owns insertion; a tombstoned message
    // must never have its purged rows resurrected.
    const existing = await db
      .select({ id: discordMessages.id, deletedAt: discordMessages.deletedAt })
      .from(discordMessages)
      .where(inArray(discordMessages.id, [messageId]));

    if (existing.length === 0) {
      logger.debug('update for unknown message — skipping, create path owns insertion', {
        messageId,
        channelId,
      });
      return { ack: true };
    }
    if (existing[0].deletedAt !== null) {
      logger.debug('update for a tombstoned message — skipping', { messageId, channelId });
      return { ack: true };
    }

    // Diff basis: the message's existing resource rows, keyed by `link`. A
    // legacy placeholder row (`link: ''`, pre-7.3) never matches an extracted
    // href, so it always counts as removed and gets purged on the first edit
    // (intended). If old rows somehow duplicate a link, first-match wins.
    const oldRows = await db
      .select({
        id: embeddings.id,
        chunkKey: embeddings.chunkKey,
        link: embeddings.link,
        title: embeddings.title,
        description: embeddings.description,
        embedding: embeddings.embedding,
      })
      .from(embeddings)
      .where(sql`${messageId} = ANY(${embeddings.messageIds})`);

    const oldByLink = new Map<string, (typeof oldRows)[number]>();
    for (const row of oldRows) {
      if (row.link !== '' && !oldByLink.has(row.link)) oldByLink.set(row.link, row);
    }

    // F1/F2: a kept link reuses its old title/description/embedding — zero
    // fetch, zero LLM, zero embed. New/changed links run the 7.2 pipeline.
    const outcome = await buildResourceRows(newContent, {
      config,
      enrichModel,
      guard,
      signal,
      logger,
      reuse: (link) => oldByLink.get(link),
    });
    const rows = outcome.kind === 'rows' ? outcome.rows : []; // F3: zero-URL edit purges.

    // D8: embed ONLY the freshly-enriched rows, OUTSIDE the transaction — a
    // slow/hanging embedder must not hold row locks or a pooled connection.
    const dimensions = config.embeddings.dimensions;
    const freshRows = rows.filter((row) => row.embedding === undefined);
    const freshTexts = freshRows.map((row) => buildEmbeddingText(row.title, row.description));
    const freshVectors = freshTexts.length > 0 ? await embedder.embedDocuments(freshTexts) : [];
    if (freshVectors.length !== freshTexts.length) {
      throw new Error(`embedder returned ${freshVectors.length} vectors for ${freshTexts.length} texts`);
    }

    let freshIndex = 0;
    const embeddedRows: EmbeddedRow[] = rows.map((row) =>
      row.embedding !== undefined
        ? { ...row, embedding: row.embedding }
        : { ...row, embedding: freshVectors[freshIndex++] },
    );

    // Assert width on EVERY row about to be inserted — fresh AND reused. A
    // reused vector from an old row is normally the correct width, but if
    // `config.embeddings.dimensions` ever changes without a re-index, a
    // stale-width reused vector must fail here with a clear error rather than
    // at the INSERT as an opaque DB poison-replay (a pure-reuse edit embeds
    // nothing, so a fresh-only assertion would never run).
    for (const row of embeddedRows) assertEmbeddingDimensions(row.embedding, dimensions);

    await db.transaction(async (tx) => {
      // Note #5: FK RESTRICT on user_read_status.embedding_id — read-status
      // rows must be deleted BEFORE the embeddings rows they reference.
      await tx.execute(sql`
        DELETE FROM user_read_status
        WHERE embedding_id IN (SELECT id FROM embeddings WHERE ${messageId} = ANY(message_ids))
      `);
      // F1: wipe ALL old rows, including kept links — they are reinserted
      // below at their (possibly new) position. Sidesteps chunk_key collisions
      // when URL positions rotate between edits.
      await tx.execute(sql`DELETE FROM embeddings WHERE ${messageId} = ANY(message_ids)`);

      // Note #6: the bot is publish-only — bring the raw row current so it
      // doesn't stay permanently stale. authorName is only appended when the
      // event carried a non-empty value (D3): a missing/empty name must never
      // null-out or blank-out a previously stored display name.
      await tx.execute(sql`
        UPDATE discord_messages
        SET content = ${newContent}, updated_at = ${timestamp}${
          authorName !== undefined ? sql`, author_name = ${authorName}` : sql``
        }
        WHERE id = ${messageId}
      `);

      // D7: UPSERT (not plain insert) even though old rows were just deleted —
      // a concurrently-processing Indexer `created` event for the same
      // message must converge, not crash (AD-13 last-write-wins on chunk_key).
      for (const row of embeddedRows) {
        await tx
          .insert(embeddings)
          .values({
            chunkKey: `${messageId}:${row.urlIndex}`,
            title: row.title,
            description: row.description,
            link: row.link,
            embedding: row.embedding,
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
    // AC-4: log the PEL locator ({ streamId, stream, messageId, channelId });
    // never log newContent or any message content — only ids/reason.
    const locator = {
      streamId,
      stream,
      messageId,
      channelId,
      reason: err instanceof Error ? err.message : String(err),
    };
    // A clean shutdown mid-fetch/enrich is expected, not a failure (7.2 P3): the
    // entry correctly stays pending for PEL replay, so log at debug rather than
    // raise a spurious failure alert. Every other error is a genuine failure.
    // Either way: no commit, no XACK.
    if (signal.aborted) {
      logger.debug('message update aborted by shutdown — entry stays pending for replay', locator);
    } else {
      logger.error('failed to process message update — entry stays pending', locator);
    }
    return { ack: false };
  }
}
