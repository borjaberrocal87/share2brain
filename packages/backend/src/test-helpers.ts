// Integration test helper: opens the SAME real clients the backend uses at startup
// (pooled pg + node-redis) so tests exercise the true DB/Redis path, not a mock.
// Requires a live Postgres + Redis — `docker compose up -d postgres redis`.
import { createDatabase, type Database } from '@hivly/shared/db';

import type { AppOptions } from './app.js';
import { createRedisClient, type RedisClient } from './infrastructure/redis.js';

// Dev defaults match the ports docker-compose exposes on localhost. Override via env
// (e.g. CI): DATABASE_URL / REDIS_URL. Password matches the compose `.env` placeholder.
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://hivly:changeme@127.0.0.1:5432/hivly';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

export interface TestClients {
  db: Database;
  redis: RedisClient;
  /** Close both clients so the test process can exit cleanly. */
  close: () => Promise<void>;
}

/** Open real DB + Redis clients (connected) for an integration test. */
export async function openTestClients(): Promise<TestClients> {
  const db = createDatabase(DATABASE_URL);
  const redis = createRedisClient(REDIS_URL);
  await redis.connect();

  return {
    db,
    redis,
    close: async () => {
      await db.$client.end();
      redis.destroy();
    },
  };
}

/** Build AppOptions with safe test defaults; override per test (e.g. inject `oauth`). */
export function buildTestAppOptions(overrides: Partial<AppOptions> = {}): AppOptions {
  return {
    sessionSecret: 'test-session-secret',
    sessionTtlDays: 7,
    cookieSecure: false,
    discord: {
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret',
      redirectUri: 'http://localhost:3000/api/auth/callback',
      guildId: 'test-guild',
    },
    frontendUrl: 'http://localhost:5173',
    allowedOrigins: ['http://localhost:5173'],
    ...overrides,
  };
}
