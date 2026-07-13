import type { Share2BrainConfig } from '@share2brain/shared';
import type { RedisClient } from '@share2brain/shared/redis';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@share2brain/shared/logger';
import {
  checkAndConsumeBudget,
  resolveEnrichmentRateLimit,
  type ResolvedEnrichmentRateLimit,
} from './rateLimiter.js';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** In-memory fake node-redis exposing INCR/EXPIRE. `failIncr` makes INCR reject
 *  so the fail-open path can be exercised. */
function makeFakeRedis(opts: { failIncr?: boolean } = {}) {
  const store = new Map<string, number>();
  const incr = vi.fn(async (key: string): Promise<number> => {
    if (opts.failIncr) throw new Error('redis down');
    const next = (store.get(key) ?? 0) + 1;
    store.set(key, next);
    return next;
  });
  const expire = vi.fn(async (): Promise<boolean> => true);
  return { redis: { incr, expire } as unknown as RedisClient, incr, expire, store };
}

const ENABLED: ResolvedEnrichmentRateLimit = {
  enabled: true,
  perAuthorHourly: 2,
  globalDaily: 100,
};

// A fixed instant so hour/day buckets are deterministic across a test's calls.
const NOW = Date.parse('2026-07-11T10:30:00.000Z');

describe('resolveEnrichmentRateLimit', () => {
  it('returns disabled when the config block is absent (behavior preserved)', () => {
    const config = { enrichment: {} } as unknown as Share2BrainConfig;
    expect(resolveEnrichmentRateLimit(config)).toEqual({
      enabled: false,
      perAuthorHourly: 0,
      globalDaily: 0,
    });
  });

  it('maps the snake_case config values when the block is present', () => {
    const config = {
      enrichment: { rate_limit: { enabled: true, per_author_hourly: 5, global_daily: 200 } },
    } as unknown as Share2BrainConfig;
    expect(resolveEnrichmentRateLimit(config)).toEqual({
      enabled: true,
      perAuthorHourly: 5,
      globalDaily: 200,
    });
  });
});

describe('checkAndConsumeBudget', () => {
  it('always allows and never touches Redis when disabled', async () => {
    const { redis, incr } = makeFakeRedis();
    const disabled: ResolvedEnrichmentRateLimit = { enabled: false, perAuthorHourly: 0, globalDaily: 0 };

    const ok = await checkAndConsumeBudget(redis, { authorId: 'a1', now: NOW }, disabled, makeLogger());

    expect(ok).toBe(true);
    expect(incr).not.toHaveBeenCalled();
  });

  it('denies once the per-author hourly cap is exceeded', async () => {
    const { redis } = makeFakeRedis();
    const logger = makeLogger();
    const call = () => checkAndConsumeBudget(redis, { authorId: 'a1', now: NOW }, ENABLED, logger);

    expect(await call()).toBe(true); // count 1 <= 2
    expect(await call()).toBe(true); // count 2 <= 2
    expect(await call()).toBe(false); // count 3 > 2 → denied
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('per-author hourly budget exceeded'),
      expect.objectContaining({ authorId: 'a1', cap: 2 }),
    );
  });

  it('denies once the global daily cap is exceeded, across different authors', async () => {
    const { redis } = makeFakeRedis();
    const resolved: ResolvedEnrichmentRateLimit = { enabled: true, perAuthorHourly: 100, globalDaily: 2 };
    const logger = makeLogger();

    expect(await checkAndConsumeBudget(redis, { authorId: 'a', now: NOW }, resolved, logger)).toBe(true);
    expect(await checkAndConsumeBudget(redis, { authorId: 'b', now: NOW }, resolved, logger)).toBe(true);
    expect(await checkAndConsumeBudget(redis, { authorId: 'c', now: NOW }, resolved, logger)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('global daily budget exceeded'),
      expect.objectContaining({ cap: 2 }),
    );
  });

  it('does not consume the global counter when the per-author cap already denies', async () => {
    const { redis, store } = makeFakeRedis();
    const logger = makeLogger();
    const call = () => checkAndConsumeBudget(redis, { authorId: 'a1', now: NOW }, ENABLED, logger);
    await call();
    await call();
    await call(); // this one is denied at the author gate

    const globalKeys = [...store.keys()].filter((k) => k.includes(':global:'));
    // Two allowed calls incremented global (to 2); the denied third never did.
    expect(globalKeys).toHaveLength(1);
    expect(store.get(globalKeys[0])).toBe(2);
  });

  it('sets the key expiry only on the first increment (INCR then EXPIRE if value===1)', async () => {
    const { redis, expire } = makeFakeRedis();
    const logger = makeLogger();

    await checkAndConsumeBudget(redis, { authorId: 'a1', now: NOW }, ENABLED, logger);
    // First call: author key AND global key each hit value===1 → one EXPIRE each.
    expect(expire).toHaveBeenCalledTimes(2);
    expect(expire).toHaveBeenCalledWith(expect.stringContaining(':author:a1:'), 3_600);
    expect(expire).toHaveBeenCalledWith(expect.stringContaining(':global:'), 86_400);

    await checkAndConsumeBudget(redis, { authorId: 'a1', now: NOW }, ENABLED, logger);
    // Second call: both counters now > 1 → no further EXPIRE calls.
    expect(expire).toHaveBeenCalledTimes(2);
  });

  it('fails OPEN (allows) and logs a warn when Redis errors', async () => {
    const { redis } = makeFakeRedis({ failIncr: true });
    const logger = makeLogger();

    const ok = await checkAndConsumeBudget(redis, { authorId: 'a1', now: NOW }, ENABLED, logger);

    expect(ok).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('failing open'),
      expect.objectContaining({ authorId: 'a1' }),
    );
  });

  it('buckets by hour/day so a later window resets the counter', async () => {
    const { redis } = makeFakeRedis();
    const logger = makeLogger();
    const call = (now: number) => checkAndConsumeBudget(redis, { authorId: 'a1', now }, ENABLED, logger);

    await call(NOW);
    await call(NOW);
    expect(await call(NOW)).toBe(false); // over cap in this hour
    // One hour later → new author bucket → allowed again.
    expect(await call(NOW + 3_600_000)).toBe(true);
  });
});
