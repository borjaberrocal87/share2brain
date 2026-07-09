// End-to-end integration test for the read-status endpoints (POST/DELETE
// /api/read-status/:embeddingId, POST /api/read-status/mark-all, GET
// /api/read-status/unread-count) against a REAL Express app + REAL Postgres,
// with an INJECTED fake DiscordOAuthClient. Proves RBAC scoping (404/403),
// idempotency, and batched mark-all. Mirrors documents.integration.test.ts.
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import { sql } from '@hivly/shared/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { DiscordOAuthClient } from './domain/repositories/discordOAuthClient.js';
import { buildTestAppOptions, openTestClients, type TestClients } from './test-helpers.js';

const suffix = `itest-readstatus-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
const CH_ALLOWED = `chan-allowed-${suffix}`;
const CH_DENIED = `chan-denied-${suffix}`;
const MEMBER_DISCORD_ID = `itest-readstatus-${suffix}`;
// Suffix-unique role: RBAC expansion resolves against the WHOLE channel_permissions
// table, so a literal role like 'member' would pull in every other integration
// test's "allowed" channels when this file's mark-all acts on the FULL scope.
const ROLE_MEMBER = `member-${suffix}`;

function memberOAuth(roles: string[]): DiscordOAuthClient {
  return {
    exchangeCode: async () => ({ accessToken: 'tok' }),
    getCurrentUser: async () => ({ id: MEMBER_DISCORD_ID, username: 'itest-readstatus', avatar: null }),
    getGuildMember: async () => ({ roles }),
  };
}

async function loginMember(agent: ReturnType<typeof request.agent>): Promise<void> {
  const login = await agent.get('/api/auth/login');
  const state = new URL(login.headers.location).searchParams.get('state');
  const cb = await agent.get(`/api/auth/callback?code=code-readstatus&state=${state}`);
  expect(cb.status).toBe(302);
}

describe('/api/read-status (integration)', () => {
  let clients: TestClients;
  let idAllowed: string;
  let idDenied: string;

  async function seedMessage(id: string, channelId: string): Promise<void> {
    await clients.db.execute(sql`
      insert into discord_messages (id, channel_id, guild_id, author_id, content, created_at, updated_at)
      values (${id}, ${channelId}, 'itest-guild', ${`author-${id}`}, 'msg', now(), now())
    `);
  }

  async function seedEmbedding(chunkKey: string, channelId: string, messageIds: string[]): Promise<string> {
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
      values (${CH_ALLOWED}, 'Allowed Channel', ARRAY[${ROLE_MEMBER}]::text[]),
             (${CH_DENIED}, 'Denied Channel', ARRAY['owner']::text[])
    `);

    await seedMessage(`${suffix}-a`, CH_ALLOWED);
    await seedMessage(`${suffix}-c`, CH_DENIED);
    idAllowed = await seedEmbedding(`${suffix}-a:0`, CH_ALLOWED, [`${suffix}-a`]);
    idDenied = await seedEmbedding(`${suffix}-c:0`, CH_DENIED, [`${suffix}-c`]);
  });

  afterAll(async () => {
    const { db } = clients;
    await db.execute(sql`delete from user_read_status where embedding_id in (${idAllowed}, ${idDenied})`);
    await db.execute(sql`delete from embeddings where chunk_key like ${`${suffix}%`}`);
    await db.execute(sql`delete from discord_messages where id like ${`${suffix}%`}`);
    await db.execute(sql`delete from channel_permissions where channel_id like ${`%${suffix}`}`);
    await db.execute(sql`delete from users where discord_id = ${MEMBER_DISCORD_ID}`);
    await clients.close();
  });

  it('should 401 without a session on every read-status route', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions());

    expect((await request(app).post(`/api/read-status/${idAllowed}`)).status).toBe(401);
    expect((await request(app).delete(`/api/read-status/${idAllowed}`)).status).toBe(401);
    expect((await request(app).post('/api/read-status/mark-all')).status).toBe(401);
    expect((await request(app).get('/api/read-status/unread-count')).status).toBe(401);
  });

  it('should 400 on a non-UUID embeddingId', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE_MEMBER]) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.post('/api/read-status/not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('should 404 on POST for a fragment outside RBAC scope (D5) without leaking existence', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE_MEMBER]) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.post(`/api/read-status/${idDenied}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('should mark a visible fragment as read idempotently (AC3)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE_MEMBER]) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const first = await agent.post(`/api/read-status/${idAllowed}`);
    const second = await agent.post(`/api/read-status/${idAllowed}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const result = await clients.db.execute(sql`
      select count(*)::int as c from user_read_status where embedding_id = ${idAllowed}
    `);
    expect((result.rows[0] as Record<string, unknown>).c).toBe(1);
  });

  it('should DELETE idempotently, even for a non-existent row (AC4)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE_MEMBER]) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const first = await agent.delete(`/api/read-status/${idAllowed}`);
    const second = await agent.delete(`/api/read-status/${idAllowed}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it('should 403 on mark-all with a channelId outside RBAC scope (D6)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE_MEMBER]) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.post('/api/read-status/mark-all').send({ channelId: CH_DENIED });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('should mark-all with an omitted channelId across the whole scope and count only new inserts (D6, AC5)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE_MEMBER]) }));
    const agent = request.agent(app);
    await loginMember(agent);
    // Start from a clean slate for this user/fragment.
    await agent.delete(`/api/read-status/${idAllowed}`);

    const first = await agent.post('/api/read-status/mark-all').send({});
    expect(first.status).toBe(200);
    expect(first.body.markedCount).toBeGreaterThanOrEqual(1);

    const second = await agent.post('/api/read-status/mark-all').send({});
    expect(second.status).toBe(200);
    expect(second.body.markedCount).toBe(0);

    // The denied fragment must never be marked by an all-scope mark-all.
    const denied = await clients.db.execute(sql`
      select count(*)::int as c from user_read_status where embedding_id = ${idDenied}
    `);
    expect((denied.rows[0] as Record<string, unknown>).c).toBe(0);
  });

  it('should return a per-channel unread-count map excluding out-of-scope channels (D7)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE_MEMBER]) }));
    const agent = request.agent(app);
    await loginMember(agent);
    await agent.delete(`/api/read-status/${idAllowed}`);

    const res = await agent.get('/api/read-status/unread-count');

    expect(res.status).toBe(200);
    expect(res.body[CH_ALLOWED]).toBeGreaterThanOrEqual(1);
    expect(res.body[CH_DENIED]).toBeUndefined();
  });

  it('should return HTTP 200 with an empty map for a user whose scope is empty', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth(['nobody']) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/read-status/unread-count');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });
});
