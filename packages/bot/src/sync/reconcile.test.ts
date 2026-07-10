// Unit tests for the pure reconciliation diff (AC-3, AC-4, AC-7, note #4, #5, #7).
// No I/O — plain fixtures only.
import { describe, expect, it } from 'vitest';

import { diffChannel, toIdKey, type FetchedMessage, type PersistedRow } from './reconcile.js';

function fetchedMessage(id: string, overrides: Partial<FetchedMessage> = {}): FetchedMessage {
  return {
    id,
    channelId: 'chan-1',
    guildId: 'guild-1',
    content: `content ${id}`,
    editedAt: new Date('2026-07-01T00:00:00.000Z'),
    author: { id: 'user-1', bot: false, displayName: 'User One' },
    partial: false,
    fetch: () => Promise.resolve(fetchedMessage(id, overrides)),
    ...overrides,
  };
}

function persistedRow(id: string, content: string): PersistedRow {
  return { id, content };
}

describe('toIdKey', () => {
  it('should parse an all-digit snowflake as a BigInt', () => {
    expect(toIdKey('12345678901234567')).toBe(12345678901234567n);
  });

  it('should return null for a non-numeric id', () => {
    expect(toIdKey('')).toBeNull();
    expect(toIdKey('abc')).toBeNull();
    expect(toIdKey('  ')).toBeNull();
  });
});

describe('diffChannel', () => {
  it('should detect an edit when fetched content differs from persisted content', () => {
    const fetched = [fetchedMessage('10', { content: 'new content' })];
    const persisted = [persistedRow('10', 'old content')];

    const result = diffChannel({ persisted, fetched, lastSeen: '10' });

    expect(result.edits).toEqual([fetched[0]]);
    expect(result.deletes).toEqual([]);
  });

  it('should NOT report an edit when fetched content equals persisted content', () => {
    const fetched = [fetchedMessage('10', { content: 'same' })];
    const persisted = [persistedRow('10', 'same')];

    const result = diffChannel({ persisted, fetched, lastSeen: '10' });

    expect(result.edits).toEqual([]);
    expect(result.deletes).toEqual([]);
  });

  it('should detect a delete for a persisted id absent from the fetched set, within the covered window', () => {
    // fetched window covers ids 8..10; persisted id 9 is absent -> deleted offline
    const fetched = [fetchedMessage('8'), fetchedMessage('10')];
    const persisted = [persistedRow('8', 'content 8'), persistedRow('9', 'content 9'), persistedRow('10', 'content 10')];

    const result = diffChannel({ persisted, fetched, lastSeen: '10' });

    expect(result.deletes).toEqual([persistedRow('9', 'content 9')]);
  });

  it('should NOT report a delete for a persisted id below oldestFetchedId (outside the covered window)', () => {
    // fetched window's oldest id is 8; persisted id 5 is below it -> never concluded deleted
    const fetched = [fetchedMessage('8'), fetchedMessage('10')];
    const persisted = [persistedRow('5', 'ancient'), persistedRow('8', 'content 8'), persistedRow('10', 'content 10')];

    const result = diffChannel({ persisted, fetched, lastSeen: '10' });

    expect(result.deletes).toEqual([]);
  });

  it('should NOT report a delete for a persisted id that is present in the fetched set', () => {
    const fetched = [fetchedMessage('8'), fetchedMessage('9'), fetchedMessage('10')];
    const persisted = [persistedRow('8', 'content 8'), persistedRow('9', 'content 9'), persistedRow('10', 'content 10')];

    const result = diffChannel({ persisted, fetched, lastSeen: '10' });

    expect(result.deletes).toEqual([]);
  });

  it('should order ids by BigInt, not lexicographically, across 18- vs 19-digit snowflakes', () => {
    const older18 = '999999999999999999'; // 18 nines
    const newer19 = '1000000000000000000'; // 19 digits, numerically larger
    // Fetched window's oldest (by BigInt) is newer19 even though it looks
    // lexicographically "smaller" (leading '1' < leading '9').
    const fetched = [fetchedMessage(newer19)];
    const persisted = [persistedRow(older18, 'ancient'), persistedRow(newer19, 'content')];

    const result = diffChannel({ persisted, fetched, lastSeen: newer19 });

    // older18 is BELOW the fetched window's oldest id (BigInt compare) -> not deleted.
    expect(result.deletes).toEqual([]);
  });

  it('should NOT report a delete for the lastSeen anchor id itself (before is exclusive of it, absence is not evidence)', () => {
    // Fetch walks `before: lastSeen` — exclusive — so the anchor row is never
    // in `fetched` even when it is perfectly intact on Discord.
    const fetched = [fetchedMessage('8'), fetchedMessage('9')];
    const persisted = [
      persistedRow('8', 'content 8'),
      persistedRow('9', 'content 9'),
      persistedRow('10', 'content 10'), // the anchor — absent from fetched by construction
    ];

    const result = diffChannel({ persisted, fetched, lastSeen: '10' });

    expect(result.deletes).toEqual([]);
  });

  it('should conclude no deletes but STILL detect edits when lastSeen is not a parseable snowflake (fail-safe, note #5)', () => {
    // A malformed/non-numeric anchor means the exclusive-boundary anchor row
    // cannot be excluded from the delete window. Rather than fail OPEN (and risk
    // a false hard-purge), diffChannel concludes no deletes at all this run — but
    // the fail-safe guard lives in the DELETE branch only, so edit detection
    // (content diff, computed independently) must be unaffected.
    const editedEight = fetchedMessage('8', { content: 'edited offline' });
    const fetched = [editedEight, fetchedMessage('10')];
    const persisted = [
      persistedRow('8', 'content 8'), // content differs -> edit, regardless of the anchor
      persistedRow('9', 'content 9'), // would be an in-window delete with a valid anchor
      persistedRow('10', 'content 10'),
    ];

    const result = diffChannel({ persisted, fetched, lastSeen: '' });

    expect(result.deletes).toEqual([]);
    expect(result.edits).toEqual([editedEight]);
  });

  it('should conclude no deletes when fetched is empty (oldestFetchedId is undefined -> empty window)', () => {
    const persisted = [persistedRow('8', 'content 8'), persistedRow('9', 'content 9')];

    const result = diffChannel({ persisted, fetched: [], lastSeen: '10' });

    expect(result.deletes).toEqual([]);
    expect(result.edits).toEqual([]);
  });

  it('should count reconciled as the number of persisted rows compared', () => {
    const persisted = [persistedRow('8', 'a'), persistedRow('9', 'b'), persistedRow('10', 'c')];

    const result = diffChannel({ persisted, fetched: [], lastSeen: '10' });

    expect(result.reconciled).toBe(3);
  });
});
