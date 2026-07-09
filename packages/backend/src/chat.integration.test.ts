// End-to-end integration test for POST /api/chat against a REAL Express app +
// REAL Postgres + pgvector + Redis, with an INJECTED fake DiscordOAuthClient,
// the default fake query embedder (one-hot at index 0), and the default fake
// chat model (fixed token stream). Proves the full slice: SSE framing, the
// frame sequence (tokens → citations → done), the AD-12 RBAC scope applied
// inside the retrieve query (a fragment in a denied channel never surfaces as a
// citation), the deleted-message exclusion (D1), conversation/message
// persistence (AC9), conversationId ownership (D8), and body validation.
// Mirrors search.integration.test.ts / documents.integration.test.ts.
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import { sql } from '@hivly/shared/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SSEFrame } from '@hivly/shared/schemas';

import { createApp } from './app.js';
import type { DiscordOAuthClient } from './domain/repositories/discordOAuthClient.js';
import { buildTestAppOptions, openTestClients, type TestClients } from './test-helpers.js';

const DIMENSIONS = 1536;
const suffix = `itest-chat-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
const CH_ALLOWED = `chan-allowed-${suffix}`;
const CH_DENIED = `chan-denied-${suffix}`;
const MEMBER_A_DISCORD_ID = `itest-chat-a-${suffix}`;
const MEMBER_B_DISCORD_ID = `itest-chat-b-${suffix}`;
// Suffix-unique role: RBAC expansion resolves against the WHOLE channel_permissions
// table, so a literal role like 'member' would pull in other integration test
// files' "allowed" channels when suites run concurrently.
const ROLE_MEMBER = `member-${suffix}`;

function oneHot(index: number): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  v[index] = 1;
  return v;
}

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

/** SSE `data: <json>\n\n` frames are buffered whole by supertest for text/*
 * responses; split them back out into the individual SSEFrame objects. */
function parseFrames(text: string): SSEFrame[] {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as SSEFrame);
}

describe('POST /api/chat (integration)', () => {
  let clients: TestClients;

  async function seedMessage(id: string, channelId: string, deleted = false): Promise<void> {
    await clients.db.execute(sql`
      insert into discord_messages (id, channel_id, guild_id, author_id, content, created_at, updated_at, deleted_at)
      values (${id}, ${channelId}, 'itest-guild', ${`author-${id}`}, 'msg', now(), now(),
              ${deleted ? sql`now()` : sql`null`})
    `);
  }

  async function seedEmbedding(chunkKey: string, channelId: string, messageIds: string[], vec: number[]): Promise<void> {
    const messageIdsLiteral = `{${messageIds.join(',')}}`;
    await clients.db.execute(sql`
      insert into embeddings (chunk_key, title, description, link, embedding, channel_id, message_ids, created_at)
      values (${chunkKey}, '', ${`description ${chunkKey}`}, '', ${JSON.stringify(vec)}::vector, ${channelId},
              ${messageIdsLiteral}::text[], now())
    `);
  }

  beforeAll(async () => {
    clients = await openTestClients();

    await clients.db.execute(sql`
      insert into channel_permissions (channel_id, name, allowed_roles)
      values (${CH_ALLOWED}, 'Allowed Channel', ARRAY[${ROLE_MEMBER}]::text[]),
             (${CH_DENIED}, 'Denied Channel', ARRAY['owner']::text[])
    `);

    await seedMessage(`${suffix}-allowed`, CH_ALLOWED);
    await seedMessage(`${suffix}-denied`, CH_DENIED);
    await seedMessage(`${suffix}-deleted`, CH_ALLOWED, true);

    // All three fragments are one-hot(0), identical to the fake embedder's query
    // vector. Only the allowed, non-deleted one may ever surface as a citation.
    await seedEmbedding(`${suffix}-allowed:0`, CH_ALLOWED, [`${suffix}-allowed`], oneHot(0));
    await seedEmbedding(`${suffix}-denied:0`, CH_DENIED, [`${suffix}-denied`], oneHot(0));
    await seedEmbedding(`${suffix}-deleted:0`, CH_ALLOWED, [`${suffix}-deleted`], oneHot(0));
  });

  afterAll(async () => {
    const { db } = clients;
    await db.execute(sql`
      delete from messages where conversation_id in (
        select id from conversations where user_id in (
          select id from users where discord_id in (${MEMBER_A_DISCORD_ID}, ${MEMBER_B_DISCORD_ID})
        )
      )
    `);
    await db.execute(sql`
      delete from conversations where user_id in (
        select id from users where discord_id in (${MEMBER_A_DISCORD_ID}, ${MEMBER_B_DISCORD_ID})
      )
    `);
    await db.execute(sql`delete from embeddings where chunk_key like ${`${suffix}%`}`);
    await db.execute(sql`delete from discord_messages where id like ${`${suffix}%`}`);
    await db.execute(sql`delete from channel_permissions where channel_id like ${`%${suffix}`}`);
    await db.execute(sql`delete from users where discord_id in (${MEMBER_A_DISCORD_ID}, ${MEMBER_B_DISCORD_ID})`);
    await clients.close();
  });

  it('should 401 without a session (generic /api gate)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions());

    const res = await request(app).post('/api/chat').send({ message: 'hello' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('should 400 VALIDATION_ERROR on a blank message', async () => {
    const app = createApp(clients.db, clients.redis, {
      ...buildTestAppOptions(),
      oauth: memberOAuth(MEMBER_A_DISCORD_ID, [ROLE_MEMBER]),
    });
    const agent = request.agent(app);
    await login(agent, 'code-chat-a-blank');

    const res = await agent.post('/api/chat').send({ message: '   ' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Mensaje inválido', code: 'VALIDATION_ERROR' });
  });

  it('should 400 VALIDATION_ERROR on an oversized message', async () => {
    const app = createApp(clients.db, clients.redis, {
      ...buildTestAppOptions(),
      oauth: memberOAuth(MEMBER_A_DISCORD_ID, [ROLE_MEMBER]),
    });
    const agent = request.agent(app);
    await login(agent, 'code-chat-a-oversized');

    const res = await agent.post('/api/chat').send({ message: 'a'.repeat(4001) });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Mensaje inválido', code: 'VALIDATION_ERROR' });
  });

  it(
    'should stream tokens then citations then a terminal done frame, RBAC-scoped and deleted-message-excluded, ' +
      'and persist the conversation + both messages (AC6, AC9, AD-12, D1)',
    async () => {
      const app = createApp(clients.db, clients.redis, {
        ...buildTestAppOptions(),
        oauth: memberOAuth(MEMBER_A_DISCORD_ID, [ROLE_MEMBER]),
      });
      const agent = request.agent(app);
      await login(agent, 'code-chat-a-new');

      const res = await agent.post('/api/chat').send({ message: 'what is the answer?' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');

      const frames = parseFrames(res.text);
      const types = frames.map((f) => f.type);

      // Frame order: N tokens, then M citations, then one terminal done (AC6).
      const firstNonTokenIndex = types.findIndex((t) => t !== 'token');
      expect(firstNonTokenIndex).toBeGreaterThan(0);
      expect(types.slice(0, firstNonTokenIndex).every((t) => t === 'token')).toBe(true);
      expect(types.at(-1)).toBe('done');
      expect(types.slice(firstNonTokenIndex, -1).every((t) => t === 'citation')).toBe(true);

      // RBAC (AD-12) + deleted-message exclusion (D1): only the allowed,
      // non-deleted fragment may ever surface as a citation.
      const citations = frames.filter((f): f is Extract<SSEFrame, { type: 'citation' }> => f.type === 'citation');
      expect(citations).toHaveLength(1);
      expect(citations[0].channel).toBe('Allowed Channel');
      expect(citations[0].link).toBe('');

      const done = frames.at(-1) as Extract<SSEFrame, { type: 'done' }>;
      expect(done.conversationId).toMatch(/^[0-9a-f-]{36}$/);

      // Persistence (AC9): a new conversation with both messages, correct roles + citations.
      const messagesResult = await clients.db.execute(sql`
        select role, content, citations from messages
        where conversation_id = ${done.conversationId}
        order by created_at asc
      `);
      const rows = messagesResult.rows as Array<{ role: string; content: string; citations: unknown }>;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ role: 'user', content: 'what is the answer?' });
      expect(rows[1].role).toBe('assistant');
      expect(rows[1].citations).toEqual([{ channel: 'Allowed Channel', author: `author-${suffix}-allowed`, date: expect.any(String), link: '' }]);
    },
  );

  it('should append to an existing owned conversation (D8)', async () => {
    const app = createApp(clients.db, clients.redis, {
      ...buildTestAppOptions(),
      oauth: memberOAuth(MEMBER_A_DISCORD_ID, [ROLE_MEMBER]),
    });
    const agent = request.agent(app);
    await login(agent, 'code-chat-a-append');

    const first = await agent.post('/api/chat').send({ message: 'first turn' });
    const firstDone = parseFrames(first.text).at(-1) as Extract<SSEFrame, { type: 'done' }>;
    const conversationId = firstDone.conversationId;

    const second = await agent.post('/api/chat').send({ message: 'second turn', conversationId });
    expect(second.status).toBe(200);
    const secondDone = parseFrames(second.text).at(-1) as Extract<SSEFrame, { type: 'done' }>;
    expect(secondDone.conversationId).toBe(conversationId);

    const messagesResult = await clients.db.execute(sql`
      select role, content from messages where conversation_id = ${conversationId} order by created_at asc
    `);
    expect(messagesResult.rows).toHaveLength(4);
  });

  it('should 404 NOT_FOUND when conversationId belongs to a different user (D8)', async () => {
    const appB = createApp(clients.db, clients.redis, {
      ...buildTestAppOptions(),
      oauth: memberOAuth(MEMBER_B_DISCORD_ID, [ROLE_MEMBER]),
    });
    const agentB = request.agent(appB);
    await login(agentB, 'code-chat-b-owned');
    const ownedByB = await agentB.post('/api/chat').send({ message: 'owned by B' });
    const bConversationId = (parseFrames(ownedByB.text).at(-1) as Extract<SSEFrame, { type: 'done' }>)
      .conversationId;

    const appA = createApp(clients.db, clients.redis, {
      ...buildTestAppOptions(),
      oauth: memberOAuth(MEMBER_A_DISCORD_ID, [ROLE_MEMBER]),
    });
    const agentA = request.agent(appA);
    await login(agentA, 'code-chat-a-crossaccess');

    const res = await agentA.post('/api/chat').send({ message: 'hi', conversationId: bConversationId });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Conversación no encontrada', code: 'NOT_FOUND' });
  });

  it('should 404 NOT_FOUND when conversationId is unknown', async () => {
    const app = createApp(clients.db, clients.redis, {
      ...buildTestAppOptions(),
      oauth: memberOAuth(MEMBER_A_DISCORD_ID, [ROLE_MEMBER]),
    });
    const agent = request.agent(app);
    await login(agent, 'code-chat-a-unknown');

    const res = await agent
      .post('/api/chat')
      .send({ message: 'hi', conversationId: '00000000-0000-0000-0000-000000000000' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Conversación no encontrada', code: 'NOT_FOUND' });
  });
});
