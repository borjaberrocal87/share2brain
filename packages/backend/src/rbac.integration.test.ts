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
//
// ISOLATION (Story OPS-2): every id (member, guild, channels) is RUN-UNIQUE via a
// per-run suffix, and every assertion is scoped to this run's ids, so a sibling
// suite or a stale row cannot perturb the result. NOTE: the member's effective
// roles include the injected `@everyone` role, whose ID equals the guild id
// (authService injects it — AD-12 / PR #32); the assertions expect it explicitly.
import { sql } from '@share2brain/shared/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppOptions } from './app.js';
import { createApp } from './app.js';
import type { DiscordOAuthClient } from './domain/repositories/discordOAuthClient.js';
import { createDrizzleChannelPermissionRepository } from './infrastructure/channelPermissionRepository.drizzle.js';
import { buildTestAppOptions, openTestClients, type TestClients } from './test-helpers.js';

// Run-unique suffix — no shared literal ids across suites/runs (Epic 4 AI#3; 6.3 salt).
const SFX = `${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
const MEMBER_DISCORD_ID = `itest-rbac-member-${SFX}`;
const GUILD_ID = `itest-rbac-guild-${SFX}`;
const CH_PREFIX = `itest-${SFX}-`;
const CH_ADMIN = `${CH_PREFIX}admin`;
const CH_MOD = `${CH_PREFIX}mod`;
const CH_PRIVATE = `${CH_PREFIX}private`;

/** A member whose Discord roles are ['admin', 'mod'] (no 'owner'). */
function memberOAuth(roles: string[] = ['admin', 'mod']): DiscordOAuthClient {
  return {
    exchangeCode: async () => ({ accessToken: 'tok' }),
    getCurrentUser: async () => ({ id: MEMBER_DISCORD_ID, username: 'itest-rbac', avatar: null }),
    getGuildMember: async () => ({ roles }),
  };
}

/** Test app options bound to this run's unique guild id (drives the @everyone
 *  injection deterministically). Overrides only guildId; keeps the other defaults. */
function appOptions(oauth: DiscordOAuthClient): AppOptions {
  const base = buildTestAppOptions({ oauth });
  return { ...base, discord: { ...base.discord, guildId: GUILD_ID } };
}

/** Establish an authenticated session on the agent (login → callback). */
async function loginMember(agent: ReturnType<typeof request.agent>): Promise<void> {
  const login = await agent.get('/api/auth/login');
  const state = new URL(login.headers.location).searchParams.get('state');
  const cb = await agent.get(`/api/auth/callback?code=code-rbac&state=${state}`);
  expect(cb.status).toBe(302);
}

/** Keep only THIS run's channels so other rows in the table can't perturb asserts. */
function ownChannels(allowedChannels: string[]): string[] {
  return allowedChannels.filter((c) => c.startsWith(CH_PREFIX)).sort();
}

describe('RBAC + route protection (integration)', () => {
  let clients: TestClients;

  beforeAll(async () => {
    clients = await openTestClients();
    // Seed the RBAC policy via the repository (also exercises upsertMany's query).
    const repo = createDrizzleChannelPermissionRepository(clients.db);
    await repo.upsertMany([
      { channelId: CH_ADMIN, name: 'admin-only', allowedRoles: ['admin'] },
      { channelId: CH_MOD, name: 'mod-only', allowedRoles: ['mod'] },
      { channelId: CH_PRIVATE, name: 'owner-only', allowedRoles: ['owner'] },
    ]);
  });

  afterAll(async () => {
    // Scoped to THIS run's own ids — never a broad `LIKE 'itest-%'`, which would
    // race every other integration file's "itest-*" rows and could delete a row
    // another suite still references (FK), aborting its cleanup.
    await clients.db.execute(sql`DELETE FROM channel_permissions WHERE channel_id LIKE ${`${CH_PREFIX}%`}`);
    await clients.db.execute(sql`DELETE FROM users WHERE discord_id = ${MEMBER_DISCORD_ID}`);
    await clients.close();
  });

  it('should return 200 { roles, allowedChannels } for /api/auth/roles with a session', async () => {
    const app = createApp(clients.db, clients.redis, appOptions(memberOAuth()));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/auth/roles');

    expect(res.status).toBe(200);
    // The member's OAuth roles PLUS the injected @everyone role (= guild id, AD-12).
    expect(res.body.roles).toEqual(['admin', 'mod', GUILD_ID]);
    // admin+mod channels are granted; the owner-only channel is NOT (security boundary).
    expect(ownChannels(res.body.allowedChannels)).toEqual([CH_ADMIN, CH_MOD].sort());
    expect(res.body.allowedChannels).not.toContain(CH_PRIVATE);
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
    const app = createApp(clients.db, clients.redis, appOptions(memberOAuth()));
    const agent = request.agent(app);
    await loginMember(agent);

    const before = await agent.get('/api/auth/roles');
    expect(before.body.allowedChannels).not.toContain(CH_PRIVATE);

    // Grant the owner-only channel to 'admin' AFTER the session was created.
    const repo = createDrizzleChannelPermissionRepository(clients.db);
    await repo.upsertMany([
      { channelId: CH_PRIVATE, name: 'owner-only', allowedRoles: ['owner', 'admin'] },
    ]);

    const after = await agent.get('/api/auth/roles');
    // Same session, changed policy → the new channel appears immediately.
    expect(after.body.allowedChannels).toContain(CH_PRIVATE);

    // Restore the seed so test ordering can't leak this change.
    await repo.upsertMany([
      { channelId: CH_PRIVATE, name: 'owner-only', allowedRoles: ['owner'] },
    ]);
  });

  it('should NOT grant any channel to a member whose roles intersect none', async () => {
    const app = createApp(clients.db, clients.redis, appOptions(memberOAuth(['nobody'])));
    const agent = request.agent(app);
    await loginMember(agent);

    const res = await agent.get('/api/auth/roles');

    expect(res.status).toBe(200);
    // 'nobody' plus the injected @everyone (guild id); neither is granted any seeded channel.
    expect(res.body.roles).toEqual(['nobody', GUILD_ID]);
    expect(ownChannels(res.body.allowedChannels)).toEqual([]);
  });
});
