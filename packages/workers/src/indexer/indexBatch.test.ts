import type { Share2BrainConfig } from '@share2brain/shared';
import type { Database } from '@share2brain/shared/db';
import type { RedisClient } from '@share2brain/shared/redis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { enrich } from '../enrichment/enrich.js';
import type { ResolvedEnrichmentRateLimit } from '../enrichment/rateLimiter.js';
import type { GuardedDispatcher } from '../enrichment/ssrfGuard.js';
import { fetchUrl } from '../enrichment/urlFetcher.js';
import type { Logger } from '@share2brain/shared/logger';
import { indexBatch } from './indexBatch.js';
import type { Embedder, IndexStateRow, RawStreamEntry } from './types.js';

/** Minimal fake node-redis client exposing just the two commands the budget
 *  limiter uses. `incrValue` fixes the count INCR returns, so a test can put an
 *  author at/over cap deterministically. */
function makeFakeRedis(incrValue = 1) {
  const incr = vi.fn(async () => incrValue);
  const expire = vi.fn(async () => true);
  return { redis: { incr, expire } as unknown as RedisClient, incr, expire };
}

const ENABLED_RATE_LIMIT: ResolvedEnrichmentRateLimit = {
  enabled: true,
  perAuthorHourly: 100,
  globalDaily: 1000,
};

vi.mock('../enrichment/urlFetcher.js', () => ({ fetchUrl: vi.fn() }));
vi.mock('../enrichment/enrich.js', async () => {
  const actual =
    await vi.importActual<typeof import('../enrichment/enrich.js')>('../enrichment/enrich.js');
  return { ...actual, enrich: vi.fn() };
});

const DIMENSIONS = 4;

const config = {
  embeddings: { dimensions: DIMENSIONS },
  enrichment: {
    language: 'en',
    llm: { timeout_ms: 60_000 },
    fetch: {
      timeout_ms: 5000,
      max_bytes: 2_000_000,
      max_redirects: 3,
      user_agent: 'Share2BrainTest/1.0',
      allowed_schemes: ['https'],
      block_private_ips: true,
    },
  },
} as unknown as Share2BrainConfig;

const enrichModel = {} as unknown as import('../enrichment/enrich.js').EnrichmentChatModel;
const guard = {} as unknown as GuardedDispatcher;

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function neverAbortedSignal(): AbortSignal {
  return new AbortController().signal;
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
  channelId: string;
  messageIds: string[];
}

/** Drizzle's `inArray(col, [id])` embeds the id array as one element of its
 *  `queryChunks`, each entry wrapped in a `Param { value }` — pull the raw ids
 *  back out so the fake stamp can gate on it without a real DB. Fragile to
 *  drizzle-orm internals, but confined to this test fake. */
function extractStampedIds(condition: unknown): string[] {
  const chunks = (condition as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
  const paramArray = chunks.find((chunk): chunk is { value: string }[] => Array.isArray(chunk));
  return (paramArray ?? []).map((param) => param.value);
}

/** Flatten a drizzle `sql` tagged-template into its literal text (params inlined)
 *  so the fake tx can recognize the M-4 liveness `SELECT … FOR UPDATE` and read
 *  the message id it locks. Mirrors the helper in processUpdate.test.ts. */
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks: unknown[] }).queryChunks;
  return chunks
    .map((c) => {
      if (c !== null && typeof c === 'object' && 'queryChunks' in c) return sqlText(c);
      if (c !== null && typeof c === 'object' && 'value' in (c as { value: unknown })) {
        const v = (c as { value: unknown }).value;
        return Array.isArray(v) ? v.join('') : String(v);
      }
      return String(c);
    })
    .join('');
}

/** A fake Drizzle db: `select…where` yields the given dedup rows; `transaction`
 *  records inserts and stamps whichever message id the stamp's `where(inArray(...))`
 *  condition names (minus `stampMiss`, to model a RETURNING miss). Works whether
 *  the message inserted zero rows (discard) or several (resource rows). */
function makeFakeDb(
  dedupRows: IndexStateRow[],
  stampMiss = new Set<string>(),
  // M-4: message ids that a concurrent delete purges mid-flight — the in-tx
  // `SELECT … FOR UPDATE` liveness check finds no row for them.
  deletedMidFlight = new Set<string>(),
  // AUDIT M1: message ids a concurrent Sync `updated` event indexes mid-flight —
  // the in-tx liveness re-check finds the row alive but with `indexed_at` set.
  indexedMidFlight = new Set<string>(),
) {
  const inserted: InsertedRow[] = [];
  let transactionCount = 0;

  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(dedupRows) }) }),
    transaction: async (cb: (tx: unknown) => Promise<boolean>) => {
      transactionCount++;
      const tx = {
        execute: (q: unknown) => {
          // Only the liveness re-check runs through `tx.execute`. No row when the
          // message was hard-deleted mid-flight (M-4, delete won); a row with a
          // non-null `indexedAt` when a Sync edit indexed it mid-flight (M1,
          // update won); otherwise a live, not-yet-indexed row.
          const text = sqlText(q);
          const deleted = [...deletedMidFlight].some((id) => text.includes(`id = ${id} `));
          if (deleted) return Promise.resolve({ rows: [] });
          const indexed = [...indexedMidFlight].some((id) => text.includes(`id = ${id} `));
          return Promise.resolve({ rows: [{ indexedAt: indexed ? new Date() : null }] });
        },
        insert: () => ({
          values: (v: InsertedRow) => {
            inserted.push(v);
            return { onConflictDoUpdate: () => Promise.resolve() };
          },
        }),
        update: () => ({
          set: () => ({
            where: (condition: unknown) => ({
              returning: () => {
                const ids = extractStampedIds(condition).filter((id) => !stampMiss.has(id));
                return Promise.resolve(ids.map((id) => ({ id })));
              },
            }),
          }),
        }),
      };
      return cb(tx);
    },
  } as unknown as Database;

  return { db, inserted, transactionCount: () => transactionCount };
}

function raw(streamId: string, overrides: Partial<Record<string, string>> = {}): RawStreamEntry {
  return {
    id: streamId,
    message: {
      type: 'discord.message.created',
      messageId: 'm1',
      channelId: 'c1',
      guildId: 'g1',
      timestamp: '2026-07-06T10:00:00.000Z',
      content: 'check https://example.com/doc out',
      authorId: 'a1',
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.mocked(fetchUrl).mockReset();
  vi.mocked(enrich).mockReset();
  // Default: every fetch succeeds with empty HTML, every enrich call succeeds
  // with a title/description derived from the URL so assertions can tell rows
  // apart without inspecting the mock call args.
  vi.mocked(fetchUrl).mockImplementation(async (url: string) =>
    Promise.resolve({ ok: true, body: '<html></html>', contentType: 'text/html', finalUrl: url }),
  );
  vi.mocked(enrich).mockImplementation(async (_model, input: { messageText: string }) =>
    Promise.resolve({ title: `Title for ${input.messageText}`, description: 'A description' }),
  );
});

describe('indexBatch', () => {
  it('should XACK malformed/foreign entries without any DB work', async () => {
    const logger = makeLogger();
    const { db, transactionCount } = makeFakeDb([]);

    const { ackIds } = await indexBatch({
      entries: [raw('s1', { type: 'discord.message.deleted' })],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual(['s1']);
    expect(transactionCount()).toBe(0);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('should XACK a tombstoned PEL entry (null message) instead of crashing', async () => {
    const logger = makeLogger();
    const { db, transactionCount } = makeFakeDb([]);

    const { ackIds } = await indexBatch({
      entries: [{ id: 's1', message: null }],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual(['s1']);
    expect(transactionCount()).toBe(0);
  });

  it('should ack already-indexed entries and skip persistence', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: new Date() }]);

    const { ackIds } = await indexBatch({
      entries: [raw('s1')],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual(['s1']);
    expect(inserted).toHaveLength(0);
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it('should leave a row-missing entry pending (never acked)', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([]); // no dedup row for m1

    const { ackIds } = await indexBatch({
      entries: [raw('s1')],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual([]);
    expect(inserted).toHaveLength(0);
  });

  it('should discard a no-URL message: stamp + ack, zero inserts', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }]);

    const { ackIds } = await indexBatch({
      entries: [raw('s1', { content: 'just chatting, no links here' })],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual(['s1']);
    expect(inserted).toHaveLength(0);
    expect(fetchUrl).not.toHaveBeenCalled();
  });

  it('should persist one row per URL for a multi-URL message', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }]);

    const { ackIds } = await indexBatch({
      entries: [raw('s1', { content: 'see https://a.com and https://b.com' })],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual(['s1']);
    expect(inserted).toHaveLength(2);
    expect(inserted.map((r) => r.chunkKey).sort()).toEqual(['m1:0', 'm1:1']);
    for (const row of inserted) expect(row.messageIds).toEqual(['m1']);
    expect(inserted.map((r) => r.link).sort()).toEqual(['https://a.com/', 'https://b.com/']);
  });

  it('should collapse a duplicate URL in one message into a single row', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }]);

    const { ackIds } = await indexBatch({
      entries: [raw('s1', { content: 'https://a.com and again https://a.com' })],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual(['s1']);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].chunkKey).toBe('m1:0');
  });

  it('should cap URLs per message at 20, processing the first N and warning about the rest', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }]);

    // 25 distinct URLs — 5 over the MAX_URLS_PER_MESSAGE cap.
    const urls = Array.from({ length: 25 }, (_, i) => `https://ex.com/${i}`);

    const { ackIds } = await indexBatch({
      entries: [raw('s1', { content: urls.join(' ') })],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual(['s1']);
    expect(inserted).toHaveLength(20);
    expect(fetchUrl).toHaveBeenCalledTimes(20); // only the first 20 fetched
    expect(inserted.map((r) => r.chunkKey).sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `m1:${i}`).sort(),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('URL cap'),
      expect.objectContaining({ extracted: 25, cap: 20, dropped: 5 }),
    );
  });

  it('should persist a text-only fallback row when the fetch fails for a non-SSRF reason', async () => {
    vi.mocked(fetchUrl).mockResolvedValue({ ok: false, reason: 'timeout' });
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }]);

    const { ackIds } = await indexBatch({
      entries: [raw('s1', { content: 'https://a.com' })],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual(['s1']);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].link).toBe('https://a.com/');
    expect(vi.mocked(enrich).mock.calls[0][1]).toMatchObject({ pageHints: null });
  });

  it('should skip an SSRF-blocked URL (no row) while persisting the other URLs of the message', async () => {
    vi.mocked(fetchUrl).mockImplementation(async (url: string) => {
      if (url === 'https://blocked.com/') return { ok: false, reason: 'ssrf_blocked' };
      return { ok: true, body: '<html></html>', contentType: 'text/html', finalUrl: url };
    });
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }]);

    const { ackIds } = await indexBatch({
      entries: [raw('s1', { content: 'https://blocked.com then https://ok.com' })],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual(['s1']);
    expect(inserted).toHaveLength(1);
    // The surviving row keeps its ORIGINAL position (index 1) — a gap at 0 is expected.
    expect(inserted[0].chunkKey).toBe('m1:1');
    expect(inserted[0].link).toBe('https://ok.com/');
  });

  it('should discard the message when every URL is SSRF-blocked', async () => {
    vi.mocked(fetchUrl).mockResolvedValue({ ok: false, reason: 'ssrf_blocked' });
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }]);

    const { ackIds } = await indexBatch({
      entries: [raw('s1', { content: 'https://blocked1.com and https://blocked2.com' })],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual(['s1']);
    expect(inserted).toHaveLength(0);
  });

  it('should skip a scheme-disallowed URL like an SSRF block (no row)', async () => {
    vi.mocked(fetchUrl).mockResolvedValue({ ok: false, reason: 'scheme_disallowed' });
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }]);

    const { ackIds } = await indexBatch({
      entries: [raw('s1', { content: 'https://a.com' })],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual(['s1']);
    expect(inserted).toHaveLength(0);
  });

  it('should leave the entry un-ACKed and persist nothing when enrich fails for any URL (D1)', async () => {
    vi.mocked(enrich).mockRejectedValue(new Error('LLM provider down'));
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }]);

    const { ackIds } = await indexBatch({
      entries: [raw('s1', { content: 'https://a.com and https://b.com' })],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual([]);
    expect(inserted).toHaveLength(0);
    expect(logger.error).toHaveBeenCalled();
  });

  it('should treat an embedding dimension mismatch as a message failure, un-ACKed', async () => {
    vi.mocked(enrich).mockResolvedValue({ title: 'WRONGDIM title', description: 'x' });
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }]);

    const { ackIds } = await indexBatch({
      entries: [raw('s1', { content: 'https://a.com' })],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual([]);
    expect(inserted).toHaveLength(0);
  });

  it('should treat an embedder throw as a message failure, un-ACKed, and still process other messages', async () => {
    vi.mocked(enrich).mockImplementation(async (_model, input: { messageText: string }) =>
      Promise.resolve({
        title: input.messageText.includes('boom') ? 'BOOM title' : 'fine title',
        description: 'x',
      }),
    );
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([
      { id: 'boom', indexedAt: null },
      { id: 'ok', indexedAt: null },
    ]);

    const { ackIds } = await indexBatch({
      entries: [
        raw('s-boom', { messageId: 'boom', channelId: 'c1', content: 'boom https://a.com' }),
        raw('s-ok', { messageId: 'ok', channelId: 'c2', content: 'fine https://b.com' }),
      ],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual(['s-ok']);
    expect(inserted.map((r) => r.chunkKey)).toEqual(['ok:0']);
  });

  it('should dedupe a producer-duplicate messageId and ack every stream id once persisted', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }]);

    const { ackIds } = await indexBatch({
      entries: [
        raw('s-first', { messageId: 'm1', content: 'https://a.com' }),
        raw('s-second', { messageId: 'm1', content: 'https://a.com' }),
      ],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(inserted.filter((r) => r.chunkKey === 'm1:0')).toHaveLength(1);
    expect(ackIds.sort()).toEqual(['s-first', 's-second']);
  });

  it('should dedupe a triple producer-duplicate messageId and ack all three stream ids', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }]);

    const { ackIds } = await indexBatch({
      entries: [
        raw('s-1', { messageId: 'm1', content: 'https://a.com' }),
        raw('s-2', { messageId: 'm1', content: 'https://a.com' }),
        raw('s-3', { messageId: 'm1', content: 'https://a.com' }),
      ],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(inserted.filter((r) => r.chunkKey === 'm1:0')).toHaveLength(1);
    expect(ackIds.sort()).toEqual(['s-1', 's-2', 's-3']);
  });

  it('should ack only the message id returned by the stamp RETURNING', async () => {
    const logger = makeLogger();
    const { db } = makeFakeDb(
      [
        { id: 'm1', indexedAt: null },
        { id: 'm2', indexedAt: null },
      ],
      new Set(['m2']),
    );

    const { ackIds } = await indexBatch({
      entries: [
        raw('s1', { messageId: 'm1', channelId: 'c1', content: 'https://a.com' }),
        raw('s2', { messageId: 'm2', channelId: 'c1', content: 'https://b.com' }),
      ],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual(['s1']);
  });

  it('should abort persistence as a no-op but still ack when the message is hard-deleted mid-index (M-4)', async () => {
    const logger = makeLogger();
    // Row exists at dedup time (indexed_at null → toProcess), but a concurrent
    // hard delete removes it before the persist tx: the in-tx FOR UPDATE
    // liveness check finds nothing, so no embeddings are resurrected — and the
    // entry is still acked (the delete won the race).
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }], new Set(), new Set(['m1']));

    const { ackIds } = await indexBatch({
      entries: [raw('s1', { content: 'https://a.com' })],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual(['s1']); // acked no-op
    expect(inserted).toHaveLength(0); // nothing resurrected
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('deleted mid-index'),
      expect.objectContaining({ messageId: 'm1' }),
    );
  });

  it('should abort persistence as a no-op but still ack when a concurrent edit indexes the message mid-flight (M1)', async () => {
    const logger = makeLogger();
    // Row exists and is un-indexed at dedup time (→ toProcess), but a concurrent
    // Sync `updated` event indexes it (newer content) before our persist tx. The
    // in-tx FOR UPDATE re-check now sees `indexed_at` set, so we must NOT UPSERT
    // the stale create-time rows over the edit — abort as a no-op and still ack.
    const { db, inserted } = makeFakeDb(
      [{ id: 'm1', indexedAt: null }],
      new Set(),
      new Set(),
      new Set(['m1']),
    );

    const { ackIds } = await indexBatch({
      entries: [raw('s1', { content: 'https://a.com' })],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
    });

    expect(ackIds).toEqual(['s1']); // acked no-op — the edit won
    expect(inserted).toHaveLength(0); // stale create-time rows never written
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('already indexed mid-flight'),
      expect.objectContaining({ messageId: 'm1' }),
    );
  });

  it('should degrade to no-URL indexing (no fetch, still stamp+ack) when the author budget is exceeded (M-5)', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }]);
    const { redis, incr } = makeFakeRedis(101); // 101 > perAuthorHourly (100) → deny

    const { ackIds } = await indexBatch({
      entries: [raw('s1', { content: 'https://a.com', authorId: 'spammer' })],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
      redis,
      rateLimit: ENABLED_RATE_LIMIT,
    });

    expect(ackIds).toEqual(['s1']); // message NOT dropped — indexed with zero rows
    expect(inserted).toHaveLength(0);
    expect(fetchUrl).not.toHaveBeenCalled(); // no paid fetch/LLM on the URLs
    expect(incr).toHaveBeenCalled(); // budget was consulted
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('degrading message to no-URL indexing'),
      expect.objectContaining({ messageId: 'm1', authorId: 'spammer' }),
    );
  });

  it('should perform full enrichment when the budget allows it (M-5)', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }]);
    const { redis } = makeFakeRedis(1); // well under cap → allowed

    const { ackIds } = await indexBatch({
      entries: [raw('s1', { content: 'https://a.com', authorId: 'a1' })],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
      redis,
      rateLimit: ENABLED_RATE_LIMIT,
    });

    expect(ackIds).toEqual(['s1']);
    expect(fetchUrl).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].link).toBe('https://a.com/');
  });

  it('should not consult the budget for a no-URL message (M-5)', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }]);
    const { redis, incr } = makeFakeRedis(1);

    const { ackIds } = await indexBatch({
      entries: [raw('s1', { content: 'just chatting, no links', authorId: 'a1' })],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: neverAbortedSignal(),
      redis,
      rateLimit: ENABLED_RATE_LIMIT,
    });

    expect(ackIds).toEqual(['s1']);
    expect(inserted).toHaveLength(0);
    expect(incr).not.toHaveBeenCalled(); // a costless message never burns budget
  });

  it('should bail the batch and leave every entry un-ACKed when already aborted', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([
      { id: 'm1', indexedAt: null },
      { id: 'm2', indexedAt: null },
    ]);
    const controller = new AbortController();
    controller.abort();

    const { ackIds } = await indexBatch({
      entries: [
        raw('s1', { messageId: 'm1', content: 'https://a.com' }),
        raw('s2', { messageId: 'm2', content: 'https://b.com' }),
      ],
      db,
      embedder,
      config,
      logger,
      enrichModel,
      guard,
      signal: controller.signal,
    });

    expect(ackIds).toEqual([]);
    expect(inserted).toHaveLength(0);
    expect(fetchUrl).not.toHaveBeenCalled();
  });
});
