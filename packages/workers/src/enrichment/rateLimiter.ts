// Economic-DoS guard on the Indexer's outbound fetch/LLM/embeddings fan-out
// (audit M-5). Without a budget, any Discord member can burn paid LLM/embeddings
// quota by posting many URL-heavy messages. This is a Redis-backed spend limiter
// with two fixed-window counters — a per-author hourly cap and a global daily
// cap — consumed once per FULL (URL-fetching) enrichment.
//
// Fail-open by design: the per-message URL cap (MAX_URLS_PER_MESSAGE) and the
// SSRF-guarded fetch already bound raw throughput; the budget is a COST guard on
// top of that. Blocking ALL enrichment on a Redis hiccup is worse than briefly
// over-spending, so a Redis blip logs a warn and ALLOWS the enrichment.
//
// Logging convention (AC-7): only ids/counters are ever logged — never message
// content.
import type { Share2BrainConfig } from '@share2brain/shared';
import type { RedisClient } from '@share2brain/shared/redis';

import type { Logger } from '@share2brain/shared/logger';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const HOUR_SECONDS = 3_600;
const DAY_SECONDS = 86_400;

/** Namespace for the budget counters — kept distinct from stream/session keys. */
const KEY_PREFIX = 's2b:enrich';

export interface ResolvedEnrichmentRateLimit {
  enabled: boolean;
  /** Max full (URL-fetching) enrichments per author per rolling hour. */
  perAuthorHourly: number;
  /** Max full enrichments across all authors per rolling day. */
  globalDaily: number;
}

/**
 * Resolve the optional `enrichment.rate_limit` config block to concrete values.
 * Absent block → disabled (current behavior preserved — no counters, always
 * allowed). Present block → its exact values (all positive ints per the schema).
 */
export function resolveEnrichmentRateLimit(config: Share2BrainConfig): ResolvedEnrichmentRateLimit {
  const rl = config.enrichment?.rate_limit;
  if (!rl) return { enabled: false, perAuthorHourly: 0, globalDaily: 0 };
  return {
    enabled: rl.enabled,
    perAuthorHourly: rl.per_author_hourly,
    globalDaily: rl.global_daily,
  };
}

/** INCR a counter and set its expiry ONLY on the first increment (value === 1),
 *  so the fixed window's TTL is stamped once and the key self-cleans after it. */
async function incrWithExpiry(redis: RedisClient, key: string, ttlSeconds: number): Promise<number> {
  const value = await redis.incr(key);
  if (value === 1) await redis.expire(key, ttlSeconds);
  return value;
}

/**
 * Check and consume one unit of the enrichment budget for `authorId`. Returns
 * `true` if a FULL (URL-fetching) enrichment is allowed, `false` if a cap is hit
 * (the caller must then DEGRADE to no-URL indexing — never drop the message).
 *
 * - Disabled → always `true` (no Redis I/O).
 * - Per-author hourly counter checked first; if it would exceed its cap, the
 *   global counter is left untouched and the call denies.
 * - Redis failure → log a warn and FAIL OPEN (`true`) — availability over a
 *   strict cost cap (the fetch limits still bound throughput).
 *
 * `now` is injectable for deterministic bucket math in tests; `Date.now()` is
 * fine in this runtime path (not a workflow script).
 */
export async function checkAndConsumeBudget(
  redis: RedisClient,
  { authorId, now }: { authorId: string; now?: number },
  resolved: ResolvedEnrichmentRateLimit,
  logger: Logger,
): Promise<boolean> {
  if (!resolved.enabled) return true;

  const ts = now ?? Date.now();
  const hourBucket = Math.floor(ts / HOUR_MS);
  const dayBucket = Math.floor(ts / DAY_MS);
  const authorKey = `${KEY_PREFIX}:author:${authorId}:${hourBucket}`;
  const globalKey = `${KEY_PREFIX}:global:${dayBucket}`;

  try {
    const authorCount = await incrWithExpiry(redis, authorKey, HOUR_SECONDS);
    if (authorCount > resolved.perAuthorHourly) {
      logger.warn('enrichment per-author hourly budget exceeded — will degrade to no-URL indexing', {
        authorId,
        count: authorCount,
        cap: resolved.perAuthorHourly,
      });
      return false;
    }

    const globalCount = await incrWithExpiry(redis, globalKey, DAY_SECONDS);
    if (globalCount > resolved.globalDaily) {
      logger.warn('enrichment global daily budget exceeded — will degrade to no-URL indexing', {
        count: globalCount,
        cap: resolved.globalDaily,
      });
      return false;
    }

    return true;
  } catch (err) {
    // A Redis blip must never block enrichment (fail open — see header).
    logger.warn('enrichment budget check failed — failing open (allowing enrichment)', {
      authorId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}
