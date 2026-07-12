// Integration test for GET /api/ui-config (Epic 10, Story 10.1) against a REAL
// Express app + REAL Postgres + Redis. Proves: no-cookie 200 default (auth
// exemption + "es" default), the "en" override, and the rate-limit tiering
// (general `api` tier, NOT the auth tier) — mirrors security.integration.test.ts.
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp, type AppOptions } from './app.js';
import { buildTestAppOptions, openTestClients, type TestClients } from './test-helpers.js';

/** A rateLimit block with every tier set to a tiny, fast-to-exceed limit. */
function tinyRateLimit(limit = 2): AppOptions['rateLimit'] {
  const tier = { windowMs: 60_000, limit };
  return { api: tier, auth: tier, chat: tier };
}

describe('GET /api/ui-config (integration)', () => {
  let clients: TestClients;

  beforeAll(async () => {
    clients = await openTestClients();
  });

  afterAll(async () => {
    await clients.close();
  });

  it('responds 200 with { language: "es" } with no cookie and no headers', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions());

    const res = await request(app).get('/api/ui-config');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ language: 'es' });
  });

  it('responds 200 with { language: "en" } when uiLanguage is "en"', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions({ uiLanguage: 'en' }));

    const res = await request(app).get('/api/ui-config');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ language: 'en' });
  });

  it('terminates a non-GET request with a 404 in the unified error shape (no gate fall-through)', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions());

    // POST carries the CSRF header so it passes requireCustomHeader and reaches
    // the router; the router's catch-all must terminate it (never falling through
    // to the generic /api gate, where the shared apiLimiters would double-count it).
    const res = await request(app)
      .post('/api/ui-config')
      .set('X-Requested-With', 'share2brain');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
  });

  describe('rate-limit tiering', () => {
    beforeEach(async () => {
      const keys = await clients.redis.keys('rl:*');
      if (keys.length > 0) await clients.redis.del(keys);
    });

    it('429s past the api tier limit (shares the general rl:api: budget)', async () => {
      const app = createApp(
        clients.db,
        clients.redis,
        buildTestAppOptions({ rateLimit: tinyRateLimit(2) }),
      );

      const first = await request(app).get('/api/ui-config');
      const second = await request(app).get('/api/ui-config');
      const third = await request(app).get('/api/ui-config');

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(429);
    });

    it('stays 200 after exhausting the auth tier (not on the auth budget)', async () => {
      const app = createApp(
        clients.db,
        clients.redis,
        buildTestAppOptions({ rateLimit: tinyRateLimit(2) }),
      );

      // Exhaust the auth tier via /api/auth/login — must not affect ui-config.
      await request(app).get('/api/auth/login');
      await request(app).get('/api/auth/login');
      const authThird = await request(app).get('/api/auth/login');
      expect(authThird.status).toBe(429);

      const res = await request(app).get('/api/ui-config');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ language: 'es' });
    });
  });
});
