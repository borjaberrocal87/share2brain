// Integration test for GET /api/channels against a REAL Express app + REAL
// Postgres + Redis, with an INJECTED fake DiscordOAuthClient (no real Discord).
// Covers: the generic /api gate (401 without a session) and the AD-12 RBAC
// scope — a channel outside the caller's role never surfaces.
//
// Uses a run-unique role + channel-id suffix (not the shared literal 'member')
// because this test asserts the FULL RBAC scope, and RBAC expansion resolves
// against the WHOLE channel_permissions table — a shared role would leak other
// suites' channels into the assertion (learned in Story 4.2).
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import { sql } from '@share2brain/shared/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { DiscordOAuthClient } from './domain/repositories/discordOAuthClient.js';
import { buildTestAppOptions, openTestClients, type TestClients } from './test-helpers.js';

const suffix = `itest-channels-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
const ROLE = `role-${suffix}`;
const CH_ALLOWED = `${suffix}-allowed`;
const CH_DENIED = `${suffix}-denied`;
const MEMBER_DISCORD_ID = `${suffix}-member`;

function memberOAuth(roles: string[]): DiscordOAuthClient {
  return {
    exchangeCode: async () => ({ accessToken: 'tok' }),
    getCurrentUser: async () => ({ id: MEMBER_DISCORD_ID, username: 'itest-channels', avatar: null }),
    getGuildMember: async () => ({ roles }),
  };
}

async function loginMember(agent: ReturnType<typeof request.agent>): Promise<void> {
  const login = await agent.get('/api/auth/login');
  const state = new URL(login.headers.location).searchParams.get('state');
  const cb = await agent.get(`/api/auth/callback?code=code-channels&state=${state}`);
  expect(cb.status).toBe(302);
}

describe('GET /api/channels (integration)', () => {
  let clients: TestClients;

  beforeAll(async () => {
    clients = await openTestClients();

    await clients.db.execute(sql`
      insert into channel_permissions (channel_id, name, allowed_roles)
      values (${CH_ALLOWED}, 'Allowed Channel', ARRAY[${ROLE}]::text[]),
             (${CH_DENIED}, 'Denied Channel', ARRAY['owner']::text[])
    `);
  });

  afterAll(async () => {
    await clients.db.execute(sql`delete from channel_permissions where channel_id like ${`${suffix}%`}`);
    await clients.db.execute(sql`delete from users where discord_id = ${MEMBER_DISCORD_ID}`);
    await clients.close();
  });

  it('should 401 without a session (generic /api gate)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions());

    const res = await request(app).get('/api/channels');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('should return only channels the caller can access — RBAC array-overlap inside the query (AC7)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth([ROLE]) }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/channels');

    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([{ id: CH_ALLOWED, name: 'Allowed Channel' }]);
    const ids = (res.body.channels as { id: string }[]).map((c) => c.id);
    expect(ids).not.toContain(CH_DENIED);
  });

  it('should return an empty channels array for a user whose roles intersect none (deny-by-default)', async () => {
    const app = createApp(
      clients.db,
      clients.redis,
      buildTestAppOptions({ oauth: memberOAuth(['nobody']) }),
    );
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/channels');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channels: [] });
  });
});
