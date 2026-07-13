import { describe, expect, it, vi } from 'vitest';

import type { Share2BrainConfig } from '@share2brain/shared';
import type { RedisClient } from '@share2brain/shared/redis';
import { STREAM_KEYS } from '@share2brain/shared/types/events';

import type { Logger } from '@share2brain/shared/logger';
import {
  compareStreamIds,
  computeSafeFloor,
  resolveStreamsConfig,
  runStreamTrimmer,
  trimStream,
} from './streamTrimmer.js';

function makeLogger(): Logger & { calls: Array<{ level: string; msg: string; ctx?: unknown }> } {
  const calls: Array<{ level: string; msg: string; ctx?: unknown }> = [];
  const mk =
    (level: string) =>
    (msg: string, ctx?: Record<string, unknown>): void => {
      calls.push({ level, msg, ctx });
    };
  return { calls, debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') };
}

/** A fake node-redis client exposing only the stream methods the trimmer uses. */
function makeRedis(overrides: Partial<Record<string, unknown>> = {}): RedisClient {
  return {
    xInfoGroups: vi.fn(),
    xPending: vi.fn(),
    xTrim: vi.fn().mockResolvedValue(0),
    xLen: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as RedisClient;
}

function configWithStreams(streams?: Share2BrainConfig['streams']): Share2BrainConfig {
  return { streams } as unknown as Share2BrainConfig;
}

describe('compareStreamIds', () => {
  it('orders by the millisecond part', () => {
    expect(compareStreamIds('100-0', '200-0')).toBeLessThan(0);
    expect(compareStreamIds('200-0', '100-0')).toBeGreaterThan(0);
  });

  it('orders by the sequence part when ms is equal', () => {
    expect(compareStreamIds('100-1', '100-2')).toBeLessThan(0);
    expect(compareStreamIds('100-5', '100-5')).toBe(0);
  });

  it('compares numerically, not lexically, across a digit-count change (the BigInt trap)', () => {
    // 18-digit ms vs 19-digit ms: a string compare would call the 19-digit id
    // "smaller" because '1' < '9'. Numerically the 19-digit id is larger.
    const eighteen = '999999999999999999-0';
    const nineteen = '1000000000000000000-0';
    expect(compareStreamIds(eighteen, nineteen)).toBeLessThan(0);
    expect(compareStreamIds(nineteen, eighteen)).toBeGreaterThan(0);
  });

  it('treats a missing sequence part as 0', () => {
    expect(compareStreamIds('100', '100-0')).toBe(0);
  });
});

describe('resolveStreamsConfig', () => {
  it('defaults to enabled / 5-min / no-ceiling when the block is absent (D1)', () => {
    expect(resolveStreamsConfig(configWithStreams(undefined))).toEqual({
      enabled: true,
      intervalMs: 300_000,
      maxLen: null,
    });
  });

  it('uses the configured values when the block is present', () => {
    const resolved = resolveStreamsConfig(
      configWithStreams({ trim_enabled: false, trim_interval_ms: 60_000, max_len: 500_000 }),
    );
    expect(resolved).toEqual({ enabled: false, intervalMs: 60_000, maxLen: 500_000 });
  });

  it('honors an explicit max_len of null (PEL-safe only)', () => {
    const resolved = resolveStreamsConfig(
      configWithStreams({ trim_enabled: true, trim_interval_ms: 300_000, max_len: null }),
    );
    expect(resolved.maxLen).toBeNull();
  });
});

describe('computeSafeFloor', () => {
  it('returns the minimum needed id across two groups (the laggier group wins)', async () => {
    const redis = makeRedis({
      xInfoGroups: vi.fn().mockResolvedValue([
        { name: 'g1', pending: 0, 'last-delivered-id': '500-0' },
        { name: 'g2', pending: 0, 'last-delivered-id': '200-0' },
      ]),
    });

    const result = await computeSafeFloor(redis, 'stream');

    expect(result).toEqual({ floor: '200-0', hasGroups: true });
  });

  it('uses the oldest pending id (firstId) over last-delivered when a group has pending', async () => {
    const redis = makeRedis({
      xInfoGroups: vi.fn().mockResolvedValue([
        { name: 'g1', pending: 3, 'last-delivered-id': '900-0' },
      ]),
      xPending: vi.fn().mockResolvedValue({ pending: 3, firstId: '300-0', lastId: '900-0', consumers: null }),
    });

    const result = await computeSafeFloor(redis, 'stream');

    expect(redis.xPending).toHaveBeenCalledWith('stream', 'g1');
    expect(result.floor).toBe('300-0'); // the unacked entry, NOT last-delivered 900-0
  });

  it('coerces a numeric-looking last-delivered-id to a string (node-redis typing gotcha)', async () => {
    const redis = makeRedis({
      // Simulate the value arriving as a number-shaped id; String() must handle it.
      xInfoGroups: vi.fn().mockResolvedValue([{ name: 'g1', pending: 0, 'last-delivered-id': '0-0' }]),
    });

    const result = await computeSafeFloor(redis, 'stream');

    expect(result.floor).toBe('0-0');
    expect(typeof result.floor).toBe('string');
  });

  it('returns { null, false } for a stream with no consumer group', async () => {
    const redis = makeRedis({ xInfoGroups: vi.fn().mockResolvedValue([]) });

    expect(await computeSafeFloor(redis, 'stream')).toEqual({ floor: null, hasGroups: false });
  });

  it('treats a non-existent stream (no such key) as a no-op, not an error', async () => {
    const redis = makeRedis({
      xInfoGroups: vi.fn().mockRejectedValue(new Error('ERR no such key')),
    });

    expect(await computeSafeFloor(redis, 'stream')).toEqual({ floor: null, hasGroups: false });
  });

  it('rethrows an unexpected error', async () => {
    const redis = makeRedis({
      xInfoGroups: vi.fn().mockRejectedValue(new Error('CONNECTION_BROKEN')),
    });

    await expect(computeSafeFloor(redis, 'stream')).rejects.toThrow('CONNECTION_BROKEN');
  });
});

describe('trimStream', () => {
  it('issues XTRIM MINID at the PEL-safe floor', async () => {
    const redis = makeRedis({
      xInfoGroups: vi.fn().mockResolvedValue([{ name: 'g1', pending: 0, 'last-delivered-id': '500-0' }]),
      xTrim: vi.fn().mockResolvedValue(4),
    });
    const logger = makeLogger();

    await trimStream({ redis, stream: 'stream', maxLen: null, logger });

    expect(redis.xTrim).toHaveBeenCalledWith('stream', 'MINID', '500-0');
  });

  it('does NOT issue a MINID trim when the floor is 0-0 (nothing acked yet)', async () => {
    const redis = makeRedis({
      xInfoGroups: vi.fn().mockResolvedValue([{ name: 'g1', pending: 0, 'last-delivered-id': '0-0' }]),
    });
    const logger = makeLogger();

    await trimStream({ redis, stream: 'stream', maxLen: null, logger });

    expect(redis.xTrim).not.toHaveBeenCalled();
  });

  it('does NOT apply the max_len backstop when max_len is null', async () => {
    const redis = makeRedis({
      xInfoGroups: vi.fn().mockResolvedValue([{ name: 'g1', pending: 0, 'last-delivered-id': '0-0' }]),
      xLen: vi.fn().mockResolvedValue(1_000_000),
    });
    const logger = makeLogger();

    await trimStream({ redis, stream: 'stream', maxLen: null, logger });

    expect(redis.xLen).not.toHaveBeenCalled();
    expect(redis.xTrim).not.toHaveBeenCalled();
  });

  it('applies the max_len ceiling and warns (stuck consumer) when a stream with groups exceeds it', async () => {
    const redis = makeRedis({
      xInfoGroups: vi.fn().mockResolvedValue([{ name: 'g1', pending: 0, 'last-delivered-id': '0-0' }]),
      xLen: vi.fn().mockResolvedValue(600_000),
      xTrim: vi.fn().mockResolvedValue(100_000),
    });
    const logger = makeLogger();

    await trimStream({ redis, stream: 'stream', maxLen: 500_000, logger });

    expect(redis.xTrim).toHaveBeenCalledWith('stream', 'MAXLEN', 500_000, { strategyModifier: '~' });
    const warns = logger.calls.filter((c) => c.level === 'warn');
    expect(warns).toHaveLength(1);
  });

  it('does NOT trim (or warn) when length is within the max_len ceiling', async () => {
    const redis = makeRedis({
      xInfoGroups: vi.fn().mockResolvedValue([{ name: 'g1', pending: 0, 'last-delivered-id': '0-0' }]),
      xLen: vi.fn().mockResolvedValue(400_000),
    });
    const logger = makeLogger();

    await trimStream({ redis, stream: 'stream', maxLen: 500_000, logger });

    expect(redis.xTrim).not.toHaveBeenCalled();
    expect(logger.calls.filter((c) => c.level === 'warn')).toHaveLength(0);
  });

  it('does NOT log when the approximate max_len trim evicts nothing (removed === 0)', async () => {
    const redis = makeRedis({
      xInfoGroups: vi.fn().mockResolvedValue([{ name: 'g1', pending: 0, 'last-delivered-id': '0-0' }]),
      xLen: vi.fn().mockResolvedValue(500_050), // just over the ceiling
      xTrim: vi.fn().mockResolvedValue(0), // '~' couldn't evict a whole macro-node
    });
    const logger = makeLogger();

    await trimStream({ redis, stream: 'stream', maxLen: 500_000, logger });

    expect(redis.xTrim).toHaveBeenCalledWith('stream', 'MAXLEN', 500_000, { strategyModifier: '~' });
    expect(logger.calls.filter((c) => c.level === 'warn' || c.level === 'info')).toHaveLength(0);
  });

  it('trims a no-group stream by max_len at info level (not a stuck-consumer warn)', async () => {
    const redis = makeRedis({
      xInfoGroups: vi.fn().mockResolvedValue([]), // no consumer group (e.g. KNOWLEDGE_EVENTS)
      xLen: vi.fn().mockResolvedValue(600_000),
      xTrim: vi.fn().mockResolvedValue(100_000),
    });
    const logger = makeLogger();

    await trimStream({ redis, stream: 'stream', maxLen: 500_000, logger });

    expect(redis.xTrim).toHaveBeenCalledWith('stream', 'MAXLEN', 500_000, { strategyModifier: '~' });
    expect(logger.calls.filter((c) => c.level === 'warn')).toHaveLength(0);
    expect(logger.calls.some((c) => c.level === 'info')).toBe(true);
  });
});

describe('runStreamTrimmer', () => {
  it('does nothing and returns when the signal is already aborted', async () => {
    const redis = makeRedis();
    const logger = makeLogger();
    const controller = new AbortController();
    controller.abort();

    await runStreamTrimmer({
      redis,
      config: configWithStreams(undefined),
      logger,
      signal: controller.signal,
      sleep: vi.fn(),
    });

    expect(redis.xInfoGroups).not.toHaveBeenCalled();
  });

  it('trims all four managed streams once per tick, then stops when aborted mid-wait', async () => {
    const redis = makeRedis({
      xInfoGroups: vi.fn().mockResolvedValue([]), // no groups → no trim, just enumerated
    });
    const logger = makeLogger();
    const controller = new AbortController();
    // Abort during the first inter-tick wait so exactly one tick runs.
    const sleep = vi.fn().mockImplementation((_ms: number, signal: AbortSignal) => {
      controller.abort();
      void signal;
      return Promise.resolve();
    });

    await runStreamTrimmer({
      redis,
      config: configWithStreams(undefined),
      logger,
      signal: controller.signal,
      sleep,
    });

    // All four managed streams inspected exactly once (one tick).
    expect((redis.xInfoGroups as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
    const streamsSeen = (redis.xInfoGroups as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(streamsSeen).toEqual([
      STREAM_KEYS.DISCORD_MESSAGES,
      STREAM_KEYS.DISCORD_MESSAGES_UPDATED,
      STREAM_KEYS.DISCORD_MESSAGES_DELETED,
      STREAM_KEYS.KNOWLEDGE_EVENTS,
    ]);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('isolates a failing stream — the other streams in the tick still trim', async () => {
    let call = 0;
    const redis = makeRedis({
      xInfoGroups: vi.fn().mockImplementation(() => {
        call += 1;
        if (call === 1) return Promise.reject(new Error('CONNECTION_BROKEN'));
        return Promise.resolve([]);
      }),
    });
    const logger = makeLogger();
    const controller = new AbortController();
    const sleep = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });

    await runStreamTrimmer({
      redis,
      config: configWithStreams(undefined),
      logger,
      signal: controller.signal,
      sleep,
    });

    // First stream threw but the loop kept going: all four were attempted.
    expect((redis.xInfoGroups as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
    const errors = logger.calls.filter((c) => c.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].msg).toMatch(/trim failed/);
  });

  it('never logs a context object carrying message content', async () => {
    const redis = makeRedis({
      xInfoGroups: vi.fn().mockResolvedValue([{ name: 'g1', pending: 0, 'last-delivered-id': '500-0' }]),
      xTrim: vi.fn().mockResolvedValue(2),
    });
    const logger = makeLogger();
    const controller = new AbortController();
    const sleep = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });

    await runStreamTrimmer({
      redis,
      config: configWithStreams(undefined),
      logger,
      signal: controller.signal,
      sleep,
    });

    for (const { ctx } of logger.calls) {
      if (ctx && typeof ctx === 'object') {
        expect(Object.keys(ctx as object)).not.toContain('content');
        expect(Object.keys(ctx as object)).not.toContain('newContent');
      }
    }
  });
});
