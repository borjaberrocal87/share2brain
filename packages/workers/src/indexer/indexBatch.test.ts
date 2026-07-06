import type { HivlyConfig } from '@hivly/shared';
import type { Database } from '@hivly/shared/db';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../logger.js';
import { indexBatch } from './indexBatch.js';
import type { Embedder, IndexStateRow, RawStreamEntry } from './types.js';

const DIMENSIONS = 4;

const config = {
  knowledge: { chunk_size: 500, chunk_overlap: 50, grouping_window: 10 },
  embeddings: { dimensions: DIMENSIONS },
} as unknown as HivlyConfig;

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Deterministic embedder: throws on "BOOM", returns a wrong-width vector on
 *  "WRONGDIM", otherwise a valid DIMENSIONS-length vector per input chunk. */
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
  messageIds: string[];
  content: string;
}

/** A fake Drizzle db: `select…where` yields the given dedup rows; `transaction`
 *  records inserts and stamps every message id inserted in that tx (minus
 *  `stampMiss`, to model a RETURNING miss). */
function makeFakeDb(dedupRows: IndexStateRow[], stampMiss = new Set<string>()) {
  const inserted: InsertedRow[] = [];
  let transactionCount = 0;

  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(dedupRows) }) }),
    transaction: async (cb: (tx: unknown) => Promise<Set<string>>) => {
      transactionCount++;
      const txInserted: string[] = [];
      const tx = {
        insert: () => ({
          values: (v: InsertedRow) => {
            inserted.push({ chunkKey: v.chunkKey, messageIds: v.messageIds, content: v.content });
            txInserted.push(...v.messageIds);
            return { onConflictDoUpdate: () => Promise.resolve() };
          },
        }),
        update: () => ({
          set: () => ({
            where: () => ({
              returning: () => {
                const ids = [...new Set(txInserted)].filter((id) => !stampMiss.has(id));
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

function raw(
  streamId: string,
  overrides: Partial<Record<string, string>> = {},
): RawStreamEntry {
  return {
    id: streamId,
    message: {
      type: 'discord.message.created',
      messageId: 'm1',
      channelId: 'c1',
      guildId: 'g1',
      timestamp: '2026-07-06T10:00:00.000Z',
      content: 'hello world',
      authorId: 'a1',
      ...overrides,
    },
  };
}

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
    });

    expect(ackIds).toEqual(['s1']);
    expect(transactionCount()).toBe(0);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('should ack already-indexed entries and skip persistence', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: new Date() }]);

    const { ackIds } = await indexBatch({ entries: [raw('s1')], db, embedder, config, logger });

    expect(ackIds).toEqual(['s1']);
    expect(inserted).toHaveLength(0);
  });

  it('should leave a row-missing entry pending (never acked)', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([]); // no dedup row for m1

    const { ackIds } = await indexBatch({ entries: [raw('s1')], db, embedder, config, logger });

    expect(ackIds).toEqual([]);
    expect(inserted).toHaveLength(0);
  });

  it('should upsert a fresh entry keyed on <firstMessageId>:<chunkIndex> and ack it', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb([{ id: 'm1', indexedAt: null }]);

    const { ackIds } = await indexBatch({ entries: [raw('s1')], db, embedder, config, logger });

    expect(ackIds).toEqual(['s1']);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].chunkKey).toBe('m1:0');
    expect(inserted[0].content).toBe('hello world');
  });

  it('should not ack a group failing the dimension guard, but ack a healthy group', async () => {
    const logger = makeLogger();
    const { db } = makeFakeDb([
      { id: 'bad', indexedAt: null },
      { id: 'good', indexedAt: null },
    ]);

    const { ackIds } = await indexBatch({
      entries: [
        raw('s-bad', { messageId: 'bad', channelId: 'c1', content: 'WRONGDIM here' }),
        raw('s-good', { messageId: 'good', channelId: 'c2', content: 'fine content' }),
      ],
      db,
      embedder,
      config,
      logger,
    });

    expect(ackIds).toEqual(['s-good']);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('dimension mismatch'),
      expect.objectContaining({ channelId: 'c1', expected: DIMENSIONS }),
    );
  });

  it('should isolate a group whose embedder throws and still process others', async () => {
    const logger = makeLogger();
    const { db } = makeFakeDb([
      { id: 'boom', indexedAt: null },
      { id: 'ok', indexedAt: null },
    ]);

    const { ackIds } = await indexBatch({
      entries: [
        raw('s-boom', { messageId: 'boom', channelId: 'c1', content: 'BOOM goes the batch' }),
        raw('s-ok', { messageId: 'ok', channelId: 'c2', content: 'healthy' }),
      ],
      db,
      embedder,
      config,
      logger,
    });

    expect(ackIds).toEqual(['s-ok']);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to index group'),
      expect.objectContaining({ channelId: 'c1' }),
    );
  });

  it('should ack only ids returned by the stamp RETURNING', async () => {
    const logger = makeLogger();
    // m1 and m2 are both fresh and in the same channel → one group; but the stamp
    // only returns m1 (m2's row vanished / never committed) → only s1 is acked.
    const { db } = makeFakeDb(
      [
        { id: 'm1', indexedAt: null },
        { id: 'm2', indexedAt: null },
      ],
      new Set(['m2']),
    );

    const { ackIds } = await indexBatch({
      entries: [
        raw('s1', { messageId: 'm1', channelId: 'c1', content: 'one' }),
        raw('s2', { messageId: 'm2', channelId: 'c1', content: 'two' }),
      ],
      db,
      embedder,
      config,
      logger,
    });

    expect(ackIds).toEqual(['s1']);
  });
});
