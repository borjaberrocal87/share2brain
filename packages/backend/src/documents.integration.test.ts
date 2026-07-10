// End-to-end integration test for GET /api/documents against a REAL Express app
// + REAL Postgres, with an INJECTED fake DiscordOAuthClient. Proves the full
// slice: the /api gate (401), query validation (400), pagination (D4), the
// AD-12 RBAC scope applied inside the query, D1 exclusion, and the isRead
// per-user annotation (AC1.3). Mirrors search.integration.test.ts.
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import { sql } from '@share2brain/shared/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { DiscordOAuthClient } from './domain/repositories/discordOAuthClient.js';
import { buildTestAppOptions, openTestClients, type TestClients } from './test-helpers.js';

const suffix = `itest-documents-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
const CH_ALLOWED = `chan-allowed-${suffix}`;
const CH_DENIED = `chan-denied-${suffix}`;
const MEMBER_DISCORD_ID = `itest-documents-${suffix}`;
// Suffix-unique role: RBAC expansion resolves against the WHOLE channel_permissions
// table, so a literal role like 'member' would pull in every other integration
// test's "allowed" channels when this suite's total/pagination assertions run
// concurrently with other files.
const ROLE_MEMBER = `member-${suffix}`;

function memberOAuth(roles: string[]): DiscordOAuthClient {
  return {
    exchangeCode: async () => ({ accessToken: 'tok' }),
    getCurrentUser: async () => ({ id: MEMBER_DISCORD_ID, username: 'itest-documents', avatar: null }),
    getGuildMember: async () => ({ roles }),
  };
}

async function loginMember(agent: ReturnType<typeof request.agent>): Promise<void> {
  const login = await agent.get('/api/auth/login');
  const state = new URL(login.headers.location).searchParams.get('state');
  const cb = await agent.get(`/api/auth/callback?code=code-documents&state=${state}`);
  expect(cb.status).toBe(302);
}

describe('GET /api/documents (integration)', () => {
  let clients: TestClients;

  async function seedMessage(id: string, channelId: string, deleted = false): Promise<void> {
    await clients.db.execute(sql`
      insert into discord_messages (id, channel_id, guild_id, author_id, content, created_at, updated_at, deleted_at)
      values (${id}, ${channelId}, 'itest-guild', ${`author-${id}`}, 'msg', now(), now(),
              ${deleted ? sql`now()` : sql`null`})
    `);
  }

  async function seedEmbedding(chunkKey: string, channelId: string, messageIds: string[]): Promise<void> {
    const messageIdsLiteral = `{${messageIds.join(',')}}`;
    const vec = new Array<number>(1536).fill(0);
    await clients.db.execute(sql`
      insert into embeddings (chunk_key, title, description, link, embedding, channel_id, message_ids, created_at)
      values (${chunkKey}, ${`title ${chunkKey}`}, ${`description ${chunkKey}`}, ${`https://example.com/itest/${chunkKey}`},
              ${JSON.stringify(vec)}::vector, ${channelId}, ${messageIdsLiteral}::text[], now())
    `);
  }

  beforeAll(async () => {
    clients = await openTestClients();

    await clients.db.execute(sql`
      insert into channel_permissions (channel_id, name, allowed_roles)
      values (${CH_ALLOWED}, 'Allowed Channel', ARRAY[${ROLE_MEMBER}]::text[]),
             (${CH_DENIED}, 'Denied Channel', ARRAY['owner']::text[])
    `);

    await seedMessage(`${suffix}-a`, CH_ALLOWED);
    await seedMessage(`${suffix}-b`, CH_DENIED);
    await seedMessage(`${suffix}-d`, CH_ALLOWED);
    await seedMessage(`${suffix}-d-del`, CH_ALLOWED, true);

    await seedEmbedding(`${suffix}-a:0`, CH_ALLOWED, [`${suffix}-a`]);
    await seedEmbedding(`${suffix}-b:0`, CH_DENIED, [`${suffix}-b`]);
    await seedEmbedding(`${suffix}-d:0`, CH_ALLOWED, [`${suffix}-d`, `${suffix}-d-del`]);
  });

  afterAll(async () => {
    const { db } = clients;
    await db.execute(sql`delete from user_read_status where embedding_id in (
      select id from embeddings where chunk_key like ${`${suffix}%`}
    )`);
    await db.execute(sql`delete from embeddings where chunk_key like ${`${suffix}%`}`);
    await db.execute(sql`delete from discord_messages where id like ${`${suffix}%`}`);
    await db.execute(sql`delete from channel_permissions where channel_id like ${`%${suffix}`}`);
    await db.execute(sql`delete from users where discord_id = ${MEMBER_DISCORD_ID}`);
    await clients.close();
  });

  it('should 401 without a session (generic /api gate)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions());

    const res = await request(app).get('/api/documents');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('should 400 VALIDATION_ERROR on an invalid limit', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE_MEMBER]) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/documents?limit=999');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('should list only fragments in channels the user can access — RBAC inside the query (AC7)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE_MEMBER]) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/documents?limit=100');

    expect(res.status).toBe(200);
    const messageIds = res.body.results.map((r: { messageId: string }) => r.messageId);
    expect(messageIds).toContain(`${suffix}-a`);
    expect(messageIds).not.toContain(`${suffix}-b`);
  });

  it('should round-trip title/description/link from the DB row', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE_MEMBER]) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/documents?limit=100');

    const frag = res.body.results.find((r: { messageId: string }) => r.messageId === `${suffix}-a`);
    expect(frag.title).toBe(`title ${suffix}-a:0`);
    expect(frag.description).toBe(`description ${suffix}-a:0`);
    expect(frag.link).toBe(`https://example.com/itest/${suffix}-a:0`);
  });

  it('should exclude a chunk whose group contains a soft-deleted message (D1)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE_MEMBER]) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/documents?limit=100');

    const messageIds = res.body.results.map((r: { messageId: string }) => r.messageId);
    expect(messageIds).not.toContain(`${suffix}-d`);
  });

  it('should mark exactly the pre-read fragment as isRead:true (AC1.3)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE_MEMBER]) }));
    const agent = request.agent(app);
    await loginMember(agent);

    // Mark fragment A as read via the write endpoint, then verify the list reflects it.
    const listBefore = await agent.get('/api/documents?limit=100');
    const fragA = listBefore.body.results.find((r: { messageId: string }) => r.messageId === `${suffix}-a`);
    expect(fragA.isRead).toBe(false);

    const markRes = await agent.post(`/api/read-status/${fragA.id}`);
    expect(markRes.status).toBe(200);

    const listAfter = await agent.get('/api/documents?limit=100');
    const fragAAfter = listAfter.body.results.find((r: { messageId: string }) => r.messageId === `${suffix}-a`);
    expect(fragAAfter.isRead).toBe(true);
  });

  it('should paginate with page/limit and report a stable total (D4)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE_MEMBER]) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/documents?page=1&limit=1');

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(1);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
  });

  it('should return HTTP 200 with an empty page for a user whose scope is empty (AC7)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth(['nobody']) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/documents');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [], page: 1, limit: 20, total: 0 });
  });

  it('should return only unread fragments when unreadOnly=true (AC9)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE_MEMBER]) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const before = await agent.get('/api/documents?limit=100');
    const fragA = before.body.results.find((r: { messageId: string }) => r.messageId === `${suffix}-a`);
    await agent.post(`/api/read-status/${fragA.id}`);

    const res = await agent.get('/api/documents?unreadOnly=true&limit=100');

    expect(res.status).toBe(200);
    const messageIds = res.body.results.map((r: { messageId: string }) => r.messageId);
    expect(messageIds).not.toContain(`${suffix}-a`);
  });

  it('should narrow the page to one channel via channelId (AC9)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE_MEMBER]) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get(`/api/documents?channelId=${CH_ALLOWED}&limit=100`);

    expect(res.status).toBe(200);
    expect(res.body.results.every((r: { channelId: string }) => r.channelId === CH_ALLOWED)).toBe(true);
  });

  it('should return an empty page for a channelId outside the caller scope — no existence leak (AC9)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE_MEMBER]) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get(`/api/documents?channelId=${CH_DENIED}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [], page: 1, limit: 20, total: 0 });
  });
});
