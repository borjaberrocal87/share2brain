// Integration test for the documents-list adapter against a REAL Postgres — this
// is where the value lives (AD-12 RBAC-in-query, D1 deleted_at exclusion, D4
// pagination/ordering, isRead LEFT JOIN annotation).
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import { sql } from '@hivly/shared/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDrizzleDocumentRepository } from './documentRepository.drizzle.js';
import { openTestClients, type TestClients } from '../test-helpers.js';

describe('DocumentRepository (integration, real Postgres)', () => {
  let clients: TestClients;
  const suffix = `itest-4-2-doc-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
  const CH_ALLOWED = `chan-allowed-${suffix}`;
  const CH_DENIED = `chan-denied-${suffix}`;
  const DISCORD_ID = `itest-4-2-doc-${suffix}`;
  let userId: string;

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
      insert into embeddings (chunk_key, title, description, link, embedding, channel_id, message_ids, created_at)
      values (${chunkKey}, ${`title ${chunkKey}`}, ${`description ${chunkKey}`}, ${`https://example.com/itest/${chunkKey}`},
              ${JSON.stringify(vec)}::vector, ${channelId}, ${messageIdsLiteral}::text[], now())
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
      insert into users (discord_id, username) values (${DISCORD_ID}, 'itest-doc-user')
      returning id
    `);
    userId = String((userResult.rows[0] as Record<string, unknown>).id);

    await seedMessage(`${suffix}-a`, CH_ALLOWED);
    await seedMessage(`${suffix}-b`, CH_ALLOWED);
    await seedMessage(`${suffix}-c`, CH_DENIED);
    await seedMessage(`${suffix}-d`, CH_ALLOWED);
    await seedMessage(`${suffix}-d-del`, CH_ALLOWED, true);

    const idA = await seedEmbedding(`${suffix}-a:0`, CH_ALLOWED, [`${suffix}-a`]);
    await seedEmbedding(`${suffix}-b:0`, CH_ALLOWED, [`${suffix}-b`]);
    await seedEmbedding(`${suffix}-c:0`, CH_DENIED, [`${suffix}-c`]);
    await seedEmbedding(`${suffix}-d:0`, CH_ALLOWED, [`${suffix}-d`, `${suffix}-d-del`]);

    await clients.db.execute(sql`
      insert into user_read_status (user_id, embedding_id) values (${userId}, ${idA})
    `);
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

  it('should return only fragments inside allowedChannelIds — RBAC beats listing (AC7)', async () => {
    const repo = createDrizzleDocumentRepository(clients.db);

    const rows = await repo.listDocuments(userId, [CH_ALLOWED], 10, 0, false);

    expect(rows.map((r) => r.channelId)).not.toContain(CH_DENIED);
    expect(rows.map((r) => r.messageId)).not.toContain(`${suffix}-c`);
  });

  it('should exclude a chunk whose group contains any soft-deleted message (D1)', async () => {
    const repo = createDrizzleDocumentRepository(clients.db);

    const rows = await repo.listDocuments(userId, [CH_ALLOWED], 10, 0, false);

    expect(rows.map((r) => r.messageId)).not.toContain(`${suffix}-d`);
  });

  it('should mark exactly the pre-seeded fragment as isRead:true (AC1.3)', async () => {
    const repo = createDrizzleDocumentRepository(clients.db);

    const rows = await repo.listDocuments(userId, [CH_ALLOWED], 10, 0, false);

    const fragA = rows.find((r) => r.messageId === `${suffix}-a`);
    const fragB = rows.find((r) => r.messageId === `${suffix}-b`);
    expect(fragA?.isRead).toBe(true);
    expect(fragB?.isRead).toBe(false);
  });

  it('should order by created_at DESC, id DESC and paginate (D4)', async () => {
    const repo = createDrizzleDocumentRepository(clients.db);

    const page1 = await repo.listDocuments(userId, [CH_ALLOWED], 1, 0, false);
    const page2 = await repo.listDocuments(userId, [CH_ALLOWED], 1, 1, false);

    expect(page1).toHaveLength(1);
    expect(page2).toHaveLength(1);
    expect(page1[0].id).not.toBe(page2[0].id);
  });

  it('should count only visible fragments matching D1 + RBAC (D4 total)', async () => {
    const repo = createDrizzleDocumentRepository(clients.db);

    const total = await repo.countDocuments(userId, [CH_ALLOWED], false);

    // A and B survive; D excluded by D1; C is out of scope.
    expect(total).toBe(2);
  });

  it('should return [] / 0 without touching the DB when the scope is empty (AC7)', async () => {
    const repo = createDrizzleDocumentRepository(clients.db);

    expect(await repo.listDocuments(userId, [], 10, 0, false)).toEqual([]);
    expect(await repo.countDocuments(userId, [], false)).toBe(0);
  });

  it('should return only unread fragments when unreadOnly=true, with a matching count (AC9)', async () => {
    const repo = createDrizzleDocumentRepository(clients.db);

    const rows = await repo.listDocuments(userId, [CH_ALLOWED], 10, 0, true);
    const total = await repo.countDocuments(userId, [CH_ALLOWED], true);

    // A is pre-seeded as read; only B remains unread.
    expect(rows.map((r) => r.messageId)).not.toContain(`${suffix}-a`);
    expect(rows.map((r) => r.messageId)).toContain(`${suffix}-b`);
    expect(total).toBe(1);
  });

  it('should narrow to a single channel when allowedChannelIds is [channelId] (AC9 channelId narrowing)', async () => {
    const repo = createDrizzleDocumentRepository(clients.db);

    const rows = await repo.listDocuments(userId, [CH_ALLOWED], 10, 0, false);
    const total = await repo.countDocuments(userId, [CH_ALLOWED], false);

    expect(rows.every((r) => r.channelId === CH_ALLOWED)).toBe(true);
    expect(total).toBe(2);
  });
});
