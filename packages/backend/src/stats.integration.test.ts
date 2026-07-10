// End-to-end integration test for GET /api/stats against a REAL Express app +
// REAL Postgres + Redis, with an INJECTED fake DiscordOAuthClient. Proves the
// AD-12 RBAC-in-query filter across every aggregation: a denied channel B must
// never surface in any figure — not even its existence in `channels[]` — while
// an allowed channel A drives the KPIs, the 14-day activity window, and
// personal read/query coverage for the logged-in user. Mirrors
// documents.integration.test.ts / conversations.integration.test.ts.
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import { sql } from '@hivly/shared/db';
import { StatsResponseSchema, type StatsResponse } from '@hivly/shared/schemas';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { DiscordOAuthClient } from './domain/repositories/discordOAuthClient.js';
import { buildTestAppOptions, openTestClients, type TestClients } from './test-helpers.js';

const suffix = `itest-stats-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
const CH_ALLOWED = `chan-allowed-${suffix}`;
const CH_DENIED = `chan-denied-${suffix}`;
const CH_ALLOWED_NAME = `Allowed Channel ${suffix}`;
const MEMBER_DISCORD_ID = `${suffix}-member`;
const OTHER_DISCORD_ID = `${suffix}-other`;
// Suffix-unique role: RBAC expansion resolves against the WHOLE channel_permissions
// table, so a literal role like 'member' would pull in every other integration
// test's "allowed" channels — this suite asserts ABSOLUTE counts, so that leak
// would silently inflate every KPI.
const ROLE_MEMBER = `member-${suffix}`;

function memberOAuth(discordId: string, roles: string[]): DiscordOAuthClient {
  return {
    exchangeCode: async () => ({ accessToken: 'tok' }),
    getCurrentUser: async () => ({ id: discordId, username: discordId, avatar: null }),
    getGuildMember: async () => ({ roles }),
  };
}

async function login(agent: ReturnType<typeof request.agent>, code: string): Promise<void> {
  const loginRes = await agent.get('/api/auth/login');
  const state = new URL(loginRes.headers.location).searchParams.get('state');
  const cb = await agent.get(`/api/auth/callback?code=${code}&state=${state}`);
  expect(cb.status).toBe(302);
}

describe('GET /api/stats (integration)', () => {
  let clients: TestClients;
  const ids: Record<string, string> = {};

  async function getUserId(discordId: string): Promise<string> {
    const result = await clients.db.execute(
      sql`SELECT id FROM users WHERE discord_id = ${discordId} LIMIT 1`,
    );
    return String((result.rows[0] as { id: string }).id);
  }

  async function seedMessage(
    id: string,
    channelId: string,
    authorId: string,
    deleted = false,
  ): Promise<void> {
    await clients.db.execute(sql`
      insert into discord_messages (id, channel_id, guild_id, author_id, content, created_at, updated_at, deleted_at)
      values (${id}, ${channelId}, 'itest-guild', ${authorId}, 'msg', now(), now(),
              ${deleted ? sql`now()` : sql`null`})
    `);
  }

  async function seedEmbedding(
    chunkKey: string,
    channelId: string,
    messageIds: string[],
    createdAt: string,
  ): Promise<string> {
    const messageIdsLiteral = `{${messageIds.join(',')}}`;
    const vec = new Array<number>(1536).fill(0);
    const result = await clients.db.execute(sql`
      insert into embeddings (chunk_key, title, description, link, embedding, channel_id, message_ids, created_at)
      values (${chunkKey}, ${`title ${chunkKey}`}, ${`description ${chunkKey}`}, ${`https://example.com/itest/${chunkKey}`},
              ${JSON.stringify(vec)}::vector, ${channelId}, ${messageIdsLiteral}::text[], ${createdAt})
      returning id
    `);
    return String((result.rows[0] as { id: string }).id);
  }

  async function insertConversation(userId: string): Promise<string> {
    const result = await clients.db.execute(sql`
      INSERT INTO conversations (user_id) VALUES (${userId}) RETURNING id
    `);
    return String((result.rows[0] as { id: string }).id);
  }

  async function insertMessage(
    conversationId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
  ): Promise<void> {
    await clients.db.execute(sql`
      INSERT INTO messages (conversation_id, role, content, citations)
      VALUES (${conversationId}, ${role}, ${content}, '[]'::jsonb)
    `);
  }

  function appForMember() {
    return createApp(clients.db, clients.redis, {
      ...buildTestAppOptions(),
      oauth: memberOAuth(MEMBER_DISCORD_ID, [ROLE_MEMBER]),
    });
  }

  beforeAll(async () => {
    clients = await openTestClients();

    await clients.db.execute(sql`
      insert into channel_permissions (channel_id, name, allowed_roles)
      values (${CH_ALLOWED}, ${CH_ALLOWED_NAME}, ARRAY[${ROLE_MEMBER}]::text[]),
             (${CH_DENIED}, 'Denied Channel', ARRAY['owner']::text[])
    `);

    // Log in both users once so their `users` rows exist, then seed directly.
    const agentMember = request.agent(appForMember());
    await login(agentMember, `${suffix}-seed-member`);
    const appOther = createApp(clients.db, clients.redis, {
      ...buildTestAppOptions(),
      oauth: memberOAuth(OTHER_DISCORD_ID, [ROLE_MEMBER]),
    });
    const agentOther = request.agent(appOther);
    await login(agentOther, `${suffix}-seed-other`);

    const memberUserId = await getUserId(MEMBER_DISCORD_ID);
    const otherUserId = await getUserId(OTHER_DISCORD_ID);

    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
    const todayStr = now.toISOString().slice(0, 10);
    const threeDaysAgoStr = threeDaysAgo.toISOString().slice(0, 10);
    const twentyDaysAgoStr = twentyDaysAgo.toISOString().slice(0, 10);

    await seedMessage(`${suffix}-a-today`, CH_ALLOWED, `${suffix}-author-today`);
    await seedMessage(`${suffix}-a-3d`, CH_ALLOWED, `${suffix}-author-3d`);
    await seedMessage(`${suffix}-a-20d`, CH_ALLOWED, `${suffix}-author-20d`);
    await seedMessage(`${suffix}-a-del`, CH_ALLOWED, `${suffix}-author-del`, true);
    await seedMessage(`${suffix}-b`, CH_DENIED, `${suffix}-author-b`);

    const embeddingAToday = await seedEmbedding(
      `${suffix}-a-today:0`,
      CH_ALLOWED,
      [`${suffix}-a-today`],
      now.toISOString(),
    );
    await seedEmbedding(`${suffix}-a-3d:0`, CH_ALLOWED, [`${suffix}-a-3d`], threeDaysAgo.toISOString());
    await seedEmbedding(`${suffix}-a-20d:0`, CH_ALLOWED, [`${suffix}-a-20d`], twentyDaysAgo.toISOString());
    // D4: anchor message is soft-deleted — this embedding must be excluded from EVERY figure.
    await seedEmbedding(`${suffix}-a-del:0`, CH_ALLOWED, [`${suffix}-a-del`], now.toISOString());
    // Channel B — must never surface, in any figure, not even channels[] existence.
    await seedEmbedding(`${suffix}-b:0`, CH_DENIED, [`${suffix}-b`], now.toISOString());

    // Mark the "today" A-embedding read for the session (member) user.
    const markRes = await agentMember.post(`/api/read-status/${embeddingAToday}`);
    expect(markRes.status).toBe(200);

    // Agent-usage KPI: 2 own `user` messages + 1 `assistant` reply for the session
    // user; a second conversation for ANOTHER user must not be counted.
    const convMember = await insertConversation(memberUserId);
    await insertMessage(convMember, 'user', 'first question');
    await insertMessage(convMember, 'assistant', 'an answer');
    await insertMessage(convMember, 'user', 'second question');
    const convOther = await insertConversation(otherUserId);
    await insertMessage(convOther, 'user', "another user's question");

    Object.assign(ids, {
      memberUserId,
      otherUserId,
      embeddingAToday,
      todayStr,
      threeDaysAgoStr,
      twentyDaysAgoStr,
    });
  });

  afterAll(async () => {
    const { db } = clients;
    await db.execute(sql`
      DELETE FROM user_read_status WHERE embedding_id IN (
        SELECT id FROM embeddings WHERE chunk_key LIKE ${`${suffix}%`}
      )
    `);
    await db.execute(sql`DELETE FROM embeddings WHERE chunk_key LIKE ${`${suffix}%`}`);
    await db.execute(sql`DELETE FROM discord_messages WHERE id LIKE ${`${suffix}%`}`);
    await db.execute(sql`DELETE FROM channel_permissions WHERE channel_id LIKE ${`%${suffix}`}`);
    await db.execute(sql`
      DELETE FROM messages WHERE conversation_id IN (
        SELECT id FROM conversations WHERE user_id IN (
          SELECT id FROM users WHERE discord_id IN (${MEMBER_DISCORD_ID}, ${OTHER_DISCORD_ID})
        )
      )
    `);
    await db.execute(sql`
      DELETE FROM conversations WHERE user_id IN (
        SELECT id FROM users WHERE discord_id IN (${MEMBER_DISCORD_ID}, ${OTHER_DISCORD_ID})
      )
    `);
    await db.execute(
      sql`DELETE FROM users WHERE discord_id IN (${MEMBER_DISCORD_ID}, ${OTHER_DISCORD_ID})`,
    );
    await clients.close();
  });

  it('should 401 without a session (generic /api gate)', async () => {
    const res = await request(appForMember()).get('/api/stats');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: expect.any(String), code: 'AUTH_REQUIRED' });
  });

  it('should return a 200 body that satisfies the shared StatsResponse contract (AD-6)', async () => {
    const agent = request.agent(appForMember());
    await login(agent, `${suffix}-shape`);

    const res = await agent.get('/api/stats');

    expect(res.status).toBe(200);
    expect(() => StatsResponseSchema.parse(res.body)).not.toThrow();
  });

  it('should scope the resources/channels/authors KPIs to channel A, excluding B and the deleted row (AC2, AC3, D4)', async () => {
    const agent = request.agent(appForMember());
    await login(agent, `${suffix}-kpis`);

    const res = await agent.get('/api/stats');
    const body = res.body as StatsResponse;

    const byKey = Object.fromEntries(body.kpis.map((k) => [k.key, k]));
    // 3 non-deleted A rows (today, 3d, 20d) — the deleted-anchor row and B's row excluded.
    expect(byKey.resources.value).toBe(3);
    expect(byKey.resources.sub).toBe('+2 esta semana'); // today + 3d fall inside the 7-day window
    expect(byKey.channels.value).toBe(1); // only channel A
    expect(byKey.channels.sub).toBe('de 1 accesibles');
    expect(byKey.authors.value).toBe(3); // 3 distinct authors across today/3d/20d
  });

  it('should never surface channel B — not even its existence — in channels[] (AC3, no leak)', async () => {
    const agent = request.agent(appForMember());
    await login(agent, `${suffix}-channels`);

    const res = await agent.get('/api/stats');
    const body = res.body as StatsResponse;

    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]).toEqual({ channelId: CH_ALLOWED, channelName: CH_ALLOWED_NAME, count: 3 });
    expect(body.channels.some((c) => c.channelId === CH_DENIED)).toBe(false);
  });

  it('should return exactly 14 zero-filled activity days, correct today/3d-ago counts, 20d-ago absent (AC4)', async () => {
    const agent = request.agent(appForMember());
    await login(agent, `${suffix}-activity`);

    const res = await agent.get('/api/stats');
    const body = res.body as StatsResponse;

    expect(body.activity).toHaveLength(14);
    const byDate = Object.fromEntries(body.activity.map((p) => [p.date, p.count]));
    expect(byDate[ids.todayStr]).toBe(1);
    expect(byDate[ids.threeDaysAgoStr]).toBe(1);
    expect(byDate[ids.twentyDaysAgoStr]).toBeUndefined(); // outside the 14-day window entirely

    const knownDates = new Set([ids.todayStr, ids.threeDaysAgoStr]);
    for (const point of body.activity) {
      if (!knownDates.has(point.date)) expect(point.count).toBe(0);
    }
  });

  it("should report the session user's own read coverage over the scoped total (AC5)", async () => {
    const agent = request.agent(appForMember());
    await login(agent, `${suffix}-coverage`);

    const res = await agent.get('/api/stats');
    const body = res.body as StatsResponse;

    expect(body.coverage).toEqual({ readCount: 1, totalCount: 3, readPct: 33 });
  });

  it("should count only the session user's own `user`-role messages for the queries KPI (D3)", async () => {
    const agent = request.agent(appForMember());
    await login(agent, `${suffix}-queries`);

    const res = await agent.get('/api/stats');
    const body = res.body as StatsResponse;

    const queriesKpi = body.kpis.find((k) => k.key === 'queries');
    expect(queriesKpi).toEqual({
      key: 'queries',
      label: 'Tus consultas al agente',
      value: 2, // 2 own `user` messages — not the assistant reply, not the other user's message
      sub: 'en total',
    });
  });
});
