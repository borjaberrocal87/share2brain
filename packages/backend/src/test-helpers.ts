// Integration test helper: opens the SAME real clients the backend uses at startup
// (pooled pg + ioredis) so tests exercise the true DB/Redis path, not a mock.
// Requires a live Postgres + Redis — `docker compose up -d postgres redis`.
import { createDatabase, type Database } from '@hivly/shared/db';
import { Redis } from 'ioredis';

// Dev defaults match the ports docker-compose exposes on localhost. Override via env
// (e.g. CI): DATABASE_URL / REDIS_URL. Password matches the compose `.env` placeholder.
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://hivly:changeme@127.0.0.1:5432/hivly';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

export interface TestClients {
  db: Database;
  redis: Redis;
  /** Close both clients so the test process can exit cleanly. */
  close: () => Promise<void>;
}

/** Open real DB + Redis clients for an integration test. */
export function openTestClients(): TestClients {
  const db = createDatabase(DATABASE_URL);
  const redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  // Swallow async connection errors so a dead server surfaces via the probe/assertion,
  // not as an unhandled 'error' event that crashes the worker.
  redis.on('error', () => {});

  return {
    db,
    redis,
    close: async () => {
      await db.$client.end();
      redis.disconnect();
    },
  };
}
