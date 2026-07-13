// Redis Streams retention (Story OPS-1). A third long-lived loop in @share2brain/workers
// (alongside the Indexer and Sync consumers) that periodically trims the Discord
// streams WITHOUT ever dropping an unprocessed entry, so a long-running self-hosted
// instance does not grow Redis memory without limit while at-least-once delivery
// (AD-13) stays intact.
//
// COVERAGE CAVEAT: the PEL-safe bound only applies to a stream that HAS a consumer
// group (the three Discord streams). A stream with no group (KNOWLEDGE_EVENTS today
// — the Notifier consumer is deferred) has no PEL to protect and is bounded ONLY by
// the optional `max_len` backstop; with the default `max_len: null` it is not
// trimmed at all. That is acceptable today (KNOWLEDGE_EVENTS carries ~one
// backfill-completed event per bot boot); set a numeric `max_len` to bound it.
//
// WHY NOT `MAXLEN` ON `xAdd`: `XADD/XTRIM … MAXLEN` trims the oldest entries by
// COUNT with no awareness of the Pending Entries List. If a consumer group falls
// behind by more than the cap, its unacked (pending) entries are trimmed and lost
// — a direct AD-13 violation. So the primary bound here is `XTRIM … MINID` at a
// PEL-safe floor: the oldest entry still needed by ANY consumer group. Everything
// older has been delivered to AND acked by every group, so it is safe to remove.
//
// The trimmer runs on its OWN Redis client (main.ts opens one for it): the Indexer
// and Sync loops each park on a blocking XREADGROUP, and node-redis serializes
// commands per connection, so a shared client would queue the trimmer's admin
// commands behind a parked read (the one-client-per-loop lesson from Story 6.2).
import type { Share2BrainConfig } from '@share2brain/shared';
import type { RedisClient } from '@share2brain/shared/redis';
import { STREAM_KEYS } from '@share2brain/shared/types/events';

import type { Logger } from '@share2brain/shared/logger';

const DEFAULT_TRIM_INTERVAL_MS = 300_000; // 5 minutes (Story OPS-1 D2)

/** Streams the trimmer manages. The three Discord streams carry consumer groups
 *  (Indexer / Sync) and get the PEL-safe MINID trim; KNOWLEDGE_EVENTS has no
 *  consumer today (Notifier deferred) so it is only ever touched by the optional
 *  max_len backstop (D3). */
const MANAGED_STREAMS: readonly string[] = [
  STREAM_KEYS.DISCORD_MESSAGES,
  STREAM_KEYS.DISCORD_MESSAGES_UPDATED,
  STREAM_KEYS.DISCORD_MESSAGES_DELETED,
  STREAM_KEYS.KNOWLEDGE_EVENTS,
];

export interface ResolvedStreamsConfig {
  enabled: boolean;
  intervalMs: number;
  maxLen: number | null;
}

/** Resolve the optional `streams` config block to concrete values (D1: optional
 *  with in-code defaults so configs omitting the block still work — enabled,
 *  5-min interval, no ceiling). */
export function resolveStreamsConfig(config: Share2BrainConfig): ResolvedStreamsConfig {
  const s = config.streams;
  return {
    enabled: s?.trim_enabled ?? true,
    intervalMs: s?.trim_interval_ms ?? DEFAULT_TRIM_INTERVAL_MS,
    maxLen: s?.max_len ?? null,
  };
}

/**
 * Compare two Redis stream ids ("<ms>-<seq>") numerically. Returns <0, 0, or >0.
 * A plain string compare is WRONG once the millisecond part changes digit count
 * (e.g. "9999999999999-0" vs "10000000000000-0") — parse both parts as BigInt.
 * This is the same ordering trap Story 6.3's `reconcile.ts` (`toIdKey`) covers.
 */
export function compareStreamIds(a: string, b: string): number {
  const [aMs, aSeq = '0'] = a.split('-');
  const [bMs, bSeq = '0'] = b.split('-');
  const aMsB = BigInt(aMs);
  const bMsB = BigInt(bMs);
  if (aMsB !== bMsB) return aMsB < bMsB ? -1 : 1;
  const aSeqB = BigInt(aSeq);
  const bSeqB = BigInt(bSeq);
  if (aSeqB !== bSeqB) return aSeqB < bSeqB ? -1 : 1;
  return 0;
}

export interface SafeFloor {
  /** Oldest stream id still needed by any consumer group; null if none/unknown. */
  floor: string | null;
  /** Whether the stream currently has at least one consumer group. */
  hasGroups: boolean;
}

/**
 * Compute the PEL-safe floor for a stream: the minimum, across all its consumer
 * groups, of (the group's oldest pending entry id if it has pending entries, else
 * its last-delivered id). Entries strictly older than this floor have been
 * delivered to and acked by every group, so trimming them cannot lose work.
 * Returns `{ floor: null, hasGroups: false }` for a stream that does not exist yet
 * or has no consumer group.
 */
export async function computeSafeFloor(redis: RedisClient, stream: string): Promise<SafeFloor> {
  let groups: Awaited<ReturnType<RedisClient['xInfoGroups']>>;
  try {
    groups = await redis.xInfoGroups(stream);
  } catch (err) {
    // The stream does not exist yet (no producer has written to it). Nothing to
    // trim — a no-op, not an error (AC-4).
    if (err instanceof Error && /no such key/i.test(err.message)) {
      return { floor: null, hasGroups: false };
    }
    throw err;
  }

  if (groups.length === 0) return { floor: null, hasGroups: false };

  let floor: string | null = null;
  for (const group of groups) {
    const groupName = String(group.name);
    // node-redis 6 types `last-delivered-id` as NumberReply, but the RESP value is
    // a stream-id STRING ("<ms>-<seq>"). Coerce with String() (identity if already
    // a string) — a real gotcha in this version's typings.
    const lastDelivered = String(group['last-delivered-id']);
    let needed = lastDelivered;
    if (Number(group.pending) > 0) {
      const pending = await redis.xPending(stream, groupName);
      // Fail SAFE, not open: if pending is claimed but the oldest-pending id is
      // somehow unknown, contribute '0-0' so the stream floor collapses and
      // NOTHING is trimmed this tick — never fall back to lastDelivered (the
      // HIGHEST delivered id), which would drop the very pending entries we must
      // keep. Unreachable today (Redis returns a non-null firstId when pending>0),
      // but this is the one module whose whole job is delete-conservatism
      // (mirrors Story 6.3's fail-open→fail-safe review patch).
      needed = pending.firstId ? String(pending.firstId) : '0-0';
    }
    if (floor === null || compareStreamIds(needed, floor) < 0) floor = needed;
  }
  return { floor, hasGroups: true };
}

export interface TrimStreamDeps {
  redis: RedisClient;
  stream: string;
  maxLen: number | null;
  logger: Logger;
}

/**
 * Trim one stream: the PEL-safe MINID trim first (always), then the optional
 * absolute MAXLEN ceiling backstop (only when `maxLen` is set and exceeded).
 */
export async function trimStream(deps: TrimStreamDeps): Promise<void> {
  const { redis, stream, maxLen, logger } = deps;
  const { floor, hasGroups } = await computeSafeFloor(redis, stream);

  // Primary bound (AC-1). `XTRIM MINID <floor>` removes entries with id STRICTLY
  // LESS than the floor, so the floor entry itself (the oldest pending entry, or a
  // group's resume point) is always kept. Skip a "0-0" floor (would trim nothing).
  if (floor !== null && compareStreamIds(floor, '0-0') > 0) {
    const removed = await redis.xTrim(stream, 'MINID', floor);
    if (removed > 0) logger.debug('PEL-safe trim removed acked entries', { stream, floor, removed });
  }

  // Backstop APPROXIMATE ('~') ceiling (AC-2), disabled by default (max_len null).
  // Bounds a stream whose consumer group is stuck/dead — its PEL floor never
  // advances — or one with no consumer at all. This trim is NOT PEL-aware and may
  // drop pending entries, so a real eviction with live groups is a warn-level
  // alarm. '~' only evicts whole macro-nodes, so `removed` can be 0 when the
  // overflow is smaller than a node — only log when something was actually
  // removed, else the same line re-fires every tick.
  if (maxLen !== null) {
    const len = await redis.xLen(stream);
    if (len > maxLen) {
      const removed = await redis.xTrim(stream, 'MAXLEN', maxLen, { strategyModifier: '~' });
      if (removed > 0 && hasGroups) {
        logger.warn(
          'stream exceeded max_len ceiling — a consumer group is stuck/dead; forced MAXLEN trim may have dropped pending (unacked) entries',
          { stream, len, maxLen, removed },
        );
      } else if (removed > 0) {
        logger.info('stream with no consumer group trimmed to max_len ceiling', {
          stream,
          len,
          maxLen,
          removed,
        });
      }
    }
  }
}

/** Abortable sleep — resolves after `ms` or immediately when `signal` aborts. */
function sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export interface RunStreamTrimmerDeps {
  /** Dedicated client — must NOT be shared with a blocking consumer loop (note #5). */
  redis: RedisClient;
  config: Share2BrainConfig;
  logger: Logger;
  /** Aborted on SIGTERM/SIGINT — the loop stops before the next tick. */
  signal: AbortSignal;
  /** Injectable abortable wait (tests). Defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Run the trimmer until `signal` aborts: every `trim_interval_ms`, trim each
 * managed stream. A failing stream is caught, logged, and never aborts the tick
 * or crashes the process (AC-4); the abort flag is checked between every stream
 * and before each wait so shutdown stops promptly (AC-5).
 */
export async function runStreamTrimmer(deps: RunStreamTrimmerDeps): Promise<void> {
  const { redis, config, logger, signal } = deps;
  const sleep = deps.sleep ?? sleepOrAbort;
  const { intervalMs, maxLen } = resolveStreamsConfig(config);

  logger.info('stream trimmer starting', {
    intervalMs,
    maxLen,
    streamCount: MANAGED_STREAMS.length,
  });

  while (!signal.aborted) {
    for (const stream of MANAGED_STREAMS) {
      if (signal.aborted) break;
      try {
        await trimStream({ redis, stream, maxLen, logger });
      } catch (err) {
        // AC-4: per-stream isolation — one failure never stops the others or the loop.
        logger.error('stream trim failed — will retry next tick', {
          stream,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (signal.aborted) break;
    await sleep(intervalMs, signal);
  }

  logger.info('stream trimmer stopped');
}
