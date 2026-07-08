// Integration test for Story 6.4's security hardening (AC-2) against a REAL
// Express app + REAL Postgres + Redis: helmet headers on every response
// (including /health) and the three-tier rate limiter's injection contract —
// present + enforcing when `rateLimit` is passed, absent by default (guarding
// note #4: the rest of this test suite and the Playwright e2e harness build
// the app via `buildTestAppOptions`, which omits it, and must never see a 429).
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp, type AppOptions } from './app.js';
import { buildTestAppOptions, openTestClients, type TestClients } from './test-helpers.js';

/** A rateLimit block with every tier set to a tiny, fast-to-exceed limit. */
function tinyRateLimit(limit = 2): AppOptions['rateLimit'] {
  const tier = { windowMs: 60_000, limit };
  return { api: tier, auth: tier, chat: tier };
}

describe('Security hardening (integration)', () => {
  let clients: TestClients;

  beforeAll(async () => {
    clients = await openTestClients();
  });

  afterAll(async () => {
    await clients.close();
  });

  describe('helmet headers', () => {
    it('sets the AC-2 security headers on GET /health', async () => {
      const app = createApp(clients.db, clients.redis, buildTestAppOptions());

      const res = await request(app).get('/health');

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['strict-transport-security']).toBeDefined();
    });

    it('sets the AC-2 security headers on an /api/* response', async () => {
      const app = createApp(clients.db, clients.redis, buildTestAppOptions());

      const res = await request(app).get('/api/auth/login');

      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['content-security-policy']).toBeDefined();
      expect(res.headers['strict-transport-security']).toBeDefined();
    });
  });

  describe('rate limiting — injected (production shape)', () => {
    it('returns 429 with RateLimit headers past the auth tier limit', async () => {
      const app = createApp(
        clients.db,
        clients.redis,
        buildTestAppOptions({ rateLimit: tinyRateLimit(2) }),
      );

      const first = await request(app).get('/api/auth/login');
      const second = await request(app).get('/api/auth/login');
      const third = await request(app).get('/api/auth/login');

      expect(first.status).toBe(302);
      expect(second.status).toBe(302);
      expect(third.status).toBe(429);
      expect(third.headers['ratelimit']).toBeDefined();
    });

    it('returns 429 past the api tier limit even for an unauthenticated request', async () => {
      const app = createApp(
        clients.db,
        clients.redis,
        buildTestAppOptions({ rateLimit: tinyRateLimit(2) }),
      );

      // The api limiter sits BEFORE requireAuth on the generic /api gate, so an
      // unauthenticated request still counts towards it (and 401s until then).
      const first = await request(app).get('/api/documents');
      const second = await request(app).get('/api/documents');
      const third = await request(app).get('/api/documents');

      expect(first.status).toBe(401);
      expect(second.status).toBe(401);
      expect(third.status).toBe(429);
      expect(third.headers['ratelimit']).toBeDefined();
    });

    it('never rate-limits /health, even past the api tier limit', async () => {
      const app = createApp(
        clients.db,
        clients.redis,
        buildTestAppOptions({ rateLimit: tinyRateLimit(2) }),
      );

      // Exhaust the api tier's tiny budget on a real /api/* path first...
      await request(app).get('/api/documents');
      await request(app).get('/api/documents');
      await request(app).get('/api/documents');
      // ...then confirm /health is untouched by that same limiter.
      const health1 = await request(app).get('/health');
      const health2 = await request(app).get('/health');
      const health3 = await request(app).get('/health');

      for (const res of [health1, health2, health3]) {
        expect(res.status).not.toBe(429);
      }
    });
  });

  describe('rate limiting — default (test/e2e shape)', () => {
    it('never 429s /api/auth/* or /api/chat without an injected rateLimit', async () => {
      const app = createApp(clients.db, clients.redis, buildTestAppOptions());

      for (let i = 0; i < 5; i++) {
        const res = await request(app).get('/api/auth/login');
        expect(res.status).not.toBe(429);
      }
      for (let i = 0; i < 5; i++) {
        const res = await request(app).post('/api/chat').send({ message: 'hi' });
        expect(res.status).not.toBe(429);
      }
    });
  });
});
