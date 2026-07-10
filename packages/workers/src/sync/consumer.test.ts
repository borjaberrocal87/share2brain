import type { Share2BrainConfig } from '@share2brain/shared';
import type { Database } from '@share2brain/shared/db';
import type { RedisClient } from '@share2brain/shared/redis';
import { STREAM_KEYS } from '@share2brain/shared/types/events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnrichmentChatModel } from '../enrichment/enrich.js';
import type { GuardedDispatcher } from '../enrichment/ssrfGuard.js';
import type { Embedder } from '../indexer/types.js';
import type { Logger } from '../logger.js';
import { runSync as runSyncImpl } from './consumer.js';
import { processDelete } from './processDelete.js';
import { processUpdate } from './processUpdate.js';

// runSync now takes one dedicated client per loop (updated/deleted). The fake
// redis below routes reads by stream key, so a single fake stands in for both
// clients — map the one `redis` onto both to keep the call sites focused.
// processUpdate/processDelete are mocked below, so enrichModel/guard are never
// actually invoked — fixed fakes just satisfy RunSyncDeps' shape (AC-7).
const enrichModel = {} as unknown as EnrichmentChatModel;
const guard = {} as unknown as GuardedDispatcher;

function runSync(deps: {
  redis: RedisClient;
  db: Database;
  embedder: Embedder;
  config: Share2BrainConfig;
  logger: Logger;
  signal: AbortSignal;
}) {
  const { redis, ...rest } = deps;
  return runSyncImpl({ redisUpdated: redis, redisDeleted: redis, enrichModel, guard, ...rest });
}

// Isolate the loop mechanics from the processors: processUpdate/processDelete
// are exercised by their own unit tests; here we control exactly what they
// "ack" and assert the loop dispatches/XACKs correctly.
vi.mock('./processUpdate.js', () => ({ processUpdate: vi.fn() }));
vi.mock('./processDelete.js', () => ({ processDelete: vi.fn() }));

const config = {} as unknown as Share2BrainConfig;
const db = {} as unknown as Database;
const embedder = {} as unknown as Embedder;

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const UPDATED_STREAM = STREAM_KEYS.DISCORD_MESSAGES_UPDATED;
const DELETED_STREAM = STREAM_KEYS.DISCORD_MESSAGES_DELETED;

interface StreamArg {
  key: string;
  id: string;
}

/** Build a fake node-redis client whose XREADGROUP responses are scripted
 *  PER STREAM — the two Sync loops run concurrently against different keys.
 *  Once a stream's scripted queue is exhausted it returns `null` (BLOCK
 *  timeout) forever, so a loop never hangs waiting for more script. */
function fakeRedis(opts: {
  groupCreate?: (stream: string) => Promise<string>;
  reads: Record<string, Array<(streams: StreamArg) => unknown>>;
}) {
  const acked: Array<{ stream: string; id: string }> = [];
  const readIdx: Record<string, number> = {};
  const redis = {
    xGroupCreate: vi.fn((stream: string) =>
      (opts.groupCreate ?? (() => Promise.resolve('OK')))(stream),
    ),
    xReadGroup: vi.fn((_group: string, _consumer: string, streams: StreamArg) => {
      const queue = opts.reads[streams.key] ?? [];
      const i = readIdx[streams.key] ?? 0;
      readIdx[streams.key] = i + 1;
      const impl = queue[i] ?? (() => null);
      return Promise.resolve(impl(streams));
    }),
    xAck: vi.fn((stream: string, _group: string, id: string) => {
      acked.push({ stream, id });
      return Promise.resolve(1);
    }),
  } as unknown as RedisClient;
  return { redis, acked };
}

function batch(stream: string, entries: Array<{ id: string; message: Record<string, string> }>): unknown {
  return [{ name: stream, messages: entries }];
}

beforeEach(() => {
  vi.mocked(processUpdate).mockReset();
  vi.mocked(processDelete).mockReset();
  vi.mocked(processUpdate).mockResolvedValue({ ack: true });
  vi.mocked(processDelete).mockResolvedValue({ ack: true });
});

describe('runSync', () => {
  it('should create the consumer group on both streams, tolerating BUSYGROUP', async () => {
    const controller = new AbortController();
    const seenStreams: string[] = [];
    const { redis } = fakeRedis({
      groupCreate: (stream) => {
        seenStreams.push(stream);
        return stream === UPDATED_STREAM
          ? Promise.reject(new Error('BUSYGROUP Consumer Group name already exists'))
          : Promise.resolve('OK');
      },
      reads: {
        [UPDATED_STREAM]: [
          () => null,
          () => {
            controller.abort();
            return null;
          },
        ],
        [DELETED_STREAM]: [() => null],
      },
    });

    await runSync({ redis, db, embedder, config, logger: makeLogger(), signal: controller.signal });

    expect(seenStreams.sort()).toEqual([DELETED_STREAM, UPDATED_STREAM].sort());
  });

  it('should replay pending entries on both streams, dispatch to the right processor, and ack only on {ack:true}', async () => {
    const controller = new AbortController();
    vi.mocked(processUpdate).mockResolvedValueOnce({ ack: true });
    vi.mocked(processDelete).mockResolvedValueOnce({ ack: false });

    const { redis, acked } = fakeRedis({
      reads: {
        [UPDATED_STREAM]: [
          () =>
            batch(UPDATED_STREAM, [
              {
                id: '1-0',
                message: {
                  type: 'discord.message.updated',
                  messageId: 'm1',
                  channelId: 'c1',
                  guildId: 'g1',
                  timestamp: 't',
                  newContent: 'x',
                },
              },
            ]),
          () => batch(UPDATED_STREAM, []), // empty → break replay
          () => {
            controller.abort();
            return null;
          },
        ],
        [DELETED_STREAM]: [
          () =>
            batch(DELETED_STREAM, [
              {
                id: '2-0',
                message: {
                  type: 'discord.message.deleted',
                  messageId: 'm2',
                  channelId: 'c2',
                  guildId: 'g1',
                  timestamp: 't',
                },
              },
            ]),
          () => batch(DELETED_STREAM, []),
        ],
      },
    });

    await runSync({ redis, db, embedder, config, logger: makeLogger(), signal: controller.signal });

    expect(processUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ event: expect.objectContaining({ messageId: 'm1' }) }),
    );
    expect(processDelete).toHaveBeenCalledWith(
      expect.objectContaining({ event: expect.objectContaining({ messageId: 'm2' }) }),
    );
    expect(acked).toContainEqual({ stream: UPDATED_STREAM, id: '1-0' });
    expect(acked).not.toContainEqual({ stream: DELETED_STREAM, id: '2-0' }); // ack:false stays pending
  });

  it('should ack + warn (not dispatch) a malformed/foreign entry', async () => {
    const controller = new AbortController();
    const { redis, acked } = fakeRedis({
      reads: {
        [UPDATED_STREAM]: [
          () => batch(UPDATED_STREAM, [{ id: '1-0', message: { type: 'discord.message.created' } }]),
          () => batch(UPDATED_STREAM, []),
          () => {
            controller.abort();
            return null;
          },
        ],
        [DELETED_STREAM]: [() => null],
      },
    });
    const logger = makeLogger();

    await runSync({ redis, db, embedder, config, logger, signal: controller.signal });

    expect(processUpdate).not.toHaveBeenCalled();
    expect(acked).toContainEqual({ stream: UPDATED_STREAM, id: '1-0' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('malformed'),
      expect.objectContaining({ streamId: '1-0' }),
    );
  });

  it('should ack + warn a tombstoned (null message) PEL entry instead of dispatching', async () => {
    const controller = new AbortController();
    const { redis, acked } = fakeRedis({
      reads: {
        [DELETED_STREAM]: [
          () => batch(DELETED_STREAM, [{ id: '2-0', message: null as unknown as Record<string, string> }]),
          () => batch(DELETED_STREAM, []),
          () => {
            controller.abort();
            return null;
          },
        ],
        [UPDATED_STREAM]: [() => null],
      },
    });
    const logger = makeLogger();

    await runSync({ redis, db, embedder, config, logger, signal: controller.signal });

    expect(processDelete).not.toHaveBeenCalled();
    expect(acked).toContainEqual({ stream: DELETED_STREAM, id: '2-0' });
  });

  it('should isolate a throwing processor — the entry stays pending and the loop continues', async () => {
    const controller = new AbortController();
    vi.mocked(processUpdate).mockRejectedValueOnce(new Error('boom'));
    const { redis, acked } = fakeRedis({
      reads: {
        [UPDATED_STREAM]: [
          () =>
            batch(UPDATED_STREAM, [
              {
                id: '1-0',
                message: {
                  type: 'discord.message.updated',
                  messageId: 'm1',
                  channelId: 'c1',
                  guildId: 'g1',
                  timestamp: 't',
                  newContent: 'x',
                },
              },
            ]),
          () => batch(UPDATED_STREAM, []),
          () => {
            controller.abort();
            return null;
          },
        ],
        [DELETED_STREAM]: [() => null],
      },
    });
    const logger = makeLogger();

    await runSync({ redis, db, embedder, config, logger, signal: controller.signal });

    expect(acked).not.toContainEqual({ stream: UPDATED_STREAM, id: '1-0' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('unhandled error'),
      expect.objectContaining({ streamId: '1-0', messageId: 'm1' }),
    );
  });

  it('should do no reads on either stream when already aborted before the loop', async () => {
    const controller = new AbortController();
    controller.abort();
    const { redis } = fakeRedis({ reads: {} });

    await runSync({ redis, db, embedder, config, logger: makeLogger(), signal: controller.signal });

    expect(redis.xReadGroup).not.toHaveBeenCalled();
  });

  it('should never log message content in any log context', async () => {
    const controller = new AbortController();
    const secret = 'super secret edited content';
    vi.mocked(processUpdate).mockRejectedValueOnce(new Error('boom'));
    const { redis } = fakeRedis({
      reads: {
        [UPDATED_STREAM]: [
          () =>
            batch(UPDATED_STREAM, [
              {
                id: '1-0',
                message: {
                  type: 'discord.message.updated',
                  messageId: 'm1',
                  channelId: 'c1',
                  guildId: 'g1',
                  timestamp: 't',
                  newContent: secret,
                },
              },
            ]),
          () => batch(UPDATED_STREAM, []),
          () => {
            controller.abort();
            return null;
          },
        ],
        [DELETED_STREAM]: [() => null],
      },
    });
    const logger = makeLogger();

    await runSync({ redis, db, embedder, config, logger, signal: controller.signal });

    const allCalls = [
      ...(logger.debug as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ];
    expect(JSON.stringify(allCalls)).not.toContain(secret);
  });
});
