// Integration test for GET /health against a REAL Express app + REAL Postgres + Redis.
// This is the layer unit tests can't cover: the actual `select 1` probe, a real
// Redis PING, the Zod-validated response, and Express status-code wiring end to end.
//
// Requires infra:  docker compose up -d postgres redis
// Run:             npm run test:integration
import { HealthResponseSchema } from '@hivly/shared/schemas';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { buildTestAppOptions, openTestClients, type TestClients } from './test-helpers.js';

describe('GET /health (integration)', () => {
  let clients: TestClients;

  beforeAll(async () => {
    clients = await openTestClients();
  });

  afterAll(async () => {
    await clients.close();
  });

  it('returns 200 healthy with both dependencies connected against real DB + Redis', async () => {
    const app = createApp(clients.db, clients.redis, buildTestAppOptions());

    const res = await request(app).get('/health');

    // Shape is always the shared contract, regardless of health (AD-6).
    expect(() => HealthResponseSchema.parse(res.body)).not.toThrow();
    // With infra up, both gating dependencies probe connected → overall healthy → 200.
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.components.database).toBe('connected');
    expect(res.body.components.redis).toBe('connected');
    // discord/indexer stay "pending" until Bot/Workers report readiness (Epic 3).
    expect(res.body.components.discord).toBe('pending');
    expect(res.body.components.indexer).toBe('pending');
  });
});
