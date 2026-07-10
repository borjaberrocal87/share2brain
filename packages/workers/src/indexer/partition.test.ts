import type { MessageCreatedEvent } from '@share2brain/shared/types/events';
import { describe, expect, it } from 'vitest';

import { partitionByIndexState } from './partition.js';
import type { IndexStateRow, ParsedEntry } from './types.js';

function entry(streamId: string, messageId: string, channelId = 'c1', content = 'x'): ParsedEntry {
  const event: MessageCreatedEvent = {
    type: 'discord.message.created',
    messageId,
    channelId,
    guildId: 'g1',
    timestamp: '2026-07-06T10:00:00.000Z',
    content,
    authorId: 'a1',
  };
  return { streamId, event };
}

describe('partitionByIndexState', () => {
  it('should ackNow an entry whose row is already indexed', () => {
    const entries = [entry('s1', 'm1')];
    const rows: IndexStateRow[] = [{ id: 'm1', indexedAt: new Date() }];

    const result = partitionByIndexState(entries, rows);

    expect(result.ackNow).toEqual(['s1']);
    expect(result.pending).toEqual([]);
    expect(result.toProcess).toEqual([]);
  });

  it('should leave an entry pending when no row exists (XADD raced ahead of COMMIT)', () => {
    const entries = [entry('s1', 'm1')];

    const result = partitionByIndexState(entries, []);

    expect(result.pending).toEqual(['s1']);
    expect(result.ackNow).toEqual([]);
    expect(result.toProcess).toEqual([]);
  });

  it('should route a fresh row (indexed_at NULL) to toProcess', () => {
    const entries = [entry('s1', 'm1')];
    const rows: IndexStateRow[] = [{ id: 'm1', indexedAt: null }];

    const result = partitionByIndexState(entries, rows);

    expect(result.toProcess).toHaveLength(1);
    expect(result.toProcess[0].streamId).toBe('s1');
    expect(result.ackNow).toEqual([]);
    expect(result.pending).toEqual([]);
  });

  it('should classify a mixed batch independently per entry', () => {
    const entries = [entry('s1', 'indexed'), entry('s2', 'fresh'), entry('s3', 'missing')];
    const rows: IndexStateRow[] = [
      { id: 'indexed', indexedAt: '2026-07-06T00:00:00Z' },
      { id: 'fresh', indexedAt: null },
    ];

    const result = partitionByIndexState(entries, rows);

    expect(result.ackNow).toEqual(['s1']);
    expect(result.toProcess.map((e) => e.streamId)).toEqual(['s2']);
    expect(result.pending).toEqual(['s3']);
  });

  it('should put duplicate entries of the same fresh id both in toProcess', () => {
    const entries = [entry('s1', 'm1'), entry('s2', 'm1')];
    const rows: IndexStateRow[] = [{ id: 'm1', indexedAt: null }];

    const result = partitionByIndexState(entries, rows);

    expect(result.toProcess.map((e) => e.streamId)).toEqual(['s1', 's2']);
  });
});
