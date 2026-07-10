// Integration test for runOfflineSync against a REAL Postgres + Redis (AC-9):
// an offline edit lands discord.message.updated with the new content; an
// offline delete (absent from the re-fetch, within the covered window) lands
// discord.message.deleted; an unchanged message and a message below the
// window publish nothing; a null-cursor channel is skipped entirely; and the
// bot writes NO discord_messages rows itself (publish-only, note #2).
// Discord is NEVER hit — the client is faked at the boundary.
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import type { HivlyConfig } from '@hivly/shared';
import { sql } from '@hivly/shared/db';
import { STREAM_KEYS } from '@hivly/shared/types/events';
import type { Client } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openTestClients, type TestClients } from '../test-helpers.js';
import { runOfflineSync } from './offlineSync.js';
import type { FetchedMessage } from './reconcile.js';

const NOW = Date.now();
const RUN = `itest-6-3-${NOW}-${Math.round(Math.random() * 1_000_000)}`;
const GUILD = `${RUN}-guild`;
const CHANNEL = `${RUN}-chan`;
const EMPTY_CHANNEL = `${RUN}-empty-chan`;

// Run-unique salt embedded in every id below — NEVER a hardcoded literal
// snowflake, which would collide with backfill.integration.test.ts's own
// fixture ids (e.g. '999999999999999999') and race its id-scoped cleanup
// when both suites run concurrently (Epic 4 retro: run-unique test isolation).
const SALT = String(NOW).slice(-8).padStart(8, '0');

// Below the fetched window (oldest fetched id is ID_EDIT) — an 18-digit
// snowflake so a lexicographic compare would (wrongly) rank it ABOVE the
// 19-digit ids below, which would falsely include it in the window.
const ID_BELOW_WINDOW = `${'9'.repeat(10)}${SALT}`; // 18 digits
const ID_EDIT = `1${'0'.repeat(9)}${SALT}1`; // 19 digits
const ID_UNCHANGED = `1${'0'.repeat(9)}${SALT}2`;
const ID_DELETED = `1${'0'.repeat(9)}${SALT}3`;
const ID_LAST_SEEN = `1${'0'.repeat(9)}${SALT}4`; // newest row -> becomes the cursor anchor

const config = {
  discord: {
    guild_id: GUILD,
    channels: [
      { id: CHANNEL, name: 'itest', enabled: true },
      { id: EMPTY_CHANNEL, name: 'itest-empty', enabled: true },
    ],
    backfill: { enabled: true, limit: 1000, ignore_bots: true },
  },
} as unknown as HivlyConfig;

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function fetchedMessage(id: string, content: string): FetchedMessage {
  return {
    id,
    channelId: CHANNEL,
    guildId: GUILD,
    content,
    editedAt: new Date('2026-07-08T00:00:00.000Z'),
    author: { id: `${RUN}-author`, bot: false, displayName: 'Offline Author' },
    partial: false,
    fetch: () => Promise.resolve(fetchedMessage(id, content)),
  };
}

describe('offlineSync (integration)', () => {
  let clients: TestClients;
  const createdIds: string[] = [];
  const createdStreamEntries: Array<{ key: string; id: string }> = [];

  beforeAll(async () => {
    clients = await openTestClients();
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await clients.db.execute(sql`delete from discord_messages where id = ${id}`);
    }
    for (const entry of createdStreamEntries) {
      await clients.redis.xDel(entry.key, [entry.id]);
    }
    await clients.close();
  });

  async function insertRow(id: string, content: string, createdAt: string): Promise<void> {
    createdIds.push(id);
    await clients.db.execute(
      sql`insert into discord_messages (id, channel_id, guild_id, author_id, content, created_at, updated_at)
          values (${id}, ${CHANNEL}, ${GUILD}, ${`${RUN}-author`}, ${content}, ${createdAt}, ${createdAt})`,
    );
  }

  it('should reconcile an offline edit, an offline delete, an unchanged message, and skip a null-cursor channel', async () => {
    await insertRow(ID_BELOW_WINDOW, 'ancient content', '2021-12-01T00:00:00.000Z');
    await insertRow(ID_EDIT, 'original content', '2026-07-01T00:00:00.000Z');
    await insertRow(ID_UNCHANGED, 'stable content', '2026-07-02T00:00:00.000Z');
    await insertRow(ID_DELETED, 'about to be deleted', '2026-07-03T00:00:00.000Z');
    await insertRow(ID_LAST_SEEN, 'anchor content', '2026-07-04T00:00:00.000Z');

    // Fake Discord: one page covering [ID_EDIT, ID_UNCHANGED] (the anchor
    // ID_LAST_SEEN is deliberately never returned — `before` is exclusive —
    // and ID_DELETED is omitted to simulate an offline delete).
    const fetchedPage = new Map([
      [ID_EDIT, fetchedMessage(ID_EDIT, 'updated content')],
      [ID_UNCHANGED, fetchedMessage(ID_UNCHANGED, 'stable content')],
    ]);
    const channel = {
      isTextBased: () => true,
      messages: {
        fetch: (opts: { before?: string }): Promise<Map<string, FetchedMessage>> => {
          if (opts.before === ID_LAST_SEEN) return Promise.resolve(fetchedPage);
          return Promise.resolve(new Map()); // no further pages — head of history
        },
      },
    };
    const client = {
      channels: {
        fetch: (id: string): Promise<typeof channel | null> =>
          Promise.resolve(id === CHANNEL ? channel : null),
      },
    } as unknown as Client;

    await runOfflineSync({
      client,
      config,
      db: clients.db,
      redis: clients.redis,
      logger: silentLogger,
      signal: new AbortController().signal,
      sleep: () => Promise.resolve(),
    });

    // The edit landed on the updated stream with the NEW content.
    const updatedEntries = await clients.redis.xRange(STREAM_KEYS.DISCORD_MESSAGES_UPDATED, '-', '+');
    const editEntries = updatedEntries.filter((e) => e.message.messageId === ID_EDIT);
    expect(editEntries).toHaveLength(1);
    createdStreamEntries.push({ key: STREAM_KEYS.DISCORD_MESSAGES_UPDATED, id: editEntries[0].id });
    expect(editEntries[0].message).toEqual({
      type: 'discord.message.updated',
      messageId: ID_EDIT,
      channelId: CHANNEL,
      guildId: GUILD,
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as unknown,
      newContent: 'updated content',
      authorName: 'Offline Author',
    });

    // The unchanged message published nothing.
    const unchangedEntries = updatedEntries.filter((e) => e.message.messageId === ID_UNCHANGED);
    expect(unchangedEntries).toHaveLength(0);

    // The offline delete landed on the deleted stream.
    const deletedEntries = await clients.redis.xRange(STREAM_KEYS.DISCORD_MESSAGES_DELETED, '-', '+');
    const deleteEntries = deletedEntries.filter((e) => e.message.messageId === ID_DELETED);
    expect(deleteEntries).toHaveLength(1);
    createdStreamEntries.push({ key: STREAM_KEYS.DISCORD_MESSAGES_DELETED, id: deleteEntries[0].id });
    expect(deleteEntries[0].message).toEqual({
      type: 'discord.message.deleted',
      messageId: ID_DELETED,
      channelId: CHANNEL,
      guildId: GUILD,
      timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as unknown,
    });

    // The message BELOW the fetched window (18-digit, oldest) was never
    // concluded deleted, and the anchor itself was never concluded deleted.
    const noDeleteFor = [ID_BELOW_WINDOW, ID_LAST_SEEN];
    const wrongDeletes = deletedEntries.filter((e) => noDeleteFor.includes(e.message.messageId));
    expect(wrongDeletes).toHaveLength(0);

    // Publish-only: the bot wrote NO rows itself — every seeded row is intact,
    // exactly as inserted (content unchanged, deleted_at still null).
    const rows = await clients.db.execute(
      sql`select id, content, deleted_at from discord_messages where channel_id = ${CHANNEL} order by created_at asc`,
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({ id: ID_BELOW_WINDOW, content: 'ancient content', deleted_at: null }),
      expect.objectContaining({ id: ID_EDIT, content: 'original content', deleted_at: null }),
      expect.objectContaining({ id: ID_UNCHANGED, content: 'stable content', deleted_at: null }),
      expect.objectContaining({ id: ID_DELETED, content: 'about to be deleted', deleted_at: null }),
      expect.objectContaining({ id: ID_LAST_SEEN, content: 'anchor content', deleted_at: null }),
    ]);
  });

  it('should safely republish the same edit/delete on a redundant re-run (idempotent, AD-13)', async () => {
    // Same fixture as the previous test — the bot wrote no rows, so replaying
    // the identical re-fetch against the SAME persisted state is exactly what
    // a second boot without new backfill activity would see. This story does
    // not attempt exactness (AC-6): a redundant republish must not throw or
    // behave differently — the 6.2 Sync worker is what makes it converge.
    const fetchedPage = new Map([
      [ID_EDIT, fetchedMessage(ID_EDIT, 'updated content')],
      [ID_UNCHANGED, fetchedMessage(ID_UNCHANGED, 'stable content')],
    ]);
    const channel = {
      isTextBased: () => true,
      messages: {
        fetch: (opts: { before?: string }): Promise<Map<string, FetchedMessage>> => {
          if (opts.before === ID_LAST_SEEN) return Promise.resolve(fetchedPage);
          return Promise.resolve(new Map());
        },
      },
    };
    const client = {
      channels: {
        fetch: (id: string): Promise<typeof channel | null> =>
          Promise.resolve(id === CHANNEL ? channel : null),
      },
    } as unknown as Client;

    await expect(
      runOfflineSync({
        client,
        config,
        db: clients.db,
        redis: clients.redis,
        logger: silentLogger,
        signal: new AbortController().signal,
        sleep: () => Promise.resolve(),
      }),
    ).resolves.toBeUndefined();

    // The redundant run published a SECOND pair of events — offlineSync does
    // not dedupe (that's the worker's job via UPSERT/idempotent delete); it
    // only guarantees it never throws or corrupts persisted state on replay.
    const updatedEntries = await clients.redis.xRange(STREAM_KEYS.DISCORD_MESSAGES_UPDATED, '-', '+');
    const editEntries = updatedEntries.filter((e) => e.message.messageId === ID_EDIT);
    expect(editEntries).toHaveLength(2);
    createdStreamEntries.push({ key: STREAM_KEYS.DISCORD_MESSAGES_UPDATED, id: editEntries[1].id });

    const deletedEntries = await clients.redis.xRange(STREAM_KEYS.DISCORD_MESSAGES_DELETED, '-', '+');
    const deleteEntries = deletedEntries.filter((e) => e.message.messageId === ID_DELETED);
    expect(deleteEntries).toHaveLength(2);
    createdStreamEntries.push({ key: STREAM_KEYS.DISCORD_MESSAGES_DELETED, id: deleteEntries[1].id });

    // Still no DB write from the bot itself.
    const rows = await clients.db.execute(
      sql`select id, content, deleted_at from discord_messages where channel_id = ${CHANNEL} order by created_at asc`,
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({ id: ID_BELOW_WINDOW, content: 'ancient content', deleted_at: null }),
      expect.objectContaining({ id: ID_EDIT, content: 'original content', deleted_at: null }),
      expect.objectContaining({ id: ID_UNCHANGED, content: 'stable content', deleted_at: null }),
      expect.objectContaining({ id: ID_DELETED, content: 'about to be deleted', deleted_at: null }),
      expect.objectContaining({ id: ID_LAST_SEEN, content: 'anchor content', deleted_at: null }),
    ]);
  });

  it('should skip a channel with no persisted rows (null cursor) without touching Discord', async () => {
    const client = {
      channels: {
        fetch: (): Promise<never> => {
          throw new Error('must not be called for a null-cursor channel');
        },
      },
    } as unknown as Client;

    await expect(
      runOfflineSync({
        client,
        config: {
          ...config,
          discord: { ...config.discord, channels: [{ id: EMPTY_CHANNEL, name: 'itest-empty', enabled: true }] },
        } as unknown as HivlyConfig,
        db: clients.db,
        redis: clients.redis,
        logger: silentLogger,
        signal: new AbortController().signal,
        sleep: () => Promise.resolve(),
      }),
    ).resolves.toBeUndefined();
  });
});
