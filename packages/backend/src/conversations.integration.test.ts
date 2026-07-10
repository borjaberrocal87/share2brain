// End-to-end integration test for the conversations READ side against a REAL
// Express app + REAL Postgres + Redis, with an INJECTED fake DiscordOAuthClient.
// Proves the SQL that unit tests can't: pagination + `updated_at DESC` ordering,
// the title derived from the first user message (correlated subquery), chronological
// messages in detail, and OWNERSHIP isolation (a user can never see another user's
// conversations; unknown/unowned/malformed ids all 404 with no existence leak).
// Also exercises AC4 end-to-end: a second /api/chat turn round-trips prior history
// and the detail endpoint returns the grown transcript. Mirrors chat.integration.test.ts.
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import { sql } from '@share2brain/shared/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ConversationDetail, ConversationsResponse } from '@share2brain/shared/schemas';

import { createApp } from './app.js';
import type { DiscordOAuthClient } from './domain/repositories/discordOAuthClient.js';
import { buildTestAppOptions, openTestClients, type TestClients } from './test-helpers.js';

const suffix = `itest-conv-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
const MEMBER_A_DISCORD_ID = `${suffix}-a`;
const MEMBER_B_DISCORD_ID = `${suffix}-b`;
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

describe('GET /api/conversations (integration)', () => {
  let clients: TestClients;

  async function getUserId(discordId: string): Promise<string> {
    const result = await clients.db.execute(
      sql`SELECT id FROM users WHERE discord_id = ${discordId} LIMIT 1`,
    );
    return String((result.rows[0] as { id: string }).id);
  }

  async function insertConversation(
    userId: string,
    createdAt: string,
    updatedAt: string,
  ): Promise<string> {
    const result = await clients.db.execute(sql`
      INSERT INTO conversations (user_id, created_at, updated_at)
      VALUES (${userId}, ${createdAt}, ${updatedAt})
      RETURNING id
    `);
    return String((result.rows[0] as { id: string }).id);
  }

  async function insertMessage(
    conversationId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    createdAt: string,
    citations: unknown[] = [],
  ): Promise<string> {
    const result = await clients.db.execute(sql`
      INSERT INTO messages (conversation_id, role, content, citations, created_at)
      VALUES (${conversationId}, ${role}, ${content}, ${JSON.stringify(citations)}::jsonb, ${createdAt})
      RETURNING id
    `);
    return String((result.rows[0] as { id: string }).id);
  }

  // A stable app bound to member A; login mints the session cookie on the agent.
  function appForA() {
    return createApp(clients.db, clients.redis, {
      ...buildTestAppOptions(),
      oauth: memberOAuth(MEMBER_A_DISCORD_ID, [ROLE_MEMBER]),
    });
  }

  beforeAll(async () => {
    clients = await openTestClients();

    // Log in both users once so their `users` rows exist, then seed directly.
    const agentA = request.agent(appForA());
    await login(agentA, `${suffix}-seed-a`);
    const appB = createApp(clients.db, clients.redis, {
      ...buildTestAppOptions(),
      oauth: memberOAuth(MEMBER_B_DISCORD_ID, [ROLE_MEMBER]),
    });
    const agentB = request.agent(appB);
    await login(agentB, `${suffix}-seed-b`);

    const userA = await getUserId(MEMBER_A_DISCORD_ID);
    const userB = await getUserId(MEMBER_B_DISCORD_ID);

    // User A: two conversations. conv2 is more recently active (later updated_at) so
    // it must sort first. Each has a first USER message that becomes the title.
    const convA1 = await insertConversation(userA, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    await insertMessage(convA1, 'user', 'First conversation question', '2026-07-01T00:00:01.000Z');
    await insertMessage(convA1, 'assistant', 'Answer one', '2026-07-01T00:00:02.000Z', [
      {
        title: 'Deploying with Docker Compose',
        channel: 'general',
        author: 'ada',
        date: '2026-07-01T00:00:00.000Z',
        link: 'https://example.com/itest/deploying-with-docker-compose',
      },
    ]);

    const convA2 = await insertConversation(userA, '2026-07-02T00:00:00.000Z', '2026-07-05T00:00:00.000Z');
    await insertMessage(convA2, 'user', 'Second conversation question', '2026-07-02T00:00:01.000Z');
    await insertMessage(convA2, 'assistant', 'Answer two', '2026-07-02T00:00:02.000Z');
    await insertMessage(convA2, 'user', 'A later follow-up (must NOT become the title)', '2026-07-02T00:00:03.000Z');

    // User B: one conversation, used to prove ownership isolation.
    const convB1 = await insertConversation(userB, '2026-07-03T00:00:00.000Z', '2026-07-03T00:00:00.000Z');
    await insertMessage(convB1, 'user', "B's private question", '2026-07-03T00:00:01.000Z');

    // Stash the ids on the suite for the tests.
    Object.assign(ids, { userA, userB, convA1, convA2, convB1 });
  });

  const ids: Record<string, string> = {};

  afterAll(async () => {
    const { db } = clients;
    await db.execute(sql`
      DELETE FROM messages WHERE conversation_id IN (
        SELECT id FROM conversations WHERE user_id IN (
          SELECT id FROM users WHERE discord_id IN (${MEMBER_A_DISCORD_ID}, ${MEMBER_B_DISCORD_ID})
        )
      )
    `);
    await db.execute(sql`
      DELETE FROM conversations WHERE user_id IN (
        SELECT id FROM users WHERE discord_id IN (${MEMBER_A_DISCORD_ID}, ${MEMBER_B_DISCORD_ID})
      )
    `);
    await db.execute(
      sql`DELETE FROM users WHERE discord_id IN (${MEMBER_A_DISCORD_ID}, ${MEMBER_B_DISCORD_ID})`,
    );
    await clients.close();
  });

  it('should 401 without a session (generic /api gate)', async () => {
    const res = await request(appForA()).get('/api/conversations');
    expect(res.status).toBe(401);
  });

  it('should list only the caller\'s own conversations, updated_at DESC, title = first user message', async () => {
    const agent = request.agent(appForA());
    await login(agent, `${suffix}-list`);

    const res = await agent.get('/api/conversations');

    expect(res.status).toBe(200);
    const body = res.body as ConversationsResponse;
    expect(body.total).toBe(2); // only A's two — never B's
    expect(body.results.map((r) => r.id)).toEqual([ids.convA2, ids.convA1]); // DESC by updated_at
    expect(body.results[0].title).toBe('Second conversation question'); // first USER msg, not the follow-up
    expect(body.results[1].title).toBe('First conversation question');
    // No leak of B's conversation.
    expect(body.results.some((r) => r.id === ids.convB1)).toBe(false);
  });

  it('should paginate with page/limit and a correct total', async () => {
    const agent = request.agent(appForA());
    await login(agent, `${suffix}-page`);

    const page1 = await agent.get('/api/conversations?page=1&limit=1');
    expect(page1.status).toBe(200);
    const body1 = page1.body as ConversationsResponse;
    expect(body1.results).toHaveLength(1);
    expect(body1.results[0].id).toBe(ids.convA2); // newest first
    expect(body1.total).toBe(2);
    expect(body1.limit).toBe(1);

    const page2 = await agent.get('/api/conversations?page=2&limit=1');
    const body2 = page2.body as ConversationsResponse;
    expect(body2.results[0].id).toBe(ids.convA1);
  });

  it('should 400 VALIDATION_ERROR on an invalid page', async () => {
    const agent = request.agent(appForA());
    await login(agent, `${suffix}-badpage`);

    const res = await agent.get('/api/conversations?page=0');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Parámetros inválidos', code: 'VALIDATION_ERROR' });
  });

  it('should return the detail with chronological messages and citations', async () => {
    const agent = request.agent(appForA());
    await login(agent, `${suffix}-detail`);

    const res = await agent.get(`/api/conversations/${ids.convA1}`);

    expect(res.status).toBe(200);
    const body = res.body as ConversationDetail;
    expect(body.id).toBe(ids.convA1);
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant']); // created_at ASC
    expect(body.messages[0].content).toBe('First conversation question');
    expect(body.messages[1].citations).toEqual([
      {
        title: 'Deploying with Docker Compose',
        channel: 'general',
        author: 'ada',
        date: '2026-07-01T00:00:00.000Z',
        link: 'https://example.com/itest/deploying-with-docker-compose',
      },
    ]);
  });

  it('should order messages by id when two share the exact same created_at (code-review patch)', async () => {
    const agent = request.agent(appForA());
    await login(agent, `${suffix}-tiebreak`);

    const tiedConv = await insertConversation(ids.userA, '2026-07-04T00:00:00.000Z', '2026-07-04T00:00:00.000Z');
    // Two USER messages with an IDENTICAL timestamp — without an `id` tiebreaker in
    // the ORDER BY, which one sorts first is undefined and could flip between runs.
    const idA = await insertMessage(tiedConv, 'user', 'tied A', '2026-07-04T00:00:01.000Z');
    const idB = await insertMessage(tiedConv, 'user', 'tied B', '2026-07-04T00:00:01.000Z');
    // Expected order is driven by the `id ASC` tiebreaker itself, not insertion
    // order (ids are random UUIDs) — compute it the same way the SQL does.
    const expectedContent = idA < idB ? ['tied A', 'tied B'] : ['tied B', 'tied A'];

    const res = await agent.get(`/api/conversations/${tiedConv}`);

    expect((res.body as ConversationDetail).messages.map((m) => m.content)).toEqual(expectedContent);

    // Repeating the query must be stable — the tiebreaker makes the order
    // deterministic across calls, not just internally self-consistent.
    const repeat = await agent.get(`/api/conversations/${tiedConv}`);
    expect((repeat.body as ConversationDetail).messages.map((m) => m.content)).toEqual(expectedContent);
  });

  it('should 404 when the conversation belongs to another user (no existence leak)', async () => {
    const agent = request.agent(appForA());
    await login(agent, `${suffix}-crossuser`);

    const res = await agent.get(`/api/conversations/${ids.convB1}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Conversación no encontrada', code: 'NOT_FOUND' });
  });

  it('should 404 on an unknown (well-formed) conversationId', async () => {
    const agent = request.agent(appForA());
    await login(agent, `${suffix}-unknown`);

    const res = await agent.get('/api/conversations/00000000-0000-0000-0000-000000000000');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('should 404 on a malformed conversationId (D9 — treated as not-found, not 400)', async () => {
    const agent = request.agent(appForA());
    await login(agent, `${suffix}-malformed`);

    const res = await agent.get('/api/conversations/not-a-uuid');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('should round-trip prior history: a second /api/chat turn grows the transcript (AC4)', async () => {
    const agent = request.agent(appForA());
    await login(agent, `${suffix}-history`);

    const first = await agent.post('/api/chat').send({ message: 'first turn' });
    expect(first.status).toBe(200);
    const conversationId = first.text
      .split('\n\n')
      .filter((c) => c.trim())
      .map((c) => JSON.parse(c.replace(/^data: /, '')))
      .at(-1).conversationId as string;

    const second = await agent.post('/api/chat').send({ message: 'second turn', conversationId });
    expect(second.status).toBe(200);

    // The detail endpoint now shows all four persisted turns, chronological.
    const detail = await agent.get(`/api/conversations/${conversationId}`);
    const body = detail.body as ConversationDetail;
    expect(body.messages).toHaveLength(4);
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(body.messages[0].content).toBe('first turn');
    expect(body.messages[2].content).toBe('second turn');
  });
});
