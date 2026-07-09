// The Sync consumer loop (AC-1…AC-6). Consumes BOTH `discord.message.updated`
// and `discord.message.deleted` under the ONE `hivly:sync` consumer group, via
// TWO independent single-stream loops (DECISION 5) — each structurally
// identical to `runIndexer` (`indexer/consumer.ts`): idempotent xGroupCreate +
// MKSTREAM, PEL replay from '0' advancing past each batch, then a live '>' loop
// with BLOCK, abort checked at the top of every iteration.
//
// Each loop runs on its OWN Redis client (main.ts opens one per stream, plus
// the Indexer's) — two concurrent blocking loops cannot share a client: on a
// single node-redis connection a parked `XREADGROUP … BLOCK` serializes the
// other loop's read and its `xAck` behind it (see indexer/consumer.ts's header
// comment). So the updated- and deleted-stream loops truly drain in parallel.
import type { HivlyConfig } from '@hivly/shared';
import type { Database } from '@hivly/shared/db';
import type { RedisClient } from '@hivly/shared/redis';
import { CONSUMER_GROUPS, STREAM_KEYS } from '@hivly/shared/types/events';

import type { EnrichmentChatModel } from '../enrichment/enrich.js';
import type { GuardedDispatcher } from '../enrichment/ssrfGuard.js';
import type { Embedder, RawStreamEntry } from '../indexer/types.js';
import type { Logger } from '../logger.js';
import { parseDeletedEvent, parseUpdatedEvent } from './events.js';
import { processDelete } from './processDelete.js';
import { processUpdate } from './processUpdate.js';
import type { ProcessResult } from './types.js';

const CONSUMER = 'consumer-1'; // single-consumer group (per epic AC)
const COUNT = 10;
const BLOCK_MS = 5000;

export interface RunSyncDeps {
  /** Dedicated client for the updated-stream loop (see header — no sharing). */
  redisUpdated: RedisClient;
  /** Dedicated client for the deleted-stream loop (see header — no sharing). */
  redisDeleted: RedisClient;
  db: Database;
  embedder: Embedder;
  config: HivlyConfig;
  logger: Logger;
  /** The enrichment chat model — built once at boot, injected (AC-7, the SAME
   *  instance given to the Indexer). Only the updated-stream loop uses it. */
  enrichModel: EnrichmentChatModel;
  /** The SSRF-guarded dispatcher — built once at boot, injected (AC-7). */
  guard: GuardedDispatcher;
  /** Aborted on SIGTERM/SIGINT — both loops exit at their next iteration boundary. */
  signal: AbortSignal;
}

/**
 * Run the Sync consumer until `signal` aborts: the updated-stream and
 * deleted-stream loops run concurrently and independently on their own Redis
 * clients — a failure in one never affects the other.
 */
export async function runSync(deps: RunSyncDeps): Promise<void> {
  const { redisUpdated, redisDeleted, db, embedder, config, logger, enrichModel, guard, signal } = deps;
  const group = CONSUMER_GROUPS.SYNC;
  const updatedStream = STREAM_KEYS.DISCORD_MESSAGES_UPDATED;
  const deletedStream = STREAM_KEYS.DISCORD_MESSAGES_DELETED;

  await Promise.all([
    runStreamLoop({
      redis: redisUpdated,
      group,
      stream: updatedStream,
      logger,
      signal,
      handle: (entry) => {
        const event = entry.message == null ? null : parseUpdatedEvent(entry.message);
        if (event === null) {
          logger.warn('discarding malformed, foreign, or tombstoned update entry', {
            streamId: entry.id,
            type: entry.message?.type,
          });
          return Promise.resolve({ ack: true });
        }
        return processUpdate({
          event,
          streamId: entry.id,
          stream: updatedStream,
          db,
          embedder,
          config,
          logger,
          enrichModel,
          guard,
          signal,
        });
      },
    }),
    runStreamLoop({
      redis: redisDeleted,
      group,
      stream: deletedStream,
      logger,
      signal,
      handle: (entry) => {
        const event = entry.message == null ? null : parseDeletedEvent(entry.message);
        if (event === null) {
          logger.warn('discarding malformed, foreign, or tombstoned delete entry', {
            streamId: entry.id,
            type: entry.message?.type,
          });
          return Promise.resolve({ ack: true });
        }
        return processDelete({ event, streamId: entry.id, stream: deletedStream, db, config, logger });
      },
    }),
  ]);
}

interface RunStreamLoopDeps {
  redis: RedisClient;
  group: string;
  stream: string;
  logger: Logger;
  signal: AbortSignal;
  handle: (entry: RawStreamEntry) => Promise<ProcessResult>;
}

/** One stream's idempotent-group-create + PEL-replay + live-read loop — the
 *  exact shape of `runIndexer`, parameterized over the stream and its handler. */
async function runStreamLoop(deps: RunStreamLoopDeps): Promise<void> {
  const { redis, group, stream, logger, signal, handle } = deps;

  // AC-6: idempotent group creation — BUSYGROUP means "already exists".
  try {
    await redis.xGroupCreate(stream, group, '0', { MKSTREAM: true });
    logger.info('created consumer group', { stream, group });
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('BUSYGROUP')) throw err;
    logger.debug('consumer group already exists', { stream, group });
  }

  // AC-6: PEL replay — advance past each batch so a failed entry (still
  // pending) doesn't make us re-read '0' forever. Leftover failures replay
  // next boot.
  let replayId = '0';
  while (!signal.aborted) {
    const res = await redis.xReadGroup(group, CONSUMER, { key: stream, id: replayId }, { COUNT });
    const entries = (res?.[0]?.messages ?? []) as RawStreamEntry[];
    if (entries.length === 0) break;
    logger.info('replaying pending entries', { stream, count: entries.length });
    await processEntries({ entries, stream, group, redis, handle, logger });
    replayId = entries[entries.length - 1].id;
  }

  // AC-6: live loop. xReadGroup returns null on BLOCK timeout — loop and
  // re-check the abort flag, checked at every top so shutdown stops within
  // ~BLOCK_MS.
  while (!signal.aborted) {
    const res = await redis.xReadGroup(
      group,
      CONSUMER,
      { key: stream, id: '>' },
      { COUNT, BLOCK: BLOCK_MS },
    );
    if (!res) continue; // BLOCK timeout, no new entries
    const entries = (res[0]?.messages ?? []) as RawStreamEntry[];
    if (entries.length === 0) continue;
    await processEntries({ entries, stream, group, redis, handle, logger });
  }
}

interface ProcessEntriesDeps {
  entries: RawStreamEntry[];
  stream: string;
  group: string;
  redis: RedisClient;
  handle: (entry: RawStreamEntry) => Promise<ProcessResult>;
  logger: Logger;
}

/** AC-5: per-entry isolation — a throwing handler never aborts the batch or
 *  blocks later entries; only `{ ack: true }` results in an XACK. */
async function processEntries(deps: ProcessEntriesDeps): Promise<void> {
  const { entries, stream, group, redis, handle, logger } = deps;

  for (const entry of entries) {
    try {
      const { ack } = await handle(entry);
      if (ack) await redis.xAck(stream, group, entry.id);
    } catch (err) {
      // AC-7: never log message content — only ids/reason.
      logger.error('unhandled error processing sync entry — entry stays pending', {
        streamId: entry.id,
        stream,
        messageId: entry.message?.messageId,
        channelId: entry.message?.channelId,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
