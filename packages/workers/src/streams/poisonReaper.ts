// Poison-entry reaper (security-audit fix A-1). Both consumer loops read live
// with '>' — a failed entry stays in the PEL and is only redelivered by the
// boot replay, so an entry that fails deterministically (a "poison pill", e.g.
// a message whose linked page makes enrichment fail every time) would stay
// pending forever. That has a second-order cost: the stream trimmer's PEL-safe
// floor (trim/streamTrimmer.ts) never advances past the oldest pending entry,
// so Redis memory grows without bound — and any Discord member can trigger it.
//
// The reaper closes both holes with the standard Streams pattern:
//   1. Pending entries whose delivery count reached `maxDeliveries` are copied
//      to a bounded dead-letter stream (`<stream>:dlq`) and XACKed — the PEL
//      shrinks, the trim floor advances, and the payload is preserved for
//      operator inspection/replay.
//   2. The remaining entries idle for at least `minIdleMs` are XAUTOCLAIMed
//      back to the same consumer (which increments their delivery counter) and
//      returned, so the caller retries them through its normal handler —
//      transient failures now retry in-process instead of waiting for the next
//      boot, and deterministic ones walk toward the dead-letter cap.
//
// The reaper runs inline in each (strictly sequential) consumer loop, so it can
// share that loop's Redis client: nothing here blocks, and it never runs while
// an entry of its own loop is mid-processing.
import type { RedisClient } from '@share2brain/shared/redis';

import type { RawStreamEntry } from '../indexer/types.js';
import type { Logger } from '@share2brain/shared/logger';

/** Deliveries (boot replays + reaper reclaims) before an entry is dead-lettered. */
export const MAX_DELIVERIES = 5;
/** How long an entry must sit untouched in the PEL before the reaper considers
 *  it stale — spaces retries out instead of hammering a failing dependency. */
export const DEFAULT_MIN_IDLE_MS = 5 * 60_000;
/** How often the consumer loops invoke the reaper. */
export const DEFAULT_REAP_INTERVAL_MS = 60_000;

// The DLQ must not recreate the unbounded-growth problem it exists to solve:
// approximate MAXLEN cap, oldest dead letters evicted first. 10k entries of
// ≤~4 KB Discord payloads bound it to a few tens of MB.
const DLQ_MAX_LEN = 10_000;
const REAP_BATCH = 100;

export function dlqStreamKey(stream: string): string {
  return `${stream}:dlq`;
}

export interface ReapDeps {
  redis: RedisClient;
  stream: string;
  group: string;
  consumer: string;
  logger: Logger;
  maxDeliveries?: number;
  minIdleMs?: number;
}

/**
 * Dead-letter the poison entries of one stream's PEL, then reclaim the rest of
 * its stale entries for an in-process retry. Returns the reclaimed entries in
 * the same shape XREADGROUP delivers them, so callers reuse their batch path.
 */
export async function reapPoisonEntries(deps: ReapDeps): Promise<RawStreamEntry[]> {
  const { redis, stream, group, consumer, logger } = deps;
  const maxDeliveries = deps.maxDeliveries ?? MAX_DELIVERIES;
  const minIdleMs = deps.minIdleMs ?? DEFAULT_MIN_IDLE_MS;

  const pending = await redis.xPendingRange(stream, group, '-', '+', REAP_BATCH, {
    IDLE: minIdleMs,
  });

  for (const p of pending) {
    // node-redis 6 types these as Blob/NumberReply; the RESP values are a
    // stream-id string and a number (same coercion gotcha as streamTrimmer).
    const id = String(p.id);
    const deliveries = Number(p.deliveriesCounter);
    if (deliveries < maxDeliveries) continue;

    // Copy the payload before releasing the entry. An empty range means the
    // entry was XDEL'd/trimmed — nothing left to preserve, just ack it free.
    const range = await redis.xRange(stream, id, id);
    const message = range[0]?.message;
    if (message != null) {
      await redis.xAdd(
        dlqStreamKey(stream),
        '*',
        {
          ...message,
          dlqOriginalId: id,
          dlqOriginalStream: stream,
          dlqDeliveries: String(deliveries),
        },
        { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: DLQ_MAX_LEN } },
      );
    }
    await redis.xAck(stream, group, id);
    // Never log message content — only ids/counters (AC-7 convention).
    logger.error('entry exceeded max deliveries — moved to dead-letter stream', {
      stream,
      streamId: id,
      deliveries,
      dlq: dlqStreamKey(stream),
    });
  }

  // Claim whatever stale entries remain (the dead-lettered ones are acked and
  // gone from the PEL). XAUTOCLAIM bumps each claimed entry's delivery counter
  // and drops XDEL'd tombstones from the PEL on its own (reported via
  // `deletedMessages`, which therefore needs no handling here).
  const claimed = await redis.xAutoClaim(stream, group, consumer, minIdleMs, '0-0', {
    COUNT: REAP_BATCH,
  });
  const entries: RawStreamEntry[] = [];
  for (const msg of claimed.messages) {
    if (msg == null) continue;
    // Same loose node-redis typing as XREADGROUP: the RESP shape is exactly
    // { id, message: Record<string, string> }.
    entries.push({ id: String(msg.id), message: msg.message as unknown as Record<string, string> });
  }
  if (entries.length > 0) {
    logger.info('reclaimed stale pending entries for retry', { stream, count: entries.length });
  }
  return entries;
}
