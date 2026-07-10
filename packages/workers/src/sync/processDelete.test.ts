import type { Share2BrainConfig } from '@share2brain/shared';
import type { Database } from '@share2brain/shared/db';
import type { MessageDeletedEvent } from '@share2brain/shared/types/events';
import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../logger.js';
import { processDelete as processDeleteImpl, type ProcessDeleteDeps } from './processDelete.js';

// The consumer always supplies streamId/stream (AC-5); inject fixed values so
// the call sites below stay focused on event/db/policy behavior.
const STREAM = 'share2brain:discord:messages:deleted';
function processDelete(deps: Omit<ProcessDeleteDeps, 'streamId' | 'stream'>) {
  return processDeleteImpl({ ...deps, streamId: 's1', stream: STREAM });
}

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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

interface FakeDbOptions {
  /** Throw on the top-level db.execute (soft path) or inside the transaction (hard path). */
  throwOn?: 'execute' | 'transaction';
}

function makeFakeDb(opts: FakeDbOptions = {}) {
  const executeLog: string[] = [];
  let transactionCount = 0;

  const db = {
    execute: (q: unknown) => {
      if (opts.throwOn === 'execute') throw new Error('db exploded');
      executeLog.push(sqlText(q));
      return Promise.resolve({ rows: [] });
    },
    transaction: async (cb: (tx: unknown) => Promise<void>) => {
      transactionCount++;
      const tx = {
        execute: (q: unknown) => {
          if (opts.throwOn === 'transaction') throw new Error('tx exploded');
          executeLog.push(sqlText(q));
          return Promise.resolve({ rows: [] });
        },
      };
      await cb(tx);
    },
  } as unknown as Database;

  return { db, executeLog, transactionCount: () => transactionCount };
}

function deletedEvent(overrides: Partial<MessageDeletedEvent> = {}): MessageDeletedEvent {
  return {
    type: 'discord.message.deleted',
    messageId: 'm1',
    channelId: 'c1',
    guildId: 'g1',
    timestamp: '2026-07-08T10:00:00.000Z',
    ...overrides,
  };
}

function softConfig(): Share2BrainConfig {
  return { sync: { enabled: true, sync_on_start: false, delete_policy: 'soft' } } as unknown as Share2BrainConfig;
}

function hardConfig(): Share2BrainConfig {
  return { sync: { enabled: true, sync_on_start: false, delete_policy: 'hard' } } as unknown as Share2BrainConfig;
}

describe('processDelete — soft policy', () => {
  it('should set deleted_at and never touch embeddings', async () => {
    const logger = makeLogger();
    const { db, executeLog, transactionCount } = makeFakeDb();

    const result = await processDelete({ event: deletedEvent(), db, config: softConfig(), logger });

    expect(result).toEqual({ ack: true });
    expect(transactionCount()).toBe(0);
    expect(executeLog).toHaveLength(1);
    expect(executeLog[0]).toContain('discord_messages');
    expect(executeLog[0]).toContain('deleted_at');
    expect(executeLog[0]).not.toContain('embeddings');
  });

  it('should be idempotent (no rows to affect) without throwing', async () => {
    const logger = makeLogger();
    const { db } = makeFakeDb();

    const result = await processDelete({ event: deletedEvent(), db, config: softConfig(), logger });

    expect(result).toEqual({ ack: true });
  });

  it('should not ack when the DB write throws', async () => {
    const logger = makeLogger();
    const { db } = makeFakeDb({ throwOn: 'execute' });

    const result = await processDelete({ event: deletedEvent(), db, config: softConfig(), logger });

    expect(result).toEqual({ ack: false });
    // AC-5: failure log carries the PEL locator (streamId + stream).
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to process message delete'),
      expect.objectContaining({ messageId: 'm1', policy: 'soft', streamId: 's1', stream: STREAM }),
    );
  });
});

describe('processDelete — hard policy', () => {
  it('should delete read-status before embeddings, then set deleted_at (superset of soft)', async () => {
    const logger = makeLogger();
    const { db, executeLog, transactionCount } = makeFakeDb();

    const result = await processDelete({ event: deletedEvent(), db, config: hardConfig(), logger });

    expect(result).toEqual({ ack: true });
    expect(transactionCount()).toBe(1);
    expect(executeLog).toHaveLength(3);
    expect(executeLog[0]).toContain('DELETE FROM user_read_status');
    expect(executeLog[1]).toContain('DELETE FROM embeddings');
    expect(executeLog[2]).toContain('discord_messages');
    expect(executeLog[2]).toContain('deleted_at');
  });

  it('should be idempotent (no rows to affect) without throwing', async () => {
    const logger = makeLogger();
    const { db } = makeFakeDb();

    const result = await processDelete({ event: deletedEvent(), db, config: hardConfig(), logger });

    expect(result).toEqual({ ack: true });
  });

  it('should not ack and roll back when the transaction throws', async () => {
    const logger = makeLogger();
    const { db } = makeFakeDb({ throwOn: 'transaction' });

    const result = await processDelete({ event: deletedEvent(), db, config: hardConfig(), logger });

    expect(result).toEqual({ ack: false });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to process message delete'),
      expect.objectContaining({ messageId: 'm1', policy: 'hard' }),
    );
  });
});

describe('processDelete — content never logged', () => {
  it('should never log the messageId-adjacent content in any log context', async () => {
    const logger = makeLogger();
    const { db } = makeFakeDb({ throwOn: 'execute' });

    await processDelete({
      event: deletedEvent({ messageId: 'm-secret-marker' }),
      db,
      config: softConfig(),
      logger,
    });

    // There is no content field on a delete event; assert none of the log
    // context accidentally carries anything beyond ids/reason/policy.
    const allCalls = [
      ...(logger.debug as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.info as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.warn as ReturnType<typeof vi.fn>).mock.calls,
      ...(logger.error as ReturnType<typeof vi.fn>).mock.calls,
    ];
    expect(JSON.stringify(allCalls)).toContain('m-secret-marker');
    expect(JSON.stringify(allCalls)).not.toContain('content');
  });
});
