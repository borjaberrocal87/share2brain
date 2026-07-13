// Batch orchestrator (FR5, AC-6): turns one XREADGROUP batch into resource rows
// and the set of stream ids that are safe to XACK. The resource pipeline per
// message is: extract URLs → discard if none → per URL: SSRF-guarded fetch →
// AI enrich (message-text-only fallback on fetch failure) → embed all of the
// message's `title\n\ndescription` texts in one call → persist + stamp in one
// transaction.
//
// AD-13 made concrete: an id is returned for XACK only after its row(s) are
// stamped `indexed_at` inside a COMMITted tx (RETURNING-gated) — or, for a
// no-URL/all-blocked message, after the SAME stamp with zero rows (D2/discard).
// An enrichment or embedding hard failure for the message leaves it un-ACKed
// entirely (D1) — no partial persistence; later messages still run.
import type { Share2BrainConfig } from '@share2brain/shared';
import { discordMessages, embeddings, inArray, sql } from '@share2brain/shared/db';
import type { Database } from '@share2brain/shared/db';
import { assertEmbeddingDimensions } from '@share2brain/shared/providers';
import type { RedisClient } from '@share2brain/shared/redis';

import { buildEmbeddingText, type EnrichmentChatModel } from '../enrichment/enrich.js';
import { extractUrls } from '../enrichment/extractUrls.js';
import {
  checkAndConsumeBudget,
  type ResolvedEnrichmentRateLimit,
} from '../enrichment/rateLimiter.js';
import { buildResourceRows, type MessageOutcome, type ResourceRow } from '../enrichment/resourceRows.js';
import type { GuardedDispatcher } from '../enrichment/ssrfGuard.js';
import type { Logger } from '@share2brain/shared/logger';
import { parseCreatedEvent } from './events.js';
import { partitionByIndexState } from './partition.js';
import type { Embedder, IndexStateRow, ParsedEntry, RawStreamEntry } from './types.js';

/** Disabled limiter — used when no `rateLimit`/`redis` is threaded through (the
 *  config block is absent, or a caller that predates M-5). Preserves the
 *  pre-M-5 behavior exactly: every message runs FULL enrichment. */
const DISABLED_RATE_LIMIT: ResolvedEnrichmentRateLimit = {
  enabled: false,
  perAuthorHourly: 0,
  globalDaily: 0,
};

export interface IndexBatchDeps {
  entries: RawStreamEntry[];
  db: Database;
  embedder: Embedder;
  config: Share2BrainConfig;
  logger: Logger;
  /** The enrichment chat model — built once at boot, injected (AC-6, mirrors
   *  the `embedder` injection pattern; never constructed here). */
  enrichModel: EnrichmentChatModel;
  /** The SSRF-guarded dispatcher — built once at boot, injected (AC-2/AC-6). */
  guard: GuardedDispatcher;
  /** Aborted on SIGTERM/SIGINT — checked between messages/URLs so a shutdown
   *  never lets a partially-processed message get falsely stamped complete. */
  signal: AbortSignal;
  /** Redis client for the M-5 spend limiter's counters. OPTIONAL: absent (with
   *  no `rateLimit`, or a disabled one) means the budget is never consulted and
   *  behavior is exactly the pre-M-5 pipeline. The Indexer consumer threads its
   *  own client through. */
  redis?: RedisClient;
  /** Resolved enrichment budget (M-5). OPTIONAL: absent → disabled passthrough. */
  rateLimit?: ResolvedEnrichmentRateLimit;
}

export interface IndexBatchResult {
  /** Stream ids safe to XACK: malformed entries, already-indexed entries, and
   *  entries whose row(s) were stamped `indexed_at` in a committed tx this pass. */
  ackIds: string[];
}

/**
 * One tx per message: re-verify liveness under a row lock (M-4), then UPSERT
 * every resource row by `chunk_key` and stamp `indexed_at`. `rows`/`vectors`
 * may be empty (the discard path) — the stamp still gates on the SAME RETURNING
 * check. Returns whether the entry should be ACKed: `true` when the stamp
 * touched the row, `true` when the message was deleted mid-flight (no-op, the
 * delete won the race), `false` only when the stamp's RETURNING found no row.
 */
async function persistMessage(
  db: Database,
  messageId: string,
  channelId: string,
  rows: ResourceRow[],
  vectors: number[][],
  logger: Logger,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // M-4 (update/delete race): re-verify the message is still alive under a
    // ROW LOCK before inserting any embeddings. The Sync worker's deleted-stream
    // loop runs concurrently with the Indexer; a hard delete completing between
    // the dedup SELECT and this tx would otherwise let us resurrect orphan
    // vectors for a purged message (delete_policy: 'hard'). `FOR UPDATE` holds
    // the row until this tx commits, so the stamp below can no longer race a
    // delete either. No alive row → the delete won: abort as a no-op but still
    // ACK (at-least-once is satisfied — there is nothing left to index).
    //
    // AUDIT M1 (create/update race): also read `indexed_at` UNDER THE SAME LOCK.
    // The dedup SELECT that routed this entry to `toProcess` read `indexed_at`
    // OUTSIDE the tx (partitionByIndexState); during our slow fetch→enrich→embed
    // window a concurrent Sync `updated` event can re-index this message (newer
    // content) and stamp `indexed_at`. Without this check we would UPSERT the
    // now-stale create-time rows by `chunk_key` — clobbering the edit or leaving
    // duplicate rows that never self-heal. A non-null `indexed_at` means an edit
    // already won: abort as a no-op ACK, exactly like the delete-won branch.
    const alive = await tx.execute(
      sql`SELECT indexed_at AS "indexedAt" FROM discord_messages WHERE id = ${messageId} AND deleted_at IS NULL FOR UPDATE`,
    );
    if (alive.rows.length === 0) {
      logger.debug('message deleted mid-index — skipping persistence, acking no-op (delete won the race)', {
        messageId,
        channelId,
      });
      return true;
    }
    if ((alive.rows[0] as { indexedAt: unknown }).indexedAt != null) {
      logger.debug('message already indexed mid-flight — skipping stale create persistence, acking no-op (update won the race)', {
        messageId,
        channelId,
      });
      return true;
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      await tx
        .insert(embeddings)
        .values({
          chunkKey: `${messageId}:${row.urlIndex}`,
          title: row.title,
          description: row.description,
          link: row.link,
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

    const stamped = await tx
      .update(discordMessages)
      .set({ indexedAt: sql`now()` })
      .where(inArray(discordMessages.id, [messageId]))
      .returning({ id: discordMessages.id });

    return stamped.length > 0;
  });
}

/**
 * Process one batch of raw stream entries. Never throws for a data/processing
 * failure — a failed message is logged and its entries are simply omitted from
 * `ackIds` so Redis redelivers them.
 */
export async function indexBatch(deps: IndexBatchDeps): Promise<IndexBatchResult> {
  const { entries, db, embedder, config, logger, enrichModel, guard, signal, redis } = deps;
  const rateLimit = deps.rateLimit ?? DISABLED_RATE_LIMIT;
  const ackIds: string[] = [];

  // 1. Parse. Malformed / foreign-typed entries can never succeed — XACK them so
  //    they leave the PEL instead of being redelivered forever. A tombstoned
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

  // 2. Dedup state — ONE query over the batch's distinct message ids.
  const ids = [...new Set(parsed.map((e) => e.event.messageId))];
  const rows: IndexStateRow[] = await db
    .select({ id: discordMessages.id, indexedAt: discordMessages.indexedAt })
    .from(discordMessages)
    .where(inArray(discordMessages.id, ids));

  const { ackNow, pending, toProcess } = partitionByIndexState(parsed, rows);
  // Already-indexed → XACK + skip; row-missing → leave PENDING (no ack), retried
  // once the bot's COMMIT lands.
  ackIds.push(...ackNow);
  if (pending.length > 0) {
    logger.debug('entries pending — no discord_messages row yet, leaving un-ACKed', {
      count: pending.length,
    });
  }

  // A producer duplicate can put the SAME messageId in `toProcess` twice (up to 3x,
  // per persistMessage's documented COMMIT-race amplification). Dedup by messageId
  // BEFORE processing — keep the first occurrence for content, and remember every
  // duplicate's streamId so they all get acked once that messageId is confirmed
  // persisted.
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

  const dimensions = config.embeddings.dimensions;

  // 3. Resource pipeline, one message at a time — never grouped/chunked (FR5).
  for (const parsedEntry of dedupedToProcess) {
    if (signal.aborted) {
      logger.debug('shutdown signal observed — bailing the rest of the batch, entries stay pending');
      break;
    }

    const { messageId, channelId, content, authorId } = parsedEntry.event;
    const extraStreamIds = extraStreamIdsByMessageId.get(messageId) ?? [];

    try {
      // M-5 (economic DoS): the paid fetch/LLM/embeddings fan-out only happens
      // for a message that actually carries URLs, so consult the spend budget
      // ONLY then (a no-URL message costs nothing and must not consume budget).
      // If the budget is exhausted, DEGRADE to no-URL indexing (the existing
      // `discard` path: stamp + ack with zero rows) rather than drop the entry —
      // at-least-once (AD-13) is preserved.
      const hasUrls = extractUrls(content, config.enrichment.fetch.allowed_schemes).length > 0;
      let outcome: MessageOutcome;
      if (hasUrls && rateLimit.enabled && redis) {
        const allowed = await checkAndConsumeBudget(redis, { authorId }, rateLimit, logger);
        if (allowed) {
          outcome = await buildResourceRows(content, { config, enrichModel, guard, signal, logger });
        } else {
          logger.info('degrading message to no-URL indexing — enrichment budget exceeded', {
            messageId,
            channelId,
            authorId,
          });
          outcome = { kind: 'discard' };
        }
      } else {
        outcome = await buildResourceRows(content, { config, enrichModel, guard, signal, logger });
      }

      let stamped: boolean;
      if (outcome.kind === 'discard') {
        stamped = await persistMessage(db, messageId, channelId, [], [], logger);
      } else {
        const texts = outcome.rows.map((row) => buildEmbeddingText(row.title, row.description));
        const vectors = await embedder.embedDocuments(texts);
        if (vectors.length !== texts.length) {
          throw new Error(`embedder returned ${vectors.length} vectors for ${texts.length} texts`);
        }
        for (const vector of vectors) assertEmbeddingDimensions(vector, dimensions);

        stamped = await persistMessage(db, messageId, channelId, outcome.rows, vectors, logger);
      }

      if (stamped) {
        ackIds.push(parsedEntry.streamId, ...extraStreamIds);
      } else {
        logger.debug('message row vanished before the stamp — leaving un-ACKed', { messageId });
      }
    } catch (err) {
      logger.error('failed to index message — entry stays pending', {
        messageId,
        channelId,
        reason: err instanceof Error ? err.message : String(err),
      });
      // No ack ids for this message; later messages still run.
    }
  }

  return { ackIds };
}
