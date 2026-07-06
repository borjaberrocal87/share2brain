// Integration test for RBAC + route protection against a REAL Express app +
// REAL Postgres + Redis, with an INJECTED fake DiscordOAuthClient (no real Discord).
// Covers: GET /api/auth/roles (session → 200 { roles, allowedChannels }; no session
// → 401); the generic /api/* gate (401 without a session); per-request recompute
// (a permission change between two calls on the SAME session changes the result —
// proving it is not cached); and the security boundary (non-intersecting roles do
// NOT receive a channel).
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import { sql } from '@hivly/shared/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { DiscordOAuthClient } from './domain/repositories/discordOAuthClient.js';
import { createDrizzleChannelPermissionRepository } from './infrastructure/channelPermissionRepository.drizzle.js';
import { buildTestAppOptions, openTestClients, type TestClients } from './test-helpers.js';

const MEMBER_DISCORD_ID = 'itest-rbac-member';

/** A member whose Discord roles are ['admin', 'mod'] (no 'owner'). */
function memberOAuth(roles: string[] = ['admin', 'mod']): DiscordOAuthClient {
  return {
    exchangeCode: async () => ({ accessToken: 'tok' }),
    getCurrentUser: async () => ({ id: MEMBER_DISCORD_ID, username: 'itest-rbac', avatar: null }),
    getGuildMember: async () => ({ roles }),
  };
}

/** Establish an authenticated session on the agent (login → callback). */
async function loginMember(agent: ReturnType<typeof request.agent>): Promise<void> {
  const login = await agent.get('/api/auth/login');
  const state = new URL(login.headers.location).searchParams.get('state');
  const cb = await agent.get(`/api/auth/callback?code=code-rbac&state=${state}`);
  expect(cb.status).toBe(302);
}

/** Keep only the itest- channels so other rows in the table don't perturb asserts. */
function itestChannels(allowedChannels: string[]): string[] {
  return allowedChannels.filter((c) => c.startsWith('itest-')).sort();
}

describe('RBAC + route protection (integration)', () => {
  let clients: TestClients;

  beforeAll(async () => {
    clients = await openTestClients();
    // Seed the RBAC policy via the repository (also exercises upsertMany's query).
    const repo = createDrizzleChannelPermissionRepository(clients.db);
    await repo.upsertMany([
      { channelId: 'itest-admin', name: 'admin-only', allowedRoles: ['admin'] },
      { channelId: 'itest-mod', name: 'mod-only', allowedRoles: ['mod'] },
      { channelId: 'itest-private', name: 'owner-only', allowedRoles: ['owner'] },
    ]);
  });

  afterAll(async () => {
    await clients.db.execute(sql`DELETE FROM channel_permissions WHERE channel_id LIKE 'itest-%'`);
    // Scoped to this suite's own discord_id — a broad `LIKE 'itest-%'` would race
    // with every other integration file's "itest-*" users and could delete a row
    // another suite still references (e.g. via a user_read_status FK), aborting
    // its cleanup with a FK violation.
    await clients.db.execute(sql`DELETE FROM users WHERE discord_id = ${MEMBER_DISCORD_ID}`);
    await clients.close();
  });

  it('should return 200 { roles, allowedChannels } for /api/auth/roles with a session', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth() }));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/auth/roles');

    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(['admin', 'mod']);
    // admin+mod channels are granted; the owner-only channel is NOT (security boundary).
    expect(itestChannels(res.body.allowedChannels)).toEqual(['itest-admin', 'itest-mod']);
    expect(res.body.allowedChannels).not.toContain('itest-private');
  });

  it('should return 401 AUTH_REQUIRED for /api/auth/roles without a session', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions());

    const res = await request(app).get('/api/auth/roles');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('should 401 the generic /api/* gate for a non-auth path without a session', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions());

    // No route is defined at /api/anything; the gate fires before routing.
    const res = await request(app).get('/api/anything');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('should recompute allowedChannels per request (not cached in the session)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth() }));
    const agent = request.agent(app);
    await loginMember(agent);

    const before = await agent.get('/api/auth/roles');
    expect(before.body.allowedChannels).not.toContain('itest-private');

    // Grant the owner-only channel to 'admin' AFTER the session was created.
    const repo = createDrizzleChannelPermissionRepository(clients.db);
    await repo.upsertMany([
      { channelId: 'itest-private', name: 'owner-only', allowedRoles: ['owner', 'admin'] },
    ]);

    const after = await agent.get('/api/auth/roles');
    // Same session, changed policy → the new channel appears immediately.
    expect(after.body.allowedChannels).toContain('itest-private');

    // Restore the seed so test ordering can't leak this change.
    await repo.upsertMany([
      { channelId: 'itest-private', name: 'owner-only', allowedRoles: ['owner'] },
    ]);
  });

  it('should NOT grant any channel to a member whose roles intersect none', async () => {
    const app = createApp(
      clients.db,
      clients.redis,
      buildTestAppOptions({ oauth: memberOAuth(['nobody']) }),
    );
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/auth/roles');

    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(['nobody']);
    expect(itestChannels(res.body.allowedChannels)).toEqual([]);
  });
});
