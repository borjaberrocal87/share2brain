import type { HivlyConfig } from '@hivly/shared';
import type { Database } from '@hivly/shared/db';
import type { MessageUpdatedEvent } from '@hivly/shared/types/events';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../logger.js';
import type { Embedder } from '../indexer/types.js';
import { processUpdate as processUpdateImpl, type ProcessUpdateDeps } from './processUpdate.js';

// The consumer always supplies streamId/stream (AC-5); inject fixed values so
// the call sites below stay focused on event/db/embedder behavior.
const STREAM = 'hivly:discord:messages:updated';
function processUpdate(deps: Omit<ProcessUpdateDeps, 'streamId' | 'stream'>) {
  return processUpdateImpl({ ...deps, streamId: 's1', stream: STREAM });
}

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
  description: string;
  channelId: string;
  messageIds: string[];
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

/** A fake Drizzle db: `select…where` yields whether the message exists;
 *  `transaction` records every `execute`d statement (in order) and every
 *  `insert`ed embeddings row. */
function makeFakeDb(opts: { existing: boolean }) {
  const executeLog: string[] = [];
  const inserted: InsertedRow[] = [];
  let transactionCount = 0;

  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(opts.existing ? [{ id: 'm1' }] : []),
      }),
    }),
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

describe('processUpdate', () => {
  it('should skip an update for an unknown message with no writes and ack', async () => {
    const logger = makeLogger();
    const { db, transactionCount } = makeFakeDb({ existing: false });

    const result = await processUpdate({ event: updatedEvent(), db, embedder, config, logger });

    expect(result).toEqual({ ack: true });
    expect(transactionCount()).toBe(0);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('unknown message'),
      expect.objectContaining({ messageId: 'm1' }),
    );
  });

  it('should delete read-status before embeddings (FK RESTRICT order)', async () => {
    const logger = makeLogger();
    const { db, executeLog } = makeFakeDb({ existing: true });

    await processUpdate({ event: updatedEvent(), db, embedder, config, logger });

    const readStatusIdx = executeLog.findIndex((s) => s.includes('DELETE FROM user_read_status'));
    const embeddingsIdx = executeLog.findIndex((s) => s.includes('DELETE FROM embeddings'));
    expect(readStatusIdx).toBeGreaterThanOrEqual(0);
    expect(embeddingsIdx).toBeGreaterThan(readStatusIdx);
  });

  it('should delete every chunk matching ANY(message_ids)', async () => {
    const logger = makeLogger();
    const { db, executeLog } = makeFakeDb({ existing: true });

    await processUpdate({ event: updatedEvent(), db, embedder, config, logger });

    expect(executeLog.some((s) => s.includes('ANY(message_ids)') && s.includes('m1'))).toBe(true);
  });

  it('should refresh discord_messages.content and updated_at', async () => {
    const logger = makeLogger();
    const { db, executeLog } = makeFakeDb({ existing: true });

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

  it('should re-chunk standalone and upsert keyed on <id>:<i>', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb({ existing: true });

    await processUpdate({ event: updatedEvent(), db, embedder, config, logger });

    expect(inserted).toHaveLength(1);
    expect(inserted[0].chunkKey).toBe('m1:0');
    expect(inserted[0].messageIds).toEqual(['m1']);
    expect(inserted[0].description).toBe('edited content');
    expect(inserted[0].channelId).toBe('c1');
  });

  it('should stamp indexed_at', async () => {
    const logger = makeLogger();
    const { db, executeLog } = makeFakeDb({ existing: true });

    await processUpdate({ event: updatedEvent(), db, embedder, config, logger });

    expect(executeLog.some((s) => s.includes('indexed_at'))).toBe(true);
  });

  it('should not ack and leave the entry pending when the embedder throws', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb({ existing: true });

    const result = await processUpdate({
      event: updatedEvent({ newContent: 'this will BOOM' }),
      db,
      embedder,
      config,
      logger,
    });

    expect(result).toEqual({ ack: false });
    expect(inserted).toHaveLength(0);
    // AC-5: the failure log carries the PEL locator (streamId + stream) so an
    // operator can find the pending entry.
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to process message update'),
      expect.objectContaining({ messageId: 'm1', streamId: 's1', stream: STREAM }),
    );
  });

  it('should not ack on a dimension mismatch', async () => {
    const logger = makeLogger();
    const { db, inserted } = makeFakeDb({ existing: true });

    const result = await processUpdate({
      event: updatedEvent({ newContent: 'WRONGDIM content' }),
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
    const { db } = makeFakeDb({ existing: true });
    const secret = 'super secret edited content';

    await processUpdate({ event: updatedEvent({ newContent: secret }), db, embedder, config, logger });
    await processUpdate({
      event: updatedEvent({ newContent: `${secret} BOOM` }),
      db: makeFakeDb({ existing: true }).db,
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
});
