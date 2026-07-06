import type { HivlyConfig } from '@hivly/shared';
import type { Database } from '@hivly/shared/db';
import type { RedisClient } from '@hivly/shared/redis';
import { STREAM_KEYS } from '@hivly/shared/types/events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '../logger.js';
import { runIndexer } from './consumer.js';
import { indexBatch } from './indexBatch.js';
import type { Embedder } from './types.js';

// Isolate the loop mechanics from the batch pipeline: indexBatch is exercised by
// its own unit + integration tests; here we control exactly which ids it "acks".
vi.mock('./indexBatch.js', () => ({ indexBatch: vi.fn() }));

const config = {} as unknown as HivlyConfig;
const db = {} as unknown as Database;
const embedder = {} as unknown as Embedder;

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
      runIndexer({ redis, db, embedder, config, logger: makeLogger(), signal: controller.signal }),
    ).resolves.toBeUndefined();
  });

  it('should rethrow a non-BUSYGROUP group-create error', async () => {
    const controller = new AbortController();
    const { redis } = fakeRedis({
      groupCreate: () => Promise.reject(new Error('NOPERM insufficient permissions')),
      reads: [],
    });

    await expect(
      runIndexer({ redis, db, embedder, config, logger: makeLogger(), signal: controller.signal }),
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

    await runIndexer({ redis, db, embedder, config, logger: makeLogger(), signal: controller.signal });

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

    await runIndexer({ redis, db, embedder, config, logger: makeLogger(), signal: controller.signal });

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

    await runIndexer({ redis, db, embedder, config, logger: makeLogger(), signal: controller.signal });

    expect(acked).toEqual(['a', 'b']); // 'c' was not confirmed by indexBatch
  });

  it('should do no reads when already aborted before the loop', async () => {
    const controller = new AbortController();
    controller.abort();
    const { redis } = fakeRedis({ reads: [] });

    await runIndexer({ redis, db, embedder, config, logger: makeLogger(), signal: controller.signal });

    expect(redis.xReadGroup).not.toHaveBeenCalled();
  });
});
