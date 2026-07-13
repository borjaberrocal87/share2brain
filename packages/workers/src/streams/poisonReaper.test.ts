import type { RedisClient } from '@share2brain/shared/redis';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@share2brain/shared/logger';
import { dlqStreamKey, MAX_DELIVERIES, reapPoisonEntries } from './poisonReaper.js';

const STREAM = 'share2brain:discord:messages';
const GROUP = 'share2brain:indexer';
const CONSUMER = 'consumer-1';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface PendingEntry {
  id: string;
  consumer: string;
  millisecondsSinceLastDelivery: number;
  deliveriesCounter: number;
}

/** Fake node-redis client covering the five commands the reaper issues. */
function fakeRedis(opts: {
  pending?: PendingEntry[];
  /** Payload returned by xRange per id; a missing id yields an empty range (XDEL'd). */
  payloads?: Record<string, Record<string, string>>;
  /** Messages returned by xAutoClaim (null = tombstone of an XDEL'd entry). */
  claimed?: Array<{ id: string; message: Record<string, string> } | null>;
}) {
  const redis = {
    xPendingRange: vi.fn().mockResolvedValue(opts.pending ?? []),
    xRange: vi.fn((_stream: string, id: string) => {
      const message = opts.payloads?.[id];
      return Promise.resolve(message ? [{ id, message }] : []);
    }),
    xAdd: vi.fn().mockResolvedValue('1-1'),
    xAck: vi.fn().mockResolvedValue(1),
    xAutoClaim: vi.fn().mockResolvedValue({ nextId: '0-0', messages: opts.claimed ?? [], deletedMessages: [] }),
  } as unknown as RedisClient;
  return redis;
}

function pendingEntry(id: string, deliveries: number): PendingEntry {
  return { id, consumer: CONSUMER, millisecondsSinceLastDelivery: 600_000, deliveriesCounter: deliveries };
}

describe('reapPoisonEntries', () => {
  it('should dead-letter an entry at max deliveries: copy payload + metadata to the capped DLQ, then XACK', async () => {
    const logger = makeLogger();
    const redis = fakeRedis({
      pending: [pendingEntry('5-0', MAX_DELIVERIES)],
      payloads: { '5-0': { type: 'discord.message.created', messageId: 'm1' } },
    });

    await reapPoisonEntries({ redis, stream: STREAM, group: GROUP, consumer: CONSUMER, logger });

    expect(redis.xAdd).toHaveBeenCalledWith(
      dlqStreamKey(STREAM),
      '*',
      {
        type: 'discord.message.created',
        messageId: 'm1',
        dlqOriginalId: '5-0',
        dlqOriginalStream: STREAM,
        dlqDeliveries: String(MAX_DELIVERIES),
      },
      { TRIM: { strategy: 'MAXLEN', strategyModifier: '~', threshold: 10_000 } },
    );
    expect(redis.xAck).toHaveBeenCalledWith(STREAM, GROUP, '5-0');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('dead-letter'),
      expect.objectContaining({ streamId: '5-0', deliveries: MAX_DELIVERIES }),
    );
  });

  it('should XACK without a DLQ copy when the poison entry was XDEL’d (empty range)', async () => {
    const redis = fakeRedis({ pending: [pendingEntry('5-0', MAX_DELIVERIES)] });

    await reapPoisonEntries({ redis, stream: STREAM, group: GROUP, consumer: CONSUMER, logger: makeLogger() });

    expect(redis.xAdd).not.toHaveBeenCalled();
    expect(redis.xAck).toHaveBeenCalledWith(STREAM, GROUP, '5-0');
  });

  it('should leave an entry under the deliveries cap alone and return it via XAUTOCLAIM for retry', async () => {
    const redis = fakeRedis({
      pending: [pendingEntry('3-0', MAX_DELIVERIES - 1)],
      claimed: [{ id: '3-0', message: { messageId: 'm1' } }],
    });

    const reclaimed = await reapPoisonEntries({
      redis,
      stream: STREAM,
      group: GROUP,
      consumer: CONSUMER,
      logger: makeLogger(),
    });

    expect(redis.xAdd).not.toHaveBeenCalled();
    expect(redis.xAck).not.toHaveBeenCalled();
    expect(reclaimed).toEqual([{ id: '3-0', message: { messageId: 'm1' } }]);
  });

  it('should pass the idle threshold to both XPENDING and XAUTOCLAIM and skip null claimed tombstones', async () => {
    const redis = fakeRedis({ claimed: [null, { id: '7-0', message: { messageId: 'm7' } }] });

    const reclaimed = await reapPoisonEntries({
      redis,
      stream: STREAM,
      group: GROUP,
      consumer: CONSUMER,
      logger: makeLogger(),
      minIdleMs: 1234,
    });

    expect(redis.xPendingRange).toHaveBeenCalledWith(STREAM, GROUP, '-', '+', 100, { IDLE: 1234 });
    expect(redis.xAutoClaim).toHaveBeenCalledWith(STREAM, GROUP, CONSUMER, 1234, '0-0', { COUNT: 100 });
    expect(reclaimed).toEqual([{ id: '7-0', message: { messageId: 'm7' } }]);
  });

  it('should never log message content, only ids and counters', async () => {
    const secret = 'super secret discord content';
    const logger = makeLogger();
    const redis = fakeRedis({
      pending: [pendingEntry('5-0', MAX_DELIVERIES)],
      payloads: { '5-0': { content: secret } },
    });

    await reapPoisonEntries({ redis, stream: STREAM, group: GROUP, consumer: CONSUMER, logger });

    const allCalls = [
      ...(logger.debug as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ];
    expect(JSON.stringify(allCalls)).not.toContain(secret);
  });
});
