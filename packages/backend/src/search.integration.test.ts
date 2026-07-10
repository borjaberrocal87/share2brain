// End-to-end integration test for GET /api/search against a REAL Express app +
// REAL Postgres + pgvector + Redis, with an INJECTED fake DiscordOAuthClient and
// the default fake query embedder (one-hot at index 0). Proves the full slice:
// the /api gate (401), query validation (400), and the AD-12 RBAC scope applied
// inside the vector query end-to-end (a fragment in a channel the user cannot see
// never surfaces, even when it is identical to the query), plus AC3 (empty scope).
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import { sql } from '@share2brain/shared/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { DiscordOAuthClient } from './domain/repositories/discordOAuthClient.js';
import { buildTestAppOptions, openTestClients, type TestClients } from './test-helpers.js';

const DIMENSIONS = 1536;
const suffix = `itest-search-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
const CH_ALLOWED = `chan-allowed-${suffix}`;
const CH_DENIED = `chan-denied-${suffix}`;
const MEMBER_DISCORD_ID = `itest-search-${suffix}`;

function oneHot(index: number): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  v[index] = 1;
  return v;
}

function memberOAuth(roles: string[]): DiscordOAuthClient {
  return {
    exchangeCode: async () => ({ accessToken: 'tok' }),
    getCurrentUser: async () => ({ id: MEMBER_DISCORD_ID, username: 'itest-search', avatar: null }),
    getGuildMember: async () => ({ roles }),
  };
}

async function loginMember(agent: ReturnType<typeof request.agent>): Promise<void> {
  const login = await agent.get('/api/auth/login');
  const state = new URL(login.headers.location).searchParams.get('state');
  const cb = await agent.get(`/api/auth/callback?code=code-search&state=${state}`);
  expect(cb.status).toBe(302);
}

describe('GET /api/search (integration)', () => {
  let clients: TestClients;

  async function seedMessage(id: string, channelId: string): Promise<void> {
    await clients.db.execute(sql`
      insert into discord_messages (id, channel_id, guild_id, author_id, content, created_at, updated_at)
      values (${id}, ${channelId}, 'itest-guild', ${`author-${id}`}, 'msg', now(), now())
    `);
  }

  async function seedEmbedding(chunkKey: string, channelId: string, messageIds: string[], vec: number[]): Promise<void> {
    const messageIdsLiteral = `{${messageIds.join(',')}}`;
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
      values (${CH_ALLOWED}, 'Allowed Channel', ARRAY['member']::text[]),
             (${CH_DENIED}, 'Denied Channel', ARRAY['owner']::text[])
    `);

    await seedMessage(`${suffix}-a`, CH_ALLOWED);
    await seedMessage(`${suffix}-denied`, CH_DENIED);
    // Both fragments are one-hot(0), identical to the fake embedder's query vector.
    // Only the allowed one may surface — RBAC lives inside the query.
    await seedEmbedding(`${suffix}-a:0`, CH_ALLOWED, [`${suffix}-a`], oneHot(0));
    await seedEmbedding(`${suffix}-denied:0`, CH_DENIED, [`${suffix}-denied`], oneHot(0));
  });

  afterAll(async () => {
    const { db } = clients;
    await db.execute(sql`delete from embeddings where chunk_key like ${`${suffix}%`}`);
    await db.execute(sql`delete from discord_messages where id like ${`${suffix}%`}`);
    await db.execute(sql`delete from channel_permissions where channel_id like ${`%${suffix}`}`);
    await db.execute(sql`delete from users where discord_id = ${MEMBER_DISCORD_ID}`);
    await clients.close();
  });

  it('should 401 without a session (generic /api gate)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions());

    const res = await request(app).get('/api/search?q=hello');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('should 400 VALIDATION_ERROR when q is missing (AC4)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth(['member']) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/search');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Query requerida', code: 'VALIDATION_ERROR' });
  });

  it('should return only fragments in channels the user can access — RBAC inside the query (AC1, AC5)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth(['member']) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/search?q=hello');

    expect(res.status).toBe(200);
    const messageIds = res.body.results.map((r: { messageId: string }) => r.messageId);
    expect(messageIds).toContain(`${suffix}-a`);
    // The denied fragment is IDENTICAL to the query but must never surface.
    expect(messageIds).not.toContain(`${suffix}-denied`);
    // Response shape (AC2): the allowed fragment carries the expected fields.
    const frag = res.body.results.find((r: { messageId: string }) => r.messageId === `${suffix}-a`);
    expect(frag.channelId).toBe(CH_ALLOWED);
    expect(frag.channelName).toBe('Allowed Channel');
    expect(frag.similarity).toBeCloseTo(1, 3);
  });

  it('should round-trip title/description/link from the DB row', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth(['member']) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/search?q=hello');

    const frag = res.body.results.find((r: { messageId: string }) => r.messageId === `${suffix}-a`);
    expect(frag.title).toBe(`title ${suffix}-a:0`);
    expect(frag.description).toBe(`description ${suffix}-a:0`);
    expect(frag.link).toBe(`https://example.com/itest/${suffix}-a:0`);
  });

  it('should return HTTP 200 with an empty array for a user whose scope is empty (AC3)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth(['nobody']) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/search?q=hello');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [] });
  });
});
