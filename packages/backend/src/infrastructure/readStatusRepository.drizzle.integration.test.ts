// Integration test for the read-status adapter against a REAL Postgres — this is
// where the value lives (AD-12 RBAC-in-query, D1 exclusion, idempotent
// mark/unmark, batched mark-all, per-channel unread counts).
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import { sql } from '@hivly/shared/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDrizzleReadStatusRepository } from './readStatusRepository.drizzle.js';
import { openTestClients, type TestClients } from '../test-helpers.js';

describe('ReadStatusRepository (integration, real Postgres)', () => {
  let clients: TestClients;
  const suffix = `itest-4-2-rs-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
  const CH_ALLOWED = `chan-allowed-${suffix}`;
  const CH_DENIED = `chan-denied-${suffix}`;
  const DISCORD_ID = `itest-4-2-rs-${suffix}`;
  let userId: string;
  let idA: string;
  let idB: string;
  let idC: string;
  let idD: string;

  async function seedMessage(id: string, channelId: string, deleted = false): Promise<void> {
    await clients.db.execute(sql`
      insert into discord_messages (id, channel_id, guild_id, author_id, content, created_at, updated_at, deleted_at)
      values (${id}, ${channelId}, 'itest-guild', ${`author-${id}`}, 'msg content', now(), now(),
              ${deleted ? sql`now()` : sql`null`})
    `);
  }

  async function seedEmbedding(
    chunkKey: string,
    channelId: string,
    messageIds: string[],
  ): Promise<string> {
    const messageIdsLiteral = `{${messageIds.join(',')}}`;
    const vec = new Array<number>(1536).fill(0);
    const result = await clients.db.execute(sql`
      insert into embeddings (chunk_key, content, embedding, channel_id, message_ids, created_at)
      values (${chunkKey}, ${`content ${chunkKey}`}, ${JSON.stringify(vec)}::vector, ${channelId},
              ${messageIdsLiteral}::text[], now())
      returning id
    `);
    return String((result.rows[0] as Record<string, unknown>).id);
  }

  beforeAll(async () => {
    clients = await openTestClients();

    await clients.db.execute(sql`
      insert into channel_permissions (channel_id, name, allowed_roles)
      values (${CH_ALLOWED}, 'Allowed Channel', ARRAY['member']::text[]),
             (${CH_DENIED}, 'Denied Channel', ARRAY['owner']::text[])
    `);

    const userResult = await clients.db.execute(sql`
      insert into users (discord_id, username) values (${DISCORD_ID}, 'itest-rs-user')
      returning id
    `);
    userId = String((userResult.rows[0] as Record<string, unknown>).id);

    await seedMessage(`${suffix}-a`, CH_ALLOWED);
    await seedMessage(`${suffix}-b`, CH_ALLOWED);
    await seedMessage(`${suffix}-c`, CH_DENIED);
    await seedMessage(`${suffix}-d`, CH_ALLOWED);
    await seedMessage(`${suffix}-d-del`, CH_ALLOWED, true);

    idA = await seedEmbedding(`${suffix}-a:0`, CH_ALLOWED, [`${suffix}-a`]);
    idB = await seedEmbedding(`${suffix}-b:0`, CH_ALLOWED, [`${suffix}-b`]);
    idC = await seedEmbedding(`${suffix}-c:0`, CH_DENIED, [`${suffix}-c`]);
    idD = await seedEmbedding(`${suffix}-d:0`, CH_ALLOWED, [`${suffix}-d`, `${suffix}-d-del`]);
  });

  afterAll(async () => {
    const { db } = clients;
    await db.execute(sql`delete from user_read_status where user_id = ${userId}`);
    await db.execute(sql`delete from embeddings where chunk_key like ${`${suffix}%`}`);
    await db.execute(sql`delete from discord_messages where id like ${`${suffix}%`}`);
    await db.execute(sql`delete from channel_permissions where channel_id like ${`%${suffix}`}`);
    await db.execute(sql`delete from users where discord_id = ${DISCORD_ID}`);
    await clients.close();
  });

  describe('findVisibleEmbeddingChannel', () => {
    it('should return the channel id for a visible fragment', async () => {
      const repo = createDrizzleReadStatusRepository(clients.db);
      expect(await repo.findVisibleEmbeddingChannel(idA, [CH_ALLOWED])).toBe(CH_ALLOWED);
    });

    it('should return null for a fragment outside allowedChannelIds (AC7)', async () => {
      const repo = createDrizzleReadStatusRepository(clients.db);
      expect(await repo.findVisibleEmbeddingChannel(idC, [CH_ALLOWED])).toBeNull();
    });

    it('should return null for a D1-excluded fragment', async () => {
      const repo = createDrizzleReadStatusRepository(clients.db);
      expect(await repo.findVisibleEmbeddingChannel(idD, [CH_ALLOWED])).toBeNull();
    });

    it('should return null without touching the DB when scope is empty', async () => {
      const repo = createDrizzleReadStatusRepository(clients.db);
      expect(await repo.findVisibleEmbeddingChannel(idA, [])).toBeNull();
    });
  });

  describe('markRead / unmarkRead', () => {
    it('should be idempotent — two markRead calls leave exactly one row', async () => {
      const repo = createDrizzleReadStatusRepository(clients.db);
      await repo.markRead(userId, idB);
      await repo.markRead(userId, idB);

      const result = await clients.db.execute(sql`
        select count(*)::int as c from user_read_status where user_id = ${userId} and embedding_id = ${idB}
      `);
      expect((result.rows[0] as Record<string, unknown>).c).toBe(1);
    });

    it('should be idempotent — unmarkRead on a non-existent row still succeeds', async () => {
      const repo = createDrizzleReadStatusRepository(clients.db);
      await expect(repo.unmarkRead(userId, idA)).resolves.toBeUndefined();
      await expect(repo.unmarkRead(userId, idA)).resolves.toBeUndefined();
    });

    it('should remove the row on unmarkRead', async () => {
      const repo = createDrizzleReadStatusRepository(clients.db);
      await repo.markRead(userId, idB);
      await repo.unmarkRead(userId, idB);

      const result = await clients.db.execute(sql`
        select count(*)::int as c from user_read_status where user_id = ${userId} and embedding_id = ${idB}
      `);
      expect((result.rows[0] as Record<string, unknown>).c).toBe(0);
    });
  });

  describe('markAllInChannels', () => {
    it('should mark every visible, not-already-read fragment and count only new inserts (AC5)', async () => {
      const repo = createDrizzleReadStatusRepository(clients.db);

      const firstRun = await repo.markAllInChannels(userId, [CH_ALLOWED]);
      // A, B visible (D excluded by D1); neither pre-read for this fresh assertion
      // (previous describe block's markRead/unmarkRead left B unread).
      expect(firstRun).toBeGreaterThanOrEqual(1);

      const secondRun = await repo.markAllInChannels(userId, [CH_ALLOWED]);
      expect(secondRun).toBe(0);
    });

    it('should return 0 without touching the DB when channelIds is empty', async () => {
      const repo = createDrizzleReadStatusRepository(clients.db);
      expect(await repo.markAllInChannels(userId, [])).toBe(0);
    });

    it('should never mark a fragment outside the given channelIds', async () => {
      const repo = createDrizzleReadStatusRepository(clients.db);
      await repo.markAllInChannels(userId, [CH_ALLOWED]);

      const result = await clients.db.execute(sql`
        select count(*)::int as c from user_read_status where user_id = ${userId} and embedding_id = ${idC}
      `);
      expect((result.rows[0] as Record<string, unknown>).c).toBe(0);
    });
  });

  describe('unreadCountByChannel', () => {
    it('should count only visible, unread fragments per channel (D7)', async () => {
      const repo = createDrizzleReadStatusRepository(clients.db);
      await clients.db.execute(sql`delete from user_read_status where user_id = ${userId}`);
      await repo.markRead(userId, idA);

      const counts = await repo.unreadCountByChannel(userId, [CH_ALLOWED]);

      // A is read (excluded); B is unread (counted); D is D1-excluded (never counted).
      expect(counts[CH_ALLOWED]).toBe(1);
    });

    it('should never include a channel outside allowedChannelIds', async () => {
      const repo = createDrizzleReadStatusRepository(clients.db);
      const counts = await repo.unreadCountByChannel(userId, [CH_ALLOWED]);
      expect(counts[CH_DENIED]).toBeUndefined();
    });

    it('should return {} without touching the DB when scope is empty', async () => {
      const repo = createDrizzleReadStatusRepository(clients.db);
      expect(await repo.unreadCountByChannel(userId, [])).toEqual({});
    });
  });
});
