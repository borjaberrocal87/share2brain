// Unit tests for the runOfflineSync orchestrator (AC-1, AC-2, AC-5, AC-7, AC-8):
// per-channel sequencing, null-cursor/disabled-channel skips, per-channel error
// isolation (no deletes on a failed re-fetch), abort at channel boundaries, the
// per-channel info summary, the publish path shape, and never logging content.
import type { HivlyConfig } from '@hivly/shared';
import type { Database } from '@hivly/shared/db';
import type { RedisClient } from '@hivly/shared/redis';
import type { Client } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getChannelCursor } from '../backfill/cursor.js';
import { handleMessageDelete } from '../discord/handlers/messageDelete.js';
import { handleMessageUpdate } from '../discord/handlers/messageUpdate.js';
import type { Logger } from '../logger.js';
import { runOfflineSync, type OfflineSyncDeps } from './offlineSync.js';
import type { FetchedMessage } from './reconcile.js';

vi.mock('../backfill/cursor.js', () => ({ getChannelCursor: vi.fn() }));
vi.mock('../discord/handlers/messageUpdate.js', () => ({ handleMessageUpdate: vi.fn() }));
vi.mock('../discord/handlers/messageDelete.js', () => ({ handleMessageDelete: vi.fn() }));

const getChannelCursorMock = vi.mocked(getChannelCursor);
const handleMessageUpdateMock = vi.mocked(handleMessageUpdate);
const handleMessageDeleteMock = vi.mocked(handleMessageDelete);

function fetchedMsg(id: string, overrides: Partial<FetchedMessage> = {}): FetchedMessage {
  return {
    id,
    channelId: 'chan-1',
    guildId: 'guild-1',
    content: `content ${id}`,
    editedAt: new Date('2026-07-01T00:00:00.000Z'),
    author: { id: 'user-1', bot: false, displayName: 'User One' },
    partial: false,
    fetch: () => Promise.resolve(fetchedMsg(id, overrides)),
    ...overrides,
  };
}

/** Discord-shaped fetch result: a Map (Collection extends Map), newest-first. */
function asFetchResult(messages: FetchedMessage[]): Map<string, FetchedMessage> {
  const desc = [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
  return new Map(desc.map((m) => [m.id, m]));
}

interface FakeChannel {
  isTextBased: () => boolean;
  messages: { fetch: ReturnType<typeof vi.fn> };
}

function textChannel(pages: FetchedMessage[][]): FakeChannel {
  const fetch = vi.fn();
  for (const page of pages) fetch.mockResolvedValueOnce(asFetchResult(page));
  fetch.mockResolvedValue(new Map());
  return { isTextBased: () => true, messages: { fetch } };
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeConfig(
  overrides: { channels?: Array<{ id: string; enabled: boolean }>; limit?: number } = {},
): HivlyConfig {
  return {
    discord: {
      guild_id: 'guild-1',
      channels: (overrides.channels ?? [{ id: 'chan-1', enabled: true }]).map((c) => ({
        ...c,
        name: c.id,
      })),
      backfill: { enabled: true, limit: overrides.limit ?? 1000, ignore_bots: true },
    },
  } as unknown as HivlyConfig;
}

function makeDb(rows: Array<Record<string, unknown>>): { db: Database; execute: ReturnType<typeof vi.fn> } {
  const execute = vi.fn().mockResolvedValue({ rows });
  return { db: { execute } as unknown as Database, execute };
}

function makeDeps(opts: {
  config?: HivlyConfig;
  channels?: Record<string, FakeChannel | Error>;
  dbRows?: Array<Record<string, unknown>>;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}): OfflineSyncDeps & { logger: Logger; execute: ReturnType<typeof vi.fn> } {
  const channels = opts.channels ?? {};
  const client = {
    channels: {
      fetch: vi.fn((id: string) => {
        const entry = channels[id];
        if (entry === undefined) return Promise.resolve(null);
        if (entry instanceof Error) return Promise.reject(entry);
        return Promise.resolve(entry);
      }),
    },
  } as unknown as Client;
  const logger = fakeLogger();
  const { db, execute } = makeDb(opts.dbRows ?? []);
  return {
    client,
    config: opts.config ?? makeConfig(),
    db,
    redis: {} as RedisClient,
    logger,
    signal: opts.signal ?? new AbortController().signal,
    sleep: opts.sleep ?? ((): Promise<void> => Promise.resolve()),
    execute,
  };
}

beforeEach(() => {
  getChannelCursorMock.mockReset();
  handleMessageUpdateMock.mockReset().mockResolvedValue(undefined);
  handleMessageDeleteMock.mockReset().mockResolvedValue(undefined);
});

describe('runOfflineSync', () => {
  it('should skip a channel with a null cursor, without touching the Discord API', async () => {
    getChannelCursorMock.mockResolvedValue(null);
    const channel = textChannel([[fetchedMsg('1')]]);
    const deps = makeDeps({ channels: { 'chan-1': channel } });

    await runOfflineSync(deps);

    expect(deps.client.channels.fetch).not.toHaveBeenCalled();
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('nothing to reconcile'),
      expect.objectContaining({ channelId: 'chan-1' }),
    );
  });

  it('should skip disabled channels entirely', async () => {
    const deps = makeDeps({
      config: makeConfig({ channels: [{ id: 'chan-1', enabled: false }] }),
      channels: {},
    });

    await runOfflineSync(deps);

    expect(getChannelCursorMock).not.toHaveBeenCalled();
    expect(deps.client.channels.fetch).not.toHaveBeenCalled();
  });

  it('should process channels sequentially — channel B is not fetched before channel A resolves', async () => {
    const order: string[] = [];
    getChannelCursorMock.mockImplementation(async (_db, channelId: string) => {
      order.push(`cursor:${channelId}`);
      return '10';
    });
    let resolveA: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const channelA = {
      isTextBased: () => true,
      messages: {
        fetch: vi.fn(async () => {
          order.push('fetch:chan-1');
          await gate;
          return new Map();
        }),
      },
    };
    const channelB = textChannel([[fetchedMsg('20', { channelId: 'chan-2' })]]);
    const deps = makeDeps({
      config: makeConfig({
        channels: [
          { id: 'chan-1', enabled: true },
          { id: 'chan-2', enabled: true },
        ],
      }),
      channels: { 'chan-1': channelA, 'chan-2': channelB },
    });

    const run = runOfflineSync(deps);
    // Give the event loop a tick — channel B's fetch must NOT have started yet.
    await new Promise((r) => setTimeout(r, 0));
    expect(channelB.messages.fetch).not.toHaveBeenCalled();
    resolveA?.();
    await run;

    expect(order).toEqual(['cursor:chan-1', 'fetch:chan-1', 'cursor:chan-2']);
    expect(channelB.messages.fetch).toHaveBeenCalled();
  });

  it('should isolate a per-channel failure: log error, continue to the next channel, publish nothing for the failed one', async () => {
    getChannelCursorMock.mockResolvedValue('10');
    const channelB = textChannel([[fetchedMsg('20', { channelId: 'chan-2', content: 'new' })]]);
    const deps = makeDeps({
      config: makeConfig({
        channels: [
          { id: 'chan-1', enabled: true },
          { id: 'chan-2', enabled: true },
        ],
      }),
      channels: { 'chan-1': new Error('Missing Access'), 'chan-2': channelB },
      dbRows: [{ id: '20', content: 'old' }],
    });

    await runOfflineSync(deps);

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('offline sync'),
      expect.objectContaining({ channelId: 'chan-1', error: 'Missing Access' }),
    );
    expect(handleMessageUpdateMock).toHaveBeenCalledTimes(1);
    expect(handleMessageDeleteMock).not.toHaveBeenCalled();
  });

  it('should stop cleanly at a channel boundary when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const channel = textChannel([[fetchedMsg('1')]]);
    const deps = makeDeps({
      config: makeConfig({
        channels: [
          { id: 'chan-1', enabled: true },
          { id: 'chan-2', enabled: true },
        ],
      }),
      channels: { 'chan-1': channel, 'chan-2': channel },
      signal: controller.signal,
    });

    await runOfflineSync(deps);

    expect(getChannelCursorMock).not.toHaveBeenCalled();
    expect(deps.client.channels.fetch).not.toHaveBeenCalled();
  });

  it('should publish an edit via handleMessageUpdate with the full fetched message', async () => {
    getChannelCursorMock.mockResolvedValue('10');
    const edited = fetchedMsg('10', { content: 'edited content' });
    const channel = textChannel([[edited]]);
    const deps = makeDeps({
      channels: { 'chan-1': channel },
      dbRows: [{ id: '10', content: 'original content' }],
    });

    await runOfflineSync(deps);

    expect(handleMessageUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: '10', content: 'edited content', partial: false }),
      expect.objectContaining({ config: deps.config, redis: deps.redis, logger: deps.logger }),
    );
  });

  it('should publish a delete via handleMessageDelete with { id, channelId, guildId }', async () => {
    getChannelCursorMock.mockResolvedValue('10');
    // Fetched window covers ids 8..10 (oldestFetchedId=8) — persisted id 9 is
    // absent from it, so it falls within the covered window -> deleted.
    const channel = textChannel([[fetchedMsg('8'), fetchedMsg('10')]]);
    const deps = makeDeps({
      channels: { 'chan-1': channel },
      dbRows: [
        { id: '8', content: 'content 8' },
        { id: '9', content: 'gone' },
        { id: '10', content: 'content 10' },
      ],
    });

    await runOfflineSync(deps);

    expect(handleMessageDeleteMock).toHaveBeenCalledWith(
      { id: '9', channelId: 'chan-1', guildId: 'guild-1' },
      expect.objectContaining({ config: deps.config, redis: deps.redis, logger: deps.logger }),
    );
  });

  it('should emit a per-channel info summary including windowCapped', async () => {
    getChannelCursorMock.mockResolvedValue('200');
    const fullPage = Array.from({ length: 100 }, (_, i) => fetchedMsg(String(i + 1)));
    const channel = textChannel([fullPage, [fetchedMsg('0')]]);
    const deps = makeDeps({
      config: makeConfig({ limit: 50 }),
      channels: { 'chan-1': channel },
      dbRows: [],
    });

    await runOfflineSync(deps);

    expect(deps.logger.info).toHaveBeenCalledWith(
      'offline sync channel done',
      expect.objectContaining({
        channelId: 'chan-1',
        editsPublished: 0,
        deletesPublished: 0,
        reconciled: 0,
        windowCapped: true,
      }),
    );
  });

  it('should NOT fire an extra page fetch when aborted during the inter-page throttle (AC-5)', async () => {
    getChannelCursorMock.mockResolvedValue('200');
    const controller = new AbortController();
    // A full first page (100) forces a second loop iteration; the injected sleep
    // aborts DURING the throttle (waitOrAbort resolves, never rejects), so the
    // post-throttle abort check must stop the walk BEFORE the second fetch.
    const fullPage = Array.from({ length: 100 }, (_, i) => fetchedMsg(String(i + 1)));
    const channel = textChannel([fullPage, [fetchedMsg('0')]]);
    const deps = makeDeps({
      channels: { 'chan-1': channel },
      dbRows: [{ id: '1', content: 'content 1' }],
      signal: controller.signal,
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    });

    await runOfflineSync(deps);

    expect(channel.messages.fetch).toHaveBeenCalledTimes(1);
    // No completion side effects on abort: persisted rows are never loaded and
    // nothing is published for the aborted walk.
    expect(deps.execute).not.toHaveBeenCalled();
    expect(handleMessageUpdateMock).not.toHaveBeenCalled();
    expect(handleMessageDeleteMock).not.toHaveBeenCalled();
  });

  it('should report windowCapped=true when a short final page overshoots the limit (AC-7)', async () => {
    getChannelCursorMock.mockResolvedValue('100');
    // A single short page (5 < 100) reaches head-of-history, but 5 > limit(3):
    // slice(0, limit) discards older messages, so the reconciled window is NOT
    // the full history and windowCapped must be true.
    const page = [
      fetchedMsg('5'),
      fetchedMsg('4'),
      fetchedMsg('3'),
      fetchedMsg('2'),
      fetchedMsg('1'),
    ];
    const channel = textChannel([page]);
    const deps = makeDeps({ config: makeConfig({ limit: 3 }), channels: { 'chan-1': channel }, dbRows: [] });

    await runOfflineSync(deps);

    expect(deps.logger.info).toHaveBeenCalledWith(
      'offline sync channel done',
      expect.objectContaining({ channelId: 'chan-1', windowCapped: true }),
    );
  });

  it('should report windowCapped=false when a short page fits fully within the limit (AC-7)', async () => {
    getChannelCursorMock.mockResolvedValue('100');
    const page = [fetchedMsg('3'), fetchedMsg('2'), fetchedMsg('1')];
    const channel = textChannel([page]);
    const deps = makeDeps({ config: makeConfig({ limit: 10 }), channels: { 'chan-1': channel }, dbRows: [] });

    await runOfflineSync(deps);

    expect(deps.logger.info).toHaveBeenCalledWith(
      'offline sync channel done',
      expect.objectContaining({ channelId: 'chan-1', windowCapped: false }),
    );
  });

  it('should never log message content', async () => {
    getChannelCursorMock.mockResolvedValue('10');
    const channel = textChannel([[fetchedMsg('10', { content: 'super secret edit' })]]);
    const deps = makeDeps({
      channels: { 'chan-1': channel },
      dbRows: [{ id: '10', content: 'super secret original' }],
    });

    await runOfflineSync(deps);

    const logger = deps.logger as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const allCalls = [
      ...logger.debug.mock.calls,
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ];
    expect(JSON.stringify(allCalls)).not.toContain('secret');
  });
});
