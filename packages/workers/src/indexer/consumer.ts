// The Indexer consumer loop (AC-1, AC-5, AC-6). Creates the consumer group
// idempotently, drains its own PEL on boot (crash-recovery replay), then reads
// live. XACK happens only for the ids indexBatch confirms were persisted.
//
// One dedicated Redis client is enough: this loop is strictly sequential
// (read → process → ack → read), so nothing ever queues behind the blocking read.
// Do not share the injected client with a concurrent caller.
import type { HivlyConfig } from '@hivly/shared';
import type { Database } from '@hivly/shared/db';
import type { RedisClient } from '@hivly/shared/redis';
import { CONSUMER_GROUPS, STREAM_KEYS } from '@hivly/shared/types/events';

import type { Logger } from '../logger.js';
import { indexBatch } from './indexBatch.js';
import type { Embedder, RawStreamEntry } from './types.js';

const CONSUMER = 'consumer-1'; // single-consumer group (per epic AC)
const COUNT = 10;
const BLOCK_MS = 5000;

export interface RunIndexerDeps {
  redis: RedisClient;
  db: Database;
  embedder: Embedder;
  config: HivlyConfig;
  logger: Logger;
  /** Aborted on SIGTERM/SIGINT — the loop exits at the next iteration boundary. */
  signal: AbortSignal;
}

/**
 * Run the Indexer until `signal` aborts. Resolves when the loop observes the abort
 * (≤ ~BLOCK_MS after signal, since a parked blocking read must return first).
 */
export async function runIndexer(deps: RunIndexerDeps): Promise<void> {
  const { redis, db, embedder, config, logger, signal } = deps;
  const stream = STREAM_KEYS.DISCORD_MESSAGES;
  const group = CONSUMER_GROUPS.INDEXER;

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
    const { ackIds } = await indexBatch({ entries, db, embedder, config, logger });
    for (const id of ackIds) await redis.xAck(stream, group, id);
    replayId = entries[entries.length - 1].id; // move past this batch, acked or not
  }

  // AC-1: live loop. xReadGroup returns null on BLOCK timeout — just loop and
  // re-check the abort flag. Checked at every top so shutdown stops within ~BLOCK_MS.
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
    const { ackIds } = await indexBatch({ entries, db, embedder, config, logger });
    for (const id of ackIds) await redis.xAck(stream, group, id);
  }
}
