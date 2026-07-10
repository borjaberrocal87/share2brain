// Integration test helper: opens the SAME real clients the bot uses at startup
// (pooled pg via @share2brain/shared/db + node-redis via @share2brain/shared/redis) so tests
// exercise the true DB/Redis path, not a mock. Mirrors packages/backend's helper,
// but imports only from @share2brain/shared (AD-2 — the bot never imports the backend).
//
// Requires a live Postgres + Redis — `docker compose up -d postgres redis`.
import { createDatabase, type Database } from '@share2brain/shared/db';
import { createRedisClient, type RedisClient } from '@share2brain/shared/redis';

// Dev defaults match the ports docker-compose exposes on localhost. Override via env
// (e.g. CI): DATABASE_URL / REDIS_URL. Password matches the compose `.env` placeholder.
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://share2brain:changeme@127.0.0.1:5432/share2brain';
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
