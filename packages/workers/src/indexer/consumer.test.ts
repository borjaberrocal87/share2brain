import type { Share2BrainConfig } from '@share2brain/shared';
import type { Database } from '@share2brain/shared/db';
import type { RedisClient } from '@share2brain/shared/redis';
import { CONSUMER_GROUPS, STREAM_KEYS } from '@share2brain/shared/types/events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnrichmentChatModel } from '../enrichment/enrich.js';
import type { GuardedDispatcher } from '../enrichment/ssrfGuard.js';
import type { Logger } from '@share2brain/shared/logger';
import { reapPoisonEntries } from '../streams/poisonReaper.js';
import { runIndexer } from './consumer.js';
import { indexBatch } from './indexBatch.js';
import type { Embedder } from './types.js';

// Isolate the loop mechanics from the batch pipeline: indexBatch is exercised by
// its own unit + integration tests; here we control exactly which ids it "acks".
vi.mock('./indexBatch.js', () => ({ indexBatch: vi.fn() }));
// Same isolation for the reaper (own unit tests in streams/poisonReaper.test.ts);
// keep the real DEFAULT_REAP_INTERVAL_MS the loop imports.
vi.mock('../streams/poisonReaper.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../streams/poisonReaper.js')>()),
  reapPoisonEntries: vi.fn(),
}));

const config = {} as unknown as Share2BrainConfig;
const db = {} as unknown as Database;
const embedder = {} as unknown as Embedder;
const enrichModel = {} as unknown as EnrichmentChatModel;
const guard = {} as unknown as GuardedDispatcher;

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface StreamArg {
  key: string;
  id: string;
}

/** Build a fake node-redis client with scripted XREADGROUP responses. */
function fakeRedis(opts: {
  groupCreate?: () => Promise<string>;
  reads: Array<(streams: StreamArg) => unknown>;
}) {
  const acked: string[] = [];
  let readIdx = 0;
  const redis = {
    xGroupCreate: vi.fn(opts.groupCreate ?? (() => Promise.resolve('OK'))),
    xReadGroup: vi.fn((_group: string, _consumer: string, streams: StreamArg) => {
      const impl = opts.reads[readIdx++] ?? (() => null);
      return Promise.resolve(impl(streams));
    }),
    xAck: vi.fn((_key: string, _group: string, id: string) => {
      acked.push(id);
      return Promise.resolve(1);
    }),
    // Poison reaper (never triggers unless reapIntervalMs is set to 0 in a test).
    xPendingRange: vi.fn().mockResolvedValue([]),
    xAutoClaim: vi.fn().mockResolvedValue({ nextId: '0-0', messages: [], deletedMessages: [] }),
    xRange: vi.fn().mockResolvedValue([]),
    xAdd: vi.fn().mockResolvedValue('1-1'),
  } as unknown as RedisClient;
  return { redis, acked };
}

const STREAM = STREAM_KEYS.DISCORD_MESSAGES;
function batch(ids: string[]): unknown {
  return [{ name: STREAM, messages: ids.map((id) => ({ id, message: { messageId: id } })) }];
}

beforeEach(() => {
  vi.mocked(indexBatch).mockReset();
  vi.mocked(indexBatch).mockResolvedValue({ ackIds: [] });
  vi.mocked(reapPoisonEntries).mockReset();
  vi.mocked(reapPoisonEntries).mockResolvedValue([]); // no reclaimed entries unless a test says so
});

describe('runIndexer', () => {
  it('should tolerate a BUSYGROUP rejection on group creation', async () => {
    const controller = new AbortController();
    const { redis } = fakeRedis({
      groupCreate: () => Promise.reject(new Error('BUSYGROUP Consumer Group name already exists')),
      reads: [
        () => null, // replay: nothing pending → break
        () => {
          controller.abort();
          return null; // live: abort then timeout → exit
        },
      ],
    });

    await expect(
      runIndexer({ redis, db, embedder, config, logger: makeLogger(), enrichModel, guard, signal: controller.signal }),
    ).resolves.toBeUndefined();
  });

  it('should rethrow a non-BUSYGROUP group-create error', async () => {
    const controller = new AbortController();
    const { redis } = fakeRedis({
      groupCreate: () => Promise.reject(new Error('NOPERM insufficient permissions')),
      reads: [],
    });

    await expect(
      runIndexer({ redis, db, embedder, config, logger: makeLogger(), enrichModel, guard, signal: controller.signal }),
    ).rejects.toThrow('NOPERM');
  });

  it('should replay pending entries, advance the id past each batch, and stop on empty', async () => {
    const controller = new AbortController();
    vi.mocked(indexBatch).mockResolvedValueOnce({ ackIds: ['1-0'] });
    const seenReplayIds: string[] = [];
    const { redis, acked } = fakeRedis({
      reads: [
        (s) => {
          seenReplayIds.push(s.id);
          return batch(['1-0']);
        },
        (s) => {
          seenReplayIds.push(s.id);
          return batch([]); // empty → break replay
        },
        () => {
          controller.abort();
          return null; // live → exit
        },
      ],
    });

    await runIndexer({ redis, db, embedder, config, logger: makeLogger(), enrichModel, guard, signal: controller.signal });

    expect(seenReplayIds).toEqual(['0', '1-0']); // advanced past the first batch
    expect(acked).toEqual(['1-0']);
  });

  it('should loop on a null (BLOCK-timeout) live read and exit on abort', async () => {
    const controller = new AbortController();
    let liveCalls = 0;
    const { redis } = fakeRedis({
      reads: [
        () => null, // replay empty → break
        () => {
          liveCalls++;
          return null; // live timeout #1 → continue
        },
        () => {
          liveCalls++;
          controller.abort();
          return null; // live timeout #2 → abort
        },
      ],
    });

    await runIndexer({ redis, db, embedder, config, logger: makeLogger(), enrichModel, guard, signal: controller.signal });

    expect(liveCalls).toBe(2);
    expect(indexBatch).not.toHaveBeenCalled();
  });

  it('should XACK only the ids indexBatch returns', async () => {
    const controller = new AbortController();
    vi.mocked(indexBatch).mockResolvedValueOnce({ ackIds: ['a', 'b'] });
    const { redis, acked } = fakeRedis({
      reads: [
        () => null, // replay empty → break
        () => batch(['a', 'b', 'c']), // live batch of 3
        () => {
          controller.abort();
          return null;
        },
      ],
    });

    await runIndexer({ redis, db, embedder, config, logger: makeLogger(), enrichModel, guard, signal: controller.signal });

    expect(acked).toEqual(['a', 'b']); // 'c' was not confirmed by indexBatch
  });

  it('should reap the PEL between live reads and re-index whatever it reclaims', async () => {
    const controller = new AbortController();
    // reapPoisonEntries is mocked (its own dead-letter/reclaim logic is covered
    // in streams/poisonReaper.test.ts); here we only assert the loop invokes it
    // and drives the reclaimed entries back through indexBatch + XACK.
    vi.mocked(reapPoisonEntries).mockResolvedValueOnce([{ id: 'reclaimed-1', message: { messageId: 'r1' } }]);
    vi.mocked(indexBatch).mockResolvedValueOnce({ ackIds: ['reclaimed-1'] });
    const { redis, acked } = fakeRedis({
      reads: [
        () => null, // replay empty → break
        () => null, // live BLOCK timeout; reap already fired at the top of this iteration
        () => {
          controller.abort();
          return null;
        },
      ],
    });

    await runIndexer({
      redis,
      db,
      embedder,
      config,
      logger: makeLogger(),
      enrichModel,
      guard,
      signal: controller.signal,
      reapIntervalMs: 0, // reap on the very first live iteration
    });

    expect(reapPoisonEntries).toHaveBeenCalledWith(
      expect.objectContaining({ stream: STREAM, group: CONSUMER_GROUPS.INDEXER, consumer: 'consumer-1' }),
    );
    expect(indexBatch).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [{ id: 'reclaimed-1', message: { messageId: 'r1' } }] }),
    );
    expect(acked).toContain('reclaimed-1'); // reclaimed entry re-indexed then acked
  });

  it('should do no reads when already aborted before the loop', async () => {
    const controller = new AbortController();
    controller.abort();
    const { redis } = fakeRedis({ reads: [] });

    await runIndexer({ redis, db, embedder, config, logger: makeLogger(), enrichModel, guard, signal: controller.signal });

    expect(redis.xReadGroup).not.toHaveBeenCalled();
  });
});
