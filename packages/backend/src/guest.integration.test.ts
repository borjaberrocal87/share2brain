// Integration test for the Story 2.5 guest-access endpoints against a REAL Express
// app + REAL Postgres + Redis. Proves: the config gate (404 on both verbs when
// disabled), the guest session shape + per-session TTL (D7 — the short TTL beats
// the store default), RBAC scoping through the synthetic role (AD-12, incl. the
// explicit exclusion of an unmapped channel), the deny path, the generic-gate
// pass-through, guest chat persisting a conversation under the seeded guest user
// (D9), and seed idempotency / honor-existing-row (D5).
//
// ⚠️ The guest sentinel row (discord_id='guest') is a SINGLETON, not run-unique —
// this suite mutates/deletes it and is NOT concurrency-safe with a running e2e
// server or a dev's manually-enabled guest row on the shared DB.
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import { sql } from '@share2brain/shared/db';
import type { SSEFrame } from '@share2brain/shared/schemas';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { seedGuestUser } from './infrastructure/guestAccess.js';
import { buildTestAppOptions, openTestClients, type TestClients } from './test-helpers.js';

const SFX = `${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
const GUEST_ROLE = `itest-guest-role-${SFX}`;
const NO_CHANNEL_ROLE = `itest-guest-none-${SFX}`;
const CH_MAPPED = `itest-guest-${SFX}-mapped`;
const CH_UNMAPPED = `itest-guest-${SFX}-unmapped`;
const OTHER_ROLE = `itest-other-${SFX}`;
const TTL_MINUTES = 120;

/** SSE `data: <json>\n\n` frames are buffered whole by supertest for text/*. */
function parseFrames(text: string): SSEFrame[] {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => JSON.parse(chunk.replace(/^data: /, '')) as SSEFrame);
}

/** Raw session id from a `sid=s:<id>.<sig>` Set-Cookie header. */
function sidFromSetCookie(setCookie: string | string[] | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const header = cookies.find((c) => c.startsWith('sid='));
  if (!header) throw new Error('no sid cookie set');
  const raw = decodeURIComponent(header.split(';')[0].slice('sid='.length));
  return raw.slice(2).split('.')[0];
}

describe('Guest access endpoints (integration)', () => {
  let clients: TestClients;
  let guestUserId: string;

  /** FK-ordered removal of ALL guest data (messages → conversations → users row). */
  async function deleteGuestData(): Promise<void> {
    const { db } = clients;
    await db.execute(sql`
      delete from messages where conversation_id in (
        select id from conversations where user_id in (
          select id from users where discord_id = 'guest'
        )
      )
    `);
    await db.execute(sql`
      delete from conversations where user_id in (
        select id from users where discord_id = 'guest'
      )
    `);
    await db.execute(sql`delete from users where discord_id = 'guest'`);
  }

  function enabledApp(role: string = GUEST_ROLE) {
    return createApp(
      clients.db,
      clients.redis,
      buildTestAppOptions({ guestAccess: { role, sessionTtlMinutes: TTL_MINUTES, userId: guestUserId } }),
    );
  }

  function disabledApp() {
    return createApp(clients.db, clients.redis, buildTestAppOptions());
  }

  /** Establish a guest session on the agent via POST /api/auth/guest. */
  async function guestLogin(agent: ReturnType<typeof request.agent>): Promise<void> {
    const res = await agent.post('/api/auth/guest');
    expect(res.status).toBe(200);
  }

  beforeAll(async () => {
    clients = await openTestClients();
    await deleteGuestData(); // clean slate for the singleton row
    await clients.db.execute(sql`
      insert into channel_permissions (channel_id, name, allowed_roles)
      values (${CH_MAPPED}, 'Guest Mapped', ARRAY[${GUEST_ROLE}]::text[]),
             (${CH_UNMAPPED}, 'No Guest', ARRAY[${OTHER_ROLE}]::text[])
    `);
    guestUserId = (await seedGuestUser(clients.db, 'Invitado')).id;
  });

  afterAll(async () => {
    await deleteGuestData();
    await clients.db.execute(
      sql`delete from channel_permissions where channel_id in (${CH_MAPPED}, ${CH_UNMAPPED})`,
    );
    await clients.close();
  });

  // (a) Disabled by default.
  it('should 404 GUEST_ACCESS_DISABLED on GET and POST when guest access is disabled', async () => {
    const app = disabledApp();

    const get = await request(app).get('/api/auth/guest');
    expect(get.status).toBe(404);
    expect(get.body).toEqual({ error: 'Not found', code: 'GUEST_ACCESS_DISABLED' });

    const post = await request(app).post('/api/auth/guest');
    expect(post.status).toBe(404);
    expect(post.body.code).toBe('GUEST_ACCESS_DISABLED');
  });

  // (b) Guest session creation + per-session TTL.
  it('should create a guest Redis session with isGuest and a short per-session TTL', async () => {
    const app = enabledApp();
    const agent = request.agent(app);

    const availability = await agent.get('/api/auth/guest');
    expect(availability.status).toBe(200);
    expect(availability.body).toEqual({ enabled: true });

    const res = await agent.post('/api/auth/guest');
    expect(res.status).toBe(200);
    expect(res.body.isGuest).toBe(true);
    expect(res.body.id).toBe(guestUserId);

    const sid = sidFromSetCookie(res.headers['set-cookie']);
    expect(await clients.redis.exists(`sess:${sid}`)).toBe(1);

    const raw = await clients.redis.get(`sess:${sid}`);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).isGuest).toBe(true);

    // The per-session TTL (D7) beat the store default (sessionTtlDays=7 → 604800s):
    // the Redis key expires with the ~7200s demo window, not the 7-day default.
    const ttl = await clients.redis.ttl(`sess:${sid}`);
    expect(ttl).toBeLessThanOrEqual(TTL_MINUTES * 60);
    expect(ttl).toBeGreaterThan(TTL_MINUTES * 60 - 60);
  });

  // (c) RBAC scoping — the guest sees exactly the mapped channel, never the unmapped one.
  it('should scope the guest to only the channels whose allowed_roles list the guest role', async () => {
    const agent = request.agent(enabledApp());
    await guestLogin(agent);

    const roles = await agent.get('/api/auth/roles');
    expect(roles.status).toBe(200);
    expect(roles.body.roles).toEqual([GUEST_ROLE]);
    // Exactly the mapped channel — the run-unique guest role is listed by CH_MAPPED
    // alone, so the RBAC expansion is fully determined (spec Task 7c "exactly").
    expect(roles.body.allowedChannels).toEqual([CH_MAPPED]);
  });

  // (d) Deny — a guest role mapped to no channel yields no access (natural join, no branch).
  it('should give an unmapped guest role an empty channel set (deny)', async () => {
    const agent = request.agent(enabledApp(NO_CHANNEL_ROLE));
    await guestLogin(agent);

    const roles = await agent.get('/api/auth/roles');
    expect(roles.status).toBe(200);
    expect(roles.body.roles).toEqual([NO_CHANNEL_ROLE]);
    // A run-unique role that no channel lists → the natural join is empty (spec
    // Task 7d "[]"): assert the exact empty set, not just the two exclusions.
    expect(roles.body.allowedChannels).toEqual([]);
  });

  // (e) Generic gate — a guest session passes requireAuth (has userId), so an
  // unknown route is 404 (route-not-found), NOT 401.
  it('should pass the generic /api gate for a guest session (404, not 401)', async () => {
    const agent = request.agent(enabledApp());
    await guestLogin(agent);

    const res = await agent.get('/api/this-route-does-not-exist');
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(404);
  });

  // (f) Guest chat persists a conversation under the seeded guest user (D9) — the
  // FK the seed exists for, exercised through the real chat pipeline (fake model).
  it('should persist a conversation under the guest user when the guest chats', async () => {
    const agent = request.agent(enabledApp());
    await guestLogin(agent);

    const chat = await agent.post('/api/chat').send({ message: 'hola desde la demo' });
    expect(chat.status).toBe(200);

    const rows = await clients.db.execute(
      sql`select count(*)::int as n from conversations where user_id = ${guestUserId}`,
    );
    expect(Number((rows.rows[0] as { n: number }).n)).toBeGreaterThanOrEqual(1);
  });

  // (h) Guest history isolation (review D-1): all guests share one sentinel id, so
  // the conversation list/detail MUST NOT expose the shared history to a guest —
  // even a conversation the guest just persisted. List → empty, detail → 404.
  it('should isolate guest chat history — list is empty and detail 404s even for a persisted guest conversation', async () => {
    const agent = request.agent(enabledApp());
    await guestLogin(agent);

    const chat = await agent.post('/api/chat').send({ message: 'demo isolation probe' });
    expect(chat.status).toBe(200);

    // The conversation exists in the DB under the shared guest id …
    const rows = await clients.db.execute(
      sql`select id from conversations where user_id = ${guestUserId} limit 1`,
    );
    const persistedId = (rows.rows[0] as { id: string }).id;
    expect(persistedId).toBeTruthy();

    // … yet the guest's own list is empty (never leaks another guest's history).
    const list = await agent.get('/api/conversations');
    expect(list.status).toBe(200);
    expect(list.body.results).toEqual([]);
    expect(list.body.total).toBe(0);

    // … and fetching that very conversation by id 404s (existence-hiding, D9).
    const detail = await agent.get(`/api/conversations/${persistedId}`);
    expect(detail.status).toBe(404);
    expect(detail.body.code).toBe('NOT_FOUND');
  });

  // (i) Guest chat resume is scoped to the CURRENT session (review): multi-turn
  // within the session works, but a different guest session cannot resume another's
  // conversation — even though the shared sentinel "owns" it. The per-session
  // `guestConversationIds` allowlist is the boundary, not DB ownership.
  it('should scope guest chat resume to the session — same-session multi-turn works, cross-session resume 404s', async () => {
    const agentA = request.agent(enabledApp());
    await guestLogin(agentA);

    // First turn (no id) → new conversation; its id comes back in the done frame.
    const first = await agentA.post('/api/chat').send({ message: 'guest turn 1' });
    expect(first.status).toBe(200);
    const convId = (parseFrames(first.text).at(-1) as Extract<SSEFrame, { type: 'done' }>)
      .conversationId;
    expect(convId).toMatch(/^[0-9a-f-]{36}$/);

    // Same session, same id → resumes (multi-turn preserved via the allowlist).
    const second = await agentA
      .post('/api/chat')
      .send({ message: 'guest turn 2', conversationId: convId });
    expect(second.status).toBe(200);
    expect((parseFrames(second.text).at(-1) as Extract<SSEFrame, { type: 'done' }>).conversationId).toBe(
      convId,
    );

    // A DIFFERENT guest session may NOT resume A's conversation → pre-stream 404.
    const agentB = request.agent(enabledApp());
    await guestLogin(agentB);
    const cross = await agentB
      .post('/api/chat')
      .send({ message: 'steal', conversationId: convId });
    expect(cross.status).toBe(404);
    expect(cross.body.code).toBe('NOT_FOUND');
  });

  // (j) Guest stats + read-status are ephemeral (review): the per-user stats
  // aggregates report 0 and read-status writes don't persist — even though earlier
  // cases (f/h/i) persisted guest user-messages under the shared sentinel. Without
  // the fix, `countUserAgentQueries(sentinel)` would be ≥1 → this discriminates it.
  it('should zero a guest stats per-user aggregates and no-op read-status writes', async () => {
    const agent = request.agent(enabledApp());
    await guestLogin(agent);
    // Guarantee at least one persisted user-message under the sentinel this run.
    await agent.post('/api/chat').send({ message: 'stats probe' });

    const stats = await agent.get('/api/stats');
    expect(stats.status).toBe(200);
    const queriesKpi = (stats.body.kpis as { key: string; value: number }[]).find(
      (k) => k.key === 'queries',
    );
    expect(queriesKpi?.value).toBe(0); // zeroed despite persisted sentinel messages
    expect(stats.body.coverage.readCount).toBe(0);

    // Guest markAll is ephemeral → nothing persisted, markedCount 0.
    const markAll = await agent.post('/api/read-status/mark-all').send({});
    expect(markAll.status).toBe(200);
    expect(markAll.body.markedCount).toBe(0);
  });

  // (g) Seed idempotency + honor-existing-row (D5). Runs LAST: it rewrites the
  // singleton guest row, which the afterAll then cleans up.
  it('should upsert the guest row idempotently and honor a pre-existing row id', async () => {
    // Idempotent: two seeds keep one row (same id), refreshing the username.
    const first = await seedGuestUser(clients.db, 'Invitado');
    const second = await seedGuestUser(clients.db, 'Demo User');
    expect(second.id).toBe(first.id);
    const count = await clients.db.execute(
      sql`select count(*)::int as n, max(username) as name from users where discord_id = 'guest'`,
    );
    expect(Number((count.rows[0] as { n: number }).n)).toBe(1);
    expect((count.rows[0] as { name: string }).name).toBe('Demo User');

    // Honor-existing: a pre-existing guest row with a DIFFERENT uuid keeps its id.
    await deleteGuestData();
    const existingId = '11111111-1111-4111-a111-111111111111';
    await clients.db.execute(
      sql`insert into users (id, discord_id, username, avatar) values (${existingId}, 'guest', 'Old Guest', null)`,
    );
    const seeded = await seedGuestUser(clients.db, 'Invitado');
    expect(seeded.id).toBe(existingId);
  });
});
