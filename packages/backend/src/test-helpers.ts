// Integration test helper: opens the SAME real clients the backend uses at startup
// (pooled pg + node-redis) so tests exercise the true DB/Redis path, not a mock.
// Requires a live Postgres + Redis — `docker compose up -d postgres redis`.
import { createDatabase, sql, type Database } from '@share2brain/shared/db';

import type { AppOptions } from './app.js';
import type { ChatModel } from './domain/repositories/chatModel.js';
import type { QueryEmbedder } from './domain/repositories/queryEmbedder.js';
import { createRedisClient, type RedisClient } from '@share2brain/shared/redis';

// The deployed embeddings width (Story 3.3 pivot); the migrated column is vector(1536).
// The fake query embedder MUST match it so the `<=>` operator accepts the query vector.
export const TEST_EMBEDDING_DIMENSIONS = 1536;

/**
 * Deterministic fake query embedder for integration tests — a one-hot vector at
 * index 0, so a seeded embedding that is also one-hot at index 0 scores similarity
 * 1. Never hits a real embeddings endpoint (mirrors the Indexer's fake embedder).
 */
export function fakeQueryEmbedder(index = 0): QueryEmbedder {
  return {
    embedQuery: async () => {
      const v = new Array<number>(TEST_EMBEDDING_DIMENSIONS).fill(0);
      v[index] = 1;
      return v;
    },
  };
}

/**
 * Deterministic fake chat model for integration tests / the e2e harness — streams
 * a fixed token list. Never hits a real LLM endpoint (mirrors fakeQueryEmbedder).
 * This is what makes `/api/chat` live in every integration test AND the
 * Playwright harness backend without a real provider (AC11).
 */
export function fakeChatModel(tokens: string[] = ['Hola', ' desde', ' Share2Brain', '.']): ChatModel {
  return {
    async *stream() {
      for (const token of tokens) yield token;
    },
  };
}

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

/**
 * Fail fast (Story OPS-2) if another process is connected to the test database from
 * a client address OTHER than this test's own — typically a live `docker compose`
 * app container (backend/bot/workers), or a remote client, that materializes/mutates
 * shared tables (`channel_permissions`) and causes intermittent integration failures.
 *
 * BEST-EFFORT — it does NOT catch every competing writer: a same-host writer (e.g. a
 * local `npm run dev -w @share2brain/backend`) shares this test's client address and slips
 * through, and a writer behind a connection pooler or under a different DB role is
 * also invisible. The `docs/development_guide.md` precondition covers those. Clean/CI
 * DBs (only the test connected) pass. Bypass with `SHARE2BRAIN_TEST_ALLOW_SHARED_DB=1`.
 */
async function assertNoCompetingWriter(db: Database): Promise<void> {
  if (process.env.SHARE2BRAIN_TEST_ALLOW_SHARED_DB === '1') return;
  try {
    const result = await db.execute(sql`
      SELECT count(*)::int AS n
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND client_addr IS NOT NULL
        -- Only compare when OUR OWN connection has a client_addr; over a unix socket
        -- it is NULL and every TCP peer would spuriously satisfy IS DISTINCT FROM NULL.
        AND (SELECT client_addr FROM pg_stat_activity WHERE pid = pg_backend_pid()) IS NOT NULL
        AND client_addr IS DISTINCT FROM (
          SELECT client_addr FROM pg_stat_activity WHERE pid = pg_backend_pid()
        )
    `);
    const n = Number((result.rows[0] as { n?: number } | undefined)?.n ?? 0);
    if (n > 0) {
      throw new Error(
        `[integration] Detected ${n} connection(s) to the test database from a foreign ` +
          `client address — likely a live "docker compose" app container (backend/bot/workers), ` +
          `or another remote client, that mutates shared tables (channel_permissions) and causes ` +
          `intermittent failures. Stop the app containers ("docker compose stop bot backend workers") ` +
          `or use a dedicated test database. Bypass with SHARE2BRAIN_TEST_ALLOW_SHARED_DB=1.`,
      );
    }
  } catch (err) {
    // Re-throw the guard's own detection error; otherwise fail OPEN (e.g. no
    // permission to read pg_stat_activity, a transient error) so the guard never
    // blocks a legitimate run — but WARN, so a silently-disabled guard is
    // diagnosable rather than invisible.
    if (err instanceof Error && err.message.startsWith('[integration]')) throw err;
    console.warn(
      '[integration] competing-writer guard skipped (could not read pg_stat_activity):',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Open real DB + Redis clients (connected) for an integration test. */
export async function openTestClients(): Promise<TestClients> {
  const db = createDatabase(DATABASE_URL);
  // Run the guard FIRST — it needs only `db`. On throw, end the pool so we don't
  // leak it (Redis isn't connected yet, and `clients` is never assigned so a
  // beforeAll failure can't reach afterAll's close()).
  try {
    await assertNoCompetingWriter(db);
  } catch (err) {
    await db.$client.end().catch(() => undefined);
    throw err;
  }
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
    // Deterministic fake so tests never hit a real embeddings endpoint. Overridable.
    queryEmbedder: fakeQueryEmbedder(),
    // Deterministic fake so tests never hit a real LLM endpoint. Overridable.
    chatModel: fakeChatModel(),
    ...overrides,
  };
}
