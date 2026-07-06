import type { MessageCreatedEvent } from '@hivly/shared/types/events';
import { describe, expect, it } from 'vitest';

import { groupByChannel, partitionByIndexState } from './grouping.js';
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

describe('groupByChannel', () => {
  it('should group a single channel of messages into one group under the window', () => {
    const entries = [entry('s1', 'm1', 'c1', 'a'), entry('s2', 'm2', 'c1', 'b')];

    const groups = groupByChannel(entries, 10);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({
      channelId: 'c1',
      messageIds: ['m1', 'm2'],
      streamIds: ['s1', 's2'],
      contents: ['a', 'b'],
    });
  });

  it('should partition entries by channel preserving stream order', () => {
    const entries = [
      entry('s1', 'm1', 'c1'),
      entry('s2', 'm2', 'c2'),
      entry('s3', 'm3', 'c1'),
    ];

    const groups = groupByChannel(entries, 10);

    expect(groups).toHaveLength(2);
    // c1 first (first appearance), with its messages in stream order.
    expect(groups[0].channelId).toBe('c1');
    expect(groups[0].messageIds).toEqual(['m1', 'm3']);
    expect(groups[1].channelId).toBe('c2');
    expect(groups[1].messageIds).toEqual(['m2']);
  });

  it('should cap each group at the grouping window and overflow into new groups', () => {
    const entries = Array.from({ length: 5 }, (_, i) => entry(`s${i}`, `m${i}`, 'c1'));

    const groups = groupByChannel(entries, 2);

    expect(groups.map((g) => g.messageIds)).toEqual([
      ['m0', 'm1'],
      ['m2', 'm3'],
      ['m4'],
    ]);
  });

  it('should coerce a non-positive window to 1 rather than emit empty groups', () => {
    const entries = [entry('s1', 'm1', 'c1'), entry('s2', 'm2', 'c1')];

    const groups = groupByChannel(entries, 0);

    expect(groups.map((g) => g.messageIds)).toEqual([['m1'], ['m2']]);
  });

  it('should return no groups for an empty input', () => {
    expect(groupByChannel([], 10)).toEqual([]);
  });

  it('should cap a misconfigured huge window instead of concatenating unbounded messages', () => {
    const entries = Array.from({ length: 60 }, (_, i) => entry(`s${i}`, `m${i}`, 'c1'));

    const groups = groupByChannel(entries, 10_000);

    expect(groups).toHaveLength(2);
    expect(groups[0].messageIds).toHaveLength(50);
    expect(groups[1].messageIds).toHaveLength(10);
  });

  it('should pass a window exactly at the cap through unclamped', () => {
    const entries = Array.from({ length: 50 }, (_, i) => entry(`s${i}`, `m${i}`, 'c1'));

    const groups = groupByChannel(entries, 50);

    expect(groups).toHaveLength(1);
    expect(groups[0].messageIds).toHaveLength(50);
  });

  it('should clamp a window one over the cap', () => {
    const entries = Array.from({ length: 51 }, (_, i) => entry(`s${i}`, `m${i}`, 'c1'));

    const groups = groupByChannel(entries, 51);

    expect(groups).toHaveLength(2);
    expect(groups[0].messageIds).toHaveLength(50);
    expect(groups[1].messageIds).toHaveLength(1);
  });
});
