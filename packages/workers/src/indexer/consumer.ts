// The Indexer consumer loop (AC-1, AC-5, AC-6). Creates the consumer group
// idempotently, drains its own PEL on boot (crash-recovery replay), then reads
// live. XACK happens only for the ids indexBatch confirms were persisted.
//
// One dedicated Redis client is enough: this loop is strictly sequential
// (read → process → ack → read), so nothing ever queues behind the blocking read.
// Do not share the injected client with a concurrent caller.
import type { Share2BrainConfig } from '@share2brain/shared';
import type { Database } from '@share2brain/shared/db';
import type { RedisClient } from '@share2brain/shared/redis';
import { CONSUMER_GROUPS, STREAM_KEYS } from '@share2brain/shared/types/events';

import type { EnrichmentChatModel } from '../enrichment/enrich.js';
import { resolveEnrichmentRateLimit } from '../enrichment/rateLimiter.js';
import type { GuardedDispatcher } from '../enrichment/ssrfGuard.js';
import type { Logger } from '@share2brain/shared/logger';
import { DEFAULT_REAP_INTERVAL_MS, reapPoisonEntries } from '../streams/poisonReaper.js';
import { indexBatch } from './indexBatch.js';
import type { Embedder, RawStreamEntry } from './types.js';

const CONSUMER = 'consumer-1'; // single-consumer group (per epic AC)
const COUNT = 10;
const BLOCK_MS = 5000;

export interface RunIndexerDeps {
  redis: RedisClient;
  db: Database;
  embedder: Embedder;
  config: Share2BrainConfig;
  logger: Logger;
  /** Built once at boot alongside the embedder — never constructed here (AC-6). */
  enrichModel: EnrichmentChatModel;
  guard: GuardedDispatcher;
  /** Aborted on SIGTERM/SIGINT — the loop exits at the next iteration boundary. */
  signal: AbortSignal;
  /** Poison-reap cadence override (tests). Defaults to DEFAULT_REAP_INTERVAL_MS. */
  reapIntervalMs?: number;
}

/**
 * Run the Indexer until `signal` aborts. Resolves when the loop observes the abort
 * (≤ ~BLOCK_MS after signal, since a parked blocking read must return first).
 */
export async function runIndexer(deps: RunIndexerDeps): Promise<void> {
  const { redis, db, embedder, config, logger, enrichModel, guard, signal } = deps;
  const stream = STREAM_KEYS.DISCORD_MESSAGES;
  const group = CONSUMER_GROUPS.INDEXER;
  // M-5: resolve the enrichment spend budget once at boot and thread it (plus
  // the consumer's own Redis client) into every indexBatch call. Absent config
  // block → disabled → the pipeline behaves exactly as before.
  const rateLimit = resolveEnrichmentRateLimit(config);

  // AC-1: idempotent group creation — BUSYGROUP means "already exists", the
  // "create if not exists" of the AC. Any other error is fatal.
  try {
    await redis.xGroupCreate(stream, group, '0', { MKSTREAM: true });
    logger.info('created consumer group', { stream, group });
  } catch (err) {
    if (!(err instanceof Error) || !err.message.startsWith('BUSYGROUP')) throw err;
    logger.debug('consumer group already exists', { stream, group });
  }

  // AC-1: PEL replay. Reading with an explicit id (not '>') returns OUR pending
  // entries after that id; advance past each batch so a failed entry — which stays
  // pending — doesn't make us re-read '0' forever. Leftover failures replay next boot.
  let replayId = '0';
  while (!signal.aborted) {
    const res = await redis.xReadGroup(group, CONSUMER, { key: stream, id: replayId }, { COUNT });
    // node-redis types the XREADGROUP reply loosely; the RESP2 shape is a fixed
    // { id, message: Record<string,string> } which is exactly RawStreamEntry.
    const entries = (res?.[0]?.messages ?? []) as RawStreamEntry[];
    if (entries.length === 0) break;
    logger.info('replaying pending entries', { count: entries.length });
    const { ackIds } = await indexBatch({ entries, db, embedder, config, logger, enrichModel, guard, signal, redis, rateLimit });
    for (const id of ackIds) await redis.xAck(stream, group, id);
    replayId = entries[entries.length - 1].id; // move past this batch, acked or not
  }

  // AC-1: live loop. xReadGroup returns null on BLOCK timeout — just loop and
  // re-check the abort flag. Checked at every top so shutdown stops within ~BLOCK_MS.
  // Between reads, periodically reap the PEL: retry stale entries in-process and
  // dead-letter poison ones so they can't pin the trimmer's floor forever (the
  // boot replay above just walked the PEL, so the first reap can wait a full tick).
  const reapIntervalMs = deps.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  let nextReapAt = Date.now() + reapIntervalMs;
  while (!signal.aborted) {
    if (Date.now() >= nextReapAt) {
      nextReapAt = Date.now() + reapIntervalMs;
      try {
        const reclaimed = await reapPoisonEntries({ redis, stream, group, consumer: CONSUMER, logger });
        if (reclaimed.length > 0) {
          const retry = await indexBatch({ entries: reclaimed, db, embedder, config, logger, enrichModel, guard, signal, redis, rateLimit });
          for (const id of retry.ackIds) await redis.xAck(stream, group, id);
        }
      } catch (err) {
        // Reaping is auxiliary — a Redis blip here must not kill the consumer.
        logger.error('poison reap failed — will retry next tick', {
          stream,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const res = await redis.xReadGroup(
      group,
      CONSUMER,
      { key: stream, id: '>' },
      { COUNT, BLOCK: BLOCK_MS },
    );
    if (!res) continue; // BLOCK timeout, no new entries
    const entries = (res[0]?.messages ?? []) as RawStreamEntry[];
    if (entries.length === 0) continue;
    const { ackIds } = await indexBatch({ entries, db, embedder, config, logger, enrichModel, guard, signal, redis, rateLimit });
    for (const id of ackIds) await redis.xAck(stream, group, id);
  }
}
