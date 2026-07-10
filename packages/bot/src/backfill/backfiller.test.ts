// Unit tests for the runBackfill orchestrator (AC-1…AC-6): path selection by
// cursor, live-parity guards, published-vs-skipped counting, inter-page throttle,
// per-channel failure isolation, abort semantics, and the completed event.
// discord.js is faked structurally; persistMessage is module-mocked so the tests
// observe the ingestion contract without a db.
import type { HivlyConfig } from '@hivly/shared';
import type { Database } from '@hivly/shared/db';
import type { RedisClient } from '@hivly/shared/redis';
import { STREAM_KEYS } from '@hivly/shared/types/events';
import type { Client } from 'discord.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runBackfill, type BackfillDeps } from './backfiller.js';
import type { Logger } from '../logger.js';
import { persistMessage, type IngestibleMessage } from '../persistence/persistMessage.js';

vi.mock('../persistence/persistMessage.js', () => ({
  persistMessage: vi.fn(),
}));
const persistMessageMock = vi.mocked(persistMessage);

interface FakeMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  content: string;
  createdAt: Date;
  editedAt: Date | null;
  author: { id: string; bot: boolean; displayName: string };
}

function msg(id: string, overrides: Partial<FakeMessage> = {}): FakeMessage {
  return {
    id,
    channelId: 'chan-1',
    guildId: 'guild-1',
    content: `content ${id}`,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    editedAt: null,
    author: { id: 'user-1', bot: false, displayName: 'User One' },
    ...overrides,
  };
}

/** Discord-shaped fetch result: a Map (Collection extends Map), newest-first. */
function asFetchResult(messages: FakeMessage[]): Map<string, FakeMessage> {
  const desc = [...messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
  return new Map(desc.map((m) => [m.id, m]));
}

interface FakeChannel {
  isTextBased: () => boolean;
  messages: { fetch: ReturnType<typeof vi.fn> };
}

function textChannel(pages: FakeMessage[][]): FakeChannel {
  const fetch = vi.fn();
  for (const page of pages) fetch.mockResolvedValueOnce(asFetchResult(page));
  fetch.mockResolvedValue(new Map());
  return { isTextBased: () => true, messages: { fetch } };
}

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeConfig(overrides: { channels?: Array<{ id: string; enabled: boolean }>; limit?: number; ignoreBots?: boolean } = {}): HivlyConfig {
  return {
    discord: {
      guild_id: 'guild-1',
      channels: (overrides.channels ?? [{ id: 'chan-1', enabled: true }]).map((c) => ({
        ...c,
        name: c.id,
      })),
      backfill: {
        enabled: true,
        limit: overrides.limit ?? 1000,
        ignore_bots: overrides.ignoreBots ?? true,
      },
    },
  } as unknown as HivlyConfig;
}

function makeDeps(opts: {
  config?: HivlyConfig;
  channels?: Record<string, FakeChannel | Error>;
  cursors?: Map<string, string | null>;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}): BackfillDeps & { xAdd: ReturnType<typeof vi.fn>; logger: Logger } {
  const xAdd = vi.fn().mockResolvedValue('1-0');
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
  return {
    client,
    config: opts.config ?? makeConfig(),
    db: {} as Database,
    redis: { xAdd } as unknown as RedisClient,
    logger,
    cursors: opts.cursors ?? new Map([['chan-1', null]]),
    signal: opts.signal ?? new AbortController().signal,
    sleep: opts.sleep ?? ((): Promise<void> => Promise.resolve()),
    xAdd,
  };
}

/** The messages actually handed to persistMessage, in call order. */
function persistedIds(): string[] {
  return persistMessageMock.mock.calls.map((c) => (c[0] as IngestibleMessage).id);
}

beforeEach(() => {
  persistMessageMock.mockReset();
  persistMessageMock.mockResolvedValue({ inserted: true });
});

describe('runBackfill', () => {
  it('should fetch forward from the cursor (gap path) when the channel has one', async () => {
    const channel = textChannel([[msg('11'), msg('12')]]);
    const deps = makeDeps({
      channels: { 'chan-1': channel },
      cursors: new Map([['chan-1', '10']]),
    });

    await runBackfill(deps);

    expect(channel.messages.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ after: '10', limit: 100, cache: false }),
    );
    expect(persistedIds()).toEqual(['11', '12']); // ascending — chronological inserts
  });

  it('should fetch the latest window (limit path) when the cursor is null', async () => {
    const channel = textChannel([[msg('1'), msg('2'), msg('3')]]);
    const deps = makeDeps({
      config: makeConfig({ limit: 2 }),
      channels: { 'chan-1': channel },
      cursors: new Map([['chan-1', null]]),
    });

    await runBackfill(deps);

    expect(channel.messages.fetch).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100, cache: false }),
    );
    // Newest 2 of 3, still processed oldest→newest.
    expect(persistedIds()).toEqual(['2', '3']);
  });

  it('should map fetched messages to the exact IngestibleMessage shape (incl. editedAt)', async () => {
    const editedAt = new Date('2026-07-02T00:00:00.000Z');
    const channel = textChannel([[msg('5', { editedAt })]]);
    const deps = makeDeps({ channels: { 'chan-1': channel } });

    await runBackfill(deps);

    expect(persistMessageMock).toHaveBeenCalledWith(
      {
        id: '5',
        channelId: 'chan-1',
        guildId: 'guild-1',
        content: 'content 5',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        editedAt,
        author: { id: 'user-1', bot: false, displayName: 'User One' },
      },
      expect.objectContaining({ db: deps.db, redis: deps.redis, config: deps.config }),
    );
  });

  it('should skip bot authors (when ignore_bots) and empty content at debug, without persisting', async () => {
    const channel = textChannel([
      [msg('1', { author: { id: 'bot-1', bot: true, displayName: 'Bot One' } }), msg('2', { content: '' }), msg('3')],
    ]);
    const deps = makeDeps({ channels: { 'chan-1': channel } });

    await runBackfill(deps);

    expect(persistedIds()).toEqual(['3']);
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('bot author'),
      expect.objectContaining({ channelId: 'chan-1' }),
    );
    expect(deps.logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('empty content'),
      expect.objectContaining({ messageId: '2' }),
    );
    // The live path's intent-warning must NOT fire for historical attachment-only messages.
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });

  it('should persist bot-authored history when ignore_bots is false', async () => {
    const channel = textChannel([[msg('1', { author: { id: 'bot-1', bot: true, displayName: 'Bot One' } })]]);
    const deps = makeDeps({
      config: makeConfig({ ignoreBots: false }),
      channels: { 'chan-1': channel },
    });

    await runBackfill(deps);

    expect(persistedIds()).toEqual(['1']);
  });

  it('should not count an already-persisted message (inserted=false) as published', async () => {
    const channel = textChannel([[msg('1'), msg('2')]]);
    persistMessageMock
      .mockResolvedValueOnce({ inserted: false }) // overlap at the cursor boundary
      .mockResolvedValueOnce({ inserted: true });
    const deps = makeDeps({ channels: { 'chan-1': channel } });

    await runBackfill(deps);

    const completed = deps.xAdd.mock.calls[0] as [string, string, Record<string, string>];
    expect(completed[2].messagesPublished).toBe('1');
  });

  it('should XADD the completed event to KNOWLEDGE_EVENTS with all-string fields', async () => {
    const channel = textChannel([[msg('1')]]);
    const deps = makeDeps({ channels: { 'chan-1': channel } });

    await runBackfill(deps);

    expect(deps.xAdd).toHaveBeenCalledTimes(1);
    const [key, id, fields] = deps.xAdd.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(key).toBe(STREAM_KEYS.KNOWLEDGE_EVENTS);
    expect(id).toBe('*');
    expect(fields).toEqual({
      type: 'discord.backfill.completed',
      guildId: 'guild-1',
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as unknown,
      channelsProcessed: '1',
      channelsFailed: '0',
      messagesPublished: '1',
      messagesFailed: '0',
    });
    for (const value of Object.values(fields)) {
      expect(typeof value).toBe('string'); // AD-13
    }
  });

  it('should retry a failed persist and count it as published once a later attempt succeeds', async () => {
    const channel = textChannel([[msg('1')]]);
    persistMessageMock
      .mockRejectedValueOnce(new Error('transient blip'))
      .mockResolvedValueOnce({ inserted: true });
    const deps = makeDeps({ channels: { 'chan-1': channel } });

    await runBackfill(deps);

    expect(persistMessageMock).toHaveBeenCalledTimes(2);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('retrying'),
      expect.objectContaining({ messageId: '1', attempt: 1 }),
    );
    const [, , fields] = deps.xAdd.mock.calls[0] as [string, string, Record<string, string>];
    expect(fields.messagesPublished).toBe('1');
    expect(fields.messagesFailed).toBe('0');
  });

  it('should give up after exhausting retries, count it as messagesFailed, and NOT abort the channel', async () => {
    const channel = textChannel([[msg('1'), msg('2')]]);
    persistMessageMock
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down')) // 3 attempts for msg 1, all fail
      .mockResolvedValueOnce({ inserted: true }); // msg 2 still gets processed
    const deps = makeDeps({ channels: { 'chan-1': channel } });

    await runBackfill(deps);

    expect(persistMessageMock).toHaveBeenCalledTimes(4);
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed after retries'),
      expect.objectContaining({ messageId: '1', attempts: 3 }),
    );
    const [, , fields] = deps.xAdd.mock.calls[0] as [string, string, Record<string, string>];
    expect(fields.messagesFailed).toBe('1');
    expect(fields.messagesPublished).toBe('1');
    expect(fields.channelsFailed).toBe('0');
    expect(fields.channelsProcessed).toBe('1');
  });

  it('should not log "backfill channel done" when the signal aborts mid-channel (bookkeeping guard)', async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockImplementation(() => {
      controller.abort(); // SIGTERM lands while the first page is in flight
      return Promise.resolve(asFetchResult([msg('1')]));
    });
    const channel = { isTextBased: () => true, messages: { fetch } };
    const deps = makeDeps({ channels: { 'chan-1': channel }, signal: controller.signal });

    await runBackfill(deps);

    expect(deps.logger.info).not.toHaveBeenCalledWith('backfill channel done', expect.anything());
  });

  it('should isolate a per-channel failure: log error, continue, and still emit the event', async () => {
    const good = textChannel([[msg('7', { channelId: 'chan-2' })]]);
    const deps = makeDeps({
      config: makeConfig({
        channels: [
          { id: 'chan-1', enabled: true },
          { id: 'chan-2', enabled: true },
        ],
      }),
      channels: { 'chan-1': new Error('Missing Access'), 'chan-2': good },
      cursors: new Map([
        ['chan-1', null],
        ['chan-2', null],
      ]),
    });

    await runBackfill(deps);

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('backfill'),
      expect.objectContaining({ channelId: 'chan-1', error: 'Missing Access' }),
    );
    expect(persistedIds()).toEqual(['7']); // the second channel still ran
    const [, , fields] = deps.xAdd.mock.calls[0] as [string, string, Record<string, string>];
    expect(fields.channelsProcessed).toBe('1');
    expect(fields.channelsFailed).toBe('1');
  });

  it('should treat a non-text-based or unknown channel as a per-channel failure', async () => {
    const notText = { isTextBased: () => false, messages: { fetch: vi.fn() } };
    const deps = makeDeps({
      config: makeConfig({
        channels: [
          { id: 'chan-1', enabled: true },
          { id: 'chan-2', enabled: true },
        ],
      }),
      channels: { 'chan-1': notText }, // chan-2 resolves to null (unknown)
      cursors: new Map([
        ['chan-1', null],
        ['chan-2', null],
      ]),
    });

    await runBackfill(deps);

    const [, , fields] = deps.xAdd.mock.calls[0] as [string, string, Record<string, string>];
    expect(fields.channelsProcessed).toBe('0');
    expect(fields.channelsFailed).toBe('2');
  });

  it('should skip a channel whose cursor failed to resolve, without touching the Discord API', async () => {
    const channel = textChannel([[msg('1')]]);
    const deps = makeDeps({
      channels: { 'chan-1': channel },
      cursors: new Map(), // no entry for 'chan-1' — cursor resolution failed pre-login
    });

    await runBackfill(deps);

    expect(channel.messages.fetch).not.toHaveBeenCalled();
    const [, , fields] = deps.xAdd.mock.calls[0] as [string, string, Record<string, string>];
    expect(fields.channelsFailed).toBe('1');
    expect(fields.channelsProcessed).toBe('0');
  });

  it('should skip disabled channels entirely', async () => {
    const channel = textChannel([[msg('1')]]);
    const deps = makeDeps({
      config: makeConfig({ channels: [{ id: 'chan-1', enabled: false }] }),
      channels: { 'chan-1': channel },
      cursors: new Map(),
    });

    await runBackfill(deps);

    expect(channel.messages.fetch).not.toHaveBeenCalled();
    const [, , fields] = deps.xAdd.mock.calls[0] as [string, string, Record<string, string>];
    expect(fields.channelsProcessed).toBe('0');
  });

  it('should sleep ≥1s between page fetches via the injected sleep', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fullPage = Array.from({ length: 100 }, (_, i) => msg(String(i + 11)));
    const channel = textChannel([fullPage, [msg('200')]]);
    const deps = makeDeps({
      channels: { 'chan-1': channel },
      cursors: new Map([['chan-1', '10']]),
      sleep,
    });

    await runBackfill(deps);

    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(channel.messages.fetch).toHaveBeenCalledTimes(2);
  });

  it('should stop cleanly and NOT publish the completed event when the signal aborts mid-run', async () => {
    const controller = new AbortController();
    const fetch = vi.fn().mockImplementation(() => {
      controller.abort(); // SIGTERM lands while the first page is in flight
      return Promise.resolve(asFetchResult([msg('1')]));
    });
    const channel = { isTextBased: () => true, messages: { fetch } };
    const deps = makeDeps({ channels: { 'chan-1': channel }, signal: controller.signal });

    await runBackfill(deps);

    expect(deps.xAdd).not.toHaveBeenCalled();
  });

  it('should do nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const channel = textChannel([[msg('1')]]);
    const deps = makeDeps({ channels: { 'chan-1': channel }, signal: controller.signal });

    await runBackfill(deps);

    expect(channel.messages.fetch).not.toHaveBeenCalled();
    expect(deps.xAdd).not.toHaveBeenCalled();
  });

  it('should never log full message content', async () => {
    const channel = textChannel([[msg('1', { content: 'super secret history' })]]);
    const deps = makeDeps({ channels: { 'chan-1': channel } });

    await runBackfill(deps);

    const logger = deps.logger as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const allCalls = [
      ...logger.debug.mock.calls,
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ];
    expect(JSON.stringify(allCalls)).not.toContain('super secret history');
  });
});
