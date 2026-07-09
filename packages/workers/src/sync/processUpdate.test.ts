import type { HivlyConfig } from '@hivly/shared';
import type { Database } from '@hivly/shared/db';
import type { MessageUpdatedEvent } from '@hivly/shared/types/events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { enrich } from '../enrichment/enrich.js';
import type { GuardedDispatcher } from '../enrichment/ssrfGuard.js';
import { fetchUrl } from '../enrichment/urlFetcher.js';
import type { Embedder } from '../indexer/types.js';
import type { Logger } from '../logger.js';
import { processUpdate as processUpdateImpl, type ProcessUpdateDeps } from './processUpdate.js';

vi.mock('../enrichment/urlFetcher.js', () => ({ fetchUrl: vi.fn() }));
vi.mock('../enrichment/enrich.js', async () => {
  const actual = await vi.importActual<typeof import('../enrichment/enrich.js')>('../enrichment/enrich.js');
  return { ...actual, enrich: vi.fn() };
});

// The consumer always supplies streamId/stream/enrichModel/guard/signal (AC-4,
// AC-7); inject fixed values so the call sites below stay focused on
// event/db/embedder behavior.
const STREAM = 'hivly:discord:messages:updated';
const enrichModel = {} as unknown as import('../enrichment/enrich.js').EnrichmentChatModel;
const guard = {} as unknown as GuardedDispatcher;

function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal;
}

function processUpdate(
  deps: Omit<ProcessUpdateDeps, 'streamId' | 'stream' | 'enrichModel' | 'guard' | 'signal'>,
) {
  return processUpdateImpl({ ...deps, streamId: 's1', stream: STREAM, enrichModel, guard, signal: neverAbortedSignal() });
}

const DIMENSIONS = 4;

const config = {
  embeddings: { dimensions: DIMENSIONS },
  enrichment: {
    language: 'en',
    fetch: {
      timeout_ms: 5000,
      max_bytes: 2_000_000,
      max_redirects: 3,
      user_agent: 'HivlyTest/1.0',
      allowed_schemes: ['https'],
      block_private_ips: true,
    },
  },
} as unknown as HivlyConfig;

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Deterministic embedder: throws on "BOOM", returns a wrong-width vector on
 *  "WRONGDIM", otherwise a valid DIMENSIONS-length vector per input text. */
const embedder: Embedder = {
  embedDocuments: (texts: string[]) => {
    if (texts.some((t) => t.includes('BOOM'))) throw new Error('embed exploded');
    if (texts.some((t) => t.includes('WRONGDIM'))) {
      return Promise.resolve(texts.map(() => [0.1, 0.2])); // length 2 ≠ DIMENSIONS
    }
    return Promise.resolve(texts.map(() => [0.1, 0.2, 0.3, 0.4]));
  },
};

interface InsertedRow {
  chunkKey: string;
  title: string;
  description: string;
  link: string;
  embedding: number[];
  channelId: string;
  messageIds: string[];
}

interface OldRow {
  id: string;
  chunkKey: string;
  link: string;
  title: string;
  description: string;
  embedding: number[];
}

/** Extract the literal text of a drizzle `sql` tagged-template value (params
 *  inlined) so tests can assert on statement shape without real SQL parsing. */
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks: unknown[] }).queryChunks;
  return chunks
    .map((c) =>
      c !== null && typeof c === 'object' && 'value' in (c as { value: unknown })
        ? (c as { value: string[] }).value.join('')
        : String(c),
    )
    .join('');
}

/** A fake Drizzle db. The FIRST `select` call is the existence/tombstone
 *  guard (`discord_messages`); the SECOND is the old-rows diff select
 *  (`embeddings`) — both are positional per `processUpdate`'s fixed call
 *  order. `transaction` records every `execute`d statement (in order) and
 *  every `insert`ed embeddings row. */
function makeFakeDb(opts: {
  existing: boolean;
  deletedAt?: Date | null;
  oldRows?: OldRow[];
}) {
  const executeLog: string[] = [];
  const inserted: InsertedRow[] = [];
  let transactionCount = 0;
  let selectCall = 0;

  const db = {
    select: () => {
      const callIndex = selectCall++;
      return {
        from: () => ({
          where: () => {
            if (callIndex === 0) {
              return Promise.resolve(
                opts.existing ? [{ id: 'm1', deletedAt: opts.deletedAt ?? null }] : [],
              );
            }
            return Promise.resolve(opts.oldRows ?? []);
          },
        }),
      };
    },
    transaction: async (cb: (tx: unknown) => Promise<void>) => {
      transactionCount++;
      const tx = {
        execute: (q: unknown) => {
          executeLog.push(sqlText(q));
          return Promise.resolve({ rows: [] });
        },
        insert: () => ({
          values: (v: InsertedRow) => {
            inserted.push(v);
            return { onConflictDoUpdate: () => Promise.resolve() };
          },
        }),
      };
      await cb(tx);
    },
  } as unknown as Database;

  return { db, executeLog, inserted, transactionCount: () => transactionCount };
}

function updatedEvent(overrides: Partial<MessageUpdatedEvent> = {}): MessageUpdatedEvent {
  return {
    type: 'discord.message.updated',
    messageId: 'm1',
    channelId: 'c1',
    guildId: 'g1',
    timestamp: '2026-07-08T10:00:00.000Z',
    newContent: 'edited content',
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(fetchUrl).mockReset();
  vi.mocked(enrich).mockReset();
  vi.mocked(fetchUrl).mockImplementation(async (url: string) =>
    Promise.resolve({ ok: true, body: '<html></html>', contentType: 'text/html', finalUrl: url }),
  );
  vi.mocked(enrich).mockImplementation(async (_model, input: { messageText: string }) =>
    Promise.resolve({ title: `Title for ${input.messageText}`, description: 'A description' }),
  );
});

describe('processUpdate', () => {
  it('should skip an update for an unknown message with no writes and ack', async () => {
    const logger = makeLogger();
    const { db, transactionCount } = makeFakeDb({ existing: false });

    const result = await processUpdate({
      event: updatedEvent({ newContent: 'https://a.com' }),
      db,
      embedder,
      config,
      logger,
    });

    expect(result).toEqual({ ack: true });
    expect(transactionCount()).toBe(0);
    expect(fetchUrl).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('unknown message'),
      expect.objectContaining({ messageId: 'm1' }),
    );
  });

  it('should skip a tombstoned message (deleted_at set) with no writes and ack (D2)', async () => {
    const logger = makeLogger();
    const { db, transactionCount } = makeFakeDb({ existing: true, deletedAt: new Date() });

    const result = await processUpdate({
      event: updatedEvent({ newContent: 'https://a.com' }),
      db,
      embedder,
      config,
      logger,
    });

    expect(result).toEqual({ ack: true });
    expect(transactionCount()).toBe(0);
    expect(fetchUrl).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('tombstoned'),
      expect.objectContaining({ messageId: 'm1' }),
    );
  });

  it('should insert a fresh row for an added link (no old rows)', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb({ existing: true, oldRows: [] });

    const result = await processUpdate({
      event: updatedEvent({ newContent: 'see https://a.com' }),
      db,
      embedder,
      config,
      logger,
    });

    expect(result).toEqual({ ack: true });
    expect(fetchUrl).toHaveBeenCalledTimes(1);
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].chunkKey).toBe('m1:0');
    expect(inserted[0].link).toBe('https://a.com/');
    expect(inserted[0].embedding).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('should reuse a kept link without fetching/enriching/embedding it', async () => {
    const logger = makeLogger();
    const oldEmbedding = [0.9, 0.8, 0.7, 0.6];
    const { db, inserted } = makeFakeDb({
      existing: true,
      oldRows: [
        {
          id: 'old-1',
          chunkKey: 'm1:0',
          link: 'https://a.com/',
          title: 'Old Title',
          description: 'Old Description',
          embedding: oldEmbedding,
        },
      ],
    });

    const result = await processUpdate({
      event: updatedEvent({ newContent: 'see https://a.com' }),
      db,
      embedder,
      config,
      logger,
    });

    expect(result).toEqual({ ack: true });
    expect(fetchUrl).not.toHaveBeenCalled();
    expect(enrich).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      chunkKey: 'm1:0',
      title: 'Old Title',
      description: 'Old Description',
      link: 'https://a.com/',
      embedding: oldEmbedding, // round-tripped identically, not recomputed
    });
  });

  it('should purge a removed link with no replacement (zero new URLs)', async () => {
    const logger = makeLogger();
    const { db, inserted, executeLog } = makeFakeDb({
      existing: true,
      oldRows: [
        {
          id: 'old-1',
          chunkKey: 'm1:0',
          link: 'https://old.com/',
          title: 'Old Title',
          description: 'Old Description',
          embedding: [0.1, 0.1, 0.1, 0.1],
        },
      ],
    });

    const result = await processUpdate({
      event: updatedEvent({ newContent: 'no links here anymore' }),
      db,
      embedder,
      config,
      logger,
    });

    expect(result).toEqual({ ack: true });
    expect(inserted).toHaveLength(0);
    expect(executeLog.some((s) => s.includes('DELETE FROM embeddings'))).toBe(true);
    expect(executeLog.some((s) => s.includes('indexed_at'))).toBe(true);
  });

  it('should reorder kept links to their new chunk_key positions', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb({
      existing: true,
      oldRows: [
        {
          id: 'old-a',
          chunkKey: 'm1:0',
          link: 'https://a.com/',
          title: 'A Title',
          description: 'A Desc',
          embedding: [1, 1, 1, 1],
        },
        {
          id: 'old-b',
          chunkKey: 'm1:1',
          link: 'https://b.com/',
          title: 'B Title',
          description: 'B Desc',
          embedding: [2, 2, 2, 2],
        },
      ],
    });

    const result = await processUpdate({
      event: updatedEvent({ newContent: 'https://b.com then https://a.com' }),
      db,
      embedder,
      config,
      logger,
    });

    expect(result).toEqual({ ack: true });
    expect(fetchUrl).not.toHaveBeenCalled();
    const byLink = new Map(inserted.map((r) => [r.link, r]));
    expect(byLink.get('https://b.com/')?.chunkKey).toBe('m1:0'); // new position
    expect(byLink.get('https://a.com/')?.chunkKey).toBe('m1:1'); // new position
  });

  it('should treat a message previously discarded (no old rows) whose edit adds a URL as late index entry', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb({ existing: true, oldRows: [] });

    const result = await processUpdate({
      event: updatedEvent({ newContent: 'now with a link https://late.com' }),
      db,
      embedder,
      config,
      logger,
    });

    expect(result).toEqual({ ack: true });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].link).toBe('https://late.com/');
  });

  it('should purge all rows on a blank-content edit (F3)', async () => {
    const logger = makeLogger();
    const { db, inserted, executeLog } = makeFakeDb({
      existing: true,
      oldRows: [
        {
          id: 'old-1',
          chunkKey: 'm1:0',
          link: 'https://old.com/',
          title: 'Old',
          description: 'Old',
          embedding: [0, 0, 0, 0],
        },
      ],
    });

    const result = await processUpdate({
      event: updatedEvent({ newContent: '' }),
      db,
      embedder,
      config,
      logger,
    });

    expect(result).toEqual({ ack: true });
    expect(inserted).toHaveLength(0);
    expect(executeLog.some((s) => s.includes('DELETE FROM embeddings'))).toBe(true);
  });

  it('should purge all rows when every link is SSRF-blocked (F3)', async () => {
    vi.mocked(fetchUrl).mockResolvedValue({ ok: false, reason: 'ssrf_blocked' });
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb({
      existing: true,
      oldRows: [
        {
          id: 'old-1',
          chunkKey: 'm1:0',
          link: 'https://old.com/',
          title: 'Old',
          description: 'Old',
          embedding: [0, 0, 0, 0],
        },
      ],
    });

    const result = await processUpdate({
      event: updatedEvent({ newContent: 'https://blocked.com' }),
      db,
      embedder,
      config,
      logger,
    });

    expect(result).toEqual({ ack: true });
    expect(inserted).toHaveLength(0);
  });

  it('should delete read-status before embeddings (FK RESTRICT order)', async () => {
    const logger = makeLogger();
    const { db, executeLog } = makeFakeDb({ existing: true, oldRows: [] });

    await processUpdate({ event: updatedEvent({ newContent: 'no links' }), db, embedder, config, logger });

    const readStatusIdx = executeLog.findIndex((s) => s.includes('DELETE FROM user_read_status'));
    const embeddingsIdx = executeLog.findIndex((s) => s.includes('DELETE FROM embeddings'));
    expect(readStatusIdx).toBeGreaterThanOrEqual(0);
    expect(embeddingsIdx).toBeGreaterThan(readStatusIdx);
  });

  it('should refresh discord_messages.content and updated_at', async () => {
    const logger = makeLogger();
    const { db, executeLog } = makeFakeDb({ existing: true, oldRows: [] });

    await processUpdate({
      event: updatedEvent({ newContent: 'brand new text', timestamp: '2026-07-08T12:00:00.000Z' }),
      db,
      embedder,
      config,
      logger,
    });

    const refresh = executeLog.find(
      (s) => s.includes('UPDATE discord_messages') && s.includes('content'),
    );
    expect(refresh).toBeDefined();
    expect(refresh).toContain('brand new text');
    expect(refresh).toContain('2026-07-08T12:00:00.000Z');
  });

  it('should stamp indexed_at', async () => {
    const logger = makeLogger();
    const { db, executeLog } = makeFakeDb({ existing: true, oldRows: [] });

    await processUpdate({ event: updatedEvent({ newContent: 'https://a.com' }), db, embedder, config, logger });

    expect(executeLog.some((s) => s.includes('indexed_at'))).toBe(true);
  });

  it('should cap URLs at 20 for an edit, processing the first N and warning about the rest', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb({ existing: true, oldRows: [] });
    const urls = Array.from({ length: 25 }, (_, i) => `https://ex.com/${i}`);

    const result = await processUpdate({
      event: updatedEvent({ newContent: urls.join(' ') }),
      db,
      embedder,
      config,
      logger,
    });

    expect(result).toEqual({ ack: true });
    expect(inserted).toHaveLength(20);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('URL cap'),
      expect.objectContaining({ extracted: 25, cap: 20, dropped: 5 }),
    );
  });

  it('should not ack and leave the entry pending when enrichment (LLM) fails', async () => {
    vi.mocked(enrich).mockRejectedValue(new Error('LLM provider down'));
    const logger = makeLogger();
    const { db, inserted, transactionCount } = makeFakeDb({ existing: true, oldRows: [] });

    const result = await processUpdate({
      event: updatedEvent({ newContent: 'https://a.com' }),
      db,
      embedder,
      config,
      logger,
    });

    expect(result).toEqual({ ack: false });
    expect(inserted).toHaveLength(0);
    expect(transactionCount()).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to process message update'),
      expect.objectContaining({ messageId: 'm1', streamId: 's1', stream: STREAM }),
    );
  });

  it('should not ack on an embedder throw (BOOM)', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb({ existing: true, oldRows: [] });

    const result = await processUpdate({
      event: updatedEvent({ newContent: 'this will BOOM https://a.com' }),
      db,
      embedder,
      config,
      logger,
    });

    expect(result).toEqual({ ack: false });
    expect(inserted).toHaveLength(0);
  });

  it('should not ack on an embedding dimension mismatch (WRONGDIM)', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb({ existing: true, oldRows: [] });

    const result = await processUpdate({
      event: updatedEvent({ newContent: 'WRONGDIM content https://a.com' }),
      db,
      embedder,
      config,
      logger,
    });

    expect(result).toEqual({ ack: false });
    expect(inserted).toHaveLength(0);
  });

  it('should never log the message content in any log context', async () => {
    const logger = makeLogger();
    const { db } = makeFakeDb({ existing: true, oldRows: [] });
    const secret = 'super secret edited content';

    await processUpdate({
      event: updatedEvent({ newContent: `${secret} https://a.com` }),
      db,
      embedder,
      config,
      logger,
    });

    vi.mocked(enrich).mockRejectedValueOnce(new Error('LLM provider down'));
    await processUpdate({
      event: updatedEvent({ newContent: `${secret} https://b.com` }),
      db: makeFakeDb({ existing: true, oldRows: [] }).db,
      embedder,
      config,
      logger,
    });

    const allCalls = [
      ...(logger.debug as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ];
    expect(JSON.stringify(allCalls)).not.toContain(secret);
  });

  it('should not ack when a reused (kept-link) embedding has a stale width', async () => {
    const logger = makeLogger();
    const { db, inserted, transactionCount } = makeFakeDb({
      existing: true,
      oldRows: [
        {
          id: 'old-1',
          chunkKey: 'm1:0',
          link: 'https://a.com/',
          title: 'Old Title',
          description: 'Old Description',
          embedding: [0.9, 0.8], // width 2 ≠ DIMENSIONS (4) — a stale-width reused vector
        },
      ],
    });

    const result = await processUpdate({
      event: updatedEvent({ newContent: 'see https://a.com' }),
      db,
      embedder,
      config,
      logger,
    });

    // Kept-link fast path skips fetch/enrich/embed, but the full-set dimension
    // assertion must still reject the stale-width reused vector BEFORE the tx —
    // an early clear error, not an opaque DB poison-replay at INSERT.
    expect(result).toEqual({ ack: false });
    expect(fetchUrl).not.toHaveBeenCalled();
    expect(enrich).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
    expect(transactionCount()).toBe(0);
  });

  it('should log at debug (not error) and not ack when aborted mid-update', async () => {
    const logger = makeLogger();
    const { db, transactionCount } = makeFakeDb({ existing: true, oldRows: [] });
    const controller = new AbortController();
    controller.abort();

    const result = await processUpdateImpl({
      event: updatedEvent({ newContent: 'see https://a.com' }),
      db,
      embedder,
      config,
      logger,
      streamId: 's1',
      stream: STREAM,
      enrichModel,
      guard,
      signal: controller.signal,
    });

    // A clean shutdown mid-fetch/enrich is expected, not a failure: the entry
    // stays pending for PEL replay (no ack, no tx) and is logged at debug —
    // never error, so it can't trip a spurious failure alert.
    expect(result).toEqual({ ack: false });
    expect(transactionCount()).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('aborted by shutdown'),
      expect.objectContaining({ streamId: 's1', stream: STREAM, messageId: 'm1', channelId: 'c1' }),
    );
  });
});
