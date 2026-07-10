// Integration test for the Discord OAuth2 auth endpoints against a REAL Express app
// + REAL Postgres + Redis, with an INJECTED fake DiscordOAuthClient (no real Discord).
// Covers the member flow (user upsert + Redis session + cookie), /me, logout (key
// deleted), the non-member 403, and the unauthenticated 401.
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import { sql } from '@share2brain/shared/db';
import { AuthMeResponseSchema } from '@share2brain/shared/schemas';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import type { DiscordOAuthClient } from './domain/repositories/discordOAuthClient.js';
import { buildTestAppOptions, openTestClients, type TestClients } from './test-helpers.js';

const MEMBER_DISCORD_ID = 'itest-discord-member';
const NONMEMBER_DISCORD_ID = 'itest-discord-nonmember';

function memberOAuth(roles: string[] = ['admin', 'mod']): DiscordOAuthClient {
  return {
    exchangeCode: async () => ({ accessToken: 'tok' }),
    getCurrentUser: async () => ({ id: MEMBER_DISCORD_ID, username: 'itest-ada', avatar: null }),
    getGuildMember: async () => ({ roles }),
  };
}

function nonMemberOAuth(): DiscordOAuthClient {
  return {
    exchangeCode: async () => ({ accessToken: 'tok' }),
    getCurrentUser: async () => ({
      id: NONMEMBER_DISCORD_ID,
      username: 'itest-bob',
      avatar: null,
    }),
    getGuildMember: async () => null,
  };
}

/** Extract the raw session id from a `sid=s:<id>.<sig>` Set-Cookie header. */
function sidFromSetCookie(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const header = cookies.find((c) => c.startsWith('sid='));
  if (!header) throw new Error('no sid cookie set');
  const raw = decodeURIComponent(header.split(';')[0].slice('sid='.length));
  return raw.slice(2).split('.')[0]; // strip the "s:" prefix and the ".<sig>" suffix
}

describe('Auth endpoints (integration)', () => {
  let clients: TestClients;

  beforeAll(async () => {
    clients = await openTestClients();
  });

  afterAll(async () => {
    // Scoped to this suite's own discord_ids — a broad `LIKE 'itest-%'` would race
    // with every other integration file's "itest-*" users and could delete a row
    // another suite still references (e.g. via a user_read_status FK), aborting
    // its cleanup with a FK violation.
    await clients.db.execute(
      sql`DELETE FROM users WHERE discord_id IN (${MEMBER_DISCORD_ID}, ${NONMEMBER_DISCORD_ID})`,
    );
    await clients.close();
  });

  /** GET /login, returning the CSRF state and the session id from the cookie. */
  async function login(agent: ReturnType<typeof request.agent>) {
    const res = await agent.get('/api/auth/login');
    expect(res.status).toBe(302);
    const state = new URL(res.headers.location).searchParams.get('state');
    expect(state).toBeTruthy();
    return { state: state as string, sid: sidFromSetCookie(res.headers['set-cookie']) };
  }

  it('should redirect /login to Discord with the required scopes and a state', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions());
    const res = await request(app).get('/api/auth/login');

    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    expect(url.origin + url.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(url.searchParams.get('scope')).toBe('identify guilds.members.read');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
  });

  it('should complete the member flow: upsert user, create Redis session, and serve /me', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth() }));
    const agent = request.agent(app);

    const { state } = await login(agent);
    const cb = await agent.get(`/api/auth/callback?code=code-1&state=${state}`);

    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('http://localhost:5173/');

    // The session id is REGENERATED on the callback (P1, session-fixation safety),
    // so the authenticated session lives under the callback's sid, not the login one.
    const sid = sidFromSetCookie(cb.headers['set-cookie']);

    // User row upserted.
    const rows = await clients.db.execute(
      sql`SELECT username FROM users WHERE discord_id = ${MEMBER_DISCORD_ID}`,
    );
    expect(rows.rows.length).toBe(1);

    // Session key present in Redis.
    expect(await clients.redis.exists(`sess:${sid}`)).toBe(1);

    // /me returns the profile in the shared shape.
    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.discordId).toBe(MEMBER_DISCORD_ID);
    expect(me.body.guildId).toBe('test-guild');
    expect(AuthMeResponseSchema.safeParse(me.body).success).toBe(true);

    // Logout deletes the Redis key immediately and blocks /me afterwards.
    const out = await agent.post('/api/auth/logout');
    expect(out.status).toBe(200);
    expect(await clients.redis.exists(`sess:${sid}`)).toBe(0);

    const meAfter = await agent.get('/api/auth/me');
    expect(meAfter.status).toBe(401);
    expect(meAfter.body.code).toBe('AUTH_REQUIRED');
  });

  it('should upsert idempotently: two logins for the same discord id keep one row', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth() }));

    for (let i = 0; i < 2; i++) {
      const agent = request.agent(app);
      const { state } = await login(agent);
      const cb = await agent.get(`/api/auth/callback?code=code-${i}&state=${state}`);
      expect(cb.status).toBe(302);
    }

    const rows = await clients.db.execute(
      sql`SELECT count(*)::int AS n FROM users WHERE discord_id = ${MEMBER_DISCORD_ID}`,
    );
    expect(Number((rows.rows[0] as { n: number }).n)).toBe(1);
  });

  it('should return 403 GUILD_MEMBER_REQUIRED when the user is not a guild member', async () => {
    const app = createApp(
      clients.db,
      clients.redis,
      buildTestAppOptions({ oauth: nonMemberOAuth() }),
    );
    const agent = request.agent(app);

    const { state } = await login(agent);
    const cb = await agent.get(`/api/auth/callback?code=code-x&state=${state}`);

    expect(cb.status).toBe(403);
    expect(cb.body.code).toBe('GUILD_MEMBER_REQUIRED');
    const rows = await clients.db.execute(
      sql`SELECT count(*)::int AS n FROM users WHERE discord_id = ${NONMEMBER_DISCORD_ID}`,
    );
    expect(Number((rows.rows[0] as { n: number }).n)).toBe(0);
  });

  it('should reject the callback with 400 when the CSRF state does not match', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ oauth: memberOAuth() }));
    const agent = request.agent(app);

    await login(agent);
    const cb = await agent.get('/api/auth/callback?code=c&state=tampered');

    expect(cb.status).toBe(400);
    expect(cb.body.code).toBe('INVALID_OAUTH_STATE');
  });

  it('should return 401 AUTH_REQUIRED for /me without a session', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions());
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });
});
