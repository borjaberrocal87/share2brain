// Unit test for getChannelCursor — the derived per-channel backfill cursor.
// The db is mocked; the real newest-by-created_at ordering (and the snowflake
// length trap) is covered by the integration test.
import type { Database } from '@share2brain/shared/db';
import { describe, expect, it, vi } from 'vitest';

import { getChannelCursor } from './cursor.js';

function fakeDb(rows: Array<Record<string, unknown>>): {
  db: Database;
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn().mockResolvedValue({ rows });
  return { db: { execute } as unknown as Database, execute };
}

describe('getChannelCursor', () => {
  it('should return the id of the newest row when the channel has messages', async () => {
    const { db } = fakeDb([{ id: '1000000000000000000' }]);

    await expect(getChannelCursor(db, 'chan-1')).resolves.toBe('1000000000000000000');
  });

  it('should return null when the channel has no rows', async () => {
    const { db } = fakeDb([]);

    await expect(getChannelCursor(db, 'chan-1')).resolves.toBeNull();
  });

  it('should order by created_at (never MAX on the id text column)', async () => {
    const { db, execute } = fakeDb([{ id: '1' }]);

    await getChannelCursor(db, 'chan-1');

    // The query must ride idx_discord_messages_channel (channel_id, created_at DESC):
    // lexicographic MAX(id) would mis-order 18- vs 19-digit snowflakes.
    const query = execute.mock.calls[0][0] as { queryChunks?: unknown[] };
    const rendered = JSON.stringify(query);
    expect(rendered).toContain('order by created_at desc');
    expect(rendered).not.toContain('max(');
  });

  it('should throw (not return null) when the driver returns a non-string id', async () => {
    const { db } = fakeDb([{ id: 1000000000000000000 }]);

    // Must NOT collapse into the "confirmed first run" null — that would silently
    // downgrade an established channel to the bounded limit path (Review, 4th pass).
    await expect(getChannelCursor(db, 'chan-1')).rejects.toThrow(/unexpected id type/);
  });
});
